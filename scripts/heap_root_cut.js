'use strict'

/**
 * 可达性切割实验。
 *
 * 背景：`heap_path_to_root.js` 能找到从 (GC roots) 出发的**最短**保留路径，但最短路径
 * 只说明「存在一条这样的路径」，不说明「这是唯一的根」。要判断某个根是不是**唯一**把
 * 泄漏集群钉住的原因，必须把它切掉再重测一次可达性：
 *
 *   - 切掉后目标不可达  → 它就是唯一根（或至少是必经之路）
 *   - 切掉后目标仍可达  → 还有别的根，最短路径只是恰好更短
 *
 * 同时统计可达节点数与 self_size 之和，用来量化「这个根到底钉住了多少内存」。
 *
 * 一条命令做两遍 BFS（全图 / 屏蔽指定边），避免对大快照重复读取。
 *
 * 用法：
 *   node --max-old-space-size=16384 scripts/heap_root_cut.js <snapshot> \
 *        --targets=3147771,6089105 \
 *        --describe=3952,19435332 \
 *        --blockEdge="DevTools console"
 *
 * 参数：
 *   --targets=<o,...>     必填。关心可达性的目标节点
 *   --describe=<o,...>    可选。打印这些节点的出边（含所属脚本 URL），用于看清结构
 *   --blockEdge=<substr>  可重复。BFS 时跳过「边名包含该子串」的边
 *   --blockNode=<o>       可重复。BFS 时跳过指定节点（连同其出边）
 *   --maxHops=<n>         路径最大回溯跳数，默认 400
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']

function parseArgs (argv) {
  const out = { snapshot: null, targets: [], describe: [], blockEdge: [], blockNode: [], maxHops: 400, dumpFull: false, retainers: [], retainerDepth: 3, traceToWindow: [], traceDepth: 80, rowLimit: 80 }
  for (const arg of argv) {
    if (arg === '--compact') out.compact = true
    else if (arg === '--dumpFull') out.dumpFull = true
    else if (arg.startsWith('--traceToWindow=')) out.traceToWindow = arg.slice(16).split(',').filter(Boolean).map(Number)
    else if (arg.startsWith('--traceDepth=')) out.traceDepth = Number(arg.slice(13))
    else if (arg.startsWith('--retainers=')) out.retainers = arg.slice(12).split(',').filter(Boolean).map(Number)
    else if (arg.startsWith('--retainerDepth=')) out.retainerDepth = Number(arg.slice(16))
    else if (arg.startsWith('--rowLimit=')) out.rowLimit = Number(arg.slice(11))
    else if (arg.startsWith('--targets=')) out.targets = arg.slice(10).split(',').filter(Boolean).map(Number)
    else if (arg.startsWith('--describe=')) out.describe = arg.slice(11).split(',').filter(Boolean).map(Number)
    else if (arg.startsWith('--blockEdge=')) out.blockEdge.push(arg.slice(12))
    else if (arg.startsWith('--blockNode=')) out.blockNode.push(Number(arg.slice(12)))
    else if (arg.startsWith('--blockName=')) (out.blockName || (out.blockName = [])).push(arg.slice(12))
    else if (arg.startsWith('--blockNativeName=')) (out.blockNativeName || (out.blockNativeName = [])).push(arg.slice(18))
    else if (arg.startsWith('--maxHops=')) out.maxHops = Number(arg.slice(10))
    else if (!arg.startsWith('--')) out.snapshot = arg
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
// targets 可省略：只做 --retainers / --describe 时不需要跑全图 BFS（那是最慢的一步）
if (!opts.snapshot || (!opts.targets.length && !opts.retainers.length && !opts.describe.length && !opts.traceToWindow.length)) throw new Error('用法见文件头注释')

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
  if (!found) throw new Error(`Marker not found: ${marker}`)
}

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
  const N = readNodeCount(opts.snapshot)
  const types = new Uint8Array(N)
  const names = new Uint32Array(N)
  const sizes = new Uint32Array(N)
  const ids = new Float64Array(N)
  // 0 unknown / 1 attached / 2 detached —— 判断 DOM 节点是否仍挂在文档上
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
    ids[ordinal] = tuple[2]
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
  return { nodeCount: ordinal, types, names, sizes, ids, detachedness, edgeStart, edgeType, edgeName, edgeTarget, edgeTotal: edgeOrdinal }
}

const g = (() => { let v = null; return { get: () => v, set: (x) => { v = x } } })()

function label (e, strings) {
  const t = g.get().edgeType[e]
  const raw = g.get().edgeName[e]
  if (t === 4 && raw === 0) return '<dummy>'
  if (t === 1) return `#${raw}`
  return strings[raw] || ''
}

function nameOf (o, strings) { return strings[g.get().names[o]] || '' }

/**
 * 从 closure/code 反查它属于哪个脚本。
 *
 * **只认 Script 的 `source_url`**，这是唯一可靠的来源：micro-app 的 `code2Function`
 * 会在包裹代码里注入 `//# sourceURL=<url>`，所以连 `new Function` 产生的 Script
 * 也带正确的 URL。
 *
 * 曾经的回退分支是「在 Script 节点名字里匹配第一个像 URL 的子串」。那个分支会把
 * 不同脚本归属到同一个 URL —— 实测它让「app bundle 有 20 份副本」这类**按 URL 分组
 * 的统计完全失去可信度**。现在拿不到 source_url 就返回 null：
 * 宁可缺失，也不要误归属。
 *
 * 返回 { url, via }：via ∈ 'source_url' | 'missing'，便于核实统计口径。
 */
