'use strict'

/**
 * 「谁拿着这些对象」——按名称/类型抽样若干节点，向上走 k 层持有者，
 * 并把持有者按 **所属脚本/应用（bucket）** 聚合。
 *
 * 与 heap_retainers.js 的区别：
 *   - 支持 --sampleName=<regex>（按节点名抽样），而不是手工给 ordinal；
 *   - 每个 bucket 输出 selfSize 合计（默认 0），而不是只列样本；
 *   - 增加 --exclusive：只统计「唯一持有者」链（用于判断是否并行冗余入口）。
 *
 * 用法：
 *   node --max-old-space-size=12288 scripts/heap_owner_buckets.js <snapshot> \
 *        --sampleName="^get$" --sampleType=closure --sampleCount=4 --levels=6
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

function parseArgs (argv) {
  const out = { snapshot: null, sampleName: null, sampleType: null, sampleCount: 4, sampleStep: 1, levels: 6, fanout: 4000, top: 30 }
  for (const arg of argv) {
    if (arg.startsWith('--sampleName=')) out.sampleName = arg.slice(13)
    else if (arg.startsWith('--sampleType=')) out.sampleType = arg.slice(13)
    else if (arg.startsWith('--sampleCount=')) out.sampleCount = Number(arg.slice(14))
    else if (arg.startsWith('--sampleStep=')) out.sampleStep = Number(arg.slice(13))
    else if (arg.startsWith('--levels=')) out.levels = Number(arg.slice(9))
    else if (arg.startsWith('--fanout=')) out.fanout = Number(arg.slice(9))
    else if (arg.startsWith('--top=')) out.top = Number(arg.slice(6))
    else if (!arg.startsWith('--')) out.snapshot = arg
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.snapshot || !opts.sampleName) throw new Error('用法: node scripts/heap_owner_buckets.js <snapshot> --sampleName=<regex> [--sampleType=closure] [--sampleCount=4] [--levels=6]')

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
  if (!found) throw new Error(`Marker not found: ${String(marker)}`)
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

async function readGraph (strings) {
  const N = readNodeCount()
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
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeTarget, edgeName }
}

/** 把节点归属到「脚本包」：函数/闭包看 script source_url，DOM/原生对象看是否带 micro-app 标记。 */
function makeBucketResolver (g, strings) {
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
  const cache = new Map()
  const scriptUrlOf = (node) => {
    if (cache.has(node)) return cache.get(node)
    let url = null
    const type = g.types[node]
    if (type === 5 || type === 4 || type === 3) {
      let sfi = findTarget(node, 'shared')
      if (sfi < 0) sfi = node
      const scriptNode = findTarget(sfi, 'script')
      if (scriptNode >= 0) {
        const urlNode = findTarget(scriptNode, 'source_url')
        if (urlNode >= 0) url = strings[g.names[urlNode]] || null
      }
    }
    cache.set(node, url)
    return url
  }
  return (node) => {
    const url = scriptUrlOf(node)
    if (url) {
      try {
        const parsed = new URL(url)
        const base = `${parsed.origin}${parsed.pathname}`
        const app = parsed.hostname.split('.')[0]
        return { bucket: base.length > 90 ? base.slice(0, 90) : base, app }
      } catch (_) {
        return { bucket: url.slice(0, 90), app: '(unparsed)' }
      }
    }
    const raw = strings[g.names[node]] || ''
    const type = nodeTypes[g.types[node]]
    if (type === 'native') return { bucket: `native :: ${raw.slice(0, 60)}`, app: '(native)' }
    return { bucket: `${type} (no script)`, app: '(no script)' }
  }
}

