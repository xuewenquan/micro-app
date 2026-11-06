'use strict'

// Describe a list of nodes in one pass: type, name, size, and for functions the
// owning Script's source_url (i.e. which bundle the function came from).
// Usage: node heap_describe.js <snapshot> <ordinal> [ordinal2] ...

const fs = require('fs')
const [snapshotPath, ...ordArgs] = process.argv.slice(2)
const targets = new Set(ordArgs.map(Number).filter(Number.isFinite))
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath || !targets.size) throw new Error('Usage: node heap_describe.js <snapshot> <ordinal> [ordinal2] ...')

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

function readNodeCount (snapshotPath) {
  const fd = fs.openSync(snapshotPath, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const match = buf.toString('utf8', 0, read).match(/"node_count":(\d+)/)
  return Number(match[1]) + 1
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
  const N = readNodeCount(snapshotPath)
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

  // collect the outgoing edges of the requested nodes only
  const out = new Map()
  for (const t of targets) out.set(t, [])
  let source = 0
  let remaining = edgeStart[1] - edgeStart[0]
  let f = 0, v = 0, hv = false
  const et = new Array(3)
  let wanted = targets.has(0)
  const consumeEdge = () => {
    if (!hv) return
    et[f++] = v; v = 0; hv = false
    if (f !== 3) return
    f = 0
    if (wanted) out.get(source).push({ type: et[0], name: et[1], target: et[2] / 6 })
    if (--remaining <= 0) {
      do {
        source++
        remaining = source < ordinal ? edgeStart[source + 1] - edgeStart[source] : 0
      } while (source < ordinal && remaining === 0)
      wanted = targets.has(source)
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

  const nameOf = (o) => strings[names[o]] || ''
  const label = (e) => {
    const nm = e.type === 4 && e.name === 0 ? '<dummy>' : e.type === 1 ? `#${e.name}` : (strings[e.name] || '')
    return `${edgeTypes[e.type]}:${nm}`
  }

  const result = []
  for (const t of targets) {
    const entry = {
      ordinal: t,
      type: nodeTypes[types[t]],
      selfSize: sizes[t],
      name: nameOf(t).slice(0, 120),
      props: {},
      propOrdinals: {},
    }
    const walk = (ord, depth) => {
      for (const e of out.get(ord) || []) {
        const labelStr = label(e)
        const key = labelStr.replace(/^internal:/, '')
        if (entry.props[key] === undefined && nameOf(e.target).length < 80) {
          entry.props[key] = nameOf(e.target)
          entry.propOrdinals[key] = e.target
        }
        if (depth < 2 && (key === 'shared' || key === 'script')) walk(e.target, depth + 1)
      }
    }
    walk(t, 0)
    // resolve the owning script URL for functions
    const sfi = (out.get(t) || []).find((e) => e.type === 3 && label(e) === 'internal:shared')
    if (sfi) {
      const script = (out.get(sfi.target) || []).find((e) => e.type === 3 && label(e) === 'internal:script')
      if (script) {
        const src = (out.get(script.target) || []).find((e) => e.type === 3 && label(e) === 'internal:source_url')
        if (src) entry.sourceUrl = nameOf(src.target)
        const sourceText = (out.get(script.target) || []).find((e) => e.type === 3 && label(e) === 'internal:source')
        if (sourceText) entry.scriptSourceHead = nameOf(sourceText.target).slice(0, 90)
      }
    }
    result.push(entry)
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