const urlCache = new Map()
function scriptInfoOf (node, strings) {
  if (urlCache.has(node)) return urlCache.get(node)
  const gg = g.get()
  const findTarget = (n, wanted) => {
    for (let e = gg.edgeStart[n]; e < gg.edgeStart[n + 1]; e++) {
      if (gg.edgeType[e] === 3 && (strings[gg.edgeName[e]] || '') === wanted) return gg.edgeTarget[e]
    }
    return -1
  }
  const result = { url: null, via: 'missing', scriptOrdinal: -1 }
  if (gg.types[node] === 5 || gg.types[node] === 4) {
    const shared = findTarget(node, 'shared')
    const sfi = shared >= 0 ? shared : node
    const scriptNode = findTarget(sfi, 'script')
    if (scriptNode >= 0) {
      result.scriptOrdinal = scriptNode
      const urlNode = findTarget(scriptNode, 'source_url')
      if (urlNode >= 0) {
        const raw = nameOf(urlNode, strings)
        if (raw) { result.url = raw; result.via = 'source_url' }
      }
    }
  }
  urlCache.set(node, result)
  return result
}
function scriptUrlOf (node, strings) {
  return scriptInfoOf(node, strings).url
}

/**
 * 定向走查：从一个闭包出发，沿 `internal:context` → `internal:previous` 向上爬，
 * 在每一层作用域里寻找指向「某个实例自己的 window」的槽，返回它属于哪个实例。
 *
 * **为什么需要它**：with 沙箱的包裹形式是
 *   with(proxyWindow.__MICRO_APP_WINDOW__) { (function (window, self, globalThis, …) { … }) }
 * 所以每份 bundle 副本的某个**外层**作用域里必然有一个槽（`window`/`self`/`globalThis`/
 * `proxyWindow`）指向它自己的代理，而代理 `hidden:` 指向它自己的 `CustomWindow`。
 * 这是从「bundle 内部的任意对象」反查「它属于哪个应用实例」的唯一干净依据——
 * 广度反向枚举做不到这一点（它会把同一 bundle 的所有副本混在一起）。
 *
 * 配合「该 CustomWindow 是否有 WithSandBox 持有者」，即可判定副本是 live 还是 dead。
 */
