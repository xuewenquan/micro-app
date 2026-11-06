'use strict'
// 导航到指定 URL → 等加载完成 → 强制 GC ×2 → 报告 V8 堆用量。
// 用来判定"整页导航是否释放残留"：与 Runtime.getHeapUsage() 同口径（usedSize）。
const WS = require('ws')
const url = process.argv.find(a => a.startsWith('--url='))?.slice(6)
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  // 不过滤协议：about:blank 也是合法目标（正是要靠它验证「文档销毁后是否释放」）
  const t = list.filter(x => x.type === 'page')[0]
  if (!t) throw new Error('no page target')
  const s = new WS(t.webSocketDebuggerUrl)
  let id = 0; const pend = new Map()
  s.on('message', raw => { const m = JSON.parse(raw); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  await new Promise((res, rej) => { s.once('open', res); s.once('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject }); s.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable'); await send('HeapProfiler.enable'); await send('Page.enable')
  if (url) { await send('Page.navigate', { url }); await sleep(6000) }
  for (const _ of [1, 2]) { await send('HeapProfiler.collectGarbage'); await sleep(400) }
  const usage = await send('Runtime.getHeapUsage')
  const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,n:document.querySelectorAll("micro-app").length})', returnByValue: true })
  await send('Runtime.discardConsoleEntries').catch(() => {})
  console.log(JSON.stringify({ usedMB: +(usage.usedSize / 1048576).toFixed(2), ...JSON.parse(r.result.value) }))
  s.close()
})().catch(e => { console.error(String(e)); process.exitCode = 1 })
