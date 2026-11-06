'use strict'

/**
 * 统计快照里「V8 元数据 / 编译产物」的规模：Script、SharedFunctionInfo、
 * FeedbackCell/Vector、BytecodeArray、InstructionStream、ExternalStringData 等。
 * 这些不属于「活对象」，但会实实在在占用渲染进程的物理内存。
 *
 * 只读 nodes 段，很快。
 *
 * 用法：
 *   node --max-old-space-size=8192 scripts/heap_v8_overhead.js <snapshot>
 */

const fs = require('fs')

const nodeTypeNames = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const STRING_TYPE_IDS = new Set([2, 10, 11])
// process.argv[1] 是脚本路径，真正的快照路径要从脚本之后的参数里找
const snapshot = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!snapshot) throw new Error('Usage: node scripts/heap_v8_overhead.js <snapshot>')

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

function readHeader () {
  // 头部的 trace_function_infos / samples 段可能很长，4KB 不一定够
  const fd = fs.openSync(snapshot, 'r')
  const buf = Buffer.alloc(65536)
  const read = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  const text = buf.toString('utf8', 0, read)
  const nodeMatch = text.match(/"node_count":(\d+)/)
  const edgeMatch = text.match(/"edge_count":(\d+)/)
  return {
    nodeCount: nodeMatch ? Number(nodeMatch[1]) : null,
    edgeCount: edgeMatch ? Number(edgeMatch[1]) : null,
  }
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
  const header = readHeader()
  const groups = new Map()
  const scriptSourceByUrl = new Map()
  const scriptOrdinals = new Map()
  let heapSelf = 0, ordinal = 0
  let externStringMB = 0, externStringCount = 0

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
    const name = strings[nameIndex] || ''
    heapSelf += selfSize

    let key = null
    if (name.startsWith('system / Script')) key = 'Script（编译后的脚本对象）'
    else if (name.startsWith('system / SharedFunctionInfo')) key = 'SharedFunctionInfo'
    else if (name === 'system / FeedbackCell') key = 'FeedbackCell（编译反馈）'
    else if (name.startsWith('system / FeedbackVector')) key = 'FeedbackVector（编译反馈）'
    else if (name.startsWith('system / BytecodeArray')) key = 'BytecodeArray（字节码）'
    else if (name.startsWith('system / InstructionStream')) key = 'InstructionStream（机器码）'
    else if (name === 'system / ExternalStringData') key = 'ExternalStringData（堆外字符串）'
    else if (name.startsWith('system / TrustedByteArray')) key = 'TrustedByteArray（源码/字面量）'
    else if (name === '(script line ends)') key = 'script line ends（行号表）'
    else if (name.startsWith('system / ScriptSource')) key = 'ScriptSource'
    else if (name === 'system / PropertyArray') key = 'PropertyArray'
    else if (name === 'system / DescriptorArray') key = 'DescriptorArray（隐藏类）'
    else if (name === 'system / ObjectBoilerplateDescription') key = 'ObjectBoilerplateDescription'
    if (key) {
      const row = groups.get(key) || { count: 0, bytes: 0 }
      row.count++; row.bytes += selfSize
      groups.set(key, row)
    }
    if (name === 'system / ExternalStringData') { externStringMB += selfSize; externStringCount++ }
    if (name.startsWith('system / Script')) scriptOrdinals.set(ordinal, name.replace(/^system \/ Script \/ ?/, '') || '(inline)')
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

  const mb = (b) => +(b / 1048576).toFixed(2)
  const rows = [...groups.entries()]
    .map(([name, row]) => ({ name, count: row.count, mb: mb(row.bytes) }))
    .sort((a, b) => b.mb - a.mb)

  const metaMB = rows.reduce((sum, r) => sum + r.mb, 0)
  console.log(JSON.stringify({
    file: snapshot,
    nodeCount: header.nodeCount,
    edgeCount: header.edgeCount,
    heapSelfMB: mb(heapSelf),
    v8MetadataMB: +metaMB.toFixed(2),
    v8MetadataShare: `${((metaMB / mb(heapSelf)) * 100).toFixed(1)}%`,
    scriptCount: scriptOrdinals.size,
    externalStringCount: externStringCount,
    groups: rows,
    biggestScripts: [...scriptOrdinals.values()]
      .filter((u) => u !== '(inline)')
      .slice(0, 5),
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