const WINDOW_SLOTS = ['window', 'self', 'globalThis', 'proxyWindow', 'microAppWindow', 'defaultWindow']
function traceToWindow (start, strings, maxHops) {
  const gg = g.get()
  const kindOf = (o) => {
    if (o < 0) return null
    const nm = nameOf(o, strings)
    if (gg.types[o] === 8 && nm === 'system / JSProxy') return 'JSProxy'
    if (gg.types[o] === 3 && nm === 'CustomWindow') return 'CustomWindow'
    return null
  }
  // 作用域槽位是 context: 边（type 0），作用域链与闭包→Context 是 internal: 边（type 3）
  const findEdge = (n, wanted) => {
    for (let e = gg.edgeStart[n]; e < gg.edgeStart[n + 1]; e++) {
      const ty = gg.edgeType[e]
      if ((ty === 0 || ty === 3) && (strings[gg.edgeName[e]] || '') === wanted) return { e, to: gg.edgeTarget[e] }
    }
    return null
  }
  const hiddenTarget = (proxy) => {
    for (let e = gg.edgeStart[proxy]; e < gg.edgeStart[proxy + 1]; e++) {
      if (gg.edgeType[e] === 4 && kindOf(gg.edgeTarget[e]) === 'CustomWindow') return gg.edgeTarget[e]
    }
    return -1
  }
  const describeNode = (o) => ({ ordinal: o, type: nodeTypes[gg.types[o]], name: nameOf(o, strings).slice(0, 50) })

  const trail = []
  let node = start
  let hops = 0
  let hit = null
  while (hops < maxHops && node >= 0) {
    hops++
    const ty = gg.types[node]
    if (ty === 5 || ty === 4) {
      const c = findEdge(node, 'context')
      if (!c) break
      trail.push({ from: node, edge: 'internal:context', to: c.to })
      node = c.to
      continue
    }
    // 作用域：先找 window 类槽位，再找 extension，最后沿 internal:previous 往外走
    for (const name of WINDOW_SLOTS) {
      const s = findEdge(node, name)
      if (s) {
        const kind = kindOf(s.to)
        if (kind) { hit = { slot: name, via: `context:${name}`, target: s.to, kind }; break }
      }
    }
    if (!hit) {
      const ext = findEdge(node, 'extension')
      if (ext) {
        const kind = kindOf(ext.to)
        if (kind) hit = { slot: 'extension', via: 'internal:extension', target: ext.to, kind }
      }
    }
    if (hit) {
      trail.push({ from: node, edge: hit.via, to: hit.target })
      if (hit.kind === 'JSProxy') {
        const cw = hiddenTarget(hit.target)
        if (cw >= 0) hit.customWindow = cw
      } else {
        hit.customWindow = hit.target
      }
      break
    }
    const prev = findEdge(node, 'previous')
    if (!prev) break
    trail.push({ from: node, edge: 'internal:previous', to: prev.to })
    node = prev.to
  }
  return {
    start: describeNode(start),
    hops,
    found: !!hit,
    slot: hit ? hit.slot : null,
    via: hit ? hit.via : null,
    windowKind: hit ? hit.kind : null,
    window: hit ? describeNode(hit.target) : null,
    customWindow: hit && hit.customWindow >= 0 ? describeNode(hit.customWindow) : null,
    tail: trail.slice(-6).map((h) => `${describeNode(h.from).name} --${h.edge}--> ${describeNode(h.to).name}`),
  }
}

function describe (o, strings) {
  const gg = g.get()
  const nm = nameOf(o, strings)
  return {
    ordinal: o,
    type: nodeTypes[gg.types[o]],
    selfSize: gg.sizes[o],
    name: nm.length > 100 ? `${nm.slice(0, 100)}…[${nm.length}]` : nm,
    scriptUrl: scriptUrlOf(o, strings),
    detachedness: (['unknown', 'attached', 'detached'][gg.detachedness ? gg.detachedness[o] : 0]) || 'unknown',
    outEdges: gg.edgeStart[o + 1] - gg.edgeStart[o],
  }
}

/**
 * 从 (GC roots) 做一次前向 BFS。weak 边永不保留，直接跳过；
 * 另外可屏蔽若干「边名包含给定子串」的边，以及整个节点。
 * 返回可达统计与每个目标的最短路径（用于切割前后的对比）。
 */
