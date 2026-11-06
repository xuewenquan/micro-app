'use strict'

/**
 * 通过 Chrome DevTools Protocol 抓堆快照 —— **不打开 DevTools 前端**。
 *
 * 为什么要这样做：
 *   DevTools 的 Memory 面板会启用 InspectorCSSAgent / InspectorDOMAgent / Runtime(console)
 *   等 agent，它们自身会持有可观的内存（实测某次快照里 blink::InspectorCSSAgent 独占 6.3 MB），
 *   并且被 console 打印过的 Error 对象会被长期保留、连带钉住其栈上捕获的整个作用域链。
 *   这条路径只建立 inspector 会话 + 启用 HeapProfiler，不启用上面那些 agent。
 *
 * 用法：
 *   1) 先完全退出 Chrome，再用调试端口启动（--user-data-dir 必须给，否则端口不生效）：
 *        "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
 *          --remote-debugging-port=9222 ^
 *          --user-data-dir="%TEMP%\chrome-heap-profile" ^
 *          --js-flags="--expose-gc" ^
 *          http://localhost:3000
 *      （Edge 同理，换成 msedge.exe）
 *   2) 在这个窗口里手工操作应用，走到你想观测的状态
 *   3) 抓快照：
 *        node scripts/cdp_heap_snapshot.js --out=E:/Heap-round1.heapsnapshot --gc
 *
 * 参数：
 *   --out=<path>            必填，输出文件
 *   --gc                    抓之前强制 GC（建议开；会做两轮并等待，让终结器跑完）
 *   --port=<n>              调试端口，默认 9222
 *   --url-match=<substr>    选择哪个页面标签，默认取第一个 http(s) 页面
 *   --settle=<ms>           GC 后的等待时间，默认 800
 */

const fs = require('fs')

function parseArgs (argv) {
  const out = { port: 9222, settle: 800, urlMatch: null, gc: false, out: null }
  for (const arg of argv) {
    if (arg === '--gc') out.gc = true
    else if (arg.startsWith('--out=')) out.out = arg.slice(6)
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--settle=')) out.settle = Number(arg.slice(9))
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 兼容两种 WebSocket 实现：
 *  - 仓库里的 `ws` 包（Node 20 也能用，事件用 .on()）
 *  - Node ≥ 22 的内置全局 WebSocket（事件用 addEventListener）
 * 统一成 on(name, handler)，message 一律给字符串。
 */
function connect (url) {
  let WS = null
  try { WS = require('ws') } catch (_) { /* 仓库里没有就退回内置实现 */ }
  if (!WS) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('需要 Node ≥ 22（内置 WebSocket）或在仓库内安装 ws 包')
    }
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

  return {
    on: (name, fn) => handlers[name].push(fn),
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
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

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.out) throw new Error('必须指定 --out=<path>')

  const target = await pickTarget(opts)
  process.stderr.write(`目标页面: ${target.url}\n`)

  const ws = connect(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  /**
   * 分片**直接流式写入文件**，不要先累积成数组再 join('')。
   *
   * 踩过的坑：V8 的字符串长度上限约 5.36 亿字符（kMaxStringLength），而真实应用的
   * 快照经常超过 1 GB —— `chunks.join('')` 会直接抛
   * `RangeError: Invalid string length`，而且是在抓了整份快照之后才炸。
   */
  const out = fs.createWriteStream(opts.out)
  let writeError = null
  out.on('error', (error) => { writeError = writeError || error })

  let snapshotBytes = 0
  let sawStrings = false
  let tail = ''
  let finishedReported = false
  let lastChunkAt = Date.now()

  /**
   * 等待写入缓冲排空。`write()` 在缓冲满时返回 false，此时必须挂到 `drain` 上。
   * 忽略返回值不会丢数据，但会把整份快照堆进 Node 堆（真实快照可达 2.5 GB），
   * 而真正的危险在收尾：见下方 takeHeapSnapshot 之后的注释。
   */
  const writeChunk = (chunk) => new Promise((resolve) => {
    if (writeError) return resolve()
    if (out.write(chunk)) return resolve()
    // 三个出口都要接：只挂 drain 的话，一旦流在等待期间出错/关闭就会永久挂起。
    const done = () => {
      out.removeListener('drain', done)
      out.removeListener('error', done)
      out.removeListener('close', done)
      resolve()
    }
    out.once('drain', done)
    out.once('error', done)
    out.once('close', done)
  })

  // 分片必须**按到达顺序**串行落盘，所以用一条 Promise 链排队，而不是直接并发 write。
  let writeQueue = Promise.resolve()

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      const chunk = msg.params.chunk
      snapshotBytes += Buffer.byteLength(chunk)
      lastChunkAt = Date.now()
      // 跨分片探测 "strings":[ 与结尾的 '}'。分片边界可能正好切在标记中间，
      // 所以保留 16 字节尾巴与下一片拼接后再判断。
      const probe = tail + chunk
      if (!sawStrings && probe.includes('"strings":[')) sawStrings = true
      tail = probe.slice(-16)
      writeQueue = writeQueue.then(() => writeChunk(chunk))
      return
    }
    if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress') {
      if (msg.params && msg.params.finished) finishedReported = true
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

  await send('HeapProfiler.enable')

  if (opts.gc) {
    // 两轮 GC + 等待：让 FinalizationRegistry / WeakRef 的清理跑完，
    // 否则上一轮的残留会混进这一轮的观测值。
    await send('HeapProfiler.collectGarbage')
    await sleep(opts.settle)
    await send('HeapProfiler.collectGarbage')
    await sleep(opts.settle)
    process.stderr.write(`已强制 GC（settle=${opts.settle}ms ×2）\n`)
  }

  process.stderr.write('正在抓取堆快照…\n')
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: true })

  /**
   * 关键：命令响应**不等于**分片已经写完。
   *
   * 实测踩过：报告写入 1915 MB，落盘只有 880 MB，文件停在 edges 数组中间、
   * `"strings":` 段整个缺失，下游 heap_metrics.js 抛
   * `Marker not found: "strings":[`。同目录另一份由别的脚本抓的快照同样截断
   * （而那份日志里明确打了 `finished=true`），说明这是写入方共有的收尾问题，
   * 不是某一方的偶发。
   *
   * 所以这里等三重信号：V8 的 finished 进度事件 → 分片静默 → 写队列排空。
   */
  const deadline = Date.now() + 10 * 60 * 1000
  while (!finishedReported && Date.now() < deadline) {
    if (Date.now() - lastChunkAt > 3000) break
    await sleep(200)
  }
  await writeQueue
  await new Promise((resolve) => out.end(resolve))
  if (writeError) throw writeError

  // 落盘后自检。与其让下游脚本抛一句莫名其妙的 "Marker not found"，
  // 不如在这里就明确失败——**截断的快照比没有快照更危险，它会被当成有效数据**。
  if (!sawStrings || !tail.trimEnd().endsWith('}')) {
    throw new Error(
      `快照不完整（文件已保留供排查）：${opts.out}\n` +
      `  收到 ${(snapshotBytes / 1048576).toFixed(1)} MB，末端为 ${JSON.stringify(tail)}（应以 '}' 结尾），` +
      `strings 段${sawStrings ? '已' : '未'}出现。\n` +
      '  常见原因：背压导致写入未及落盘就结束、页面过大抓取中断、磁盘空间不足。'
    )
  }
  process.stderr.write(`已写入 ${opts.out}（${(snapshotBytes / 1048576).toFixed(1)} MB）\n`)

  ws.close()
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
})
