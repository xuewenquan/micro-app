/* Real Axios 0.26 cancellation, no HTTP server or product build required. */
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const ts = require('typescript')
const vm = require('vm')
const core = process.argv[2]
if (!core) throw new Error('Usage: node scripts/test_shared_axios_lifecycle.js <wonder-core-web>')
const axios = require(path.join(core, 'node_modules/axios'))
const filename = path.join(core, 'src/utils/http/axios/Axios.ts')
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
}).outputText
const exportsObject = {}
vm.runInNewContext(code, {
  exports: exportsObject,
  require: name => {
    if (name === 'axios') return axios
    if (name === './axiosCancel') return { AxiosCanceler: class { addPending () {} removePending () {} } }
    if (name.endsWith('/is')) return { isFunction: value => typeof value === 'function' }
    if (name === 'lodash-es') return { cloneDeep: value => ({ ...value }) }
    if (name.endsWith('/httpEnum')) return { ContentTypeEnum: { FORM_URLENCODED: 'application/x-www-form-urlencoded' }, RequestEnum: { GET: 'GET' } }
    return {}
  },
  Map, Promise, console,
}, { filename })
const VAxios = exportsObject.VAxios
async function main () {
  let canceled = 0
  const adapter = config => new Promise((resolve, reject) => {
    config.cancelToken.subscribe(reason => { canceled++; reject(reason) })
  })
  const a = new VAxios({ adapter })
  const b = new VAxios({ adapter })
  const pa = a.getAxios().get('/pending-a').catch(error => error)
  const pb = b.getAxios().get('/pending-b').catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  a.dispose()
  a.dispose()
  assert(axios.isCancel(await pa))
  assert.strictEqual(canceled, 1)
  assert.strictEqual(a.ownedRequests.size, 0)
  assert.strictEqual(b.ownedRequests.size, 1)
  assert(axios.isCancel(await a.getAxios().get('/late').catch(error => error)))
  b.dispose()
  assert(axios.isCancel(await pb))
  const c = new VAxios({ adapter })
  const caller = axios.CancelToken.source()
  const pc = c.getAxios().get('/caller', { cancelToken: caller.token }).catch(error => error)
  await new Promise(resolve => setImmediate(resolve))
  caller.cancel('caller canceled')
  assert(axios.isCancel(await pc))
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(c.ownedRequests.size, 0)
  c.dispose()
  const indexFile = path.join(core, 'src/utils/http/axios/index.ts')
  const ast = ts.createSourceFile(indexFile, fs.readFileSync(indexFile, 'utf8'), ts.ScriptTarget.Latest, true)
  let catchHandler
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'responseInterceptorsCatch') catchHandler = node.initializer.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert(catchHandler, 'product response cancellation handler exists')
  const handlerCode = ts.transpileModule(`exports.handler = ${catchHandler}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2019 },
  }).outputText
  const handlerExports = {}
  vm.runInNewContext(handlerCode, {
    exports: handlerExports, isCancel: axios.isCancel, Promise,
    // If the guard is misplaced, normal cancellation must fail this test.
    console: { log: () => { throw new Error('cancellation must not be logged') } },
  })
  const cancellation = new axios.Cancel('terminal')
  assert.strictEqual(await handlerExports.handler(cancellation).catch(error => error), cancellation)
  const hookError = new Error('cache failed')
  const failingCache = new VAxios({ transform: { beforeRequestCacheHook: () => { throw hookError } } })
  const cacheResult = await Promise.race([
    failingCache.request({ url: '/cached' }).catch(error => error),
    new Promise(resolve => setTimeout(() => resolve('still pending'), 200)),
  ])
  assert.strictEqual(cacheResult, hookError)
  const failingCatch = new VAxios({
    adapter: () => Promise.reject(new Error('network failed')),
    transform: { requestCatchHook: () => { throw hookError } },
  })
  assert.strictEqual(await Promise.race([
    failingCatch.request({ url: '/failed' }).catch(error => error),
    new Promise(resolve => setTimeout(() => resolve('still pending'), 200)),
  ]), hookError)
  failingCache.dispose()
  assert(axios.isCancel(await failingCache.request({ url: '/late-cache' }).catch(error => error)))
  console.log('PASS: isolated disposal, idempotence, late requests, caller cancellation, released records')
  console.log('PASS: product response handler preserves cancellation without error reporting')
  console.log('PASS: throwing cache/error hooks settle promises; disposed instances cannot use cache')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
