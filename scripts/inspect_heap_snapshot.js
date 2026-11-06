'use strict'

const fs = require('fs')
const snapshotPath = process.argv[2]
const mode = process.argv[3] || 'scripts'
const argument = process.argv[4]
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath) throw new Error('Usage: node inspect_heap_snapshot.js <snapshot> [scripts|find|root-path] [argument]')

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
        else if (char === '"') {
          strings.push(JSON.parse(token)); token = ''; inString = false
        }
      }
    }
    return true
  })
  return strings
}

async function readNodeIndex (strings, pattern) {
  let capacity = 12000000
  let types = new Uint8Array(capacity)
  let names = new Uint32Array(capacity)
  let ids = new Float64Array(capacity)
  let sizes = new Uint32Array(capacity)
  let edgeCounts = new Uint32Array(capacity)
  const targets = []
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
    if (pattern && (strings[tuple[1]] || '').includes(pattern)) targets.push(ordinal)
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
  return { nodeCount: ordinal, types, names, ids, sizes, edgeCounts, targets }
}

function describe (index, strings, ordinal) {
  const value = strings[index.names[ordinal]] || ''
  return { ordinal, id: index.ids[ordinal], type: nodeTypes[index.types[ordinal]], selfSize: index.sizes[ordinal], name: value.length > 180 ? `${value.slice(0, 180)}...[${value.length} chars]` : value }
}

async function incoming (index, strings, targetSet, skipConsole) {
  const result = []
  let field = 0, value = 0, hasValue = false, source = 0, remaining = index.edgeCounts[0]
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const target = toOffset / 6
    const sourceName = strings[index.names[source]] || ''
    const isDevTools = skipConsole && (
      (index.types[source] === 9 && (strings[nameOrIndex] || '').includes('DevTools console')) ||
      sourceName.includes('InspectorDOMAgent') ||
      sourceName.includes('DevToolsSession')
    )
    if (type !== 6 && !isDevTools && targetSet.has(target)) result.push({ source, target, type, nameOrIndex })
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
  return result
}

async function outgoing (index, strings, wantedSource) {
  const result = []
  let field = 0, value = 0, hasValue = false, source = 0, remaining = index.edgeCounts[0]
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    if (source === wantedSource) result.push({ edge: `${edgeTypes[type]}:${type === 1 ? nameOrIndex : (strings[nameOrIndex] || nameOrIndex)}`, to: describe(index, strings, toOffset / 6) })
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
  return result
}

