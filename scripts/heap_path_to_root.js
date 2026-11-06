'use strict'

// Find the shortest retention path from the GC root to one or more target nodes,
// by running a forward BFS from the root over the whole snapshot graph.
// Weak edges are skipped: they do not keep an object alive.
// Usage: node heap_path_to_root.js <snapshot> <ordinal> [ordinal2] ...

const fs = require('fs')
const [snapshotPath, ...targetArgs] = process.argv.slice(2)
const targets = targetArgs.map(Number)
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !targets.length) throw new Error('Usage: node heap_path_to_root.js <snapshot> <ordinal> [ordinal2] ...')

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
  // pass 1: nodes
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
  process.stderr.write(`nodes=${ordinal} edges=${edgeTotal}\n`)

  // pass 2: edges
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
    edgeType[edgeOrdinal] = et[0]
    edgeName[edgeOrdinal] = et[1]
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeName, edgeTarget, edgeTotal: edgeOrdinal }
}

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\nreading graph…\n`)
  const g = await readGraph()
  const edgeNameStr = (edgeIndex) => {
    const type = g.edgeType[edgeIndex]
    const raw = g.edgeName[edgeIndex]
    if (type === 4 && raw === 0) return '<dummy>'
    if (type === 1) return `#${raw}`
    return strings[raw] || ''
  }
  const describe = (ordinal) => {
    const value = strings[g.names[ordinal]] || ''
    return {
      ordinal,
      type: nodeTypes[g.types[ordinal]],
      selfSize: g.sizes[ordinal],
      name: value.length > 120 ? `${value.slice(0, 120)}…[${value.length}]` : value,
    }
  }

  // BFS from the root over non-weak edges
  const parentEdge = new Int32Array(g.nodeCount).fill(-1)
  const queue = new Int32Array(g.nodeCount)
  let head = 0, tail = 0
  const root = 0
  queue[tail++] = root
  parentEdge[root] = -2
  const targetSet = new Set(targets)
  const reached = new Map()
  while (head < tail) {
    const node = queue[head++]
    const start = g.edgeStart[node]
    const end = g.edgeStart[node + 1]
    for (let e = start; e < end; e++) {
      if (g.edgeType[e] === 6) continue // weak edges do not retain
      const to = g.edgeTarget[e]
      if (to < 0 || to >= g.nodeCount || parentEdge[to] !== -1) continue
      parentEdge[to] = e
      queue[tail++] = to
      if (targetSet.has(to)) reached.set(to, true)
    }
  }
  process.stderr.write(`reached=${tail}/${g.nodeCount}\n`)

  const out = {}
  for (const target of targets) {
    if (parentEdge[target] === -1) {
      out[target] = { target: describe(target), reachable: false, path: [] }
      continue
    }
    const path = []
    let current = target
    let guard = 0
    while (current !== root && guard++ < 10000) {
      const e = parentEdge[current]
      if (e < 0) break
      const from = (() => {
        // find the source of edge e via edgeStart binary search
        let lo = 0, hi = g.nodeCount - 1, ans = 0
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (g.edgeStart[mid] <= e) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        return ans
      })()
      path.push({
        from: describe(from),
        edge: `${edgeTypes[g.edgeType[e]]}:${edgeNameStr(e)}`,
        to: describe(current),
      })
      current = from
    }
    path.reverse()
    out[target] = { target: describe(target), reachable: true, hops: path.length, path }
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
