'use strict'

// No Chrome or network required. Verify target checks run before opening a
// diagnostic socket, and ambiguous tabs cannot silently become a baseline.
const assert = require('assert').strict
const fs = require('fs')
const vm = require('vm')
const { EventEmitter } = require('events')
const source = fs.readFileSync(require('path').join(__dirname, 'cdp_memory_state.js'), 'utf8')
const page = (id, url) => ({ id, type: 'page', url, webSocketDebuggerUrl: `ws://test/${id}` })

async function run (targets, args) {
  const opened = [], messages = [], errors = []
  class Socket extends EventEmitter {
    constructor (url) {
      super()
      opened.push(url)
      setImmediate(() => this.emit('open'))
    }

    send (raw) {
      const request = JSON.parse(raw)
      setImmediate(() => this.emit('message', JSON.stringify({ id: request.id, result: { product: 'test-chrome' } })))
    }

    close () { this.closed = true }
  }
  const processStub = { argv: ['node', 'cdp_memory_state.js', ...args], exitCode: 0 }
  await vm.runInNewContext(source, {
    require: name => { assert.equal(name, 'ws'); return Socket },
    fetch: async () => ({ json: async () => targets }),
    AbortSignal,
    process: processStub,
    console: { log: value => messages.push(value), error: value => errors.push(value) },
    setTimeout,
    clearTimeout,
  })
  return { opened, messages, errors, exitCode: processStub.exitCode }
}

async function main () {
  const login = page('login', 'http://localhost:3000/login')
  const home = page('home', 'http://localhost:3000/wd/dashboard')
  const wrong = await run([login], ['--gc', '--expected-url=' + home.url])
  assert.equal(wrong.exitCode, 1)
  assert.equal(wrong.opened.length, 0)
  assert.match(wrong.errors[0], /mismatch/)

  const ambiguous = await run([login, home], ['--gc'])
  assert.equal(ambiguous.exitCode, 1)
  assert.equal(ambiguous.opened.length, 0)

  const missing = await run([home], ['--target-id=missing'])
  assert.equal(missing.exitCode, 1)
  assert.equal(missing.opened.length, 0)

  const correct = await run([login, home], ['--target-id=home', '--expected-url=' + home.url, '--connection-check'])
  assert.equal(correct.exitCode, 0)
  assert.deepEqual(correct.opened, ['ws://test/home'])
  assert.equal(JSON.parse(correct.messages[0]).targetId, 'home')
  console.log('PASS: mismatched URL, ambiguous tabs, missing target, explicit matching target')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
