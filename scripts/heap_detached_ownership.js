'use strict'

/**
 * 游离 DOM 归属审计。
 *
 * 回答三个问题：
 *   1. 游离节点按标签分布如何（谁是主体）；
 *   2. 它们是否带 micro-app 标记（`__MICRO_APP_NAME__`），若带则是哪个应用；
 *   3. 抽样若干节点，打印其完整入边（谁在持有），用于判断是「活组件树」还是「JS 残留」。
 *
 * 用法:
 *   node --max-old-space-size=12288 scripts/heap_detached_ownership.js <snapshot> [--samples=6] [--in=6]
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

const argv = process.argv.slice(2)
const snapshot = argv.find((a) => !a.startsWith('--'))
const sampleCount = Number((argv.find((a) => a.startsWith('--samples=')) || '--samples=6').slice(10))
const inLimit = Number((argv.find((a) => a.startsWith('--in=')) || '--in=6').slice(5))
if (!snapshot) throw new Error('Usage: node scripts/heap_detached_ownership.js <snapshot> [--samples=6] [--in=6]')

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
  const detachedness = new Uint8Array(N)
  const edgeStart = new Int32Array(N + 1)
  let field = 0, value = 0, hasValue = false, ordinal = 0, edgeTotal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]; sizes[ordinal] = tuple[3]; detachedness[ordinal] = tuple[5]
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
  return { nodeCount: ordinal, types, names, sizes, detachedness, edgeStart, edgeType, edgeTarget, edgeName }
}

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  process.stderr.write('reading graph…\n')
  const g = await readGraph()
  const edgeNameOf = (e) => {
    const type = g.edgeType[e], raw = g.edgeName[e]
    return type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const label = (o) => {
    const raw = strings[g.names[o]] || ''
    const preview = raw.replace(/\n/g, ' ').slice(0, 110)
    return `[${nodeTypes[g.types[o]]}] ${preview}`
  }

  const byTag = new Map()
  const byTagAttached = new Map()
  const detachedOrdinals = []
  let detachedBytes = 0
  for (let i = 0; i < g.nodeCount; i++) {
    if (g.types[i] !== 8 || g.detachedness[i] === 0) continue
    const raw = strings[g.names[i]] || ''
    const tag = raw.match(/^<([^ >/]+)/)?.[1] || raw || '(unknown)'
    const map = g.detachedness[i] === 2 ? byTag : byTagAttached
    const row = map.get(tag) || { tag, count: 0, bytes: 0 }
    row.count++
    row.bytes += g.sizes[i]
    map.set(tag, row)
    if (g.detachedness[i] === 2) { detachedOrdinals.push(i); detachedBytes += g.sizes[i] }
  }

  // 标记归属：`__MICRO_APP_NAME__` 边指向应用名
  const markedByApp = new Map()
  const edgeTo = (node, wanted) => {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
      if (g.edgeType[e] === 3 && edgeNameOf(e) === wanted) return g.edgeTarget[e]
    }
    return -1
  }
  for (const node of detachedOrdinals) {
    const nameNode = edgeTo(node, '__MICRO_APP_NAME__')
    if (nameNode < 0) continue
    const appName = strings[g.names[nameNode]] || '(empty)'
    const row = markedByApp.get(appName) || { app: appName, count: 0 }
    row.count++
    markedByApp.set(appName, row)
  }

  // 抽样：均匀取样，避免只看到同一种节点
  const step = Math.max(1, Math.floor(detachedOrdinals.length / sampleCount))
  const samples = []
  for (let i = 0; i < detachedOrdinals.length && samples.length < sampleCount; i += step) {
    const node = detachedOrdinals[i]
    // 需要入边：先建反向索引（一次性）
    samples.push(node)
  }
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
  const sourceOfEdge = new Int32Array(g.edgeTarget.length).fill(-1)
  for (let node = 0; node < g.nodeCount; node++) {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) sourceOfEdge[e] = node
  }

  const sampleRows = samples.map((node) => {
    const incoming = []
    for (let i = inStart[node]; i < inStart[node + 1] && incoming.length < inLimit; i++) {
      const e = inEdge[i]
      const src = sourceOfEdge[e]
      incoming.push({ edge: `${edgeTypes[g.edgeType[e]]}:${edgeNameOf(e)}`, source: src, selfSize: g.sizes[src] || 0, label: label(src) })
    }
    return { ordinal: node, selfSize: g.sizes[node], label: label(node), incoming }
  })

  const mb = (b) => +(b / 1048576).toFixed(2)
  console.log(JSON.stringify({
    file: snapshot,
    detached: {
      count: detachedOrdinals.length,
      mb: mb(detachedBytes),
      byTag: [...byTag.values()].sort((a, b) => b.count - a.count).slice(0, 25).map((r) => ({ ...r, mb: mb(r.bytes) })),
      markedByApp: [...markedByApp.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    },
    attachedByTag: [...byTagAttached.values()].sort((a, b) => b.count - a.count).slice(0, 25).map((r) => ({ ...r, mb: mb(r.bytes) })),
    samples: sampleRows,
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
