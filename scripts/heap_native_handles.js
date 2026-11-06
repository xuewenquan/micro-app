'use strict'

// Find every edge where a native (Blink/C++) node directly holds a JS closure or object,
// and attribute that JS node to its source bundle. These are the "native handle" leaks:
// DOM event listeners, timers and observers that outlive the app.
//
// Usage: node heap_native_handles.js <snapshot> [limit]

const fs = require('fs')
const [snapshotPath, limitArg] = process.argv.slice(2)
const limit = Number(limitArg) || 60
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath) throw new Error('Usage: node heap_native_handles.js <snapshot> [limit]')

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
  const urlCache = new Map()
  const URL_RE = /https?:\/\/[^\s"')]+/
  const scriptUrlOf = (node) => {
    if (urlCache.has(node)) return urlCache.get(node)
    let url = null
    if (types[node] === 5 || types[node] === 4) {
      let sfi = findTarget(node, 'shared')
      if (sfi < 0) sfi = node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        // 1) explicit source_url
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = nameOf(urlNode)
        // 2) host scripts have no source_url; V8 puts the URL in the Script node name
        if (!url) {
          const scriptName = nameOf(scriptNode)
          const m = scriptName.match(URL_RE)
          url = m ? m[0] : (scriptName.includes('system / Script') ? null : scriptName)
        }
        // 3) source map url is a last resort
        if (!url) {
          const mapNode = findTarget(scriptNode, 'source_mapping_url')
          if (mapNode >= 0) url = nameOf(mapNode)
        }
      }
    }
    urlCache.set(node, url)
    return url
  }
  const categorize = (url) => {
    if (!url) return 'unknown(no url)'
    if (url.includes('localhost:3000') || url.includes('127.0.0.1')) return 'BASE(localhost:3000)'
    if (url.includes('wonder10.com')) return 'CHILD(' + ((url.match(/\/\/([^.]+)\./) || [null, '?'])[1]) + ')'
    if (url.includes('/node_modules/') || url.includes('/@fs/') || url.includes('.vite/deps')) return 'BASE(vite/node_modules)'
    return 'other:' + url.slice(0, 40)
  }
  const categoryOf = (srcName, target, url) => {
    const base = categorize(url)
    const kind = srcName.startsWith('V8EventListener') ? 'V8EventListener'
      : srcName.startsWith('blink::') ? 'blink::' + srcName.slice(8, 26)
      : srcName.startsWith('system / JSProxy') ? 'JSProxy'
      : srcName.slice(0, 20)
    return `${kind} + ${base}`
  }
  const categories = new Map()

  // edges: native source -> closure/object target
  const groups = new Map()
  let matched = 0
  for (let node = 0; node < ordinal; node++) {
    if (types[node] !== 8) continue
    const srcName = nameOf(node)
    if (!/^(blink::|V8EventListener|EventListener|EventTarget|system \/ (JSProxy|WeakArrayList))/.test(srcName)) continue
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (edgeType[e] === 6) continue
      const t = edgeTarget[e]
      if (t < 0 || t >= ordinal) continue
      if (types[t] !== 5 && types[t] !== 3) continue
      matched++
      const marked = findTarget(t, '__MICRO_APP_MARK_OPTIONS__') >= 0
      const url = scriptUrlOf(t)
      const cat = categoryOf(srcName, t, url)
      const catRow = categories.get(cat) || { key: cat, count: 0, samples: [] }
      catRow.count++
      if (catRow.samples.length < 6) {
        catRow.samples.push({ ordinal: t, type: nodeTypes[types[t]], name: nameOf(t).slice(0, 34), url: (url || '').replace('http://', '').slice(0, 56), marked })
      }
      categories.set(cat, catRow)

      const key = `${srcName.slice(0, 46)} || ${nodeTypes[types[t]]} || ${cat} || ${(url || 'no url').replace('http://', '').slice(0, 46)}${marked ? ' [marked]' : ' [NOT marked]'}`
      const row = groups.get(key) || { key, count: 0, samples: [] }
      row.count++
      if (row.samples.length < 6) row.samples.push({ ordinal: t, type: nodeTypes[types[t]], name: nameOf(t).slice(0, 38), scriptUrl: url })
      groups.set(key, row)
    }
  }

  console.log(JSON.stringify({
    matchedEdges: matched,
    groupCount: groups.size,
    categories: [...categories.values()].sort((a, b) => b.count - a.count),
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
