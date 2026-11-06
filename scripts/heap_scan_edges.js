'use strict'

// Scan all edges once and report, per pattern, how many edges match and a
// histogram of the target values. Useful for profiling micro-app state in a heap.
// Usage: node heap_scan_edges.js <snapshot> <pattern1> [pattern2] ...

const fs = require('fs')
const [snapshotPath, ...patterns] = process.argv.slice(2)
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !patterns.length) throw new Error('Usage: node heap_scan_edges.js <snapshot> <pattern1> [pattern2] ...')

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

async function readNodeIndex (strings) {
  let capacity = 12000000
  let types = new Uint8Array(capacity)
  let names = new Uint32Array(capacity)
  let ids = new Float64Array(capacity)
  let sizes = new Uint32Array(capacity)
  let edgeCounts = new Uint32Array(capacity)
  let field = 0, value = 0, hasValue = false, ordinal = 0
  const tuple = new Array(6)
  const grow = () => {
    capacity *= 2
    const copy = (Ctor, old) => { const next = new Ctor(capacity); next.set(old); return next }
    types = copy(Uint8Array, types); names = copy(Uint32Array, names)
    ids = copy(Float64Array, ids); sizes = copy(Uint32Array, sizes); edgeCounts = copy(Uint32Array, edgeCounts)
  }
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    if (ordinal === capacity) grow()
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]; ids[ordinal] = tuple[2]
    sizes[ordinal] = tuple[3]; edgeCounts[ordinal] = tuple[4]
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
  return { nodeCount: ordinal, types, names, ids, sizes, edgeCounts }
}

const shortName = (strings, index, ordinal) => {
  const value = strings[index.names[ordinal]] || ''
  return value.length > 90 ? `${value.slice(0, 90)}…[${value.length}]` : value
}

async function main () {
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\n`)
  const index = await readNodeIndex(strings)
  process.stderr.write(`nodes=${index.nodeCount}\n`)

  const stat = new Map(patterns.map((p) => [p, { matched: 0, fromTypes: new Map(), targets: new Map(), bigTargets: [] }]))

  let field = 0, value = 0, hasValue = false, source = 0, remaining = index.edgeCounts[0]
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const edgeName = type === 4 && nameOrIndex === 0 ? '<dummy>' : (type === 1 ? `${nameOrIndex}` : (strings[nameOrIndex] || ''))
    const target = toOffset / 6
    for (const pattern of patterns) {
      if (!edgeName.includes(pattern)) continue
      const row = stat.get(pattern)
      row.matched++
      const fromType = nodeTypes[index.types[source]]
      row.fromTypes.set(fromType, (row.fromTypes.get(fromType) || 0) + 1)
      const targetName = shortName(strings, index, target)
      row.targets.set(targetName, (row.targets.get(targetName) || 0) + 1)
      if (index.sizes[target] >= 1024 * 1024) {
        row.bigTargets.push({ source, fromType, edgeType: edgeTypes[type], edgeName, target, targetType: nodeTypes[index.types[target]], targetSize: index.sizes[target] })
      }
    }
    if (--remaining === 0) {
      do { source++; remaining = index.edgeCounts[source] } while (source < index.nodeCount && remaining === 0)
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

  const out = {}
  for (const [pattern, row] of stat) {
    out[pattern] = {
      matched: row.matched,
      fromTypes: Object.fromEntries([...row.fromTypes].sort((a, b) => b[1] - a[1])),
      topTargets: [...row.targets].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
      distinctTargets: row.targets.size,
      bigTargets: row.bigTargets.slice(0, 30),
    }
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
