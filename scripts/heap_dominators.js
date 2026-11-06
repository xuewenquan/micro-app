'use strict'

// Compute the dominator tree of a V8 heap snapshot graph and report nodes by
// retained size (the memory that would be freed if the node were removed).
// Weak edges are ignored: they do not keep objects alive.
//
// Usage: node heap_dominators.js <snapshot> [topN] [--path=ordinal]

const fs = require('fs')
const args = process.argv.slice(2)
const snapshotPath = args[0]
const topN = Number(args[1]) || 40
const pathTargets = args.filter((a) => a.startsWith('--path=')).map((a) => Number(a.slice('--path='.length))).filter(Number.isFinite)
const childrenArgRaw = args.find((a) => a.startsWith('--children='))
const childrenArg = childrenArgRaw ? Number(childrenArgRaw.slice('--children='.length)) : null
const depthArg = args.find((a) => a.startsWith('--depth='))
const childrenDepth = depthArg ? Number(depthArg.slice('--depth='.length)) : 5
const capArg = args.find((a) => a.startsWith('--childCap='))
const childCap = capArg ? Number(capArg.slice('--childCap='.length)) : 6
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

if (!snapshotPath) throw new Error('Usage: node heap_dominators.js <snapshot> [topN] [--path=ordinal]')

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