function bfs (strings, { blockedEdgeSubstrings = [], blockedNodes = [] } = {}) {
  const gg = g.get()
  const N = gg.nodeCount
  const blocked = new Set(blockedNodes)
  const parentEdge = new Int32Array(N).fill(-1)
  const queue = new Int32Array(N)
  const reach = new Uint8Array(N)
  if (!gg.ephemeronKeys) {
    const keyIds = new Map()
    const needed = new Set()
    strings.forEach((name, index) => {
      if (!name.includes('part of key')) return
      const match = name.match(/part of key \(.*? @(\d+)\) -> value/)
      if (match) { keyIds.set(index, Number(match[1])); needed.add(Number(match[1])) }
    })
    const ordinals = new Map()
    for (let node = 0; node < N; node++) if (needed.has(gg.ids[node])) ordinals.set(gg.ids[node], node)
    gg.ephemeronKeys = new Map([...keyIds].map(([name, id]) => [name, ordinals.get(id) ?? -1]))
  }
  const pending = new Map()
  let head = 0, tail = 0
  let bytes = 0
  queue[tail++] = 0
  parentEdge[0] = -2
  reach[0] = 1
  // 入队即视为可达且不会重复入队（下方有 reach[to] 去重），所以循环结束后
  // tail 就是可达节点数。此前在循环外自增 count 导致恒为 1。
  while (head < tail) {
    const node = queue[head++]
    bytes += gg.sizes[node]
    if (blocked.has(node)) continue
    // V8 emits internal representation edges for WeakMap entries. Their
    // values become live only after BOTH the table and its key are live.
    for (const edge of pending.get(node) || []) {
      const to = gg.edgeTarget[edge]
      if (!reach[to]) { reach[to] = 1; parentEdge[to] = edge; queue[tail++] = to }
    }
    pending.delete(node)
    for (let e = gg.edgeStart[node]; e < gg.edgeStart[node + 1]; e++) {
      if (gg.edgeType[e] === 6) continue // weak
      let skip = false
      if (blockedEdgeSubstrings.length) {
        const l = label(e, strings)
        // 同时匹配「裸边名」和「type:边名」两种写法。原生句柄的边名只是一串数字
        // （如 "1394"），裸名匹配太容易误伤；带上 internal:/property: 前缀才能精确定位。
        const full = `${edgeTypes[gg.edgeType[e]]}:${l}`
        for (const s of blockedEdgeSubstrings) if (l.includes(s) || full.includes(s)) { skip = true; break }
      }
      if (skip) continue
      const key = gg.ephemeronKeys.get(gg.edgeName[e])
      if (key !== undefined && (!reach[key] || blocked.has(key))) {
        if (key >= 0 && !blocked.has(key)) {
          const deferred = pending.get(key) || []
          deferred.push(e)
          pending.set(key, deferred)
        }
        continue
      }
      const to = gg.edgeTarget[e]
      if (to < 0 || to >= N || reach[to]) continue
      reach[to] = 1
      parentEdge[to] = e
      queue[tail++] = to
    }
  }
  return { reach, parentEdge, count: tail, bytes }
}

function pathOf (target, bfsResult, strings) {
  const gg = g.get()
  if (bfsResult.parentEdge[target] === -1) return null
  const path = []
  let current = target
  let guard = 0
  while (current !== 0 && guard++ < opts.maxHops) {
    const e = bfsResult.parentEdge[current]
    if (e < 0) break
    // 用 edgeStart 二分反查边的源节点
    let lo = 0, hi = gg.nodeCount - 1, ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (gg.edgeStart[mid] <= e) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    const urlOf = (o) => (gg.types[o] === 5 || gg.types[o] === 4) ? scriptUrlOf(o, strings) : undefined
    path.push({
      from: { ordinal: ans, type: nodeTypes[gg.types[ans]], name: nameOf(ans, strings).slice(0, 60), scriptUrl: urlOf(ans) },
      edge: `${edgeTypes[gg.edgeType[e]]}:${label(e, strings)}`,
      to: { ordinal: current, type: nodeTypes[gg.types[current]], name: nameOf(current, strings).slice(0, 60), scriptUrl: urlOf(current) },
    })
    current = ans
  }
  path.reverse()
  return path
}

