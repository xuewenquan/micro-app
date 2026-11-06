'use strict'

/**
 * 临时诊断工具：在目标页面里跑一段表达式并把结果按 JSON 打回来。
 *
 * 刻意只启用 `Runtime` 域，**不启用 HeapProfiler**——同样地，抓堆快照时也不要
 * 和本工具同时跑（见 cdp_heap_snapshot.js 的说明）。
 *
 * 用法：
 *   node scripts/_diag_eval.js "JSON.stringify({a:1})"
 *   node scripts/_diag_eval.js --url-match=wd/ "location.href"
 *   node scripts/_diag_eval.js --file=<本地 js 文件>     # 从文件读表达式，避免命令行转义
 *   node scripts/_diag_eval.js --await --file=<文件>      # 表达式是 async IIFE 时必加 --await
 *
 * 表达式必须是「能返回字符串」的形式（内部用 returnByValue + JSON.parse）。
 */

const fs = require('fs')

function parseArgs (argv) {
  const out = { port: 9222, urlMatch: null, file: null, expr: null, awaitPromise: false, timeout: 120000 }
  for (const arg of argv) {
    if (arg === '--await') out.awaitPromise = true
    else if (arg.startsWith('--timeout=')) out.timeout = Number(arg.slice(10))
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--file=')) out.file = arg.slice(7)
    else if (!out.expr) out.expr = arg
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

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const expression = opts.file ? fs.readFileSync(opts.file, 'utf8') : opts.expr
  if (!expression) throw new Error('需要给出表达式，或用 --file=<文件>')

  const res = await fetch(`http://127.0.0.1:${opts.port}/json/list`)
  if (!res.ok) throw new Error(`无法访问调试端口 ${opts.port}`)
  const targets = await res.json()
  const pages = targets.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''))
  if (!pages.length) throw new Error('没有找到 http(s) 页面标签')
  const target = opts.urlMatch
    ? pages.find((t) => (t.url || '').includes(opts.urlMatch))
    : pages[0]
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

  await send('Runtime.enable')
  // 表达式是 async IIFE 时必须 awaitPromise，否则拿到的是 Promise 对象（returnByValue 会变成 {}）
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: opts.awaitPromise, timeout: opts.timeout })
  if (r.exceptionDetails) {
    process.stderr.write(`页面内求值异常: ${r.exceptionDetails.text || ''} ${(r.exceptionDetails.exception || {}).description || ''}\n`)
  }
  // 同 mf_acceptance.js：Runtime.enable 会让 V8 保留 console 消息里的对象，
  // 污染后续堆快照（`(Global handles) ... / DevTools console`）。关连接前清掉。
  try { await send('Runtime.discardConsoleEntries') } catch (_) {}
  try { await send('Runtime.disable') } catch (_) {}

  const value = r.result && r.result.value
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
  process.stdout.write('\n')
  process.stderr.write(`目标: ${target.url}\n`)
  ws.close()
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
})
