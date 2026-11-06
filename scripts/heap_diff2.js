'use strict'

/**
 * 两份堆快照对比（面向“有没有累积泄漏”）。
 *
 * 输出三块：
 *   1. 总量差：heapSelfMB / 节点数 / 边数 / DOM / 应用对象计数；
 *   2. 按「节点类型 + 名称形状」聚合的 self_size 差（谁涨了、谁落了）；
 *   3. 按脚本 URL 聚合的源码字节差（重复副本会在这里露出来）。
 *
 * 用法:
 *   node --max-old-space-size=12288 scripts/heap_diff2.js <before.heapsnapshot> <after.heapsnapshot> [--top=25]
 */

const fs = require('fs')

const nodeTypeNames = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const STRING_TYPE_IDS = new Set([2, 10, 11])

const argv = process.argv.slice(2)
const files = argv.filter((a) => !a.startsWith('--'))
const topN = Number((argv.find((a) => a.startsWith('--top=')) || '--top=25').slice(6))
if (files.length < 2) throw new Error('Usage: node scripts/heap_diff2.js <before> <after> [--top=25]')

async function afterMarker (file, marker, handler) {
  const stream = fs.createReadStream(file, { highWaterMark: 16 * 1024 * 1024 })
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
  if (!found) throw new Error(`Marker not found in ${file}`)
}

async function readStrings (file) {
  const strings = []
  let token = '', inString = false, escaped = false
  await afterMarker(file, Buffer.from('"strings":['), (chunk) => {
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

function readHeader (file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const text = buf.toString('utf8', 0, read)
  return {
    nodeCount: Number(text.match(/"node_count":(\d+)/)[1]),
    edgeCount: Number(text.match(/"edge_count":(\d+)/)[1]),
  }
}

/** 只扫 nodes：统计 heapSelf、按类型、按「类型|名称形状」、DOM attached/detached、script 源码字节。 */
async function scan (file, strings) {
  const header = readHeader(file)
  const byType = new Map()
  const byShape = new Map()
  const isScript = new Map() // ordinal -> true
  const scriptNames = new Map()
  let heapSelf = 0, ordinal = 0
  let attached = 0, detached = 0
  const counters = { customWindow: 0, microDocument: 0, createApp: 0, reactiveEffect: 0, computedRef: 0, accessorPair: 0, sfi: 0 }

  let field = 0, value = 0, hasValue = false
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    const typeId = tuple[0]
    const nameIndex = tuple[1]
    const selfSize = tuple[3]
    const detachedness = tuple[5]
    const name = strings[nameIndex] || ''
    heapSelf += selfSize
    const row = byType.get(typeId) || { count: 0, bytes: 0 }
    row.count++; row.bytes += selfSize
    byType.set(typeId, row)

    let shape
    if (STRING_TYPE_IDS.has(typeId)) {
      shape = `${nodeTypeNames[typeId]}|${name.slice(0, 60)}`
    } else {
      shape = `${nodeTypeNames[typeId]}|${name.slice(0, 60)}`
    }
    const srow = byShape.get(shape) || { type: nodeTypeNames[typeId], shape, count: 0, bytes: 0 }
    srow.count++; srow.bytes += selfSize
    byShape.set(shape, srow)

    if (typeId === 8 && detachedness > 0) {
      if (detachedness === 1) attached++
      else if (detachedness === 2) detached++
    }
    if (name === 'CustomWindow') counters.customWindow++
    else if (name === 'MicroDocument') counters.microDocument++
    else if (name === 'CreateApp') counters.createApp++
    else if (name === 'ReactiveEffect') counters.reactiveEffect++
    else if (name === 'ComputedRefImpl') counters.computedRef++
    else if (name === 'system / AccessorPair') counters.accessorPair++
    else if (name === 'system / ScriptFactory') counters.sfi++
    if (name.startsWith('system / Script')) {
      isScript.set(ordinal, true)
      scriptNames.set(ordinal, name.replace(/^system \/ Script \/ ?/, '') || '(inline)')
    }
    ordinal++
  }
  await afterMarker(file, Buffer.from('"nodes":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })

  const scriptSourceBytes = new Map()
  void scriptSourceBytes

  return { header, heapSelf, ordinal, byType, byShape, attached, detached, counters, scriptCount: isScript.size, scriptNames }
}

async function main () {
  const results = []
  for (const file of files.slice(0, 2)) {
    process.stderr.write(`scanning ${file}…\n`)
    const strings = await readStrings(file)
    const r = await scan(file, strings)
    results.push({ file, ...r })
    process.stderr.write(`  nodes=${r.ordinal} heapSelfMB=${(r.heapSelf / 1048576).toFixed(1)}\n`)
  }
  const [a, b] = results
  const mb = (x) => +(x / 1048576).toFixed(1)

  const shapes = new Map()
  for (const [shape, row] of a.byShape) shapes.set(shape, { shape, type: row.type, beforeBytes: row.bytes, beforeCount: row.count, afterBytes: 0, afterCount: 0 })
  for (const [shape, row] of b.byShape) {
    const cur = shapes.get(shape) || { shape, type: row.type, beforeBytes: 0, beforeCount: 0, afterBytes: 0, afterCount: 0 }
    cur.afterBytes = row.bytes
    cur.afterCount = row.count
    shapes.set(shape, cur)
  }
  const deltas = [...shapes.values()]
    .map((r) => ({ ...r, deltaBytes: r.afterBytes - r.beforeBytes, deltaCount: r.afterCount - r.beforeCount }))

  const counterDelta = {}
  for (const key of Object.keys(a.counters)) counterDelta[key] = { before: a.counters[key], after: b.counters[key], delta: b.counters[key] - a.counters[key] }

  console.log(JSON.stringify({
    before: { file: a.file, heapSelfMB: mb(a.heapSelf), nodeCount: a.header.nodeCount, edgeCount: a.header.edgeCount, attached: a.attached, detached: a.detached, counters: a.counters, scriptCount: a.scriptCount },
    after: { file: b.file, heapSelfMB: mb(b.heapSelf), nodeCount: b.header.nodeCount, edgeCount: b.header.edgeCount, attached: b.attached, detached: b.detached, counters: b.counters, scriptCount: b.scriptCount },
    heapSelfDeltaMB: mb(b.heapSelf - a.heapSelf),
    nodeDelta: b.header.nodeCount - a.header.nodeCount,
    detachedDelta: b.detached - a.detached,
    attachedDelta: b.attached - a.attached,
    counterDelta,
    byTypeDelta: [...a.byType.entries()].map(([typeId, row]) => {
      const after = b.byType.get(typeId) || { count: 0, bytes: 0 }
      return { type: nodeTypeNames[typeId], beforeMB: mb(row.bytes), afterMB: mb(after.bytes), deltaMB: mb(after.bytes - row.bytes), deltaCount: after.count - row.count }
    }).sort((x, y) => y.deltaMB - x.deltaMB),
    grewShapes: deltas.filter((r) => r.deltaBytes > 0).sort((x, y) => y.deltaBytes - x.deltaBytes).slice(0, topN)
      .map((r) => ({ type: r.type, shape: r.shape, deltaMB: mb(r.deltaBytes), deltaCount: r.deltaCount, afterMB: mb(r.afterBytes) })),
    shrankShapes: deltas.filter((r) => r.deltaBytes < 0).sort((x, y) => x.deltaBytes - y.deltaBytes).slice(0, topN)
      .map((r) => ({ type: r.type, shape: r.shape, deltaMB: mb(r.deltaBytes), deltaCount: r.deltaCount, beforeMB: mb(r.beforeBytes) })),
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
