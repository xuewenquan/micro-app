'use strict'

/**
 * 支配树分区：把整份堆按「(GC roots) 的直接支配子节点」切成若干块，按 retained size 排序，
 * 每块再给出其支配子树里最大的几个后代。
 *
 * 这是回答“内存到底被谁占住”的最直接口径：支配者（idom）回答“谁在上游”，
 * retained size 回答“砍掉它能释放多少”。
 *
 * 用法：
 *   node --max-old-space-size=16384 scripts/heap_partition.js <snapshot> [--top=25] [--depth=3]
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

function parseArgs (argv) {
  const out = { snapshot: null, top: 25, depth: 3, blockEdge: [], blockNative: [] }
  for (const arg of argv) {
    if (arg.startsWith('--top=')) out.top = Number(arg.slice(6))
    else if (arg.startsWith('--depth=')) out.depth = Number(arg.slice(8))
    else if (arg.startsWith('--blockEdge=')) out.blockEdge.push(arg.slice(12))
    else if (arg.startsWith('--blockNativeName=')) out.blockNative.push(arg.slice(18))
    else if (!arg.startsWith('--')) out.snapshot = arg
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.snapshot) throw new Error('用法: node scripts/heap_partition.js <snapshot> [--top=25] [--depth=3]')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(opts.snapshot, { highWaterMark: 16 * 1024 * 1024 })
  let tail = Buffer.alloc(0)
  let found = false
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) { tail = data.subarray(Math.max(0, data.length - marker.length + 1)); continue }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }
  if (!found) throw new Error('Marker not found')
}

function readNodeCount () {
  const fd = fs.openSync(opts.snapshot, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const match = buf.toString('utf8', 0, read).match(/"node_count":(\d+)/)
  if (!match) throw new Error('node_count not found')
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
  const N = readNodeCount()
  const types = new Uint8Array(N)
  const names = new Uint32Array(N)
  const sizes = new Uint32Array(N)
  const detachedness = new Uint8Array(N)
  const edgeStart = new Int32Array(N + 1)
  let field = 0, value = 0, hasValue = false, ordinal = 0, edgeTotal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]; sizes[ordinal] = tuple[3]; detachedness[ordinal] = tuple[5]
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
  return { nodeCount: ordinal, types, names, sizes, detachedness, edgeStart, edgeType, edgeTarget, edgeName }
}

function computeDominators (g, strings) {
  const n = g.nodeCount
  const { edgeStart, edgeType, edgeTarget } = g
  const blockEdgeMatch = (e) => {
    if (edgeType[e] === 6) return true
    if (!opts.blockEdge.length) return false
    const type = edgeType[e], raw = g.edgeName[e]
    const name = type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
    return opts.blockEdge.some((s) => name.indexOf(s) >= 0)
  }
  const blockNode = new Uint8Array(n)
  if (opts.blockNative.length) {
    for (let i = 0; i < n; i++) {
      const name = strings[g.names[i]] || ''
      if (opts.blockNative.some((s) => name.indexOf(s) >= 0)) blockNode[i] = 1
    }
  }
  const skipEdge = (e) => blockEdgeMatch(e) || blockNode[edgeTarget[e]] === 1

  const postNum = new Int32Array(n).fill(-1)
  const order = new Int32Array(n)
  const stack = new Int32Array(n)
  const iter = new Int32Array(n)
  const visited = new Uint8Array(n)
  let orderCount = 0, sp = 0
  stack[sp] = 0; iter[0] = edgeStart[0]; visited[0] = 1
  while (sp >= 0) {
    const node = stack[sp]
    const end = edgeStart[node + 1]
    let e = iter[sp]
    let advanced = false
    while (e < end) {
      const t = edgeTarget[e]
      const skip = skipEdge(e)
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
    if (!advanced) { iter[sp] = e; order[orderCount++] = node; sp-- }
  }
  for (let i = 0, j = orderCount - 1; i < j; i++, j--) { const t = order[i]; order[i] = order[j]; order[j] = t }
  const rpo = order
  for (let i = 0; i < orderCount; i++) postNum[rpo[i]] = orderCount - 1 - i
  process.stderr.write(`reachable=${orderCount}/${n}\n`)

  const indeg = new Int32Array(n)
  for (let node = 0; node < n; node++) {
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (skipEdge(e)) continue
      const t = edgeTarget[e]
      if (t >= n || postNum[t] === -1) continue
      indeg[t]++
    }
  }
  const predStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) predStart[i + 1] = predStart[i] + indeg[i]
  const predTotal = predStart[n]
  const predNode = new Int32Array(predTotal)
  const fill = new Int32Array(n)
  for (let node = 0; node < n; node++) {
    for (let e = edgeStart[node]; e < edgeStart[node + 1]; e++) {
      if (skipEdge(e)) continue
      const t = edgeTarget[e]
      if (t >= n || postNum[t] === -1) continue
      predNode[predStart[t] + fill[t]++] = node
    }
  }
  process.stderr.write(`preds=${predTotal}\n`)

  const idom = new Int32Array(n).fill(-1)
  const idomEdge = new Int32Array(n).fill(-1)
  idom[0] = 0
  const intersect = (a, b) => {
    let x = a, y = b
    while (x !== y) {
      while (postNum[x] < postNum[y]) x = idom[x]
      while (postNum[y] < postNum[x]) y = idom[y]
    }
    return x
  }
  let changed = true, rounds = 0
  while (changed) {
    changed = false; rounds++
    let changes = 0
    for (let i = 1; i < orderCount; i++) {
      const node = rpo[i]
      let newIdom = -1, newIdomEdge = -1
      for (let p = predStart[node]; p < predStart[node + 1]; p++) {
        const pred = predNode[p]
        if (idom[pred] === -1) continue
        if (newIdom === -1) { newIdom = pred } else { newIdom = intersect(pred, newIdom) }
      }
      if (newIdom !== -1 && idom[node] !== newIdom) { idom[node] = newIdom; changed = true; changes++ }
    }
    process.stderr.write(`dominator round ${rounds}: ${changes} changes\n`)
    if (rounds > 400) { process.stderr.write('WARNING: not converged\n'); break }
  }

  const childCount = new Int32Array(n)
  for (let node = 1; node < n; node++) if (idom[node] !== -1 && idom[node] !== node) childCount[idom[node]]++
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
  for (let i = 0; i < orderCount; i++) {
    const node = rpo[orderCount - 1 - i]
    const d = idom[node]
    if (d !== -1 && d !== node) retained[d] += retained[node]
  }
  return { idom, idomEdge, retained, childStart, childList, reachableCount: orderCount, rounds }
}

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\nreading graph…\n`)
  const g = await readGraph()
  const dom = computeDominators(g, strings)
  const mb = (b) => +(b / 1048576).toFixed(2)

  const describe = (o) => {
    const raw = strings[g.names[o]] || ''
    return {
      ordinal: o,
      type: nodeTypes[g.types[o]],
      selfSize: g.sizes[o],
      retainedMB: mb(dom.retained[o]),
      name: raw.length > 130 ? `${raw.slice(0, 130)}…[${raw.length}]` : raw,
    }
  }

  // 归属脚本：把函数/闭包/代码节点解析到它的 source_url
  const edgeNameOf = (e) => {
    const type = g.edgeType[e], raw = g.edgeName[e]
    return type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')
  }
  const findTarget = (node, wanted) => {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
      if (g.edgeType[e] === 3 && edgeNameOf(e) === wanted) return g.edgeTarget[e]
    }
    return -1
  }
  const urlCache = new Map()
  const scriptUrlOf = (node) => {
    if (urlCache.has(node)) return urlCache.get(node)
    let url = null
    const type = g.types[node]
    if (type === 3 || type === 4 || type === 5) {
      let sfi = findTarget(node, 'shared')
      if (sfi < 0) sfi = node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = strings[g.names[urlNode]] || null
      }
    }
    urlCache.set(node, url)
    return url
  }

  const candidates = []
  for (let i = 1; i < g.nodeCount; i++) {
    if (dom.idom[i] === -1) continue
    if (dom.retained[i] < 256 * 1024) continue
    candidates.push(i)
  }
  candidates.sort((a, b) => dom.retained[b] - dom.retained[a])

  // 游离 DOM（detachedness=2）的「顶层支配者」集合：
  // 只有 idom 不再是游离 DOM 的那些，才是把整簇游离子树钉住的入口。
  // 它们的 retained 之和 = 删掉这簇游离 DOM 后理论上能释放的上界。
  let detachedNodes = 0
  let detachedSelfBytes = 0
  let detachedTopRetained = 0
  let detachedTopCount = 0
  const detachedTop = []
  if (typeof g.detachedness !== 'undefined') {
    for (let i = 1; i < g.nodeCount; i++) {
      if (g.detachedness[i] !== 2) continue
      if (dom.idom[i] === -1) continue
      detachedNodes++
      detachedSelfBytes += g.sizes[i]
      const d = dom.idom[i]
      const parentDetached = d > 0 && g.detachedness[d] === 2
      if (parentDetached) continue
      detachedTopCount++
      detachedTopRetained += dom.retained[i]
      if (detachedTop.length < 25) detachedTop.push(describe(i))
    }
    detachedTop.sort((a, b) => b.retainedMB - a.retainedMB)
  }

  // micro-app 相关对象的「顶层支配者」retained 之和：
  // 用于回答"应用全部关闭后，框架还占着多少"。
  const MICRO_APP_RE = /^(CustomWindow|MicroDocument|CreateApp|MicroApp|WithSandBox|IframeSandBox|EventCenterForMicroApp|EventCenterForGlobal)$/
  const microNodes = []
  for (let i = 1; i < g.nodeCount; i++) {
    if (dom.idom[i] === -1) continue
    const name = strings[g.names[i]] || ''
    if (MICRO_APP_RE.test(name)) microNodes.push(i)
  }
  const microSet = new Set(microNodes)
  let microTopRetained = 0
  const microTop = []
  for (const i of microNodes) {
    const d = dom.idom[i]
    if (d > 0 && microSet.has(d)) continue
    microTopRetained += dom.retained[i]
    microTop.push({ ...describe(i), scriptUrl: scriptUrlOf(i), idomChain: (() => {
      const chain = []
      let cur = i
      for (let hop = 0; hop < opts.depth && cur !== 0; hop++) {
        const p = dom.idom[cur]
        if (p === -1 || p === cur) break
        chain.push({ ...describe(p), edgeToNext: edgeNameOf(dom.idomEdge[cur]) })
        cur = p
      }
      return chain
    })() })
  }
  microTop.sort((a, b) => b.retainedMB - a.retainedMB)

  const byUrl = new Map()
  const top = []
  const seenShape = new Set()
  for (const ordinal of candidates) {
    if (top.length >= opts.top * 6) break
    const url = scriptUrlOf(ordinal) || `${nodeTypes[g.types[ordinal]]} (no script)`
    const row = byUrl.get(url) || { url, count: 0, retainedMB: 0 }
    row.count++
    row.retainedMB = +(row.retainedMB + dom.retained[ordinal] / 1048576).toFixed(2)
    byUrl.set(url, row)
    // 只保留每个「名称 + 类型」形状的第一条，避免同一模板对象刷屏
    const name = (strings[g.names[ordinal]] || '').slice(0, 120)
    const shape = `${nodeTypes[g.types[ordinal]]}|${name}`
    if (seenShape.has(shape)) continue
    seenShape.add(shape)
    const idomChain = []
    let cur = ordinal
    for (let hop = 0; hop < opts.depth && cur !== 0; hop++) {
      const d = dom.idom[cur]
      if (d === -1 || d === cur) break
      idomChain.push({
        ...describe(d),
        scriptUrl: scriptUrlOf(d),
        edgeToNext: edgeNameOf(dom.idomEdge[cur]),
      })
      cur = d
    }
    top.push({ ...describe(ordinal), scriptUrl: url, idomChain })
  }

  console.log(JSON.stringify({
    file: opts.snapshot,
    nodeCount: g.nodeCount,
    reachable: dom.reachableCount,
    dominatorRounds: dom.rounds,
    blocked: { edgeSubstrings: opts.blockEdge, nativeNames: opts.blockNative },
    totalRetainedMB: mb(dom.retained[0]),
    detachedSummary: {
      nodes: detachedNodes,
      selfMB: mb(detachedSelfBytes),
      topEntryCount: detachedTopCount,
      topEntryRetainedMB: mb(detachedTopRetained),
      topEntries: detachedTop,
    },
    byScriptUrl: [...byUrl.values()].sort((a, b) => b.retainedMB - a.retainedMB).slice(0, 25),
    microAppObjects: {
      count: microNodes.length,
      topEntryCount: microTop.length,
      topEntryRetainedMB: mb(microTopRetained),
      entries: microTop.slice(0, 15),
    },
    topByRetained: top.slice(0, opts.top * 3),
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
