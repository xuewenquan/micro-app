'use strict'

/**
 * 临时诊断脚本：复刻 cdp_heap_snapshot.js 的写入路径（不处理背压、同样 String(data)），
 * 但加上观测：progress 事件、chunk 计数、ws close、以及最后校验文件是否以 `]}` 收尾。
 * 目的：判断「文件被截断」是 Chrome 主动结束（finished=true 但 JSON 不完整），
 * 还是传输中断（没收到 finished / 收到 close）。用完即删。
 *
 * 用法: node scripts/_diag_capture.js --out=<path> [--port=9222] [--url-match=...] [--settle=800]
 */

const fs = require('fs')

function parseArgs (argv) {
  const out = { port: 9222, settle: 800, urlMatch: null, out: null }
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out.out = arg.slice(6)
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--settle=')) out.settle = Number(arg.slice(9))
  }
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ts = () => new Date().toISOString().slice(11, 23)
const log = (...a) => process.stderr.write(`[${ts()}] ${a.join(' ')}\n`)

function connect (url) {
  const WS = require('ws')
  const socket = new WS(url)
  const handlers = { message: [], open: [], error: [], close: [] }
  const emit = (name, payload) => handlers[name].slice().forEach((fn) => fn(payload))
  socket.on('message', (data) => emit('message', String(data)))
  socket.on('open', () => emit('open'))
  socket.on('error', (error) => emit('error', error))
  socket.on('close', (code, reason) => emit('close', { code, reason: String(reason || '') }))
  return {
    on: (name, fn) => handlers[name].push(fn),
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
}

async function pickTarget ({ port, urlMatch }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await res.json()
  const pages = targets.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''))
  if (urlMatch) {
    const hit = pages.find((t) => (t.url || '').includes(urlMatch))
    if (!hit) throw new Error('no matching target')
    return hit
  }
  return pages[0]
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const target = await pickTarget(opts)
  log('target:', target.url)

  const ws = connect(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  const out = fs.createWriteStream(opts.out)
  const writeErrors = []
  out.on('error', (e) => { writeErrors.push(e); log('WRITE ERROR:', e.message) })

  let snapshotBytes = 0
  let chunkCount = 0
  let lastChunkSize = 0
  const chunkSizes = new Map()
  let progressFinished = false
  let progressLastDone = 0
  let progressLastTotal = 0
  let progressEvents = 0
  let takeDone = false
  let closed = null
  let afterTakeBytes = 0
  let lastChunkAt = Date.now()

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  ws.on('close', (info) => { closed = info; log('WS CLOSE:', JSON.stringify(info)) })
  ws.on('error', (e) => log('WS ERROR:', e && e.message))

  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      const len = Buffer.byteLength(msg.params.chunk)
      snapshotBytes += len
      chunkCount++
      lastChunkSize = len
      chunkSizes.set(len, (chunkSizes.get(len) || 0) + 1)
      if (takeDone) afterTakeBytes += len
      lastChunkAt = Date.now()
      out.write(msg.params.chunk)
      if (chunkCount % 2000 === 0) log(`chunks=${chunkCount} bytes=${(snapshotBytes / 1048576).toFixed(1)}MB`)
      return
    }
    if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress') {
      progressEvents++
      const p = msg.params || {}
      progressLastDone = p.done
      progressLastTotal = p.total
      if (p.finished) progressFinished = true
      if (p.finished || progressEvents % 20 === 0) {
        log(`progress done=${p.done} total=${p.total} finished=${p.finished}`)
      }
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.method === undefined && msg.id === 4) takeDone = true
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result)
    }
  })

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (e) => reject(e))
  })

  await send('HeapProfiler.enable')
  await send('HeapProfiler.collectGarbage')
  await sleep(opts.settle)
  await send('HeapProfiler.collectGarbage')
  await sleep(opts.settle)
  log('GC done, taking snapshot (reportProgress=true)…')

  const takeStart = Date.now()
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: true })
  const takeMs = Date.now() - takeStart
  log(`takeHeapSnapshot response received after ${(takeMs / 1000).toFixed(1)}s`)
  log(`after response: chunks=${chunkCount} bytes=${snapshotBytes} (${(snapshotBytes / 1048576).toFixed(1)}MB) trailingBytesAfterResponse=${afterTakeBytes}`)
  log(`last chunk size=${lastChunkSize}  gap since last chunk=${Date.now() - lastChunkAt}ms`)

  log('waiting 1.5s to see if more chunks / close arrive…')
  const beforeWait = snapshotBytes
  await sleep(1500)
  if (snapshotBytes !== beforeWait) log(`MORE CHUNKS after response: +${snapshotBytes - beforeWait}`)
  else log('no chunks after response')

  await new Promise((resolve) => out.end(resolve))
  log('write stream finished. writeErrors=', writeErrors.length)
  log(`progressEvents=${progressEvents} last done=${progressLastDone} total=${progressLastTotal} finished=${progressFinished}`)
  log(`closed=${JSON.stringify(closed)}`)
  log(`total chunks=${chunkCount} bytes=${snapshotBytes} file=${fs.statSync(opts.out).size}`)

  const sizes = [...chunkSizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  log('top chunk sizes (size:count):', sizes.map(([s, c]) => `${s}:${c}`).join(' '))

  // 结尾校验：完整快照一定以 "]} 收尾
  const size = fs.statSync(opts.out).size
  const fd = fs.openSync(opts.out, 'r')
  const tail = Buffer.alloc(8)
  fs.readSync(fd, tail, 0, 8, size - 8)
  fs.closeSync(fd)
  const ok = tail.toString('utf8').trim().endsWith(']}')
  log(`TAIL="${JSON.stringify(tail.toString('utf8'))}" COMPLETE=${ok}`)

  ws.close()
  process.exitCode = ok ? 0 : 2
}

main().catch((e) => {
  log('FATAL:', String(e && e.message ? e.message : e))
  process.exitCode = 1
})
