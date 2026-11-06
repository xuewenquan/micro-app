'use strict'

// Grow the boundary of a leaked cluster outward until its ingress reaches live code.
//
// A = accumulated boundary set (starts as the known gateway nodes).
// C = nodes reachable from the root ONLY by passing through A  (the leaked cluster).
// Ingress = edges from outside (C ∪ A) into (C ∪ A) — what still holds the cluster.
// Then A absorbs the ingress nodes and the loop repeats, pushing the boundary outward.
//
// Usage: node heap_grow_boundary.js <snapshot> <ordinal> [ordinal2] ... [--rounds=8] [--cap=20000]

const fs = require('fs')
const args = process.argv.slice(2)
const snapshotPath = args[0]
const flagMap = new Map(args.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => a.split('=')))
const seedOrdinals = args.slice(1).filter((a) => !a.startsWith('--')).map(Number)
const maxRounds = Number(flagMap.get('--rounds')) || 8
const ingressCap = Number(flagMap.get('--cap')) || 20000
// 把每一轮的 ingress 来源节点号写到文件（每轮覆盖，所以最终留下的是最后一轮）。
// 用途：拿到完整的来源列表后做持有者分布统计，而不是只靠一个 sample 推断。
const dumpIngressPath = flagMap.get('--dumpIngress') || null
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !seedOrdinals.length) throw new Error('Usage: node heap_grow_boundary.js <snapshot> <ordinal> [...] [--rounds=8]')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshotPath, { highWaterMark: 16 * 1024 * 1024 })
  let tail = Buffer.alloc(0)
  let found = false
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) {
        tail = data.subarray(Math.max(0, data.length - marker.length + 1))
        continue
      }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }
  if (!found) throw new Error(`Marker not found: ${marker}`)
}

function readNodeCount (snapshotPath) {
  const fd = fs.openSync(snapshotPath, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const match = buf.toString('utf8', 0, read).match(/"node_count":(\d+)/)
  return Number(match[1]) + 1
}

async function readStrings () {
  const strings = []
  let token = '', inString = false, escaped = false
  await afterMarker(Buffer.from('"strings":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const char = String.fromCharCode(chunk[i])
      if (!inString) {
        if (char === ']') return false
        if (char === '"') { inString = true; token = '"' }
      } else {
        token += char
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') { strings.push(JSON.parse(token)); token = ''; inString = false }
      }
    }
    return true
  })
  return strings
}

