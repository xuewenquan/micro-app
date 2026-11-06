'use strict'

/**
 * 单个 V8 堆快照 → 一行指标 JSON。用于 #4 的固定序列基线：每轮抓一份快照，
 * 跑一条命令就得到一行可对比的数据（可直接追加成 JSONL，几十轮后看趋势）。
 *
 * 只做 1 次节点扫描 + 1 次边扫描，因此比逐个跑 5 个脚本快得多。
 * 支配树（topAnchor）很慢（大文件 20 分钟），默认关闭，用 --dominators 显式开启，
 * 建议只在「初始化 / 首轮 / 末轮」三份上跑。
 *
 * 用法：
 *   node --max-old-space-size=16384 scripts/heap_metrics.js <snapshot> [--label=round-3]
 *        [--out=<jsonl>] [--dominators] [--pretty]
 *
 * 输出字段：
 *   label            --label 的值，便于在 JSONL 里定位轮次
 *   sizeMB           快照文件大小
 *   nodeCount/edgeCount   从文件头读取
 *   heapSelfMB       所有节点 self_size 之和（与 DevTools 底部显示的 "Total" 口径一致）
 *   markers          micro-app 遗留标记计数，持续为 0 才算正常
 *   detachedDOM      游离（detached）DOM 节点数（与微应用相关的那批）
 *   apps             作用于 DOM 元素上的不同 __MICRO_APP_NAME__ 个数
 *   customWindow / microDocument / createApp     仍在堆里的相关对象数
 *   createAppDestroyed  createApp 中 destroyed=true 的个数
 *   parsedCSS        Blink 解析后的 CSS 节点数与字节数
 *   topAnchor        --dominators 时才有的最大 retained size 节点
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']

const MARKERS = [
  '__MICRO_APP_MARK_OPTIONS__',
  '__MICRO_APP_URL__',
  '__MICRO_APP_BOUND_',
  'parsedCode',
  'webpackChunk',
]

// Blink 解析后的 CSS 相关节点。
//
// 注意：**必须排除 string 类节点**。对 string 节点来说 "name" 就是它的内容，而包裹后的
// 子应用 bundle 源码（单个可达 22 MB）里必然出现 StyleRule / CSSSelector 这类字样，
// 按名字匹配会把它们误算成 CSS 节点。实测这个错误会让 parsedCSS 从 ~27 MB 虚高到 ~98 MB。
const CSS_RE = /(StyleRule|CSSSelector|CSSPropertyValue|CSSVariableData|CSSValueList|CSSUnparsed|CSSNumeric|CSSFunction|CSSMatching|MutableCSSPropertyValueSet)/
const STRING_TYPE_IDS = new Set([2, 10, 11]) // string / concatenated string / sliced string
// 计数口径必须固定，否则轮次之间不可比：
//   customWindow   只数「实例」（object）
//   microDocument  只数「每个 app 一份的类」（closure）—— 它就是 per-app 的代理/原型载体
//   createApp      只数「实例」（object），排除同名的类闭包
const NODE_TYPE_ID = { object: 3, closure: 5 }
const COUNT_RULES = [
  { key: 'customWindow', type: NODE_TYPE_ID.object, re: /^CustomWindow$/ },
  { key: 'microDocument', type: NODE_TYPE_ID.closure, re: /^MicroDocument$/ },
  { key: 'createApp', type: NODE_TYPE_ID.object, re: /^CreateApp$/ },
]

function parseArgs (argv) {
  const out = { dominators: false, pretty: false, label: null, outFile: null, snapshot: null }
  for (const arg of argv) {
    if (arg === '--dominators') out.dominators = true
    else if (arg === '--pretty') out.pretty = true
    else if (arg.startsWith('--label=')) out.label = arg.slice(8)
    else if (arg.startsWith('--out=')) out.outFile = arg.slice(6)
    else if (!arg.startsWith('--')) out.snapshot = arg
  }
  return out
}

async function afterMarker (snapshotPath, marker, handler) {
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

function readHeader (snapshotPath) {
  const fd = fs.openSync(snapshotPath, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const text = buf.toString('utf8', 0, read)
  const nodeCount = text.match(/"node_count":(\d+)/)
  const edgeCount = text.match(/"edge_count":(\d+)/)
  if (!nodeCount) throw new Error('文件头里没有 node_count，可能不是合法的 heapsnapshot')
  return {
    nodeCount: Number(nodeCount[1]),
    edgeCount: edgeCount ? Number(edgeCount[1]) : null,
  }
}

async function readStrings (snapshotPath) {
  const strings = []
  let token = '', inString = false, escaped = false
  await afterMarker(snapshotPath, Buffer.from('"strings":['), (chunk) => {
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

async function scanNodes (snapshotPath, strings) {
  const capacity = readHeader(snapshotPath).nodeCount + 1
  const types = new Uint8Array(capacity)
  const names = new Uint32Array(capacity)
  const sizes = new Uint32Array(capacity)
  const detachedness = new Uint8Array(capacity)
  const edgeStart = new Int32Array(capacity + 1)
  const counts = { customWindow: 0, microDocument: 0, createApp: 0 }
  const isCreateApp = new Uint8Array(capacity)
  const isScript = new Uint8Array(capacity)
  let cssNodes = 0, cssBytes = 0
  const domAll = { attached: 0, detached: 0, detachedByTag: new Map() }
  let heapSelf = 0, ordinal = 0, edgeTotal = 0

  let field = 0, value = 0, hasValue = false
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    types[ordinal] = tuple[0]
    names[ordinal] = tuple[1]
    sizes[ordinal] = tuple[3]
    detachedness[ordinal] = tuple[5]
    edgeStart[ordinal] = edgeTotal
    edgeTotal += tuple[4]
    heapSelf += tuple[3]
    const name = strings[tuple[1]] || ''
    const typeId = tuple[0]
    // Existing detachedDOM is app-marked only. Count base DOM as well;
    // otherwise a retained base Vue tree can disappear from the audit.
    if (typeId === 8 && tuple[5] > 0) {
      if (tuple[5] === 1) domAll.attached++
      else if (tuple[5] === 2) {
        domAll.detached++
        const tag = name.match(/^<([^ >]+)/)?.[1] || name
        const row = domAll.detachedByTag.get(tag) || { tag, count: 0, sampleOrdinal: ordinal }
        row.count++
        domAll.detachedByTag.set(tag, row)
      }
    }
    if (name.startsWith('system / Script')) isScript[ordinal] = 1
    for (const rule of COUNT_RULES) {
      if (rule.type === typeId && rule.re.test(name)) {
        counts[rule.key]++
        if (rule.key === 'createApp') isCreateApp[ordinal] = 1
      }
    }
    if (!STRING_TYPE_IDS.has(typeId) && CSS_RE.test(name)) { cssNodes++; cssBytes += tuple[3] }
    ordinal++
  }
  await afterMarker(snapshotPath, Buffer.from('"nodes":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })
  edgeStart[ordinal] = edgeTotal
  return { nodeCount: ordinal, types, names, sizes, detachedness, edgeStart, counts, isCreateApp, isScript, cssNodes, cssBytes, heapSelf, domAll }
}

async function scanEdges (snapshotPath, strings, nodeIndex) {
  const markers = Object.fromEntries(MARKERS.map((m) => [m, 0]))
  const appCounts = new Map()
  const detachedByApp = new Map()
  const detached = { attached: 0, detached: 0, unknown: 0 }
  const createApps = new Map()
  const scriptUrl = new Map()
  const scriptSource = new Map()
  const scriptSourceType = new Map()
  const scriptRefs = new Int32Array(nodeIndex.nodeCount)
  const indirectStringBytes = new Float64Array(nodeIndex.nodeCount)
  const CONS_STRING = 10
  const SLICED_STRING = 11
  let createAppDestroyed = 0

  let consoleHandleCount = 0
  let source = 0
  let remaining = nodeIndex.edgeStart[1] - nodeIndex.edgeStart[0]
  let field = 0, value = 0, hasValue = false
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const target = toOffset / 6
    // type===1(element)/4(hidden) 用裸索引，其余是字符串索引
    if (type !== 1 && type !== 4) {
      const edgeName = strings[nameOrIndex] || ''
      /**
       * DevTools console 句柄计数。
       *
       * V8 会把「被 DevTools 控制台持有」的对象挂在 `(Global handles)` 下，
       * 边名形如 `internal:273 / DevTools console`。这类保留**是测量环境自己引入的**，
       * 不是被测代码的泄漏 —— 但如果不单独计数，它会被混进"谁持有 X"的答案里，
       * 让结论不可用（见报告 §13.9）。所以每轮都记一列，便于判断增量里有多少是噪声。
       */
      if (edgeName.indexOf('DevTools console') >= 0) consoleHandleCount++
      if (Object.prototype.hasOwnProperty.call(markers, edgeName)) {
        markers[edgeName]++
      } else if (edgeName === '__MICRO_APP_NAME__') {
        const appName = strings[nodeIndex.names[target]] || ''
        // 'system / Hole' 是 V8 表示「属性已删除」的占位符，不是应用名
        if (appName && appName !== 'system / Hole') {
          appCounts.set(appName, (appCounts.get(appName) || 0) + 1)
        }
        const d = nodeIndex.detachedness[source]
        if (d === 2) {
          detached.detached++
          const row = detachedByApp.get(appName) || { count: 0, sampleOrdinal: source }
          row.count++
          detachedByApp.set(appName, row)
        }
        else if (d === 1) detached.attached++
        else detached.unknown++
      } else if (edgeName === 'destroyed' && nodeIndex.isCreateApp[source] === 1) {
        const destroyed = (strings[nodeIndex.names[target]] || '') === 'true'
        if (destroyed) createAppDestroyed++
        const row = createApps.get(source) || { ordinal: source }
        row.destroyed = destroyed
        createApps.set(source, row)
      } else if (nodeIndex.isCreateApp[source] === 1 && edgeName === 'name') {
        const row = createApps.get(source) || { ordinal: source }
        row.name = strings[nodeIndex.names[target]] || ''
        createApps.set(source, row)
      } else if (nodeIndex.isCreateApp[source] === 1 && edgeName === 'container') {
        const row = createApps.get(source) || { ordinal: source }
        row.container = strings[nodeIndex.names[target]] || ''
        createApps.set(source, row)
      } else if (nodeIndex.isCreateApp[source] === 1 && edgeName === 'sandBox') {
        const row = createApps.get(source) || { ordinal: source }
        row.sandbox = strings[nodeIndex.names[target]] || ''
        createApps.set(source, row)
      } else if (nodeIndex.isScript[source] === 1 && edgeName === 'source_url') {
        scriptUrl.set(source, strings[nodeIndex.names[target]] || '(empty)')
      } else if (nodeIndex.isScript[source] === 1 && edgeName === 'source') {
        scriptSource.set(source, target)
        scriptSourceType.set(source, nodeIndex.types[target])
      } else if ((nodeIndex.types[source] === CONS_STRING || nodeIndex.types[source] === SLICED_STRING) && target < nodeIndex.nodeCount) {
        indirectStringBytes[source] += nodeIndex.sizes[target]
      } else if (edgeName === 'script' && nodeIndex.isScript[target] === 1) {
        scriptRefs[target]++
      }
    }
    if (--remaining <= 0) {
      do {
        source++
        remaining = source < nodeIndex.nodeCount ? nodeIndex.edgeStart[source + 1] - nodeIndex.edgeStart[source] : 0
      } while (source < nodeIndex.nodeCount && remaining === 0)
    }
  }
  await afterMarker(snapshotPath, Buffer.from('"edges":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })

  const topApps = [...appCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]) => ({ name, count }))
  const detachedApps = [...detachedByApp.entries()].sort((a, b) => b[1].count - a[1].count)
    .map(([name, row]) => ({ name, count: row.count, sampleOrdinal: row.sampleOrdinal }))

  for (let i = 0; i < nodeIndex.nodeCount; i++) {
    if (nodeIndex.isScript[i] !== 1 || scriptUrl.has(i)) continue
    const name = strings[nodeIndex.names[i]] || ''
    const match = name.match(/^system \/ Script \/ (.+)$/)
    scriptUrl.set(i, match ? match[1] : '(no url)')
  }
  const bundleMap = new Map()
  for (const [ordinal, url] of scriptUrl) {
    const sourceOrdinal = scriptSource.get(ordinal)
    const sourceBytes = sourceOrdinal === undefined
      ? 0
      : nodeIndex.sizes[sourceOrdinal] + indirectStringBytes[sourceOrdinal]
    let row = bundleMap.get(url)
    if (!row) {
      row = { url, scripts: 0, sourceBytes: 0, sfiCount: 0 }
      bundleMap.set(url, row)
    }
    row.scripts++
    row.sourceBytes += sourceBytes
    row.sfiCount += scriptRefs[ordinal]
    const sourceType = scriptSourceType.get(ordinal)
    if (sourceType === CONS_STRING) row.consScripts = (row.consScripts || 0) + 1
    else if (sourceType === SLICED_STRING) row.slicedScripts = (row.slicedScripts || 0) + 1
  }
  const bundles = [...bundleMap.values()]
    .filter((row) => row.url !== '(no url)' && row.sourceBytes > 0)
    .sort((a, b) => b.sourceBytes - a.sourceBytes)
  const bundleTotals = bundles.reduce((total, row) => ({
    scripts: total.scripts + row.scripts,
    sourceBytes: total.sourceBytes + row.sourceBytes,
    sfiCount: total.sfiCount + row.sfiCount,
    urls: total.urls + 1,
  }), { scripts: 0, sourceBytes: 0, sfiCount: 0, urls: 0 })

  return {
    markers,
    appCount: appCounts.size,
    topApps,
    detachedDOM: detached.detached,
    detachedApps,
    createAppDestroyed,
    createApps: [...createApps.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    consoleHandles: consoleHandleCount,
    bundles: {
      totals: {
        scripts: bundleTotals.scripts,
        urls: bundleTotals.urls,
        sourceMB: +(bundleTotals.sourceBytes / 1048576).toFixed(1),
        sfiCount: bundleTotals.sfiCount,
      },
      duplicateUrls: bundles.filter((row) => row.scripts > 1).map((row) => ({
        url: row.url,
        scripts: row.scripts,
        sourceMB: +(row.sourceBytes / 1048576).toFixed(1),
        sfiCount: row.sfiCount,
      })),
      top: bundles.slice(0, 12).map((row) => ({
        url: row.url,
        scripts: row.scripts,
        sourceMB: +(row.sourceBytes / 1048576).toFixed(1),
        sfiCount: row.sfiCount,
      })),
    },
  }
}

