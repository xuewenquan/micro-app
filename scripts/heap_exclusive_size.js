'use strict'

// Measure how much heap becomes unreachable when the outgoing edges of one or more
// "cut" nodes are ignored. This approximates the retained size of a suspected leak anchor.
// Usage: node heap_exclusive_size.js <snapshot> <cutOrdinal|name:pattern> ...
//   A "name:<substring>" argument cuts every node whose name contains the substring.

const fs = require('fs')
const [snapshotPath, ...cutArgs] = process.argv.slice(2)
const cutOrdinals = cutArgs.filter((a) => !a.startsWith('name:') && !a.startsWith('watch:')).map(Number)
const cutPatterns = cutArgs.filter((a) => a.startsWith('name:')).map((a) => a.slice(5))
// 超大切割集（上万个 ordinal）会超过 Windows 的 argv 上限，允许从文件读。
// 文件格式：空白或逗号分隔的 ordinal。
// 把「因此不可达」的节点号导出到文件，便于对它们做进一步分析或再切割。
const dumpLostArg = cutArgs.find((a) => a.startsWith('dumpLost:'))
const cutFileArg = cutArgs.find((a) => a.startsWith('file:'))
if (cutFileArg) {
  const raw = require('fs').readFileSync(cutFileArg.slice(5), 'utf8')
  raw.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite).forEach((n) => cutOrdinals.push(n))
}
const watchOrdinals = cutArgs.filter((a) => a.startsWith('watch:')).map((a) => Number(a.slice(6)))
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']

if (!snapshotPath || !cutArgs.length) throw new Error('Usage: node heap_exclusive_size.js <snapshot> <cutOrdinal|name:pattern> ...')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshotPath, { highWaterMark: 8 * 1024 * 1024 })
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

// Read node_count from the snapshot header so the index arrays are always big enough.
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

async function readGraph () {
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
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]
    sizes[ordinal] = tuple[3]
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
  field = 0; value = 0; hasValue = false
  let edgeOrdinal = 0
  const et = new Array(3)
  const consumeEdge = () => {
    if (!hasValue) return
    et[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    edgeType[edgeOrdinal] = et[0]
    edgeTarget[edgeOrdinal] = et[2] / 6
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeTarget }
}

function reach (g, cutSet) {
  const visited = new Uint8Array(g.nodeCount)
  const queue = new Int32Array(g.nodeCount)
  let head = 0, tail = 0
  queue[tail++] = 0
  visited[0] = 1
  let size = 0, count = 0
  while (head < tail) {
    const node = queue[head++]
    size += g.sizes[node]; count++
    if (cutSet.has(node)) continue // do not traverse out of a cut node
    const start = g.edgeStart[node]
    const end = g.edgeStart[node + 1]
    for (let e = start; e < end; e++) {
      if (g.edgeType[e] === 6) continue
      const to = g.edgeTarget[e]
      if (to < 0 || to >= g.nodeCount || visited[to]) continue
      visited[to] = 1
      queue[tail++] = to
    }
  }
  return { size, count, visited }
}

async function main () {
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\n`)
  const g = await readGraph()
  process.stderr.write(`nodes=${g.nodeCount}\n`)

  const describe = (ordinal) => {
    const value = strings[g.names[ordinal]] || ''
    return {
      ordinal,
      type: nodeTypes[g.types[ordinal]],
      selfSize: g.sizes[ordinal],
      name: value.length > 100 ? `${value.slice(0, 100)}…[${value.length}]` : value,
    }
  }

  const cutSet = new Set(cutOrdinals)
  if (cutPatterns.length) {
    for (let i = 0; i < g.nodeCount; i++) {
      const raw = strings[g.names[i]] || ''
      if (cutPatterns.some((p) => raw.includes(p))) cutSet.add(i)
    }
    process.stderr.write(`pattern cuts matched ${cutSet.size} nodes\n`)
  }

  const before = reach(g, new Set())
  process.stderr.write(`baseline: nodes=${before.count} size=${before.size}\n`)
  const after = reach(g, cutSet)
  process.stderr.write(`after cut: nodes=${after.count} size=${after.size}\n`)

  // classify the nodes that became unreachable
  const lostOrdinals = []
  const lostByType = new Map()
  const lostTop = new Map()
  let lostSize = 0, lostCount = 0
  for (let i = 0; i < g.nodeCount; i++) {
    if (before.visited[i] && !after.visited[i]) {
      if (dumpLostArg) lostOrdinals.push(i)
      lostCount++
      lostSize += g.sizes[i]
      const t = nodeTypes[g.types[i]]
      lostByType.set(t, (lostByType.get(t) || 0) + 1)
      const raw = strings[g.names[i]] || ''
      const key = `${t} ${raw.length > 70 ? `${raw.slice(0, 70)}…` : raw}`
      const row = lostTop.get(key) || { key, count: 0, selfSize: 0, sample: i }
      row.count++
      row.selfSize += g.sizes[i]
      lostTop.set(key, row)
    }
  }

  if (dumpLostArg) require('fs').writeFileSync(dumpLostArg.slice(9), lostOrdinals.join(','), 'utf8')

  console.log(JSON.stringify({
    cuts: cutOrdinals.map(describe),
    cutPatterns,
    watched: watchOrdinals.map((ordinal) => ({
      ...describe(ordinal),
      reachableBefore: !!before.visited[ordinal],
      reachableAfter: !!after.visited[ordinal],
    })),
    baseline: { nodes: before.count, selfSize: before.size },
    afterCut: { nodes: after.count, selfSize: after.size },
    lost: {
      nodes: lostCount,
      selfSize: lostSize,
      byType: Object.fromEntries([...lostByType].sort((a, b) => b[1] - a[1])),
      top: [...lostTop.values()].sort((a, b) => b.selfSize - a.selfSize).slice(0, 25),
    },
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
