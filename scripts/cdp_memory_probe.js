'use strict'

/**
 * 单页内存构成探针：连接一个已打开的调试 Chrome 页面，回答
 * 「任务管理器里那 ~520 MB 到底花在哪」。
 *
 * 与 cdp_memory_breakdown.js 的分工：本脚本在**页面自己的上下文里**执行表达式，
 * 所以能拿到 `performance.memory`、`performance.getEntriesByType('resource')`
 * 以及 V8 原生内存采样（`Memory.getBrowserSamplingProfile`）。
 *
 * 用法：
 *   node scripts/cdp_memory_probe.js --port=9222 --url-match=localhost:3000
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs (argv) {
  const out = { port: 9222, urlMatch: null, gc: true }
  for (const arg of argv) {
    if (arg === '--no-gc') out.gc = false
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
  }
  return out
}

function connect (url) {
  let WS = null
  try { WS = require('ws') } catch (_) {}
  if (!WS) {
    if (typeof WebSocket === 'undefined') throw new Error('需要 Node ≥ 22 或安装 ws')
    WS = WebSocket
  }
  const socket = new WS(url)
  const handlers = { message: [], open: [], error: [], close: [] }
  const emit = (name, payload) => handlers[name].slice().forEach((fn) => fn(payload))
  const isNodeWs = typeof socket.on === 'function' && typeof socket.addEventListener !== 'function'
  if (isNodeWs) {
    socket.on('message', (d) => emit('message', String(d)))
    socket.on('open', () => emit('open'))
    socket.on('error', (e) => emit('error', e))
    socket.on('close', () => emit('close'))
  } else {
    socket.addEventListener('message', (e) => emit('message', typeof e.data === 'string' ? e.data : String(e.data)))
    socket.addEventListener('open', () => emit('open'))
    socket.addEventListener('error', (e) => emit('error', e))
    socket.addEventListener('close', () => emit('close'))
  }
  return { on: (n, f) => handlers[n].push(f), send: (d) => socket.send(d), close: () => socket.close() }
}

const MB = (b) => (b === undefined || b === null ? null : +(b / 1048576).toFixed(2))

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const version = await (await fetch(`http://127.0.0.1:${opts.port}/json/version`)).json()
  const ws = connect(version.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
  })
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

  const { targetInfos } = await send('Target.getTargets')
  const pages = targetInfos.filter((t) => t.type === 'page')
  const target = pages.find((p) => !opts.urlMatch || (p.url || '').includes(opts.urlMatch)) || pages[0]
  if (!target) throw new Error('没有页面目标')
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const s = (m, p) => send(m, p, sessionId)

  if (opts.gc) {
    await s('HeapProfiler.enable').catch(() => {})
    for (let i = 0; i < 3; i++) { await s('HeapProfiler.collectGarbage').catch(() => {}); await sleep(400) }
    await sleep(800)
  }

  const evaluate = async (expression) => {
    const res = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    if (res.exceptionDetails) return { error: res.exceptionDetails.text || 'evaluate failed' }
    return res.result.value
  }

  const out = { url: target.url, gcPerformed: opts.gc }

  out.heap = await s('Runtime.getHeapUsage').catch(() => null)
  if (out.heap) {
    out.heap = { usedMB: MB(out.heap.usedSize), totalMB: MB(out.heap.totalSize), embedderMB: MB(out.heap.embedderHeapUsedSize), backingMB: MB(out.heap.backingStorageSize) }
  }
  const stats = await s('Runtime.getHeapStatistics').catch(() => null)
  if (stats) {
    out.v8Stats = {
      heapSizeLimitMB: MB(stats.heap_size_limit),
      totalHeapSizeMB: MB(stats.total_heap_size),
      totalAvailableMB: MB(stats.total_available_size),
      mallocedMB: MB(stats.malloced_memory),
      peakMallocedMB: MB(stats.peak_malloced_memory),
      externalMemoryMB: MB(stats.external_memory),
      nativeContexts: stats.number_of_native_contexts,
      detachedContexts: stats.number_of_detached_contexts,
      globalHandlesMB: MB(stats.total_global_handles_size),
    }
  }
  out.domCounters = await s('Memory.getDOMCounters').catch(() => null)
  out.codeCache = await s('Runtime.getHeapUsage').then(() => null).catch(() => null)

  // 页面自身读数（GC 后立刻取）
  out.pageSelfReport = await evaluate(`JSON.stringify({
    perfMemory: performance.memory ? {
      usedMB: +(performance.memory.usedJSHeapSize/1048576).toFixed(2),
      totalMB: +(performance.memory.totalJSHeapSize/1048576).toFixed(2),
      limitMB: +(performance.memory.jsHeapSizeLimit/1048576).toFixed(2)
    } : null,
    resourceCount: performance.getEntriesByType('resource').length,
    transferMB: +(performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize||0), 0)/1048576).toFixed(2),
    decodedMB: +(performance.getEntriesByType('resource').reduce((a, r) => a + (r.decodedBodySize||0), 0)/1048576).toFixed(2),
    scriptResourceCount: performance.getEntriesByType('resource').filter(r => /script|\.js|\.ts|\.vue|\.mjs/.test(r.name)).length,
    styleSheetCount: document.styleSheets.length,
    styleRuleTotal: (() => { let n = 0; for (const ss of document.styleSheets) { try { n += ss.cssRules.length } catch (_) {} } return n })(),
    domNodes: document.getElementsByTagName('*').length,
    microAppNodes: document.querySelectorAll('micro-app').length,
    scriptsInDom: document.scripts.length
  })`).then((v) => (typeof v === 'string' ? JSON.parse(v) : v))

  // V8 原生内存采样：按调用栈归类的分配量
  const profile = await s('Memory.getBrowserSamplingProfile').catch(() => null)
  if (profile && profile.profile && profile.profile.samples) {
    const byBucket = new Map()
    for (const sample of profile.profile.samples) {
      const stack = profile.profile.stacks[sample.stackId] || []
      const top = stack.length ? profile.profile.frames[stack[0]] : null
      const key = top ? `${top.name || '(anonymous)'} @ ${(top.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 60)}` : '(no stack)'
      byBucket.set(key, (byBucket.get(key) || 0) + (sample.size || 0))
    }
    out.nativeSamplingTop = [...byBucket.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([key, size]) => ({ key, MB: MB(size) }))
    out.nativeSamplingTotalMB = MB([...byBucket.values()].reduce((a, b) => a + b, 0))
  }

  console.log(JSON.stringify(out, null, 2))
  ws.close()
}

main().catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exitCode = 1 })
