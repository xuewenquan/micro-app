'use strict'

// Aggregate heap nodes by (type, name) for non-string types and print the top rows.
// Usage: node heap_symbol_summary.js <snapshot> [limit] [nameFilter]

const fs = require('fs')
const [snapshotPath, limitArg, filter] = process.argv.slice(2)
const limit = Number(limitArg) || 60
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const skipTypes = new Set([2, 10, 11]) // string variants carry huge source text; skip them

if (!snapshotPath) throw new Error('Usage: node heap_symbol_summary.js <snapshot> [limit] [nameFilter]')

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
  const rows = new Map()
  const bigNodes = []
  let field = 0, value = 0, hasValue = false, ordinal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    const typeId = tuple[0]
    const selfSize = tuple[3]
    if (!skipTypes.has(typeId)) {
      let name = strings[tuple[1]] || ''
      if (name.length > 70) name = `${name.slice(0, 70)}…`
      const key = `${nodeTypes[typeId]} ${name}`
      const row = rows.get(key) || { type: nodeTypes[typeId], name, count: 0, selfSize: 0, sample: ordinal }
      row.count++
      row.selfSize += selfSize
      rows.set(key, row)
    }
    if (selfSize >= 256 * 1024 && typeId !== 8) {
      bigNodes.push({ ordinal, type: nodeTypes[typeId], selfSize, name: (strings[tuple[1]] || '').slice(0, 90), nameLength: (strings[tuple[1]] || '').length })
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

  let list = [...rows.values()]
  if (filter) list = list.filter((row) => row.name.includes(filter) || row.type.includes(filter))
  console.log(JSON.stringify({
    nodeCount: ordinal,
    byCount: [...list].sort((a, b) => b.count - a.count).slice(0, limit),
    bySelfSize: [...list].sort((a, b) => b.selfSize - a.selfSize).slice(0, limit),
    biggestNodes: bigNodes.sort((a, b) => b.selfSize - a.selfSize).slice(0, 20),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