async function main () {
  process.stderr.write('reading…\n')
  const strings = await readStrings()
  const g = await readGraph(strings)
  const resolve = makeBucketResolver(g, strings)

  const re = new RegExp(opts.sampleName)
  const wantType = opts.sampleType ? nodeTypes.indexOf(opts.sampleType) : -1
  const seeds = []
  let matching = 0
  const step = opts.sampleStep > 0 ? opts.sampleStep : 1
  for (let i = 0; i < g.nodeCount; i++) {
    if (wantType >= 0 && g.types[i] !== wantType) continue
    const raw = strings[g.names[i]] || ''
    if (!re.test(raw)) continue
    matching++
    // 均匀抽样：每 step 个匹配取一个，避免只看到最早分配的那批
    if (matching % step === 0 && seeds.length < opts.sampleCount) seeds.push(i)
  }
  if (!seeds.length) throw new Error(`没有匹配的节点: ${opts.sampleName}`)

  const describe = (o) => {
    const raw = strings[g.names[o]] || ''
    const info = resolve(o)
    return {
      ordinal: o,
      type: nodeTypes[g.types[o]],
      selfSize: g.sizes[o],
      name: raw.length > 100 ? `${raw.slice(0, 100)}…[${raw.length}]` : raw,
      bucket: info.bucket,
    }
  }

  const visited = new Set(seeds)
  let frontier = new Set(seeds)
  const levels = []
  for (let level = 1; level <= opts.levels && frontier.size; level++) {
    const hits = new Map()
    for (let node = 0; node < g.nodeCount; node++) {
      if (frontier.has(node)) continue
      let row = null
      for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
        if (g.edgeType[e] === 6) continue
        if (!frontier.has(g.edgeTarget[e])) continue
        row = row || { labels: new Set(), targets: new Set(), edges: 0 }
        row.edges++
        const type = g.edgeType[e], raw = g.edgeName[e]
        row.labels.add(`${edgeTypes[type]}:${type === 4 && raw === 0 ? '<dummy>' : type === 1 ? `#${raw}` : (strings[raw] || '')}`)
        row.targets.add(g.edgeTarget[e])
      }
      if (row) hits.set(node, row)
    }
    if (!hits.size) { process.stderr.write(`level ${level}: no retainers\n`); break }
    process.stderr.write(`level ${level}: ${hits.size} retainers\n`)

    const byBucket = new Map()
    const byApp = new Map()
    const samples = new Map()
    for (const [node, row] of hits) {
      const info = resolve(node)
      const b = byBucket.get(info.bucket) || { bucket: info.bucket, app: info.app, count: 0, selfBytes: 0 }
      b.count++
      b.selfBytes += g.sizes[node]
      byBucket.set(info.bucket, b)
      const a = byApp.get(info.app) || { app: info.app, count: 0, selfBytes: 0 }
      a.count++
      a.selfBytes += g.sizes[node]
      byApp.set(info.app, a)
      const list = samples.get(info.bucket) || []
      if (list.length < 3) list.push({ ordinal: node, type: nodeTypes[g.types[node]], via: [...row.labels].slice(0, 4), targets: [...row.targets].slice(0, 3) })
      samples.set(info.bucket, list)
    }
    const mb = (b) => +(b / 1048576).toFixed(2)
    levels.push({
      level,
      retainerCount: hits.size,
      byApp: [...byApp.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((r) => ({ ...r, selfMB: mb(r.selfBytes) })),
      byBucket: [...byBucket.values()].sort((a, b) => b.count - a.count).slice(0, opts.top).map((r) => ({ ...r, selfMB: mb(r.selfBytes) })),
      samples: Object.fromEntries([...samples].slice(0, 6)),
    })

    if (hits.size > opts.fanout) { levels[levels.length - 1].truncated = true; process.stderr.write(`fanout ${hits.size} > cap ${opts.fanout}, stop\n`); break }
    const next = new Set()
    for (const node of hits.keys()) if (!visited.has(node)) { visited.add(node); next.add(node) }
    if (!next.size) break
    frontier = next
  }

  console.log(JSON.stringify({
    file: opts.snapshot,
    sample: { pattern: opts.sampleName, type: opts.sampleType || '(any)', count: seeds.length, totalMatching: matching },
    seeds: seeds.map(describe),
    levels,
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
