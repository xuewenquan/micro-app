'use strict'

/**
 * 把「浏览器任务管理器里那 475 MB」拆开看。
 *
 * 分三层读数：
 *   1. 渲染进程的 V8 堆（used / total / limit）—— JS 对象
 *   2. V8 的堆外部分：ArrayBuffer、代码、外部字符串（dev 环境的模块源码就在这里）
 *   3. Blink 侧：DOM 节点 / 样式 / 布局 / 图片……（`Performance.getMetrics` 的
 *      `DOMNodes`、`LayoutObjects`、`StyleRules` 等）
 *   4. 浏览器进程自己的 `SystemInfo.getProcessInfo`：哪个进程占了多少物理内存
 *
 * 用法：
 *   node scripts/cdp_memory_breakdown.js [--port=9222] [--url-match=localhost:3000]
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
  try { WS = require('ws') } catch (_) { /* 退回 Node 内置 WebSocket */ }
  if (!WS) {
    if (typeof WebSocket === 'undefined') throw new Error('需要 Node ≥ 22 或在仓库内安装 ws')
    WS = WebSocket
  }
  const socket = new WS(url)
  const handlers = { message: [], open: [], error: [], close: [] }
  const emit = (name, payload) => handlers[name].slice().forEach((fn) => fn(payload))
  const isNodeWs = typeof socket.on === 'function' && typeof socket.addEventListener !== 'function'
  if (isNodeWs) {
    socket.on('message', (data) => emit('message', String(data)))
    socket.on('open', () => emit('open'))
    socket.on('error', (error) => emit('error', error))
    socket.on('close', () => emit('close'))
  } else {
    socket.addEventListener('message', (event) => emit('message', typeof event.data === 'string' ? event.data : String(event.data)))
    socket.addEventListener('open', () => emit('open'))
    socket.addEventListener('error', (error) => emit('error', error))
    socket.addEventListener('close', () => emit('close'))
  }
  return { on: (name, fn) => handlers[name].push(fn), send: (d) => socket.send(d), close: () => socket.close() }
}

function makeClient (ws) {
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
  return { send }
}

const MB = (bytes) => (bytes === undefined || bytes === null ? null : +(bytes / 1048576).toFixed(2))

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const version = await (await fetch(`http://127.0.0.1:${opts.port}/json/version`)).json()
  const browserWs = connect(version.webSocketDebuggerUrl)
  const browser = makeClient(browserWs)
  await new Promise((resolve, reject) => {
    browserWs.on('open', resolve)
    browserWs.on('error', (e) => reject(new Error(`CDP 连接失败: ${e && e.message ? e.message : e}`)))
  })
  const { targetInfos } = await browser.send('Target.getTargets')
  const pages = targetInfos.filter((t) => t.type === 'page')
  const target = pages.find((p) => !opts.urlMatch || (p.url || '').includes(opts.urlMatch)) || pages[0]
  if (!target) throw new Error('没有找到页面目标')

  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const send = (method, params) => browser.send(method, params, sessionId)

  await send('HeapProfiler.enable').catch(() => {})
  if (opts.gc) {
    await send('Runtime.discardConsoleEntries').catch(() => {})
    for (let i = 0; i < 3; i++) { await send('HeapProfiler.collectGarbage').catch(() => {}); await sleep(400) }
    await sleep(600)
  }

  const out = {
    target: { url: target.url, title: target.title, targetId: target.targetId },
    gcPerformed: opts.gc,
  }

  // 1) V8 侧
  const heapUsage = await send('Runtime.getHeapUsage').catch((e) => ({ error: String(e.message) }))
  if (!heapUsage.error) {
    out.v8 = {
      usedMB: MB(heapUsage.usedSize),
      totalMB: MB(heapUsage.totalSize),
      embedderMB: MB(heapUsage.embedderHeapUsedSize),
      backingStorageMB: MB(heapUsage.backingStorageSize),
    }
  }
  const v8stats = await send('Runtime.getHeapStatistics').catch(() => null)
  if (v8stats) {
    out.v8.stats = {
      heapSizeLimitMB: MB(v8stats.heap_size_limit),
      totalHeapSizeMB: MB(v8stats.total_heap_size),
      totalAvailableMB: MB(v8stats.total_available_size),
      mallocedMB: MB(v8stats.malloced_memory),
      peakMallocedMB: MB(v8stats.peak_malloced_memory),
      externalMemoryMB: MB(v8stats.external_memory),
      numberOfNativeContexts: v8stats.number_of_native_contexts,
      numberOfDetachedContexts: v8stats.number_of_detached_contexts,
      totalGlobalHandlesMB: MB(v8stats.total_global_handles_size),
    }
  }
  const codeStats = await send('Runtime.getIsolateId').catch(() => null)
  void codeStats

  // 2) Blink / 渲染管线（Performance 域必须先 enable，否则 getMetrics 返回空数组）
  await send('Performance.enable').catch(() => {})
  const metrics = await send('Performance.getMetrics').catch(() => null)
  if (metrics) {
    out.blink = {}
    for (const m of metrics.metrics) {
      if (/Heap|Node|Document|Frame|Script|Resource|StyleSheet|Layout|Recalc/i.test(m.name)) {
        out.blink[m.name] = /Size|Contents/.test(m.name) ? MB(m.value) : m.value
      }
    }
  }
  const domCounters = await send('Memory.getDOMCounters').catch(() => null)
  if (domCounters) out.domCounters = domCounters

  // 3) 渲染进程的真实内存（任务管理器口径）：private footprint / resident / peak
  const processMemory = await send('Memory.getProcessMemory').catch(() => null)
  if (processMemory) {
    out.rendererProcessMemory = {}
    for (const [key, value] of Object.entries(processMemory)) {
      out.rendererProcessMemory[key] = {
        count: value.count,
        averageMB: MB(value.average),
        minMB: MB(value.min),
        maxMB: MB(value.max),
        sumMB: MB(value.sum),
      }
    }
  }

  // 4) 浏览器进程级物理内存
  const processInfo = await browser.send('SystemInfo.getProcessInfo').catch(() => null)
  if (processInfo) {
    out.processes = processInfo.processInfo
      .map((p) => ({ type: p.type, id: p.id, cpuTimeSec: +(p.cpuTime || 0).toFixed(1) }))
      .sort((a, b) => b.cpuTimeSec - a.cpuTimeSec)
    out.processCount = out.processes.length
  }

  // 4) 页面自身能看到的（navigator.deviceMemory 之类只作参考）
  const evalRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      ua: navigator.userAgent,
      deviceMemory: navigator.deviceMemory || null,
      perfMemory: performance.memory ? {
        usedJSHeapMB: +(performance.memory.usedJSHeapSize/1048576).toFixed(2),
        totalJSHeapMB: +(performance.memory.totalJSHeapSize/1048576).toFixed(2),
        limitMB: +(performance.memory.jsHeapSizeLimit/1048576).toFixed(2)
      } : null
    })`,
    returnByValue: true,
  }).catch(() => null)
  if (evalRes && evalRes.result && evalRes.result.value) out.page = JSON.parse(evalRes.result.value)

  console.log(JSON.stringify(out, null, 2))
  browserWs.close()
}

main().catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exitCode = 1 })
