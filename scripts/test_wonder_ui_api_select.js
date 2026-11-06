const fs = require('fs')
const path = require('path')
const vm = require('vm')
const assert = require('assert')
const ts = require('typescript')
const root = process.argv[2]
if (!root) throw new Error('Usage: node scripts/test_wonder_ui_api_select.js <wonder-ui>')
const source = fs.readFileSync(path.join(root, 'package/wd-form/components/ApiSelect.vue'), 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
function mount () {
  let dispose
  const effects = [], refs = [], events = [], warnings = [], requests = []
  const vue = {
    defineComponent: x => x,
    ref: value => { const r = { value }; refs.push(r); return r },
    computed: fn => ({ get value () { return fn() } }),
    unref: x => x && !Array.isArray(x) && Object.prototype.hasOwnProperty.call(x, 'value') ? x.value : x,
    watchEffect: fn => effects.push(fn), watch: () => {},
    onScopeDispose: fn => { dispose = fn },
  }
  const props = { immediate: true, params: {}, api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })), allowCreate: true, labelField: 'label', valueField: 'value' }
  const exports = {}
  vm.runInNewContext(code, {
    exports, console: { warn: x => warnings.push(x) },
    require: name => {
      if (name === 'vue') return vue
      if (name === 'element-plus') return { ElTreeSelect: {} }
      if (name.endsWith('/is')) return { isFunction: x => typeof x === 'function' }
      if (name.endsWith('/useFormItem')) return { useRuleFormItem: () => [{ value: null }] }
      if (name.endsWith('/useAttrs')) return { useAttrs: () => ({}) }
      if (name.endsWith('/propTypes')) { const p = { def: () => ({}) }; return { propTypes: { bool: p, string: p, func: p } } }
      if (name === 'lodash-es') return { omit: x => x, get: (x, k) => x[k] }
      return {}
    },
  })
  const view = exports.default.setup(props, { emit: (...args) => events.push(args) })
  return { view, refs, events, warnings, requests, fetch: () => effects[0](), dispose: () => dispose() }
}
async function flush () { await Promise.resolve(); await Promise.resolve() }
async function main () {
  const m = mount()
  m.fetch(); m.fetch()
  m.requests[1].resolve([{ label: 'new', value: '2' }]); await flush()
  m.requests[0].resolve([{ label: 'old', value: '1' }]); await flush()
  assert.strictEqual(m.view.getOptions.value[0].label, 'new')
  assert.strictEqual(m.events.length, 1)
  m.view.visibleChange(true)
  const callback = m.events[1][2]
  m.fetch(); m.dispose()
  m.requests[2].resolve([{ label: 'dead', value: '3' }]); await flush()
  callback([{ label: 'late', value: '4' }])
  assert.strictEqual(m.view.getOptions.value.length, 0)
  assert.strictEqual(m.events.length, 2)
  m.fetch(); assert.strictEqual(m.requests.length, 3)
  const n = mount(); n.fetch(); n.dispose(); n.requests[0].reject(new Error('late')); await flush()
  assert.strictEqual(n.warnings.length, 0)
  const config = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8')
  const expression = config.match(/external: (id => [\s\S]*?\.some\([^\n]+\))/)[1]
  const external = vm.runInNewContext(`(${expression})`)
  for (const id of ['vue', 'vue/dist/vue.runtime.esm-bundler.js', 'element-plus', 'element-plus/es/components/tree-select', 'element-plus/es/components/tree-select/style/css']) assert.strictEqual(external(id), true, id)
  for (const id of ['./ApiSelect.vue', 'element-plus-extra', 'vue-other']) assert.strictEqual(external(id), false, id)
  console.log('PASS: latest request, terminal disposal, retained callback, late rejection, dependency subpath externalization')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
