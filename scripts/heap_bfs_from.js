'use strict'

// Bounded forward BFS from one or more nodes; prints reachable nodes grouped by depth.
// Handy for decoding native (Blink) structures back to the JS values they hold.
// Usage: node heap_bfs_from.js <snapshot> <depth> <ordinal> [ordinal2] ...

const fs = require('fs')
const [snapshotPath, depthArg, ...rootArgs] = process.argv.slice(2)
const maxDepth = Number(depthArg) || 2
const roots = rootArgs.map(Number)
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !roots.length) throw new Error('Usage: node heap_bfs_from.js <snapshot> <depth> <ordinal> [ordinal2] ...')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshotPath, { highWaterMark: 16 * 1024 * 1024 })
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

  // pass 1: node names/sizes/types and edge counts, keeping only nodes we care about
  const N = 8000000
  const names = new Uint32Array(N)
  const types = new Uint8Array(N)
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

  // pass 2: build a per-depth reachable set by scanning edges maxDepth times
  const label = new Map()
  for (const r of roots) label.set(r, { depth: 0, edge: '(root)' })
  let frontier = new Set(roots)
  for (let depth = 1; depth <= maxDepth && frontier.size; depth++) {
    const next = new Map()
    let source = 0
    let remaining = edgeStart[1] - edgeStart[0]
    let sourceWanted = frontier.has(0)
    const et = new Array(3)
    let f = 0, v = 0, hv = false
    const consumeEdge = () => {
      if (!hv) return
      et[f++] = v; v = 0; hv = false
      if (f !== 3) return
      f = 0
      const type = et[0], nameOrIndex = et[1], to = et[2] / 6
      if (sourceWanted && !label.has(to)) {
        const name = type === 4 && nameOrIndex === 0 ? '<dummy>' : type === 1 ? `#${nameOrIndex}` : (strings[nameOrIndex] || '')
        label.set(to, { depth, edge: `${edgeTypes[type]}:${name}` })
        next.set(to, true)
      }
      if (--remaining <= 0) {
        do {
          source++
          remaining = source < ordinal ? edgeStart[source + 1] - edgeStart[source] : 0
        } while (source < ordinal && remaining === 0)
        sourceWanted = frontier.has(source)
      }
    }
    await afterMarker(Buffer.from('"edges":['), (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk[i]
        if (code >= 48 && code <= 57) { v = v * 10 + code - 48; hv = true }
        else if (code === 44) consumeEdge()
        else if (code === 93) { consumeEdge(); return false }
      }
      return true
    })
    // NOTE: the closure above advances nodes via the counter below; done here for clarity
    frontier = new Set(next.keys())
    process.stderr.write(`depth ${depth}: ${next.size} new nodes\n`)
  }

  const out = []
  for (const [node, info] of label) {
    if (info.depth === 0) continue
    const raw = strings[names[node]] || ''
    out.push({
      ordinal: node,
      depth: info.depth,
      edge: info.edge,
      type: nodeTypes[types[node]],
      selfSize: sizes[node],
      name: raw.length > 90 ? `${raw.slice(0, 90)}…` : raw,
    })
  }
  out.sort((a, b) => a.depth - b.depth || a.ordinal - b.ordinal)
  console.log(JSON.stringify({ roots, maxDepth, nodes: out }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