;(async () => {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\nreading graph…\n`)
  g.set(await readGraph())

  const out = {}

  if (opts.describe.length) {
    out.describe = opts.describe.map((o) => {
      const gg = g.get()
      const edges = []
      for (let e = gg.edgeStart[o]; e < gg.edgeStart[o + 1]; e++) {
        const to = gg.edgeTarget[e]
        const t = gg.types[to]
        edges.push({
          edge: `${edgeTypes[gg.edgeType[e]]}:${label(e, strings)}`,
          to: {
            ordinal: to,
            type: nodeTypes[t],
            name: nameOf(to, strings).slice(0, 70),
            scriptUrl: (t === 5 || t === 4) ? scriptUrlOf(to, strings) : undefined,
          },
        })
      }
      return { node: describe(o, strings), edges: edges.slice(0, 60), truncated: edges.length > 60 }
    })
  }

  if (opts.traceToWindow.length) {
    process.stderr.write(`traceToWindow: ${opts.traceToWindow.length} 个起点…\n`)
    out.traceWindow = opts.traceToWindow.map((o) => traceToWindow(o, strings, opts.traceDepth))
  }

  /**
   * 反向索引：谁指向谁。用于回答「这个对象被谁持有」——正向出边只能说明它持有什么。
   * 建一次 CSR 反向表，之后逐层向上回溯。
   */
  if (opts.retainers.length) {
    const gg = g.get()
    const N = gg.nodeCount
    // ⚠️ 必须排除 weak 边（type 6）：弱引用**不保活**。正向 BFS 一直有跳过它，
    // 反向索引早先漏了，导致「谁持有 X」把 WeakFixedArray / WeakArrayList 这类
    // 弱表也算成持有者，把「持有者数量」整体夸大。两边口径必须一致。
    const inStart = new Int32Array(N + 1)
    for (let e = 0; e < gg.edgeTotal; e++) {
      if (gg.edgeType[e] === 6) continue
      const t = gg.edgeTarget[e]
      if (t >= 0 && t < N) inStart[t + 1]++
    }
    for (let i = 0; i < N; i++) inStart[i + 1] += inStart[i]
    const cursor = inStart.slice(0, N)
    const inEdge = new Int32Array(gg.edgeTotal)
    let inCount = 0
    for (let e = 0; e < gg.edgeTotal; e++) {
      if (gg.edgeType[e] === 6) continue
      const t = gg.edgeTarget[e]
      if (t >= 0 && t < N) { inEdge[cursor[t]++] = e; inCount++ }
    }
    // 边的源节点用 edgeStart 二分反查（只为少量节点做，成本可忽略）
    const sourceOfEdge = (e) => {
      let lo = 0, hi = N - 1, ans = 0
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (gg.edgeStart[mid] <= e) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
      }
      return ans
    }
    const seen = new Set(opts.retainers)
    let frontier = opts.retainers.slice()
    const levels = []
    const maxFrontier = 3000
    let truncatedFrontier = false
    for (let depth = 1; depth <= opts.retainerDepth && frontier.length; depth++) {
      const rows = []
      const next = []
      for (const node of frontier) {
        for (let i = inStart[node]; i < inStart[node + 1]; i++) {
          const e = inEdge[i]
          const src = sourceOfEdge(e)
          rows.push({
            from: { ordinal: src, type: nodeTypes[gg.types[src]], name: nameOf(src, strings).slice(0, 60), isSyntheticRoot: gg.types[src] === 9 },
            edge: `${edgeTypes[gg.edgeType[e]]}:${label(e, strings)}`,
            to: { ordinal: node, type: nodeTypes[gg.types[node]], name: nameOf(node, strings).slice(0, 50) },
          })
          // 逐层向上时 frontier 可能爆炸（每个节点都可能有很多持有者）。
          // 显示层已有 80 行上限，这里对「下一层要展开哪些」也设上限，
          // 否则深一层就会把整张图卷进来。
          if (!seen.has(src) && next.length < maxFrontier) { seen.add(src); next.push(src) }
          else if (!seen.has(src)) truncatedFrontier = true
        }
      }
      // 先对**全部**行做聚合再截断显示。否则 80 行上限会把占比很大的类别整个丢掉
      // （踩过：884 条 ingress 里前 80 条全是 sliced string，真实分布完全看不到）。
      const groups = new Map()
      for (const row of rows) {
        const key = `${row.from.type} | ${row.from.isSyntheticRoot ? 'SYNTHETIC ROOT' : ((row.from.name || '(anon)').slice(0, 46) + (row.from.scriptUrl ? ` <${row.from.scriptUrl.replace(/^https?:\/\//, '').slice(0, 40)}>` : ''))}`
        const g = groups.get(key) || { key, count: 0, edges: new Set(), distinctFrom: new Set(), distinctTo: new Set(), sample: row }
        g.count++
        g.edges.add(row.edge)
        g.distinctFrom.add(row.from.ordinal)
        g.distinctTo.add(row.to.ordinal)
        groups.set(key, g)
      }
      levels.push({
        depth,
        count: rows.length,
        groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 40)
          .map((g) => ({
            key: g.key,
            count: g.count,
            distinctFrom: g.distinctFrom.size,
            distinctTo: g.distinctTo.size,
            // 保留被持有者的 ordinal：用于从一组节点里区分「有主的」和「孤儿」
            toOrdinals: [...g.distinctTo],
            edges: [...g.edges].slice(0, 6),
            sample: g.sample,
          })),
        groupCount: groups.size,
        // 行上限可调：默认 80，需要全量持有者列表时用 --rowLimit=<n>
        rows: rows.slice(0, opts.rowLimit),
        truncated: rows.length > opts.rowLimit,
      })
      frontier = next
    }
    out.retainers = { roots: opts.retainers.map((o) => describe(o, strings)), levels, truncatedFrontier }
    process.stderr.write(`retainers: ${levels.map((l) => `L${l.depth}=${l.count}`).join(' ')}\n`)
  }

  if (!opts.targets.length) {
    console.log(JSON.stringify(out, null, 2))
    return
  }

  process.stderr.write('BFS full…\n')
  const full = bfs(strings)
  process.stderr.write(`  reachable=${full.count} nodes / ${(full.bytes / 1048576).toFixed(1)} MB\n`)

  const blockedSubs = opts.blockEdge
  if (opts.blockName) {
    const gg = g.get()
    for (let node = 0; node < gg.types.length; node++) {
      if (opts.blockName.includes(nameOf(node, strings))) opts.blockNode.push(node)
    }
  }
  if (opts.blockNativeName) {
    const gg = g.get()
    // Do not cut the constructor/prototype named XMLHttpRequest: aborting
    // pending requests does not remove those shared JS objects from the page.
    for (let node = 0; node < gg.types.length; node++) {
      if (gg.types[node] === 8 && opts.blockNativeName.includes(nameOf(node, strings))) opts.blockNode.push(node)
    }
  }
  process.stderr.write(`BFS blocked by [${blockedSubs.join(' | ')}]…\n`)
  const cut = bfs(strings, { blockedEdgeSubstrings: blockedSubs, blockedNodes: opts.blockNode })
  process.stderr.write(`  reachable=${cut.count} nodes / ${(cut.bytes / 1048576).toFixed(1)} MB\n`)

  out.cut = {
    // Review: this is reachability in the exported graph, not a replay of V8
    // marking. Shared DescriptorArray entries require Map-prefix-aware GC;
    // skipping explicit weak edges and handling WeakMaps does not model it.
    model: 'exported-heap-graph-simulation',
    limitations: [
      'freedMB/freedNodes are simulated graph differences, not measured GC reclamation',
      'Map NumberOfOwnDescriptors / shared DescriptorArray custom marking is not modeled',
    ],
    blockedEdgeSubstrings: blockedSubs,
    blockedNodes: opts.blockNode,
    full: { reachableNodes: full.count, reachableMB: +(full.bytes / 1048576).toFixed(1) },
    after: { reachableNodes: cut.count, reachableMB: +(cut.bytes / 1048576).toFixed(1) },
    freedNodes: full.count - cut.count,
    freedMB: +((full.bytes - cut.bytes) / 1048576).toFixed(1),
  }

  out.targets = opts.targets.map((t) => {
    const fullPath = pathOf(t, full, strings)
    const cutPath = pathOf(t, cut, strings)
    return {
      target: describe(t, strings),
      full: { reachable: !!fullPath, hops: fullPath ? fullPath.length : 0, firstHops: fullPath ? fullPath.slice(0, 6) : [] },
      after: { reachable: !!cutPath, hops: cutPath ? cutPath.length : 0, firstHops: cutPath ? cutPath.slice(0, 6) : [], path: opts.dumpFull ? cutPath : undefined },
    }
  })

  if (opts.compact) {
    out.targets = out.targets.map((row) => ({
      target: row.target.ordinal,
      hops: row.after.hops,
      path: row.after.path?.map((step) => `${step.from.ordinal} ${step.from.name} --${step.edge}--> ${step.to.ordinal} ${step.to.name}${step.to.scriptUrl ? ` <${step.to.scriptUrl}>` : ''}`),
    }))
    out.describe = out.describe?.map((row) => ({ node: row.node, edges: row.edges.map((edge) => `${edge.edge} -> ${edge.to.ordinal} ${edge.to.name}`) }))
  }
  console.log(JSON.stringify(out, null, 2))
})().catch((error) => { console.error(error); process.exitCode = 1 })
