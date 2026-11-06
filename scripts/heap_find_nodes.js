'use strict'

/**
 * 按「节点名 + 节点类型」精确列出节点 ordinal。只扫 nodes 段，不读 edges，
 * 所以在大快照上比走全图的脚本快得多。
 *
 * 为什么不用 heap_find_large_nodes.js：那个脚本按**子串**匹配名字，而 string 节点的
 * "name" 就是它的内容 —— 子应用 23 MB 的包裹源码里必然出现 "CustomWindow" 字样，
 * 会把巨型字符串一起匹配出来。这里用精确相等 + 类型过滤，并且默认跳过 string 类节点。
 *
 * 用法：
 *   node --max-old-space-size=16384 scripts/heap_find_nodes.js <snapshot> --name=CustomWindow
 *        [--type=object] [--limit=200] [--includeStrings]
 *
 * 输出：JSON { matched, truncated, nodes: [{ordinal,type,selfSize,name}] }
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const STRING_TYPE_IDS = new Set([2, 10, 11])

const argv = process.argv.slice(2)
let snapshotPath = null
let wantedName = null
let wantedType = null
let limit = 200
let includeStrings = false
for (const arg of argv) {
  if (arg === '--includeStrings') includeStrings = true
  else if (arg.startsWith('--name=')) wantedName = arg.slice(7)
  else if (arg.startsWith('--type=')) wantedType = arg.slice(7)
  else if (arg.startsWith('--limit=')) limit = Number(arg.slice(8))
  else if (!arg.startsWith('--')) snapshotPath = arg
}
if (!snapshotPath || !wantedName) throw new Error('用法: node scripts/heap_find_nodes.js <snapshot> --name=<exact> [--type=object] [--limit=200] [--includeStrings]')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshotPath, { highWaterMark: 16 * 1024 * 1024 })
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
  if (!found) throw new Error(`Marker not found: ${marker}`)
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

;(async () => {
  const strings = await readStrings()
  const wantedTypeId = wantedType ? nodeTypes.indexOf(wantedType) : -1
  if (wantedType && wantedTypeId < 0) throw new Error(`未知类型: ${wantedType}`)

  const nodes = []
  let matched = 0
  let field = 0, value = 0, hasValue = false, ordinal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    const typeId = tuple[0]
    const name = strings[tuple[1]] || ''
    if (name === wantedName && (wantedTypeId < 0 || wantedTypeId === typeId) && (includeStrings || !STRING_TYPE_IDS.has(typeId))) {
      matched++
      if (nodes.length < limit) nodes.push({ ordinal, type: nodeTypes[typeId], selfSize: tuple[3], name })
    }
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

  console.log(JSON.stringify({ snapshot: snapshotPath, wantedName, totalNodes: ordinal, matched, truncated: matched > nodes.length, nodes }, null, 2))
})().catch((error) => { console.error(error); process.exitCode = 1 })