function runDominators (snapshotPath) {
  const script = path.join(__dirname, 'heap_dominators.js')
  const res = spawnSync(process.execPath, ['--max-old-space-size=16384', script, snapshotPath, '1'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (res.status !== 0 || !res.stdout) return null
  try {
    const parsed = JSON.parse(res.stdout)
    // topByRetained[0] 通常是 (GC roots) 本身，取第一个真实对象
    const candidate = (parsed.topByRetained || []).find((r) => r.type !== 'synthetic')
    if (!candidate) return null
    return {
      ordinal: candidate.ordinal,
      type: candidate.type,
      name: (candidate.name || '').slice(0, 80),
      retainedMB: +(candidate.retainedSize / 1048576).toFixed(1),
    }
  } catch (_) {
    return null
  }
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.snapshot) throw new Error('用法: node scripts/heap_metrics.js <snapshot> [--label=...] [--out=...] [--dominators]')
  if (!fs.existsSync(opts.snapshot)) throw new Error(`文件不存在: ${opts.snapshot}`)

  const header = readHeader(opts.snapshot)
  const strings = await readStrings(opts.snapshot)
  const nodeIndex = await scanNodes(opts.snapshot, strings)
  const edgeInfo = await scanEdges(opts.snapshot, strings, nodeIndex)

  const result = {
    label: opts.label || path.basename(opts.snapshot),
    file: path.basename(opts.snapshot),
    sizeMB: +(fs.statSync(opts.snapshot).size / 1048576).toFixed(1),
    nodeCount: header.nodeCount,
    edgeCount: header.edgeCount,
    heapSelfMB: +(nodeIndex.heapSelf / 1048576).toFixed(1),
    markers: edgeInfo.markers,
    detachedDOM: edgeInfo.detachedDOM,
    domAll: {
      attached: nodeIndex.domAll.attached,
      detached: nodeIndex.domAll.detached,
      detachedByTag: [...nodeIndex.domAll.detachedByTag.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    },
    consoleHandles: edgeInfo.consoleHandles,
    apps: edgeInfo.appCount,
    topApps: edgeInfo.topApps,
    detachedApps: edgeInfo.detachedApps,
    customWindow: nodeIndex.counts.customWindow,
    // Unmarked is the directly observed fact. When createApp/WithSandBox are
    // also zero these are orphan shells, but do not bake that inference into
    // the reusable metric name.
    unmarkedCustomWindow: Math.max(0, nodeIndex.counts.customWindow - edgeInfo.markers.__MICRO_APP_URL__),
    microDocument: nodeIndex.counts.microDocument,
    createApp: nodeIndex.counts.createApp,
    createAppDestroyed: edgeInfo.createAppDestroyed,
    createApps: edgeInfo.createApps,
    bundles: edgeInfo.bundles,
    parsedCSS: { nodes: nodeIndex.cssNodes, mb: +(nodeIndex.cssBytes / 1048576).toFixed(2) },
  }
  if (opts.dominators) result.topAnchor = runDominators(opts.snapshot)

  const line = opts.pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)
  console.log(line)
  if (opts.outFile) fs.appendFileSync(opts.outFile, line + '\n', 'utf8')
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
})