// Read node_count from the snapshot header so the index arrays are always big enough.
function readNodeCount (snapshotPath) {
  const fd = fs.openSync(snapshotPath, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const match = buf.toString('utf8', 0, read).match(/"node_count":(\d+)/)
  if (!match) throw new Error('node_count not found in snapshot header')
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

async function readGraph () {
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
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]
    sizes[ordinal] = tuple[3]
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
  const edgeTarget = new Int32Array(edgeTotal)
  const edgeName = new Uint32Array(edgeTotal)
  field = 0; value = 0; hasValue = false
  let edgeOrdinal = 0
  const et = new Array(3)
  const consumeEdge = () => {
    if (!hasValue) return
    et[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    edgeType[edgeOrdinal] = et[0]
    edgeName[edgeOrdinal] = et[1]
    edgeTarget[edgeOrdinal] = et[2] / 6
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeTarget, edgeName }
}

function computeDominators (g) {
  const n = g.nodeCount
  const { edgeStart, edgeType, edgeTarget } = g

  // 1. DFS from root; record postorder.
  const postNum = new Int32Array(n).fill(-1)
  const order = new Int32Array(n) // reverse postorder
  const stack = new Int32Array(n)
  const iter = new Int32Array(n)
  const visited = new Uint8Array(n)
  let orderCount = 0
  let sp = 0
  stack[sp] = 0
  iter[0] = edgeStart[0]
  visited[0] = 1
  while (sp >= 0) {
    const node = stack[sp]
    const end = edgeStart[node + 1]
    let e = iter[sp]
    let advanced = false
    while (e < end) {
      const t = edgeTarget[e]
      const skip = edgeType[e] === 6
      e++
      if (skip || visited[t] || t >= n) continue
      visited[t] = 1
      iter[sp] = e
      sp++
      stack[sp] = t
      iter[sp] = edgeStart[t]
      advanced = true
      break
    }
    if (!advanced) {
      iter[sp] = e
      order[orderCount++] = node // postorder position appended in reverse later
      sp--
    }
  }
  // order currently holds postorder (roots last); reverse it for RPO
  for (let i = 0, j = orderCount - 1; i < j; i++, j--) {
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp
  }
  // postorder number
  const rpo = new Int32Array(orderCount)
  for (let i = 0; i < orderCount; i++) {
    const node = order[i]
    rpo[i] = node
    postNum[node] = orderCount - 1 - i
  }
  process.stderr.write(`reachable=${orderCount}/${n}\n`)

  // 2. predecessor CSR over non-weak edges among reachable nodes
  const indeg = new Int32Array(n)
  for (let node = 0; node < n; node++) {
    const end = edgeStart[node + 1]
    for (let e = edgeStart[node]; e < end; e++) {
      if (edgeType[e] === 6) continue
      const t = edgeTarget[e]
      if (t >= n || postNum[t] === -1) continue
      indeg[t]++
    }
  }
  const predStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) predStart[i + 1] = predStart[i] + indeg[i]
  const predTotal = predStart[n]
  const predNode = new Int32Array(predTotal)
  const predEdge = new Int32Array(predTotal)
  const fill = new Int32Array(n)
  for (let node = 0; node < n; node++) {
    const end = edgeStart[node + 1]
    for (let e = edgeStart[node]; e < end; e++) {
      if (edgeType[e] === 6) continue
      const t = edgeTarget[e]
      if (t >= n || postNum[t] === -1) continue
      const at = predStart[t] + fill[t]++
      predNode[at] = node
      predEdge[at] = e
    }
  }
  process.stderr.write(`preds=${predTotal}\n`)

  // 3. iterative dominators (Cooper-Harvey-Kennedy)
  const idom = new Int32Array(n).fill(-1)
  const idomEdge = new Int32Array(n).fill(-1) // edge from idom -> node
  idom[0] = 0
  const intersect = (a, b) => {
    let x = a, y = b
    while (x !== y) {
      while (postNum[x] < postNum[y]) x = idom[x]
      while (postNum[y] < postNum[x]) y = idom[y]
    }
    return x
  }
  let changed = true
  let rounds = 0
  while (changed) {
    changed = false
    rounds++
    let changesThisRound = 0
    for (let i = 1; i < orderCount; i++) {
      const node = rpo[i]
      let newIdom = -1
      let newIdomEdge = -1
      const s = predStart[node]
      const e = predStart[node + 1]
      for (let p = s; p < e; p++) {
        const pred = predNode[p]
        if (idom[pred] === -1) continue
        if (newIdom === -1) {
          newIdom = pred
          newIdomEdge = predEdge[p]
        } else {
          newIdom = intersect(pred, newIdom)
          if (newIdom === pred) newIdomEdge = predEdge[p]
        }
      }
      if (newIdom !== -1 && idom[node] !== newIdom) {
        idom[node] = newIdom
        idomEdge[node] = newIdomEdge
        changed = true
        changesThisRound++
      }
    }
    process.stderr.write(`dominator round ${rounds}: ${changesThisRound} changes\n`)
    if (rounds > 400) {
      process.stderr.write('WARNING: dominators did not converge\n')
      break
    }
  }

  // 4. retained sizes: children of the dominator tree, summed bottom-up
  const childCount = new Int32Array(n)
  for (let node = 1; node < n; node++) {
    if (idom[node] !== -1 && idom[node] !== node) childCount[idom[node]]++
  }
  const childStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) childStart[i + 1] = childStart[i] + childCount[i]
  const childList = new Int32Array(childStart[n])
  const childFill = new Int32Array(n)
  for (let node = 1; node < n; node++) {
    const d = idom[node]
    if (d !== -1 && d !== node) childList[childStart[d] + childFill[d]++] = node
  }
  const retained = new Float64Array(n)
  for (let i = 0; i < n; i++) retained[i] = g.sizes[i]
  // process nodes in reverse BFS/postorder-ish: children always have larger postNum? Not guaranteed;
  // use the DFS postorder (order array reversed = postorder of DFS), which guarantees children before parents.
  for (let i = 0; i < orderCount; i++) {
    const node = rpo[orderCount - 1 - i] // postorder
    const d = idom[node]
    if (d !== -1 && d !== node) retained[d] += retained[node]
  }
  return { idom, idomEdge, retained, postNum, reachableCount: orderCount, childStart, childList, rounds }
}

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\nreading graph…\n`)
  const g = await readGraph()
  const dom = computeDominators(g)

  const describe = (ordinal) => {
    const value = strings[g.names[ordinal]] || ''
    return {
      ordinal,
      type: nodeTypes[g.types[ordinal]],
      selfSize: g.sizes[ordinal],
      name: value.length > 110 ? `${value.slice(0, 110)}…[${value.length}]` : value,
    }
  }
  const edgeLabel = (e) => {
    const type = g.edgeType[e]
    const raw = g.edgeName[e]
    const name = type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
    return `${edgeTypes[type]}:${name}`
  }

  const result = { nodeCount: g.nodeCount, reachable: dom.reachableCount, dominatorRounds: dom.rounds }

  if (childrenArg) {
    // Walk down the dominator tree from a node, showing what dominates the memory below it.
    const walk = (ordinal, depth, maxDepth) => {
      const out = { ...describe(ordinal), retainedSize: Math.round(dom.retained[ordinal]), children: [] }
      if (depth >= maxDepth) return out
      const kids = []
      for (let i = dom.childStart[ordinal]; i < dom.childStart[ordinal + 1]; i++) kids.push(dom.childList[i])
      kids.sort((a, b) => dom.retained[b] - dom.retained[a])
      out.children = kids.slice(0, childCap).map((k) => walk(k, depth + 1, maxDepth))
      if (kids.length > childCap) out.childrenTruncatedFrom = kids.length
      return out
    }
    result.children = walk(childrenArg, 0, childrenDepth)
  }

  // Outgoing-edge lookup over the loaded graph, used to attribute a function to its bundle.
  const outEdges = (node) => {
    const list = []
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) list.push(e)
    return list
  }
  const edgeNameOf = (e) => {
    const type = g.edgeType[e], raw = g.edgeName[e]
    return type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const findTarget = (node, wanted) => {
    for (const e of outEdges(node)) {
      if (g.edgeType[e] === 3 && edgeNameOf(e) === wanted) return g.edgeTarget[e]
    }
    return -1
  }
  const scriptUrlCache = new Map()
  const scriptUrlOf = (node) => {
    if (scriptUrlCache.has(node)) return scriptUrlCache.get(node)
    let url = null
    if (g.types[node] === 5 || g.types[node] === 4) { // closure or code
      const sfi = findTarget(node, 'shared') !== -1 ? findTarget(node, 'shared') : node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = strings[g.names[urlNode]] || null
      }
    }
    scriptUrlCache.set(node, url)
    return url
  }

  if (pathTargets.length) {
    result.paths = pathTargets.map((pathTarget) => {
      const path = []
      let current = pathTarget
      let guard = 0
      while (current !== 0 && guard++ < 400) {
        const d = dom.idom[current]
        if (d === -1 || d === current) break
        path.push({
          from: { ...describe(d), scriptUrl: scriptUrlOf(d) },
          edge: edgeLabel(dom.idomEdge[current]),
          to: { ...describe(current), scriptUrl: scriptUrlOf(current) },
          retained: dom.retained[current],
        })
        current = d
      }
      path.reverse()
      return { target: describe(pathTarget), retainedSize: dom.retained[pathTarget], chain: path }
    })
  }

  // top nodes by retained size (skip trivial containers)
  const all = []
  for (let i = 1; i < g.nodeCount; i++) {
    if (dom.idom[i] === -1) continue
    all.push(i)
  }
  all.sort((a, b) => dom.retained[b] - dom.retained[a])
  result.topByRetained = all.slice(0, topN).map((ordinal) => ({
    ...describe(ordinal),
    retainedSize: Math.round(dom.retained[ordinal]),
    idom: describe(dom.idom[ordinal] === -1 ? 0 : dom.idom[ordinal]),
  }))
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
