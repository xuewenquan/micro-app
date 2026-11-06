'use strict'

// Temporary browser diagnostic: record scriptParsed URLs while opening app1
// through the demo's real menu. It performs no router or micro-app API calls.
const WS = require('ws')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main () {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const target = targets.find(item => item.type === 'page' && item.url.startsWith('http://localhost:5000/'))
  if (!target) throw new Error('demo target not found')
  const socket = new WS(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let id = 0
  const pending = new Map()
  const parsed = []
  socket.on('message', data => {
    const message = JSON.parse(data)
    if (message.method === 'Debugger.scriptParsed') parsed.push(message.params.url)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  await send('Runtime.enable')
  await send('Debugger.enable')
  await sleep(200)
  parsed.length = 0
  await send('Runtime.evaluate', {
    expression: `(() => {
      const item = document.querySelectorAll('.el-menu-item')[0]
      if (!item) throw new Error('app1 menu item not found')
      item.click()
    })()`,
  })
  await sleep(5000)
  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      apps: window.microApp.getAllApps(),
      childText: document.querySelector('micro-app')?.textContent?.trim().slice(0, 120)
    })`,
    returnByValue: true,
  })
  const relevant = parsed.filter(url => /localhost:(3001|5000)/.test(url))
  console.log(JSON.stringify({ state: JSON.parse(state.result.value), scripts: relevant }, null, 2))
  await send('Debugger.disable')
  await send('Runtime.disable')
  socket.close()
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
