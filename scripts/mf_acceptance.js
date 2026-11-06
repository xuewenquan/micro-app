'use strict'

/**
 * 真实浏览器多轮 GC 验收：把"开子应用 → 关子应用"这件事自动化，每轮之后强制 GC
 * 并抓一份堆快照 + 指标，追加到 <out-dir>/baseline.jsonl。
 *
 * 为什么要有它：round-1…10 那批基线是**人工**开关 tab 得来的，轮次之间工作集不可控
 * （活沙箱数虽然都是 3，但挂载了几次、挂了哪些，无法复现）。这个脚本把每一轮变成
 * 同一段可复现的动作，才能判断"修复后还会不会累积"。
 *
 * 用法：
 *   node scripts/mf_acceptance.js --out-dir=E:/heap-accept --rounds=6
 *        [--url-match=wd/] [--away-wait=14000] [--back-wait=9000] [--destroy-prefix=wonder-ws-web,SES2-]
 *        [--apps=mftest-ws|http://ws.dev.wonder10.com/,mftest-issues|http://issues.dev.wonder10.com/]
 *
 * 每一轮的动作：
 *   1) 清理上一轮残留（移除 #mf-test-host 下所有 micro-app）
 *   2) 一次性挂载 --apps 里的全部子应用
 *   3) 等 --mount-wait，统计实际挂载成功的个数（挂载失败的轮次会被标记，避免误判）
 *   4) 移除 host（触发 unmount）
 *   5) 等 --unmount-wait
 *   6) cdp_heap_snapshot.js --gc 抓快照；heap_metrics.js 算指标并追加
 *
 * 注意：**步骤 6 的抓取脚本自己会开 CDP 连接，所以本脚本在步骤 6 之前必须关掉连接**
 * （HeapProfiler 与 Runtime 同时挂会污染内存读数）。
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

/**
 * 轮次用**路由**驱动，不自己造 DOM。
 *
 * 早先的做法是往页面里 append `<micro-app>` 元素再 remove —— 那是错的：
 *   1. 基座是 Vue 应用，注入它管理的 DOM 会让它重复渲染（实测把 6 个元素变成 12 个）；
 *   2. `disconnectedCallback` 的默认 `destroy = false`，移除元素只走 stop、不走 destroy，
 *      和真实"关掉功能页"的语义不一致。
 * 改成 `router.push` 切走再切回：基座自己卸载/重挂它自己的子应用，这就是原始基线里
 * "开几个 tab 再关掉"的等价动作，而且可复现。
 */
const DEFAULT_ROUTES = [
  '/work_flow/wd/bpm/todo',
  '/work_flow/wd/bpm/supervise',
  '/work_flow/wd/bpm/completeddetails',
]
const HOME = '/wd/ws'

function parseArgs (argv) {
  const out = {
    port: 9222, urlMatch: null, outDir: null, rounds: 6,
    mountWait: 14000, unmountWait: 9000, routes: DEFAULT_ROUTES, home: HOME, label: null, destroyPrefix: null,
  }
  for (const arg of argv) {
    if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice(10)
    else if (arg.startsWith('--rounds=')) out.rounds = Number(arg.slice(9))
    // 语义命名：awayWait = 切走之后等多久（让卸载完成），backWait = 切回之后等多久（让重挂完成）
    else if (arg.startsWith('--away-wait=')) out.mountWait = Number(arg.slice(12))
    else if (arg.startsWith('--back-wait=')) out.unmountWait = Number(arg.slice(12))
    else if (arg.startsWith('--mount-wait=')) out.mountWait = Number(arg.slice(13))
    else if (arg.startsWith('--unmount-wait=')) out.unmountWait = Number(arg.slice(15))
    else if (arg.startsWith('--label=')) out.label = arg.slice(8)
    else if (arg.startsWith('--routes=')) out.routes = arg.slice(9).split(',').filter(Boolean)
    else if (arg.startsWith('--home=')) out.home = arg.slice(7)
    else if (arg.startsWith('--destroy-prefix=')) out.destroyPrefix = arg.slice(17).split(',').filter(Boolean)
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

async function pickTarget ({ port, urlMatch }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`无法访问调试端口 ${port}`)
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

/** 开一次 CDP 连接、跑一段 async 表达式、返回解析后的值，然后关连接。 */
async function evalOnce (opts, expression) {
  const target = await pickTarget(opts)
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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 300000 })
  /**
   * 关键：`Runtime.enable` 会让 V8 开始保留 console 消息里的对象（在堆里表现为
   * `(Global handles) --internal:<n> / DevTools console-->`）。实测一轮下来能累积到
   * 4 万条量级，且会污染"谁持有 X"的答案（见报告 §13.9 / §13.10）。
   * 关连接前显式丢弃 + 关闭 Runtime 域，让下一轮的快照尽可能干净。
   */
  try { await send('Runtime.discardConsoleEntries') } catch (_) {}
  try { await send('Runtime.disable') } catch (_) {}
  ws.close()
  if (r.exceptionDetails) throw new Error(`页面内异常: ${r.exceptionDetails.text || ''} ${(r.exceptionDetails.exception || {}).description || ''}`)
  const v = r.result && r.result.value
  return typeof v === 'string' ? JSON.parse(v) : v
}