async function outgoingMany (index, strings, wantedSources, wantedProperties) {
  const result = new Map(Array.from(wantedSources, (source) => [source, []]))
  let field = 0, value = 0, hasValue = false, source = 0, remaining = index.edgeCounts[0]
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const propertyName = type === 1 ? String(nameOrIndex) : (strings[nameOrIndex] || String(nameOrIndex))
    if (result.has(source) && (!wantedProperties || wantedProperties.has(propertyName))) {
      result.get(source).push({ edge: `${edgeTypes[type]}:${propertyName}`, to: describe(index, strings, toOffset / 6) })
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
  return result
}

async function rootPath (strings, ordinal, maxDepth = 12, skipConsole = true) {
  const index = await readNodeIndex(strings)
  let frontier = new Set([ordinal])
  const seen = new Set(frontier)
  const towardTarget = new Map()
  let root = null
  for (let depth = 1; depth <= maxDepth && frontier.size; depth++) {
    const edges = await incoming(index, strings, frontier, skipConsole)
    const next = new Set()
    for (const edge of edges) {
      if (seen.has(edge.source)) continue
      seen.add(edge.source); towardTarget.set(edge.source, edge); next.add(edge.source)
      if (index.types[edge.source] === 9) { root = edge.source; break }
    }
    process.stderr.write(`depth ${depth}: ${edges.length} incoming, ${next.size} new${root === null ? '' : `, root=${root}`}\n`)
    if (root !== null || next.size > 500000) break
    frontier = next
  }
  const path = []
  if (root !== null) {
    let current = root
    while (current !== ordinal) {
      const edge = towardTarget.get(current)
      if (!edge) break
      path.push({ from: describe(index, strings, edge.source), edge: `${edgeTypes[edge.type]}:${edge.type === 1 ? edge.nameOrIndex : (strings[edge.nameOrIndex] || edge.nameOrIndex)}`, to: describe(index, strings, edge.target) })
      current = edge.target
    }
  }
  return { target: describe(index, strings, ordinal), root: root === null ? null : describe(index, strings, root), path }
}

async function main () {
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\n`)
  if (mode === 'scripts') {
    const scripts = strings.filter((value) => value.length >= 100000).map((value) => ({
      length: value.length,
      chunks: Array.from(new Set(value.match(/webpackChunk[\w$-]+/g) || [])).slice(0, 8),
      sourceUrls: Array.from(value.matchAll(/\/\/# sourceURL=(https?:\/\/[^\n]+)/g), (match) => match[1]).slice(-5),
      head: value.slice(0, 90),
    })).sort((a, b) => b.length - a.length)
    console.log(JSON.stringify({ count: scripts.length, totalCharacters: scripts.reduce((sum, item) => sum + item.length, 0), scripts }, null, 2))
  } else if (mode === 'find') {
    const index = await readNodeIndex(strings, argument)
    console.log(JSON.stringify(index.targets.map((ordinal) => describe(index, strings, ordinal)), null, 2))
  } else if (mode === 'root-path') {
    console.log(JSON.stringify(await rootPath(strings, Number(argument), Number(process.argv[5]) || 12), null, 2))
  } else if (mode === 'root-path-all') {
    console.log(JSON.stringify(await rootPath(strings, Number(argument), Number(process.argv[5]) || 12, false), null, 2))
  } else if (mode === 'incoming') {
    const index = await readNodeIndex(strings)
    const edges = await incoming(index, strings, new Set([Number(argument)]), false)
    console.log(JSON.stringify(edges.map((edge) => ({
      from: describe(index, strings, edge.source),
      edge: `${edgeTypes[edge.type]}:${edge.type === 1 ? edge.nameOrIndex : (strings[edge.nameOrIndex] || edge.nameOrIndex)}`,
      to: describe(index, strings, edge.target),
    })), null, 2))
  } else if (mode === 'outgoing') {
    const index = await readNodeIndex(strings)
    const ordinal = Number(argument)
    console.log(JSON.stringify({ source: describe(index, strings, ordinal), edges: await outgoing(index, strings, ordinal) }, null, 2))
  } else if (mode === 'outgoing-match') {
    const index = await readNodeIndex(strings)
    const ordinal = Number(argument)
    const pattern = new RegExp(process.argv[5], 'i')
    const edges = (await outgoing(index, strings, ordinal)).filter((item) => (
      pattern.test(item.edge) || pattern.test(item.to.name)
    ))
    console.log(JSON.stringify({ source: describe(index, strings, ordinal), edges }, null, 2))
  } else if (mode === 'top-self') {
    const index = await readNodeIndex(strings)
    const limit = Number(argument) || 50
    const ordinals = Array.from({ length: index.nodeCount }, (_, ordinal) => ordinal)
      .sort((a, b) => index.sizes[b] - index.sizes[a])
      .slice(0, limit)
    console.log(JSON.stringify(ordinals.map((ordinal) => describe(index, strings, ordinal)), null, 2))
  } else if (mode === 'type-summary') {
    const index = await readNodeIndex(strings)
    const rows = new Map()
    for (let ordinal = 0; ordinal < index.nodeCount; ordinal++) {
      const type = nodeTypes[index.types[ordinal]]
      const row = rows.get(type) || { type, count: 0, selfSize: 0 }
      row.count++
      row.selfSize += index.sizes[ordinal]
      rows.set(type, row)
    }
    console.log(JSON.stringify({
      nodeCount: index.nodeCount,
      types: Array.from(rows.values()).sort((a, b) => b.selfSize - a.selfSize),
    }, null, 2))
  } else if (mode === 'name-summary') {
    const index = await readNodeIndex(strings)
    const rows = new Map()
    for (let ordinal = 0; ordinal < index.nodeCount; ordinal++) {
      const name = strings[index.names[ordinal]] || ''
      const key = `${nodeTypes[index.types[ordinal]]}:${name}`
      const row = rows.get(key) || { type: nodeTypes[index.types[ordinal]], name, count: 0, selfSize: 0 }
      row.count++
      row.selfSize += index.sizes[ordinal]
      rows.set(key, row)
    }
    const limit = Number(argument) || 50
    console.log(JSON.stringify({
      nodeCount: index.nodeCount,
      byCount: Array.from(rows.values()).sort((a, b) => b.count - a.count).slice(0, limit),
      bySelfSize: Array.from(rows.values()).sort((a, b) => b.selfSize - a.selfSize).slice(0, limit),
    }, null, 2))
  } else if (mode === 'sandbox-status' || mode === 'sandbox-summary') {
    const index = await readNodeIndex(strings, 'WithSandBox')
    const ordinals = index.targets.filter((ordinal) => index.types[ordinal] === 3 && strings[index.names[ordinal]] === 'WithSandBox')
    const properties = new Set(['appName', 'active', 'destroyed', 'proxyWindow', 'microAppWindow', 'clearHijackUmdHooks'])
    const edges = await outgoingMany(index, strings, new Set(ordinals), properties)
    const rows = ordinals.map((ordinal) => ({
      sandbox: describe(index, strings, ordinal),
      properties: edges.get(ordinal),
    }))
    if (mode === 'sandbox-summary') {
      const summaries = rows.map((row) => Object.fromEntries([
        ['ordinal', row.sandbox.ordinal],
        ...row.properties.map((item) => [item.edge.slice('property:'.length), item.to.name]),
      ]))
      console.log(JSON.stringify({
        count: summaries.length,
        destroyed: summaries.filter((item) => item.destroyed === 'true').length,
        active: summaries.filter((item) => item.active === 'true').length,
        apps: summaries.map((item) => ({ ordinal: item.ordinal, appName: item.appName, destroyed: item.destroyed, active: item.active })),
      }, null, 2))
    } else {
      console.log(JSON.stringify(rows, null, 2))
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
