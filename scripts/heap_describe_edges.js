'use strict'

/**
 * 描述若干 ordinal 节点的出边与入边（含所属脚本 URL），用于把「谁持有」定位到具体代码。
 *
 * 用法:
 *   node --max-old-space-size=12288 scripts/heap_describe_edges.js <snapshot> \
 *        --nodes=3864480 [--out=40] [--in=8] [--strings]
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

const argv = process.argv.slice(2)
const snapshot = argv.find((a) => !a.startsWith('--'))
const nodesArg = argv.find((a) => a.startsWith('--nodes='))
const outLimit = Number((argv.find((a) => a.startsWith('--out=')) || '--out=30').slice(6))
const inLimit = Number((argv.find((a) => a.startsWith('--in=')) || '--in=8').slice(5))
const showStrings = argv.includes('--strings')
if (!snapshot || !nodesArg) throw new Error('Usage: node scripts/heap_describe_edges.js <snapshot> --nodes=1,2,3 [--out=30] [--in=8]')
const targets = nodesArg.slice(8).split(',').map(Number)

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshot, { highWaterMark: 16 * 1024 * 1024 })
  let tail = Buffer.alloc(0)
  let found = false
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) { tail = data.subarray(Math.max(0, data.length - marker.length + 1)); continue }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }
  if (!found) throw new Error('Marker not found')
}

function readNodeCount () {
  const fd = fs.openSync(snapshot, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  return Number(buf.toString('utf8', 0, read).match(/"node_count":(\d+)/)[1]) + 1
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
  const N = readNodeCount()
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeTarget, edgeName }
}

async function main () {
  const strings = await readStrings()
  const g = await readGraph()
  const edgeNameOf = (e) => {
    const type = g.edgeType[e], raw = g.edgeName[e]
    return type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const label = (o) => {
    const raw = strings[g.names[o]] || ''
    let preview = raw.replace(/\n/g, ' ')
    if (!showStrings && preview.length > 110) preview = `${preview.slice(0, 110)}…[${raw.length}]`
    else if (preview.length > 400) preview = `${preview.slice(0, 400)}…[${raw.length}]`
    return `[${nodeTypes[g.types[o]]}] ${preview}`
  }

  // incoming edges: build reverse index once
  const indeg = new Int32Array(g.nodeCount)
  for (let e = 0; e < g.edgeTarget.length; e++) {
    const t = g.edgeTarget[e]
    if (t >= 0 && t < g.nodeCount) indeg[t]++
  }
  const inStart = new Int32Array(g.nodeCount + 1)
  for (let i = 0; i < g.nodeCount; i++) inStart[i + 1] = inStart[i] + indeg[i]
  const inEdge = new Int32Array(inStart[g.nodeCount])
  const inFill = new Int32Array(g.nodeCount)
  for (let node = 0; node < g.nodeCount; node++) {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
      const t = g.edgeTarget[e]
      if (t < 0 || t >= g.nodeCount) continue
      inEdge[inStart[t] + inFill[t]++] = e
    }
  }

  const result = targets.map((target) => {
    const out = []
    for (let e = g.edgeStart[target]; e < g.edgeStart[target + 1] && out.length < outLimit; e++) {
      const t = g.edgeTarget[e]
      out.push({ edge: `${edgeTypes[g.edgeType[e]]}:${edgeNameOf(e)}`, target: t, selfSize: g.sizes[t] || 0, label: label(t) })
    }
    const inc = []
    for (let i = inStart[target]; i < inStart[target + 1] && inc.length < inLimit; i++) {
      const e = inEdge[i]
      inc.push({ edge: `${edgeTypes[g.edgeType[e]]}:${edgeNameOf(e)}`, edgeIndex: e })
    }
    return { target, selfSize: g.sizes[target], label: label(target), outgoing: out, incomingEdgeIndexes: inc }
  })

  // resolve incoming sources (need source per edge): compute by scanning node ranges
  const sourceOfEdge = new Int32Array(g.edgeTarget.length).fill(-1)
  for (let node = 0; node < g.nodeCount; node++) {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) sourceOfEdge[e] = node
  }
  for (const row of result) {
    row.incoming = row.incomingEdgeIndexes.map(({ edge, edgeIndex }) => {
      const src = sourceOfEdge[edgeIndex]
      return { edge, source: src, selfSize: g.sizes[src] || 0, label: label(src) }
    })
    delete row.incomingEdgeIndexes
  }

  console.log(JSON.stringify({ file: snapshot, nodes: result }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
