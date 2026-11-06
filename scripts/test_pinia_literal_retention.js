'use strict'

// Diagnostic only, not a Pinia patch. Compare a shared literal allocation with
// a fresh non-literal allocation after a child accessor has been installed.
// Run: node --expose-gc scripts/test_pinia_literal_retention.js
// A Node result must not be substituted for the product Chrome acceptance run.
const vm = require('vm')
if (typeof global.gc !== 'function') throw new Error('Run with --expose-gc')

function literalStore () {
  return { _p: null, $id: '', $onAction: null, $patch: null, $reset: null, $subscribe: null, $dispose: null }
}

function freshStore () {
  return Object.assign(Object.create(Object.prototype), {
    _p: null, $id: '', $onAction: null, $patch: null, $reset: null, $subscribe: null, $dispose: null,
  })
}

function installChildAccessor (allocate) {
  const realm = vm.createContext({})
  const getter = vm.runInContext('(function () { const state = new Array(10000).fill("child"); return function () { return state } })()', realm)
  const weak = new WeakRef(getter)
  const store = allocate()
  Object.assign(store, { theme: 'dark', setTheme () {}, getTheme: 'dark' })
  Object.defineProperty(store, '$state', { configurable: true, get: getter })
  return weak
}

async function main () {
  const cases = [literalStore, freshStore].map((allocate) => {
    // Warm the allocation site with the same plain partial-store shape.
    for (let index = 0; index < 10000; index++) allocate()
    return { name: allocate.name, weak: installChildAccessor(allocate) }
  })
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve))
    global.gc()
  }
  console.log(JSON.stringify({
    node: process.version,
    v8: process.versions.v8,
    cases: cases.map(({ name, weak }) => ({ name, getterCollected: weak.deref() === undefined })),
    limitation: 'Synthetic Node probe; does not reproduce the product Pinia/module graph or prove a Chrome fix.',
  }, null, 2))
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
