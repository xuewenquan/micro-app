'use strict'

// User-authorized CDP UI test. Real menu clicks and Tab x only: never inject
// micro-app elements, force destroy attributes, or call router/unmount APIs.
// Credentials arrive over stdin and are never written to results or logs.
const fs = require('fs')
const path = require('path')
const WS = require('ws')
const { spawnSync } = require('child_process')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const arg = (name, fallback) => process.argv.find(x => x.startsWith(name + '='))?.slice(name.length + 1) || fallback

async function credentials () {
  console.log('Waiting for login JSON on stdin (input is not echoed or saved).')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let input = ''
    const receive = data => {
      input += data.toString()
      // ConPTY may deliver Return as CR rather than LF.
      if (!/[\r\n]/.test(input)) return
      process.stdin.off('data', receive)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      try { const value = JSON.parse(input.trim()); input = ''; resolve(value) } catch (_) { reject(new Error('Invalid login JSON')) }
    }
    process.stdin.on('data', receive)
  })
}

async function main () {
  const rounds = Number(arg('--rounds', '10'))
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error('Invalid round count')
  const outDir = path.resolve(arg('--out-dir', '.tmp/real-tab-gc'))
  if (fs.existsSync(outDir)) throw new Error('Output directory already exists; choose a fresh directory')
  fs.mkdirSync(outDir, { recursive: true })
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const pages = targets.filter(t => t.type === 'page' && t.url.startsWith('http://localhost:3000/'))
  if (pages.length !== 1) throw new Error('Expected exactly one scoped localhost test page')
  const target = pages[0]
  const socket = new WS(target.webSocketDebuggerUrl)
  const pending = new Map()
  let id = 0
  socket.on('message', raw => {
    const msg = JSON.parse(raw)
    const request = pending.get(msg.id)
    if (!request) return
    pending.delete(msg.id)
    msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result)
  })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    const timer = setTimeout(() => { pending.delete(next); reject(new Error('CDP timeout: ' + method)) }, 60000)
    pending.set(next, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  const wait = async (expression, label) => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await sleep(350)
    }
    throw new Error('UI condition timed out: ' + label)
  }
  const moveClick = async (expression, hover = false) => {
    await send('Page.bringToFront')
    const rect = await evaluate(`(()=>{const e=${expression};if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`)
    if (!rect) throw new Error('Visible UI target unavailable: ' + expression)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    if (!hover) {
      // The product modal animates between observing its rectangle and input.
      // Invoke the actual visible button's click, not a store/router API.
      await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('UI target disappeared');e.click();return true})()`)
    }
  }
  const textElement = text => `Array.from(document.querySelectorAll('span,button,a,li')).find(e=>e.textContent.replace(/\\s/g,'')===${JSON.stringify(text)}&&e.getBoundingClientRect().width&&e.getBoundingClientRect().height)`
  const collect = async (label, snapshot = false) => {
    await send('Runtime.discardConsoleEntries')
    await send('Runtime.disable')
    await send('HeapProfiler.collectGarbage')
    await sleep(250)
    await send('HeapProfiler.collectGarbage')
    await sleep(250)
    const usage = await send('Runtime.getHeapUsage')
    const state = await evaluate(`JSON.stringify({url:location.href,active:window.globalPlugin?.microApp?.getActiveApps(),all:window.globalPlugin?.microApp?.getAllApps(),tabs:Array.from(document.querySelectorAll('#coreMultipleTab [role="tab"]')).map(e=>e.textContent.trim())})`)
    const row = { label, targetId: target.id, time: new Date().toISOString(), heapUsedMB: +(usage.usedSize / 1048576).toFixed(2), ...JSON.parse(state) }
    fs.appendFileSync(path.join(outDir, 'baseline.jsonl'), JSON.stringify(row) + '\n')
    console.log(JSON.stringify(row))
    if (snapshot) {
      if (arg('--snapshots', 'all') === 'endpoints' && !['login-initial', 'logout-final'].includes(label)) return row
      await send('Runtime.discardConsoleEntries')
      await send('Runtime.disable')
      // Separate minimal snapshot connection; no InspectorDOM/InspectorCSS.
      const file = path.join(outDir, label + '.heapsnapshot')
      const captured = spawnSync(process.execPath, ['scripts/cdp_heap_snapshot.js', '--out=' + file, '--url-match=localhost:3000', '--gc'], { encoding: 'utf8', timeout: 240000 })
      if (captured.status !== 0) throw new Error('Snapshot capture failed: ' + captured.stderr)
      console.log('Snapshot saved: ' + label)
    }
    return row
  }
  const logout = async () => {
    await moveClick(`Array.from(document.querySelectorAll('.ant-dropdown-trigger')).find(e=>e.textContent.trim()==='管理员')`, true)
    await wait(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).some(e=>e.getBoundingClientRect().width)`, 'account dropdown opened')
    const items = await evaluate(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).filter(e=>e.getBoundingClientRect().width).map(e=>e.textContent.trim())`)
    console.log('Account menu: ' + JSON.stringify(items))
    const exit = items.find(text => /退出/.test(text))
    if (!exit) throw new Error('Visible logout menu item unavailable')
    await moveClick(textElement(exit.replace(/\s/g, '')))
    await wait(`Array.from(document.querySelectorAll('.ant-modal-confirm button')).some(e=>e.textContent.replace(/\\s/g,'')==='确定')`, 'logout confirmation')
    await moveClick(`Array.from(document.querySelectorAll('.ant-modal-confirm button')).find(e=>e.textContent.replace(/\\s/g,'')==='确定')`)
    await wait('location.pathname.includes("login") && window.globalPlugin.microApp.getAllApps().length===0', 'logout and zero apps')
  }
  try {
    const version = await send('Browser.getVersion')
    fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({ version, targetId: target.id, rounds, sequence: 'click WS menu -> wait for WS and SES2 children -> click Tab x -> wait for names to disappear -> GC', source: 'lib/index.esm.js currently served by localhost' }, null, 2))
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
    await send('Page.bringToFront')
    if (process.argv.includes('--prepare-dashboard')) {
      if (!(await evaluate('location.pathname')).includes('login')) await logout()
      await send('Page.navigate', { url: 'http://localhost:3000/login?redirect=/wd/dashboard' })
      await wait(`!!document.querySelector('#form_item_password')`, 'fresh dashboard-redirect login page')
      await sleep(2000)
    }
    if ((await evaluate('location.pathname')).includes('login')) {
      await collect('login-initial', true)
      const login = await credentials()
      for (const [selector, value] of [['#form_item_tenantAlias', login.tenant], ['#form_item_username', login.username], ['#form_item_password', login.password]]) {
        if (typeof value !== 'string' || !value) throw new Error('Missing login field')
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();true`)
        await send('Input.insertText', { text: value })
      }
      login.password = login.username = login.tenant = null
      await moveClick(textElement('登录'))
      await wait('!location.pathname.includes("login") && !!document.querySelector("#coreMultipleTab")', 'login completion')
      await sleep(5000)
    }
    let home = await evaluate('location.pathname')
    // This product selects the personal workspace after sign-in. Close that
    // real startup tab once, and explicitly treat it as warm-up, not round 1.
    if (home === '/wd/ws') {
      await wait(`!!document.querySelector('#coreMultipleTab button.ant-tabs-tab-remove')`, 'startup WS Tab x')
      await moveClick(`document.querySelector('#coreMultipleTab button.ant-tabs-tab-remove')`)
      await wait(`location.pathname==='/wd/dashboard' && !window.globalPlugin.microApp.getAllApps().includes('wonder-ws-web')`, 'startup WS warm-up close')
      await sleep(2000)
      console.log('Startup WS tab closed as warm-up; baseline is the logged-in dashboard, not the login page.')
      home = await evaluate('location.pathname')
    }
    if (home !== '/wd/dashboard') throw new Error('Expected clean dashboard start, got ' + home)
    await collect('dashboard-initial', true)
    const owned = ['wonder-ws-web', 'SES2-Component-LoadData', 'SES2-Component-proofreadApproveModal', 'SES2-Component-SysMLLinkEditor']
    for (let round = 1; round <= rounds; round++) {
      console.log('Opening WS: round ' + round)
      await moveClick(textElement('个人工作区'))
      await wait(`location.pathname==='/wd/ws' && ${JSON.stringify(owned)}.every(n=>window.globalPlugin.microApp.getActiveApps().includes(n)) && (document.querySelector('micro-app[name="wonder-ws-web"]')?.textContent.length||0)>1000`, 'WS plus children mounted')
      await sleep(5000)
      /**
       * 受控对照开关（默认关闭）：`--destroy-attr=on`
       *
       * 关闭 Tab 的自然路径是：
       *   元素移除 → disconnectedCallback → handleDisconnected(destroy=false) → unmount(false)
       *   → **只 stop**，实例仍留在 appInstanceMap；直到**下一次同名挂载**时由
       *   micro_app_element.ts:388 的 oldApp.actionsForCompletelyDestroy() 才真销毁。
       *
       * 打开这个开关会在点 Tab × **之前**给目标元素加 `destroy` 属性，让
       * MicroAppElement.unmount() 的 getDestroyCompatibleResult() 读到它，
       * 于是销毁提前到**卸载时**发生。
       *
       * 两条路的终点都是同一个 actionsForCompletelyDestroy()，**唯一的变量是时机** ——
       * 这正是本对照实验要测的东西。默认关闭，因为它是刻意的行为改动。
       */
      if (arg('--destroy-attr', '') === 'on') {
        const tagged = await evaluate(`(()=>{const w=${JSON.stringify(owned)};const t=[];document.querySelectorAll('micro-app').forEach(el=>{if(w.includes(el.getAttribute('name'))){el.setAttribute('destroy','');t.push(el.getAttribute('name'))}});return JSON.stringify(t)})()`)
        console.log('destroy 属性已打标（销毁提前到卸载时）: ' + tagged)
      }
      await moveClick(`document.querySelector('#coreMultipleTab button.ant-tabs-tab-remove')`)
      await wait(`location.pathname==='/wd/dashboard' && ${JSON.stringify(owned)}.every(n=>!window.globalPlugin.microApp.getAllApps().includes(n))`, 'Tab close destroyed all four names')
      await sleep(1000)
      await collect('round-' + round, round === 1 || round === rounds)
    }
    await logout()
    await sleep(3000)
    await collect('logout-final', true)
    console.log('Acceptance sequence finished; results: ' + outDir)
  } finally {
    await send('Runtime.discardConsoleEntries').catch(() => {})
    await send('Runtime.disable').catch(() => {})
    await send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    socket.close()
  }
}

main().catch(error => { console.error(String(error)); process.exitCode = 1 })
