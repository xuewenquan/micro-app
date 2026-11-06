'use strict'

/**
 * 通过 CDP 监听页面控制台输出 —— 用于读取运行期的诊断日志。
 *
 * 为什么需要单独一个脚本：`cdp_heap_snapshot.js` 只启用 `HeapProfiler` 域，
 * 刻意不启用 `Runtime`/`Log`，因为那些域自身会保留对象、污染内存读数。
 * 但**读日志**必须启用 `Runtime`，所以两者分开，各用各的。
 *
 * 注意：本脚本会保留 console 的参数对象（这是 Runtime 域的固有行为），
 * 因此**不要在跑它的同时抓内存快照**。只用来读日志。
 *
 * 用法：
 *   node scripts/cdp_console_watch.js --match=micro-app --seconds=900
 *
 * 参数：
 *   --match=<substr>   只打印拼接后包含该子串的消息，默认 'micro-app'
 *   --seconds=<n>      监听时长，默认 900 秒；到点自动退出
 *   --until=<substr>   一旦出现该子串就立即退出（用于「等到某条日志出现」）
 *   --port=<n>         调试端口，默认 9222
 *   --url-match=<s>    多标签时选择页面的子串
 *   --all              不过滤，打印全部控制台消息
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs (argv) {
  const out = { port: 9222, seconds: 900, match: 'micro-app', until: null, urlMatch: null, all: false }
  for (const arg of argv) {
    if (arg === '--all') out.all = true
    else if (arg.startsWith('--match=')) out.match = arg.slice(8)
    else if (arg.startsWith('--seconds=')) out.seconds = Number(arg.slice(10))
    else if (arg.startsWith('--until=')) out.until = arg.slice(8)
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
  }
  return out
}

/** 与 cdp_heap_snapshot.js 相同的 WebSocket 兼容层（ws 包 / Node≥22 内置）。 */
function connect (url) {
  let WS = null
  try { WS = require('ws') } catch (_) { /* 仓库里没有就退回内置实现 */ }
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

async function pickTarget ({ port, urlMatch }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`无法访问调试端口 ${port}，请确认 Chrome 以 --remote-debugging-port=${port} 启动`)
  const targets = await res.json()
  const pages = targets.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''))
  if (!pages.length) throw new Error('没有找到 http(s) 页面标签')
  if (urlMatch) {
    const hit = pages.find((t) => (t.url || '').includes(urlMatch))
    if (!hit) throw new Error(`没有匹配 --url-match=${urlMatch} 的标签，现有：${pages.map((p) => p.url).join(', ')}`)
    return hit
  }
  return pages[0]
}

/** 把 CDP 的 RemoteObject 还原成可读字符串。 */
function renderArg (arg) {
  if (!arg) return ''
  if (arg.type === 'string') return arg.value
  if ('value' in arg) return JSON.stringify(arg.value)
  if (arg.unserializableValue) return String(arg.unserializableValue)
  if (arg.description) return arg.description
  return `<${arg.type}>`
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const target = await pickTarget(opts)
  process.stderr.write(`监听页面: ${target.url}\n`)
  process.stderr.write(`过滤: ${opts.all ? '(全部)' : opts.match}  时长: ${opts.seconds}s\n`)

  const ws = connect(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  let hits = 0
  let stopReason = null

  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map(renderArg).join(' ')
      if (opts.all || text.includes(opts.match)) {
        hits++
        const stamp = new Date(msg.params.timestamp || Date.now()).toISOString().slice(11, 23)
        console.log(`[${stamp}] ${String(msg.params.type).padEnd(7)} ${text}`)
        if (opts.until && text.includes(opts.until)) stopReason = 'until'
      }
      return
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry || {}
      const text = `${e.level || ''} ${e.text || ''}`
      if (opts.all || text.includes(opts.match)) {
        hits++
        console.log(`[log] ${text}`)
      }
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result)
    }
  })

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (error) => reject(new Error(`CDP WebSocket 连接失败: ${error && error.message ? error.message : error}`)))
  })

  await send('Runtime.enable')
  await send('Log.enable')
  process.stderr.write('已开始监听。请在页面里完成一轮操作。\n')

  const deadline = Date.now() + opts.seconds * 1000
  while (Date.now() < deadline && stopReason !== 'until') await sleep(250)

  process.stderr.write(`\n结束：命中 ${hits} 条${stopReason === 'until' ? '（因 --until 提前退出）' : '（到时退出）'}\n`)
  ws.close()
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
})
