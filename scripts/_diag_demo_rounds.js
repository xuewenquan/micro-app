'use strict'

/**
 * 在 microapp-demo（localhost:5000）上跑「开子应用 → 关 tab」循环，每轮强制 GC 后量堆。
 *
 * 用途：demo 是本地可控的（源码可读、子应用是我们自己的），可以把业务应用上
 * 观察到的残留放到一个最小环境里复现或排除。
 *
 * demo 的关闭路径是**显式 destroy**（`useTabs.ts` 的 `closeTab` → `unmountApp(name, {destroy:true})`），
 * 所以这个脚本测的是 destroy 路径，而不是 keep-alive 隐藏。
 *
 * 用法：
 *   node scripts/_diag_demo_rounds.js --rounds=5 [--app=app1] [--url=http://localhost:5000/]
 *        [--hold=3000] [--settle=1500]
 *
 * 每轮：router.push('/<app>/') → 等 micro-app 挂上 → 点 tab 的关闭按钮 → 等 tab 消失 → GC ×2 → 量
 */

const WS = require('ws')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const arg = (n, d) => process.argv.find(a => a.startsWith(n + '='))?.slice(n.length + 1) ?? d

;(async () => {
  const rounds = Number(arg('--rounds', '5'))
  const appName = arg('--app', 'app1')
  const home = arg('--url', 'http://localhost:5000/')
  const hold = Number(arg('--hold', '3000'))
  const settle = Number(arg('--settle', '1500'))

  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const t = list.filter(x => x.type === 'page')[0]
  if (!t) throw new Error('no page target')
  const s = new WS(t.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  s.on('message', raw => {
    const m = JSON.parse(raw)
    const p = pend.get(m.id)
    if (!p) return
    pend.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  })
  await new Promise((res, rej) => { s.once('open', res); s.once('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id
    pend.set(i, { resolve, reject })
    s.send(JSON.stringify({ id: i, method, params }))
  })
  const evalJson = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return typeof r.result.value === 'string' ? JSON.parse(r.result.value) : r.result.value
  }
  const waitFor = async (expr, label, timeout = 45000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try { if (await evalJson(expr)) return } catch (_) {}
      await sleep(400)
    }
    throw new Error('timeout: ' + label)
  }
  const gcAndMeasure = async (label) => {
    await send('Runtime.discardConsoleEntries')
    await send('HeapProfiler.collectGarbage'); await sleep(350)
    await send('HeapProfiler.collectGarbage'); await sleep(350)
    const u = await send('Runtime.getHeapUsage')
    const st = await evalJson(`JSON.stringify({url:location.href,tabs:document.querySelectorAll('.el-tabs__item').length,microApps:document.querySelectorAll('micro-app').length,apps:(window.microApp&&microApp.getAllApps)?microApp.getAllApps():null})`)
    const row = { label, usedMB: +(u.usedSize / 1048576).toFixed(2), ...st }
    console.log(JSON.stringify(row))
    return row
  }

  await send('Runtime.enable'); await send('HeapProfiler.enable'); await send('Page.enable')
  await send('Page.navigate', { url: home }); await sleep(6000)
  await waitFor(`!!document.querySelector('#app')`, 'demo boot')
  await sleep(2000)
  await gcAndMeasure('init')

  for (let r = 1; r <= rounds; r++) {
    // 1) 路由到子应用 → 自动开 tab
    await evalJson(`(async()=>{const a=document.querySelector('#app').__vue_app__;const rt=a.config.globalProperties.$router;await rt.push('/${appName}/');return JSON.stringify({url:location.href})})()`)
    await waitFor(`document.querySelectorAll('micro-app').length>0`, 'micro-app element')
    await waitFor(`(()=>{const m=document.querySelector('micro-app[name="${appName}"]');if(!m)return false;const b=m.querySelector('micro-app-body');return !!b&&b.children.length>0})()`, appName + ' mounted')
    await sleep(hold)
    // 2) 点 tab 上的关闭按钮 → closeTab → unmountApp(destroy:true)
    const clicked = await evalJson(`(()=>{const items=[...document.querySelectorAll('.el-tabs__item')];const it=items[items.length-1];if(!it)return JSON.stringify({ok:false});const x=it.querySelector('.is-icon-close');if(!x)return JSON.stringify({ok:false,why:'no close icon'});x.click();return JSON.stringify({ok:true,label:it.textContent.trim().slice(0,20)})})()`)
    /**
     * 关键修正：不能靠固定 sleep 就断言"已释放"。
     * `closeTab` 里的 `unmountApp(name, {destroy:true})` 是**异步**的，
     * 之前用固定 1500ms，在进程变重的后续轮次里会把"还没销毁完"读成"没释放"（见 §13.38）。
     * 这里改成：等到 micro-app 自己的注册表里不再有这个应用，再等 settle，然后才 GC 测量。
     */
    let destroyed = false
    try {
      await waitFor(`!window.microApp.getAllApps().includes('${appName}')`, 'app removed from registry', 30000)
      destroyed = true
    } catch (_) { destroyed = false }
    await sleep(settle)
    const row = await gcAndMeasure('round-' + r + (destroyed ? '' : ' (destroy-timeout)') + (clicked && clicked.ok ? '' : ' (close-failed)'))
  }

  await send('Runtime.discardConsoleEntries').catch(() => {})
  await send('Runtime.disable').catch(() => {})
  s.close()
})().catch(e => { console.error(String(e)); process.exitCode = 1 })
