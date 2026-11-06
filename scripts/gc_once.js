'use strict'

/**
 * 触发目标页面的 Full GC，并把前后堆用量打出来。用于自己观察内存变化。
 *
 * 做的是 `HeapProfiler.collectGarbage` —— 这是 **V8 的 full GC**，比 DevTools
 * Memory 面板上那个垃圾桶按钮更强（垃圾桶只是建议 GC）。
 *
 * 用法：
 *   # 做 3 次 GC，打印前后用量
 *   node scripts/gc_once.js
 *
 *   # 每 5 秒 GC 一次，一直跑（Ctrl+C 退出）—— 适合盯着任务管理器看
 *   node scripts/gc_once.js --loop --interval=5000
 *
 *   # 指定端口 / 多标签时选页面 / 多做几次
 *   node scripts/gc_once.js --port=9222 --url-match=localhost:3000 --times=5
 *
 * 参数：
 *   --port=<n>         调试端口，默认 9222
 *   --times=<n>        每次调用做几次 GC，默认 3
 *   --url-match=<s>    多标签时按 URL 子串选页面
 *   --loop             循环执行（配合 --interval）
 *   --interval=<ms>    --loop 的间隔，默认 5000
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs (argv) {
  const out = { port: 9222, times: 3, urlMatch: null, targetId: null, clearConsole: false, loop: false, interval: 5000 }
  for (const arg of argv) {
    if (arg === '--loop') out.loop = true
    else if (arg === '--clear-console') out.clearConsole = true
    else if (arg.startsWith('--target-id=')) out.targetId = arg.slice(12)
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--times=')) out.times = Number(arg.slice(8))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--interval=')) out.interval = Number(arg.slice(11))
  }
  return out
}

function connect (url) {
  let WS = null
  try { WS = require('ws') } catch (_) { /* 退回内置实现 */ }
  if (!WS) {
    if (typeof WebSocket === 'undefined') throw new Error('需要 Node ≥ 22（内置 WebSocket）或在仓库内安装 ws 包')
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

const mb = (bytes) => (bytes / 1048576).toFixed(2)

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  // Diagnostic control only: never silently erase Console history every round.
  if (opts.clearConsole && opts.loop) throw new Error('--clear-console cannot be combined with --loop; use a single diagnostic pass')

  const res = await fetch(`http://127.0.0.1:${opts.port}/json/list`)
  if (!res.ok) throw new Error(`无法访问调试端口 ${opts.port}，请确认 Chrome 以 --remote-debugging-port=${opts.port} 启动`)
  const targets = await res.json()
  const pages = targets.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''))
  if (!pages.length) throw new Error('没有找到 http(s) 页面标签')
  const candidates = pages.filter((t) =>
    (!opts.urlMatch || (t.url || '').includes(opts.urlMatch)) &&
    (!opts.targetId || t.id === opts.targetId))
  if (opts.clearConsole && candidates.length !== 1) {
    throw new Error(`Console cleanup requires exactly one page; found ${candidates.length}. Use --url-match or --target-id. Candidates: ${JSON.stringify(candidates.map(t => ({ id: t.id, url: t.url })))}`)
  }
  const target = candidates[0]
  if (!target) throw new Error(`没有匹配 --url-match=${opts.urlMatch} 的标签，现有：${pages.map((p) => p.url).join(', ')}`)

  const ws = connect(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result)
    }
  })
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (error) => reject(new Error(`CDP 连接失败: ${error && error.message ? error.message : error}`)))
  })

  // 只开 HeapProfiler。**不要开 Runtime** —— Runtime.enable 会让 V8 保留 console
  // 消息里的对象，把堆读数抬高（报告 §13.10/§13.11 记录过，量级能到 4 万句柄）。
  await send('HeapProfiler.enable')

  const pass = async () => {
    const before = await send('Runtime.getHeapUsage').catch(() => null)
    // GC cannot collect objects still held by Console. Avoid Runtime.enable:
    // discard existing Console/exception entries explicitly, then measure GC.
    // This affects debugging history, not app state, and is not a product fix.
    if (opts.clearConsole) {
      await send('Runtime.discardConsoleEntries')
      console.log('Discarded target Console/exception entries before GC (diagnostic control).')
    }
    for (let i = 0; i < opts.times; i++) {
      await send('HeapProfiler.collectGarbage')
      await sleep(400)
    }
    await sleep(600)
    const after = await send('Runtime.getHeapUsage').catch(() => null)
    const stamp = new Date().toISOString().slice(11, 19)
    if (before && after) {
      const freed = (before.usedSize - after.usedSize) / 1048576
      console.log(
        `[${stamp}] GC×${opts.times}  used ${mb(before.usedSize)} → ${mb(after.usedSize)} MB` +
        `   (释放 ${freed.toFixed(2)} MB)` +
        `   total ${mb(after.totalSize)} MB`
      )
    } else {
      console.log(`[${stamp}] GC×${opts.times} 已执行`)
    }
  }

  console.log(`目标: ${target.url}`)

  if (!opts.loop) {
    await pass()
    ws.close()
    return
  }

  console.log(`循环 GC 中，每 ${opts.interval} ms 一次（Ctrl+C 退出）…`)
  let stopping = false
  process.on('SIGINT', () => { stopping = true; ws.close(); process.exit(0) })
  while (!stopping) {
    await pass()
    await sleep(opts.interval)
  }
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
})