/** 一轮：从 home 切到 target（触发卸载）→ 再切回 home（触发重挂）。只返回统计。 */
function roundScript (target, home, awayWait, backWait, destroyPrefix) {
  return `(async () => {
    const app = document.querySelector('#app').__vue_app__
    const router = app.config.globalProperties.$router
    const names = () => [].map.call(document.querySelectorAll('micro-app'), e => e.getAttribute('name'))
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const out = { target: ${JSON.stringify(target)}, home: ${JSON.stringify(home)} }

    // 确保从 home 出发
    if (router.currentRoute.value.fullPath !== out.home) {
      await router.push(out.home); await sleep(${backWait})
    }
    out.startCount = names().length
    out.startNames = names()

    // 终态 destroy 路径：给会被卸载的元素加 destroy 属性，让 disconnectedCallback
    // 走 unmount(destroy=true) → actionsForCompletelyDestroy()，而不是只 stop。
    // 只加在 --destroy-prefix 指定的前缀上，避免误伤常驻的全局应用。
    if (${JSON.stringify(destroyPrefix)}) {
      const prefixes = ${JSON.stringify(destroyPrefix || [])}
      out.destroyTagged = []
      document.querySelectorAll('micro-app').forEach(el => {
        const n = el.getAttribute('name') || ''
        if (prefixes.some(p => n.startsWith(p))) { el.setAttribute('destroy', ''); out.destroyTagged.push(n) }
      })
    }

    await router.push(out.target)
    await sleep(${awayWait})
    out.awayCount = names().length
    out.awayNames = names()

    await router.push(out.home)
    await sleep(${backWait})
    out.backCount = names().length
    out.backNames = names()
    out.remounted = out.backNames.filter(n => !out.awayNames.includes(n))
    return JSON.stringify(out)
  })()`
}

function readRounds (jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return []
  return fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch (_) { return null } }).filter(Boolean)
}

function printTable (rows) {
  const header = ['label', 'heapMB', 'Δheap', 'nodes', 'Δnodes', 'detached', 'console句柄', 'cWin', 'cApp', 'destroyed', 'apps', 'mounted']
  const body = rows.map((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null
    const d = (a, b) => (a == null || b == null) ? '' : (a - b >= 0 ? '+' : '') + (a - b)
    return [
      String(row.label), row.heapSelfMB == null ? '-' : row.heapSelfMB.toFixed(1),
      prev ? d(row.heapSelfMB, prev.heapSelfMB) : '',
      String(row.nodeCount ?? '-'), prev ? d(row.nodeCount, prev.nodeCount) : '',
      String(row.detachedDOM ?? '-'), String(row.consoleHandles ?? '-'), String(row.customWindow ?? '-'),
      String(row.createApp ?? '-'), String(row.createAppDestroyed ?? '-'),
      String(row.apps ?? '-'), String(row.acceptance ? (row.acceptance.startCount + '→' + row.acceptance.awayCount + '→' + row.acceptance.backCount) : '-'),
    ]
  })
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)))
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  console.log('')
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  body.forEach((r) => console.log(line(r)))
  console.log('')
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.outDir) throw new Error('必须指定 --out-dir')
  const outDir = path.resolve(opts.outDir)
  fs.mkdirSync(outDir, { recursive: true })
  const jsonlPath = path.join(outDir, 'baseline.jsonl')
  const rows = readRounds(jsonlPath)

  console.log(`目标页面匹配: ${opts.urlMatch || '(第一个标签)'}`)
  console.log(`轮转路由: ${opts.routes.join(' / ')}   返回: ${opts.home}`)
  console.log('')

  for (let round = 1; round <= opts.rounds; round++) {
    const label = opts.label ? `${opts.label}-${round}` : `acc-${round}`
    process.stdout.write(`[${label}] 挂载/卸载子应用…\n`)
    const target = opts.routes[(round - 1) % opts.routes.length]
    const acc = await evalOnce(opts, roundScript(target, opts.home, opts.mountWait, opts.unmountWait, opts.destroyPrefix))
    process.stdout.write(`[${label}] 切到 ${acc.target}: ${acc.startCount} → ${acc.awayCount} 个应用；切回: ${acc.backCount} 个\n`)

    const snapshotPath = path.join(outDir, `${label}.heapsnapshot`)
    process.stdout.write(`[${label}] 抓快照（含强制 GC）…\n`)
    const snap = spawnSync(process.execPath, ['--max-old-space-size=16384', path.join(__dirname, 'cdp_heap_snapshot.js'),
      `--out=${snapshotPath}`, `--port=${opts.port}`, '--gc', '--settle=1200'].concat(opts.urlMatch ? [`--url-match=${opts.urlMatch}`] : []), { stdio: 'inherit' })
    if (snap.status !== 0) throw new Error('抓快照失败')

    process.stdout.write(`[${label}] 计算指标…\n`)
    const metrics = spawnSync(process.execPath, ['--max-old-space-size=16384', path.join(__dirname, 'heap_metrics.js'), snapshotPath, `--label=${label}`],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    if (metrics.status !== 0 || !metrics.stdout) throw new Error('指标计算失败')
    const row = JSON.parse(metrics.stdout.trim().split('\n').pop())
    row.acceptance = acc
    fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n', 'utf8')
    rows.push(row)
    printTable(rows)
  }

  console.log(`已追加到 ${jsonlPath}`)
}

main().catch((error) => { console.error(String(error && error.message ? error.message : error)); process.exitCode = 1 })