async function main () {
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\n`)
  const N = readNodeCount(snapshotPath)
  const types = new Uint8Array(N)
  const names = new Uint32Array(N)
  const sizes = new Uint32Array(N)
  const edgeStart = new Int32Array(N + 1)
  let field = 0, value = 0, hasValue = false, ordinal = 0, edgeTotal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]; sizes[ordinal] = tuple[3]
    edgeStart[ordinal] = edgeTotal
    edgeTotal += tuple[4]
    ordinal++
  }
  await afterMarker(Buffer.from('"nodes":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })
  edgeStart[ordinal] = edgeTotal
  process.stderr.write(`nodes=${ordinal} edges=${edgeTotal}\n`)

  const edgeType = new Uint8Array(edgeTotal)
  const edgeName = new Uint32Array(edgeTotal)
  const edgeTarget = new Int32Array(edgeTotal)
  field = 0; value = 0; hasValue = false
  let edgeOrdinal = 0
  const et = new Array(3)
  const consumeEdge = () => {
    if (!hasValue) return
    et[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    edgeType[edgeOrdinal] = et[0]; edgeName[edgeOrdinal] = et[1]; edgeTarget[edgeOrdinal] = et[2] / 6
    edgeOrdinal++
  }
  await afterMarker(Buffer.from('"edges":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consumeEdge()
      else if (code === 93) { consumeEdge(); return false }
    }
    return true
  })

  const nameOf = (o) => strings[names[o]] || ''
  const edgeNameOf = (e) => {
    const t = edgeType[e], raw = edgeName[e]
    return t === 4 && raw === 0 ? '<dummy>' : t === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const findTarget = (node, wanted) => {
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (edgeType[e] === 3 && edgeNameOf(e) === wanted) return edgeTarget[e]
    }
    return -1
  }
  const URL_RE = /https?:\/\/[^\s"')]+/
  const urlCache = new Map()
  const scriptUrlOf = (node) => {
    if (urlCache.has(node)) return urlCache.get(node)
    let url = null
    if (types[node] === 5 || types[node] === 4) {
      let sfi = findTarget(node, 'shared')
      if (sfi < 0) sfi = node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = nameOf(urlNode)
        if (!url) {
          const scriptName = nameOf(scriptNode)
          const m = scriptName.match(URL_RE)
          url = m ? m[0] : null
        }
      }
    }
    urlCache.set(node, url)
    return url
  }
  const categorize = (url) => {
    if (!url) return 'unknown'
    if (url.includes('localhost:3000') || url.includes('127.0.0.1')) return 'BASE(localhost:3000)'
    if (url.includes('wonder10.com')) return 'CHILD(' + ((url.match(/\/\/([^.]+)\./) || [null, '?'])[1]) + ')'
    return 'other'
  }
  const describe = (o) => ({ ordinal: o, type: nodeTypes[types[o]], selfSize: sizes[o], name: nameOf(o).slice(0, 70), scriptUrl: scriptUrlOf(o) })

  const reach = (blockedSet) => {
    const seen = new Uint8Array(N)
    const queue = new Int32Array(N)
    let head = 0, tail = 0
    queue[tail++] = 0; seen[0] = 1
    while (head < tail) {
      const node = queue[head++]
      if (blockedSet.has(node)) continue
      for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
        if (edgeType[e] === 6) continue
        const t = edgeTarget[e]
        if (t < 0 || t >= N || seen[t]) continue
        seen[t] = 1; queue[tail++] = t
      }
    }
    return seen
  }

  const A = new Set(seedOrdinals)
  const rounds = []
  for (let round = 1; round <= maxRounds; round++) {
    const withoutA = reach(A)
    // cluster = reachable only through A
    const inCluster = new Uint8Array(N)
    let clusterNodes = 0, clusterSize = 0
    for (let i = 0; i < N; i++) {
      if (withoutA[i]) continue
      inCluster[i] = 1; clusterNodes++; clusterSize += sizes[i]
    }
    // S = cluster ∪ A
    const inS = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (inCluster[i] || A.has(i)) inS[i] = 1
    // ingress edges: outside S -> inside S
    const groups = new Map()
    const byCat = new Map()
    const ingressSources = new Set()
    const syntheticIngress = []
    const baseClosureGroups = new Map()
    const microAppIngress = []
    let ingressCount = 0
    for (let node = 0; node < N; node++) {
      if (inS[node]) continue
      for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
        if (edgeType[e] === 6) continue
        const t = edgeTarget[e]
        if (t < 0 || t >= N || !inS[t]) continue
        ingressCount++
        ingressSources.add(node)
        const url = scriptUrlOf(node)
        if (types[node] === 9) {
          syntheticIngress.push({ ordinal: node, name: nameOf(node).slice(0, 60), edge: `${edgeTypes[edgeType[e]]}:${edgeNameOf(e)}`, to: describe(t) })
        }
        if (categorize(url) === 'BASE(localhost:3000)' && (types[node] === 5 || types[node] === 4)) {
          const gkey = `${nameOf(node) || '(anon)'} [${url.replace('http://', '').slice(0, 52)}]`
          const g = baseClosureGroups.get(gkey) || { key: gkey, edges: 0, nodes: new Set() }
          g.edges++
          g.nodes.add(node)
          baseClosureGroups.set(gkey, g)
        }
        if (url && url.includes('micro-app/lib/index.esm.js')) {
          const hit = microAppIngress.find((m) => m.ordinal === node)
          const entry = hit || { ordinal: node, name: nameOf(node).slice(0, 40), url: url.replace('http://', ''), targets: [] }
          if (!hit) microAppIngress.push(entry)
          if (entry.targets.length < 12) {
            entry.targets.push({ edge: `${edgeTypes[edgeType[e]]}:${edgeNameOf(e)}`, to: describe(t) })
          }
        }
        const cat = `${categorize(url)} | ${nodeTypes[types[node]]} | ${nameOf(node).slice(0, 30) || '(anon)'}`
        byCat.set(cat, (byCat.get(cat) || 0) + 1)
        const key = `${nodeTypes[types[node]]} ${nameOf(node).slice(0, 40) || '(anon)'} [${(url || 'no url').replace('http://', '').slice(0, 40)}]`
        const row = groups.get(key) || { key, count: 0, distinctNodes: new Set(), sample: node }
        row.count++
        row.distinctNodes.add(node)
        groups.set(key, row)
      }
    }
    process.stderr.write(`round ${round}: cluster=${clusterNodes} nodes / ${(clusterSize / 1048576).toFixed(1)} MB, ingress=${ingressCount} edges from ${ingressSources.size} sources\n`)
    // 导出本轮的 ingress 来源节点号（每轮覆盖，最终留下的是最后一轮）。
    // 用途：拿到完整来源列表后做持有者分布统计，而不是只靠一个 sample 推断。
    if (dumpIngressPath) {
      const byType = new Map()
      for (const s2 of ingressSources) {
        const k = `${nodeTypes[types[s2]]}\t${(nameOf(s2) || '(anon)').slice(0, 40)}`
        const row = byType.get(k) || { type: nodeTypes[types[s2]], name: (nameOf(s2) || '(anon)').slice(0, 40), count: 0, ords: [] }
        row.count++
        if (row.ords.length < 20000) row.ords.push(s2)
        byType.set(k, row)
      }
      try {
        fs.writeFileSync(`${dumpIngressPath}.summary.json`, JSON.stringify([...byType.values()].map((r) => ({ type: r.type, name: r.name, count: r.count })).sort((a, b) => b.count - a.count).slice(0, 60), null, 1), 'utf8')
        fs.writeFileSync(`${dumpIngressPath}.ordinals.json`, JSON.stringify([...byType.values()]), 'utf8')
      } catch (err) {
        process.stderr.write(`dumpIngress 写入失败: ${String(err && err.message)}\n`)
      }
    }
    rounds.push({
      round,
      cluster: { nodes: clusterNodes, selfSize: clusterSize, boundarySetSize: A.size },
      ingress: {
        edges: ingressCount,
        sources: ingressSources.size,
        byCategory: Object.fromEntries([...byCat].sort((a, b) => b[1] - a[1]).slice(0, 15)),
        syntheticIngress: syntheticIngress.slice(0, 60),
        microAppIngress: microAppIngress.slice(0, 30),
        baseClosures: [...baseClosureGroups.values()].sort((a, b) => b.edges - a.edges).slice(0, 20)
          .map((g) => ({ key: g.key, edges: g.edges, distinctNodes: g.nodes.size })),
        top: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 25)
          .map((r) => ({ ...r, distinctNodes: r.distinctNodes.size, sampleNode: describe(r.sample) })),
      },
    })
    if (ingressSources.size > ingressCap) {
      process.stderr.write(`round ${round}: ingress fan-out exceeds cap, stopping\n`)
      rounds[rounds.length - 1].truncated = true
      break
    }
    // does the ingress already touch the root set? if so we have reached live roots
    let touchedSynthetic = false
    for (const s of ingressSources) if (types[s] === 9) { touchedSynthetic = true; break }
    if (touchedSynthetic) {
      // Reaching one root does not close the remaining non-synthetic ingress.
      // Preserve reachedRoots for consumers, but report the actual stop reason.
      const unresolvedSources = [...ingressSources].filter((s) => types[s] !== 9).length
      process.stderr.write(`round ${round}: ingress reaches synthetic GC-root nodes; ${unresolvedSources} non-synthetic sources remain (not necessarily a complete boundary)\n`)
      rounds[rounds.length - 1].reachedRoots = true
      rounds[rounds.length - 1].boundaryComplete = unresolvedSources === 0
      rounds[rounds.length - 1].unresolvedNonSyntheticSources = unresolvedSources
      break
    }
    for (const s of ingressSources) A.add(s)
  }

  console.log(JSON.stringify({ seeds: seedOrdinals.map(describe), rounds }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
