'use strict'

// Report DOM nodes by detachedness, grouped by the micro-app that owns them.
// Reads the `detachedness` node field (0=unknown, 1=attached, 2=detached) and joins
// each node to its __MICRO_APP_NAME__ / __MICRO_APP_URL__ / src attribute.
// Usage: node heap_detached_dom.js <snapshot> [limit]

const fs = require('fs')
const [snapshotPath, limitArg] = process.argv.slice(2)
const limit = Number(limitArg) || 40
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath) throw new Error('Usage: node heap_detached_dom.js <snapshot> [limit]')

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

async function readNodes () {
  let capacity = 12000000
  let types = new Uint8Array(capacity)
  let names = new Uint32Array(capacity)
  let sizes = new Uint32Array(capacity)
  let edgeCounts = new Uint32Array(capacity)
  let detachedness = new Uint8Array(capacity)
  let field = 0, value = 0, hasValue = false, ordinal = 0
  const tuple = new Array(6)
  const grow = () => {
    capacity *= 2
    const copy = (Ctor, old) => { const next = new Ctor(capacity); next.set(old); return next }
    types = copy(Uint8Array, types); names = copy(Uint32Array, names)
    sizes = copy(Uint32Array, sizes); edgeCounts = copy(Uint32Array, edgeCounts); detachedness = copy(Uint8Array, detachedness)
  }
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    if (ordinal === capacity) grow()
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]
    sizes[ordinal] = tuple[3]; edgeCounts[ordinal] = tuple[4]; detachedness[ordinal] = tuple[5]
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
  return { nodeCount: ordinal, types, names, sizes, edgeCounts, detachedness }
}

async function main () {
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\n`)
  const nodes = await readNodes()
  process.stderr.write(`nodes=${nodes.nodeCount}\n`)

  const WANTED = new Set(['__MICRO_APP_NAME__', '__MICRO_APP_URL__', 'src'])
  const perNode = new Map() // ordinal -> {name?, url?, src?}
  const detachedStats = { attached: new Map(), detached: new Map(), unknown: new Map() }

  let field = 0, value = 0, hasValue = false, source = 0, remaining = nodes.edgeCounts[0]
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const edgeName = type === 4 && nameOrIndex === 0 ? '<dummy>' : (type === 1 ? `${nameOrIndex}` : (strings[nameOrIndex] || ''))
    if (WANTED.has(edgeName)) {
      const target = toOffset / 6
      const targetValue = strings[nodes.names[target]] || ''
      const entry = perNode.get(source) || {}
      entry[edgeName] = targetValue.length > 70 ? `${targetValue.slice(0, 70)}…` : targetValue
      perNode.set(source, entry)
    }
    if (--remaining === 0) {
      do { source++; remaining = nodes.edgeCounts[source] } while (source < nodes.nodeCount && remaining === 0)
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

  // Aggregate every node that has an app marker, by detachedness.
  const totals = { attached: 0, detached: 0, unknown: 0 }
  const sizeTotals = { attached: 0, detached: 0, unknown: 0 }
  for (const [ordinal, entry] of perNode) {
    const bucket = nodes.detachedness[ordinal] === 2 ? 'detached' : nodes.detachedness[ordinal] === 1 ? 'attached' : 'unknown'
    const key = `${nodeTypes[nodes.types[ordinal]]} ${entry.src ? `src=${entry.src}` : (entry.__MICRO_APP_NAME__ || entry.__MICRO_APP_URL__ || '?')}`
    const map = detachedStats[bucket]
    const row = map.get(key) || { key, count: 0, selfSize: 0, sample: ordinal, ...entry }
    row.count++
    row.selfSize += nodes.sizes[ordinal]
    map.set(key, row)
    totals[bucket]++
    sizeTotals[bucket] += nodes.sizes[ordinal]
  }

  const top = (map) => [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit)
  console.log(JSON.stringify({
    totals,
    sizeTotals,
    detachedTop: top(detachedStats.detached),
    attachedTop: top(detachedStats.attached),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
