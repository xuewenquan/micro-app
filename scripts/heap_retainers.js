'use strict'

// Walk UP the reference graph level by level from one or more seeds, printing every
// retainer found at each level. Unlike a shortest path this shows ALL holders, so it
// reveals when a leaked object is held by several independent chains.
//
// Usage: node heap_retainers.js <snapshot> <ordinal> [ordinal2] ... [--levels=8] [--fanout=4000] [--region]
//   --region  also compute the exclusively-retained region of the first seed and mark
//             each retainer as inside/outside it.

const fs = require('fs')
const args = process.argv.slice(2)
const snapshotPath = args[0]
const flags = new Map(args.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => a.split('=')))
const seeds = args.slice(1).filter((a) => !a.startsWith('--')).map(Number)
const maxLevels = Number(flags.get('--levels')) || 8
const fanoutCap = Number(flags.get('--fanout')) || 4000
const wantRegion = args.includes('--region')
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !seeds.length) throw new Error('Usage: node heap_retainers.js <snapshot> <ordinal> [...] [--levels=N]')

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
  if (!match) throw new Error('node_count not found in snapshot header')
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

async function readGraph (strings) {
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
  const edgeTarget = new Int32Array(edgeTotal)
  const edgeName = new Uint32Array(edgeTotal)
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeTarget, edgeName }
}

async function main () {
  process.stderr.write('reading…\n')
  const strings = await readStrings()
  const g = await readGraph(strings)
  const label = (e) => {
    const type = g.edgeType[e], raw = g.edgeName[e]
    const name = type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
    return `${edgeTypes[type]}:${name}`
  }
  const describe = (o) => {
    const raw = strings[g.names[o]] || ''
    return { ordinal: o, type: nodeTypes[g.types[o]], selfSize: g.sizes[o], name: raw.length > 90 ? `${raw.slice(0, 90)}…[${raw.length}]` : raw }
  }

  let inRegion = null
  if (wantRegion) {
    const reach = (blocked) => {
      const seen = new Uint8Array(g.nodeCount)
      const queue = new Int32Array(g.nodeCount)
      let head = 0, tail = 0
      queue[tail++] = 0; seen[0] = 1
      while (head < tail) {
        const node = queue[head++]
        if (blocked && node === seeds[0]) continue
        for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
          if (g.edgeType[e] === 6) continue
          const to = g.edgeTarget[e]
          if (to < 0 || to >= g.nodeCount || seen[to]) continue
          seen[to] = 1; queue[tail++] = to
        }
      }
      return seen
    }
    const all = reach(false)
    const without = reach(true)
    inRegion = new Uint8Array(g.nodeCount)
    let size = 0, count = 0
    for (let i = 0; i < g.nodeCount; i++) if (all[i] && !without[i]) { inRegion[i] = 1; size += g.sizes[i]; count++ }
    process.stderr.write(`exclusive region of seed ${seeds[0]}: ${count} nodes, ${(size / 1048576).toFixed(1)} MB\n`)
  }

  // Resolve which Script (bundle) a function node came from.
  const edgeNameOf = (e) => {
    const type = g.edgeType[e], raw = g.edgeName[e]
    return type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const findTarget = (node, wanted) => {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
      if (g.edgeType[e] === 3 && edgeNameOf(e) === wanted) return g.edgeTarget[e]
    }
    return -1
  }
  const urlCache = new Map()
  const scriptUrlOf = (node) => {
    if (urlCache.has(node)) return urlCache.get(node)
    let url = null
    if (g.types[node] === 5 || g.types[node] === 4) {
      let sfi = findTarget(node, 'shared')
      if (sfi < 0) sfi = node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = strings[g.names[urlNode]] || null
      }
    }
    urlCache.set(node, url)
    return url
  }

  const visited = new Set(seeds)
  let frontier = new Set(seeds)
  const result = { seeds: seeds.map(describe), levels: [] }

  for (let level = 1; level <= maxLevels && frontier.size; level++) {
    const hits = new Map() // source ordinal -> {edges:Set, targets:Set}
    for (let node = 0; node < g.nodeCount; node++) {
      if (frontier.has(node)) continue
      for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
        if (g.edgeType[e] === 6) continue
        if (!frontier.has(g.edgeTarget[e])) continue
        const row = hits.get(node) || { labels: new Set(), targets: new Set() }
        row.labels.add(label(e))
        row.targets.add(g.edgeTarget[e])
        hits.set(node, row)
      }
    }
    if (!hits.size) { process.stderr.write(`level ${level}: no retainers (reached GC root)\n`); break }

    const rows = []
    const byBundle = new Map()
    const bundleSamples = new Map()
    for (const [node, row] of hits) {
      const scriptUrl = scriptUrlOf(node)
      const bundleKey = scriptUrl || `${nodeTypes[g.types[node]]} (no script)`
      byBundle.set(bundleKey, (byBundle.get(bundleKey) || 0) + 1)
      const samples = bundleSamples.get(bundleKey) || []
      if (samples.length < 5) samples.push({ ordinal: node, via: [...row.labels].slice(0, 3).join(' + '), targets: [...row.targets].slice(0, 3) })
      bundleSamples.set(bundleKey, samples)
      rows.push({
        ...describe(node),
        scriptUrl,
        via: [...row.labels].slice(0, 4),
        targets: [...row.targets],
        inExclusiveRegion: inRegion ? !!inRegion[node] : null,
      })
    }
    rows.sort((a, b) => b.selfSize - a.selfSize)
    process.stderr.write(`level ${level}: ${hits.size} retainers\n`)

    result.levels.push({
      level,
      retainerCount: hits.size,
      byBundle: Object.fromEntries([...byBundle].sort((a, b) => b[1] - a[1]).slice(0, 12)),
      bundleSamples: Object.fromEntries([...bundleSamples].slice(0, 12)),
      retainers: rows.slice(0, 40),
    })

    if (hits.size > fanoutCap) {
      process.stderr.write(`level ${level}: fan-out ${hits.size} exceeds cap ${fanoutCap}, stopping\n`)
      result.levels[result.levels.length - 1].truncated = true
      break
    }

    const next = new Set()
    for (const node of hits.keys()) if (!visited.has(node)) { visited.add(node); next.add(node) }
    if (!next.size) break
    frontier = next
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
