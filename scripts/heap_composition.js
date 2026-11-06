'use strict'

/**
 * 快速内存构成统计：单次读取 nodes 段，按「节点类型 × 名称前缀」聚合 self_size。
 *
 * 目的：在跑昂贵的支配树/根路径之前，先回答一个更基础的问题 ——
 * 这 ~650MB 到底分布在哪些对象上（Vue 组件树、字符串、代码、DOM、闭包……）。
 * 只读 nodes，不读 edges，因此比 heap_metrics 更快。
 *
 * 用法：
 *   node --max-old-space-size=8192 scripts/heap_composition.js <snapshot> [--top=40]
 */

const fs = require('fs')

const nodeTypeNames = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const STRING_TYPE_IDS = new Set([2, 10, 11])

function parseArgs (argv) {
  const out = { snapshot: null, top: 40 }
  for (const arg of argv) {
    if (arg.startsWith('--top=')) out.top = Number(arg.slice(6))
    else if (!arg.startsWith('--')) out.snapshot = arg
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.snapshot) throw new Error('用法: node scripts/heap_composition.js <snapshot> [--top=40]')

async function readStrings () {
  const stream = fs.createReadStream(opts.snapshot, { highWaterMark: 16 * 1024 * 1024 })
  const strings = []
  let token = '', inString = false, escaped = false, found = false
  let tail = Buffer.alloc(0)
  const handler = (chunk) => {
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
  }
  const marker = Buffer.from('"strings":[')
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) { tail = data.subarray(Math.max(0, data.length - marker.length + 1)); continue }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }
  return strings
}

function readHeader () {
  const fd = fs.openSync(opts.snapshot, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const text = buf.toString('utf8', 0, read)
  return {
    nodeCount: Number(text.match(/"node_count":(\d+)/)[1]),
    edgeCount: Number(text.match(/"edge_count":(\d+)/)[1]),
  }
}

async function scanNodes (strings) {
  const header = readHeader()
  const byType = new Map() // typeId -> {count, bytes}
  const byName = new Map() // "typeId|nameKey" -> {count, bytes, sampleOrdinal}
  const stringsBySize = new Map() // string node name (content) -> bytes
  let heapSelf = 0, ordinal = 0

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
    heapSelf += selfSize
    const name = strings[nameIndex] || ''
    let row = byType.get(typeId)
    if (!row) { row = { count: 0, bytes: 0 }; byType.set(typeId, row) }
    row.count++
    row.bytes += selfSize

    if (STRING_TYPE_IDS.has(typeId)) {
      // 字符串节点的 name 就是内容：按长度分桶，找大字符串
      const key = name.length > 512 ? `LEN>512 :: ${name.slice(0, 80)}` : null
      if (key) {
        const srow = stringsBySize.get(key) || { count: 0, bytes: 0, sampleOrdinal: ordinal }
        srow.count++
        srow.bytes += selfSize
        stringsBySize.set(key, srow)
      }
    } else {
      // 名称前缀：去掉 URL / 数字 / 地址等易变部分，聚合同类对象
      let key = name
      if (key.length > 60) key = key.slice(0, 60)
      const mapKey = `${typeId}|${key}`
      const nrow = byName.get(mapKey) || { typeId, name: key, count: 0, bytes: 0, sampleOrdinal: ordinal }
      nrow.count++
      nrow.bytes += selfSize
      byName.set(mapKey, nrow)
    }
    ordinal++
  }

  let found = false
  let tail = Buffer.alloc(0)
  const marker = Buffer.from('"nodes":[')
  const stream = fs.createReadStream(opts.snapshot, { highWaterMark: 16 * 1024 * 1024 })
  const handler = (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  }
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) { tail = data.subarray(Math.max(0, data.length - marker.length + 1)); continue }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }

  return { header, byType, byName, stringsBySize, heapSelf, ordinal }
}

async function main () {
  const strings = await readStrings()
  const result = await scanNodes(strings)
  const mb = (b) => +(b / 1048576).toFixed(1)

  const types = [...result.byType.entries()]
    .map(([typeId, row]) => ({ type: nodeTypeNames[typeId] || String(typeId), count: row.count, mb: mb(row.bytes) }))
    .sort((a, b) => b.mb - a.mb)

  const names = [...result.byName.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, opts.top)
    .map((row) => ({ type: nodeTypeNames[row.typeId] || String(row.typeId), name: row.name, count: row.count, mb: mb(row.bytes), sampleOrdinal: row.sampleOrdinal }))

  const bigStringsWithContent = []
  for (const [key, row] of [...result.stringsBySize.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, opts.top)) {
    bigStringsWithContent.push({ count: row.count, mb: mb(row.bytes), sampleOrdinal: row.sampleOrdinal, preview: key.slice(9, 109) })
  }

  console.log(JSON.stringify({
    file: opts.snapshot,
    nodeCount: result.header.nodeCount,
    edgeCount: result.header.edgeCount,
    heapSelfMB: mb(result.heapSelf),
    byType: types,
    topNames: names,
    bigStrings: bigStringsWithContent,
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
