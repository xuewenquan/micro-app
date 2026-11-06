'use strict'

// List the largest nodes in a V8 .heapsnapshot, optionally filtered by a name pattern.
// Usage: node heap_find_large_nodes.js <snapshot> [minSelfSize] [namePattern] [limit]
//   - minSelfSize: bytes (default 1048576)
//   - namePattern: plain substring match (default none)

const fs = require('fs')
const [snapshotPath, minArg, pattern, limitArg] = process.argv.slice(2)
const minSelfSize = Number(minArg) || 1024 * 1024
const limit = Number(limitArg) || 200
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']

if (!snapshotPath) throw new Error('Usage: node heap_find_large_nodes.js <snapshot> [minSelfSize] [namePattern] [limit]')

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
  const found = []
  let field = 0, value = 0, hasValue = false, ordinal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    const selfSize = tuple[3]
    if (selfSize >= minSelfSize) {
      const name = strings[tuple[1]] || ''
      if (!pattern || name.includes(pattern)) {
        found.push({
          ordinal,
          type: nodeTypes[tuple[0]],
          typeId: tuple[0],
          selfSize,
          nameLength: name.length,
          head: name.slice(0, 160),
        })
      }
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
  found.sort((a, b) => b.selfSize - a.selfSize)
  console.log(JSON.stringify({
    nodeCount: ordinal,
    minSelfSize,
    pattern: pattern || null,
    matched: found.length,
    nodes: found.slice(0, limit),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
