'use strict'

// Find the "external ingress" of a retained region: BFS the region reachable from a
// seed node, then list every edge that enters the region from a node outside it.
// Those are the references that actually keep the region alive.
// Usage: node heap_ingress.js <snapshot> <seedOrdinal> [limit]

const fs = require('fs')
const [snapshotPath, seedArg, limitArg] = process.argv.slice(2)
const seed = Number(seedArg)
const limit = Number(limitArg) || 60
const watch = process.argv.slice(2).filter((a) => a.startsWith('watch:'))
  .flatMap((a) => a.slice(6).split(',')).map(Number).filter(Number.isFinite)
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !Number.isFinite(seed)) throw new Error('Usage: node heap_ingress.js <snapshot> <seedOrdinal> [limit]')

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

  // The seed reaches most of the heap, so analyse the EXCLUSIVELY retained set:
  // nodes reachable from the root only by passing through the seed.
  const reach = (blockedSeed) => {
    const seen = new Uint8Array(N)
    const queue = new Int32Array(N)
    let head = 0, tail = 0
    queue[tail++] = 0
    seen[0] = 1
    while (head < tail) {
      const node = queue[head++]
      if (blockedSeed && node === seed) continue
      for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
        if (edgeType[e] === 6) continue
        const to = edgeTarget[e]
        if (to < 0 || to >= N || seen[to]) continue
        seen[to] = 1
        queue[tail++] = to
      }
    }
    return seen
  }
  const all = reach(false)
  const withoutSeed = reach(true)
  const inRegion = new Uint8Array(N)
  let regionSize = 0, regionCount = 0
  for (let i = 0; i < N; i++) {
    if (all[i] && !withoutSeed[i]) {
      inRegion[i] = 1
      regionSize += sizes[i]
      regionCount++
    }
  }
  process.stderr.write(`region: ${regionCount} nodes, ${(regionSize / 1048576).toFixed(1)} MB\n`)

  const describe = (o) => {
    const raw = strings[names[o]] || ''
    return {
      ordinal: o,
      type: nodeTypes[types[o]],
      selfSize: sizes[o],
      name: raw.length > 100 ? `${raw.slice(0, 100)}…[${raw.length}]` : raw,
    }
  }

  // every edge entering the region from outside
  //
  // ⚠️ 必须把**种子自己**排除掉。区域的定义是 `all && !withoutSeed`（只有经过种子才可达），
  // 而当种子本身还能从别处到达时 `withoutSeed[seed] = 1`，种子就会被判成"区域外"，
  // 于是它自己的几百上千个槽边会被全部当成"环外入边"，把 ingress 结论完全带偏。
  const edges = []
  const seedOwnEdges = []
  for (let node = 0; node < N; node++) {
    if (inRegion[node]) continue
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (edgeType[e] === 6) continue
      const to = edgeTarget[e]
      if (to < 0 || to >= N || !inRegion[to]) continue
      const type = edgeType[e], raw = edgeName[e]
      const label = type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
      const row = { from: describe(node), edge: `${edgeTypes[type]}:${label}`, to: describe(to) }
      if (node === seed) seedOwnEdges.push(row)
      else edges.push(row)
    }
  }

  const grouped = new Map()
  for (const e of edges) {
    const key = `${e.from.type} ${e.from.name} || ${e.edge}`
    const row = grouped.get(key) || { key, count: 0, targets: new Set(), sample: e.from.ordinal }
    row.count++
    row.targets.add(e.to.ordinal)
    grouped.set(key, row)
  }

  // Edges that come straight out of a synthetic (GC root) node into the region:
  // these are the actual root handles keeping the region alive.
  const rootEdges = []
  for (let node = 0; node < N; node++) {
    if (types[node] !== 9) continue
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (edgeType[e] === 6) continue
      const t = edgeTarget[e]
      if (t < 0 || t >= N || !inRegion[t]) continue
      const type = edgeType[e], raw = edgeName[e]
      const label = type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
      rootEdges.push({ from: describe(node), edge: `${edgeTypes[type]}:${label}`, to: describe(t), toSize: sizes[t] })
    }
  }
  const rootGrouped = new Map()
  for (const r of rootEdges) {
    const key = `${r.from.name} || ${r.edge} || ${r.to.type}`
    const row = rootGrouped.get(key) || { key, count: 0, samples: [] }
    row.count++
    if (row.samples.length < 5) row.samples.push({ ordinal: r.to.ordinal, name: r.to.name.slice(0, 50), selfSize: r.to.selfSize })
    rootGrouped.set(key, row)
  }

  console.log(JSON.stringify({
    seed: describe(seed),
    region: { nodes: regionCount, selfSize: regionSize },
    rootEdgesIntoRegion: rootEdges.length,
    rootEdgeGroups: [...rootGrouped.values()].sort((a, b) => b.count - a.count).slice(0, 25),
    watched: watch.map((o) => ({ ...describe(o), inRegion: !!inRegion[o], reachable: !!all[o] })),
    // 种子的自有出边单列，不要混进 ingress
    seedOwnEdgeCount: seedOwnEdges.length,
    seedEdgeGroups: (() => {
      const g = new Map()
      for (const e of seedOwnEdges) {
        const k = `${e.edge} || ${e.to.type}`
        const row = g.get(k) || { key: k, count: 0 }
        row.count++
        g.set(k, row)
      }
      return [...g.values()].sort((a, b) => b.count - a.count).slice(0, 10)
    })(),
    ingressEdges: edges.length,
    distinctIngressSources: [...new Set(edges.map((e) => e.from.ordinal))].length,
    top: [...grouped.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((r) => ({ key: r.key, count: r.count, sampleOrdinal: r.sample })),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
