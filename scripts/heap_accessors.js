'use strict'

// List every accessor property (get X / set X) in the heap, together with the bundle the
// accessor function came from. This shows where sandbox accessors are installed and on
// which object they live.
//
// Usage: node heap_accessors.js <snapshot> [--filter=substring] [--limit=N]

const fs = require('fs')
const args = process.argv.slice(2)
const snapshotPath = args[0]
const flagMap = new Map(args.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => a.split('=')))
const filter = flagMap.get('--filter') || ''
const limit = Number(flagMap.get('--limit')) || 60
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath) throw new Error('Usage: node heap_accessors.js <snapshot> [--filter=substring] [--limit=N]')

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
  process.stderr.write(`nodes=${ordinal} edges=${edgeTotal}\n`)

  const edgeType = new Uint8Array(edgeTotal)
  const edgeName = new Uint32Array(edgeTotal)
  const edgeTarget = new Int32Array(edgeTotal)
  field = 0; value = 0; hasValue = false
  let edgeOrdinal = 0
  const et = new Array(3)
  const consumeEdge = () => {
    if (!hasValue) return
    et[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    edgeType[edgeOrdinal] = et[0]; edgeName[edgeOrdinal] = et[1]; edgeTarget[edgeOrdinal] = et[2] / 6
    edgeOrdinal++
  }
  await afterMarker(Buffer.from('"edges":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consumeEdge()
      else if (code === 93) { consumeEdge(); return false }
    }
    return true
  })

  const nameOf = (o) => strings[names[o]] || ''
  const edgeNameOf = (e) => {
    const t = edgeType[e], raw = edgeName[e]
    return t === 4 && raw === 0 ? '<dummy>' : t === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const findTarget = (node, wanted) => {
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (edgeType[e] === 3 && edgeNameOf(e) === wanted) return edgeTarget[e]
    }
    return -1
  }
  const URL_RE = /https?:\/\/[^\s"')]+/
  const urlCache = new Map()
  const scriptUrlOf = (node) => {
    if (urlCache.has(node)) return urlCache.get(node)
    let url = null
    if (types[node] === 5 || types[node] === 4) {
      let sfi = findTarget(node, 'shared')
      if (sfi < 0) sfi = node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = nameOf(urlNode)
        if (!url) {
          const m = nameOf(scriptNode).match(URL_RE)
          url = m ? m[0] : null
        }
      }
    }
    urlCache.set(node, url)
    return url
  }

  const rows = []
  let accessorEdges = 0
  for (let node = 0; node < ordinal; node++) {
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (edgeType[e] !== 2) continue
      const nm = edgeNameOf(e)
      if (!/^(get|set) /.test(nm)) continue
      accessorEdges++
      const t = edgeTarget[e]
      const url = scriptUrlOf(t) || ''
      if (filter && !url.includes(filter)) continue
      rows.push({
        hostType: nodeTypes[types[node]],
        hostOrdinal: node,
        hostName: nameOf(node).slice(0, 60),
        accessor: nm,
        accessorOrdinal: t,
        accessorName: nameOf(t).slice(0, 30),
        accessorUrl: url.replace('http://', ''),
      })
    }
  }

  // group by host object, summarising which accessors it carries and from where
  const byHost = new Map()
  for (const r of rows) {
    const key = `${r.hostType} ${r.hostOrdinal} ${r.hostName}`
    const g = byHost.get(key) || { key, hostType: r.hostType, hostOrdinal: r.hostOrdinal, hostName: r.hostName, accessors: [], sources: new Set() }
    g.accessors.push(r.accessor)
    g.accessorOrdinals = g.accessorOrdinals || []
    if (g.accessorOrdinals.length < 30) g.accessorOrdinals.push(`${r.accessor}=${r.accessorOrdinal}`)
    g.sources.add(r.accessorUrl || '(no url)')
    byHost.set(key, g)
  }

  console.log(JSON.stringify({
    accessorEdges,
    matched: rows.length,
    filter,
    hostCount: byHost.size,
    hosts: [...byHost.values()].sort((a, b) => b.accessors.length - a.accessors.length).slice(0, limit)
      .map((g) => ({ ...g, accessors: [...new Set(g.accessors)].slice(0, 22), sources: [...g.sources].slice(0, 6) })),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
