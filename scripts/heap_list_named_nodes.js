'use strict'

/**
 * 列出所有名称匹配给定正则的节点（ordinal + 所属脚本），
 * 并可打印某个方向的出边。用于把「计数」落到「具体哪几个对象」。
 *
 * 用法:
 *   node --max-old-space-size=8192 scripts/heap_list_named_nodes.js <snapshot> --name=^CustomWindow$ [--type=object] [--out=8]
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

const argv = process.argv.slice(2)
const snapshot = argv.find((a) => !a.startsWith('--'))
const nameArg = argv.find((a) => a.startsWith('--name='))
const typeArg = argv.find((a) => a.startsWith('--type='))
const outLimit = Number((argv.find((a) => a.startsWith('--out=')) || '--out=8').slice(6))
if (!snapshot || !nameArg) throw new Error('Usage: node scripts/heap_list_named_nodes.js <snapshot> --name=<regex> [--type=object] [--out=8]')

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

async function readNodes () {
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart }
}

async function main () {
  const strings = await readStrings()
  const g = await readNodes()
  const re = new RegExp(nameArg.slice(7))
  const wantType = typeArg ? nodeTypes.indexOf(typeArg.slice(7)) : -1
  const hits = []
  for (let i = 0; i < g.nodeCount; i++) {
    if (wantType >= 0 && g.types[i] !== wantType) continue
    const raw = strings[g.names[i]] || ''
    if (re.test(raw)) hits.push({ ordinal: i, type: nodeTypes[g.types[i]], selfSize: g.sizes[i], name: raw.slice(0, 120) })
  }

  // 出边：只为命中的节点读取（一次边扫描，遇到需要的 source 才解析）
  const wanted = new Map(hits.map((h) => [h.ordinal, []]))
  let source = 0
  let remaining = g.edgeStart[1] - g.edgeStart[0]
  let field = 0, value = 0, hasValue = false
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const list = wanted.get(source)
    if (list && list.length < outLimit) {
      const target = toOffset / 6
      const edgeName = type === 1 ? `#${nameOrIndex}` : (strings[nameOrIndex] || '')
      list.push({ edge: `${edgeTypes[type]}:${edgeName}`, target })
    }
    if (--remaining <= 0) {
      do {
        source++
        remaining = source < g.nodeCount ? g.edgeStart[source + 1] - g.edgeStart[source] : 0
      } while (source < g.nodeCount && remaining === 0)
    }
  }
  await afterMarker(Buffer.from('"edges":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })

  for (const hit of hits) {
    hit.outgoing = (wanted.get(hit.ordinal) || []).map((row) => {
      const t = row.target
      const name = t >= 0 && t < g.nodeCount ? (strings[g.names[t]] || '').slice(0, 90) : '(oob)'
      const type = t >= 0 && t < g.nodeCount ? nodeTypes[g.types[t]] : '?'
      return { edge: row.edge, target: t, targetType: type, targetName: name }
    })
  }

  console.log(JSON.stringify({ file: snapshot, pattern: nameArg, count: hits.length, hits }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
