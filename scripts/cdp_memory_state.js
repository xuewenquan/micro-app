'use strict'

// Read-only runtime inspection; return primitives only, never retain app/DOM
// handles in CDP. Optional GC does not mutate application state.
const WS = require('ws')

async function main () {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(15000) })).json()
  const targetId = process.argv.find(arg => arg.startsWith('--target-id='))?.slice('--target-id='.length)
  const expectedUrl = process.argv.find(arg => arg.startsWith('--expected-url='))?.slice('--expected-url='.length)
  const candidates = targets.filter(item => item.type === 'page' && item.url.startsWith('http://localhost:3000/') && (!targetId || item.id === targetId))
  // Review: never collect a silently selected first tab, or run GC against a
  // login page while the UI driver is exercising a different Chrome profile.
  if (candidates.length !== 1) throw new Error(`Expected exactly one scoped localhost page; found ${candidates.length}. Select a returned target with --target-id.`)
  const target = candidates[0]
  if (expectedUrl && target.url !== expectedUrl) throw new Error(`UI/memory target mismatch: expected ${expectedUrl}, got ${target.url}. No GC was performed.`)
  const socket = new WS(target.webSocketDebuggerUrl, { handshakeTimeout: 15000 })
  const pending = new Map()
  let paused = null
  let id = 0
  socket.on('message', (raw) => {
    const message = JSON.parse(raw)
    if (message.method === 'Debugger.paused') {
      paused = { reason: message.params.reason, frames: message.params.callFrames.map(frame => ({ name: frame.functionName, url: frame.url, line: frame.location.lineNumber })) }
    }
    if (!pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(message.error.message)) : resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id
    const timeout = setTimeout(() => {
      pending.delete(next)
      reject(new Error(`Diagnostic command did not respond within 30s: ${method}`))
    }, 30000)
    pending.set(next, {
      resolve: value => { clearTimeout(timeout); resolve(value) },
      reject: error => { clearTimeout(timeout); reject(error) },
    })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
  try {
    if (process.argv.includes('--connection-check')) {
      console.log(JSON.stringify({ ...await send('Browser.getVersion'), targetId: target.id, targetUrl: target.url }))
      return
    }
    if (process.argv.includes('--pause-check')) {
      await send('Debugger.enable')
      console.log(JSON.stringify({ url: target.url, paused }))
      return
    }
    if (process.argv.includes('--protocol-only')) {
      await send('Performance.enable')
      const metrics = await send('Performance.getMetrics')
      console.log(JSON.stringify({ url: target.url, metrics: metrics.metrics }))
      return
    }
    if (process.argv.includes('--gc')) await send('HeapProfiler.collectGarbage')
    const result = await send('Runtime.evaluate', {
      expression: `JSON.stringify((() => {
        const micro = window.globalPlugin?.microApp;
        return {
          url: location.href,
          active: micro?.getActiveApps?.(), all: micro?.getAllApps?.(),
          heap: performance.memory?.usedJSHeapSize,
          dom: {
            elements: document.querySelectorAll('*').length,
            rawTooltips: document.querySelectorAll('a-tooltip').length,
            layoutRoots: document.querySelectorAll('section.vben-default-layout').length,
          },
          scopedAxiosFactory: window.globalPlugin?.useAxios?.__MICRO_APP_RESOURCE_FACTORY__ === true,
          plugins: Object.keys(window.globalPlugin || {}),
          elements: Array.from(document.querySelectorAll('micro-app')).map(el => ({
            name: el.getAttribute('name'), url: el.getAttribute('url'),
            keepAlive: el.hasAttribute('keep-alive'), destroy: el.getAttribute('destroy'),
          })),
          loadedMicroAppSources: performance.getEntriesByType('resource').map(e => e.name)
            .filter(name => name.includes('micro-app/lib') || name.includes('micro-app_lib')),
        };
      })())`,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    const state = JSON.parse(result.result.value)
    if (expectedUrl && state.url !== expectedUrl) throw new Error('The memory target navigated during collection; discard this sample')
    console.log(JSON.stringify({ ...state, targetId: target.id }))
  } finally { socket.close() }
}

main().catch((error) => { console.error(String(error)); process.exitCode = 1 })
