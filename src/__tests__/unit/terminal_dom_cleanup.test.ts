import CreateApp, { appInstanceMap } from '../../create_app'
import { initGlobalEnv } from '../../libs/global_env'
import * as appTasks from '../../libs/app_tasks'
import { execScripts } from '../../source/scripts'
import { createMicroXMLHttpRequest, createXMLHttpRequestScope, disposeXMLHttpRequestScope } from '../../sandbox/request'

jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

/**
 * 2026.9.12 by Claude Code
 * 构造一个「容器 + micro-app-head(含 style) + micro-app-body(含子节点)」的结构，
 * 模拟子应用挂载后的 DOM 形态。
 */
function buildContainer (): HTMLElement {
  const container = document.createElement('div')
  const head = document.createElement('micro-app-head')
  const style = document.createElement('style')
  style.textContent = '.a{color:red}'
  head.appendChild(style)
  const body = document.createElement('micro-app-body')
  const child = document.createElement('div')
  child.textContent = 'child'
  body.appendChild(child)
  container.appendChild(head)
  container.appendChild(body)
  return container
}

function createAppLike (name: string, container: HTMLElement | null): any {
  const app: any = Object.create(CreateApp.prototype)
  app.name = name
  app.destroyed = false
  app.iframe = false
  app.umdMode = false
  app.sandBox = null
  app.container = container
  app.umdHookMount = null
  app.umdHookUnmount = null
  app.preRenderEvents = null
  app.source = { html: null, links: new Set(), scripts: new Set() }
  return app
}

describe('terminal DOM cleanup', () => {
  test('terminal snapshot preserves a node reparented into a live base container', () => {
    const container = buildContainer()
    const node = container.querySelector('micro-app-body')!.firstElementChild!
    const live = document.createElement('div')
    document.body.appendChild(live)
    const cancel = jest.fn()
    ;(node as any).getAnimations = jest.fn(() => [{ cancel }])
    const app = createAppLike('reparented-transition', container)
    app.umdHookUnmount = () => { live.appendChild(node) }
    app.handleUnmounted = jest.fn(() => app.clearOptions(true))
    try {
      app.unmount({ destroy: true, clearData: true, keepRouteState: false })
      expect(cancel).not.toHaveBeenCalled()
      expect(live.firstElementChild).toBe(node)
      expect(app.terminalDOMNodes).toBeNull()
    } finally { live.remove() }
  })
  test('terminal unmount cancels animations on nodes detached by the child hook', () => {
    const container = buildContainer()
    const input = document.createElement('input')
    container.querySelector('micro-app-body')!.appendChild(input)
    const cancel = jest.fn()
    ;(input as any).getAnimations = jest.fn(() => [{ cancel }])
    const app = createAppLike('detached-transition', container)
    app.umdHookUnmount = () => { input.remove() }
    app.handleUnmounted = jest.fn(() => app.clearOptions(true))
    app.unmount({ destroy: true, clearData: true, keepRouteState: false })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(app.terminalDOMNodes).toBeNull()
    expect(app.container).toBeNull()
  })

  test('pre-hook snapshot excludes nested apps and normal unmount', () => {
    const container = buildContainer()
    const nested = document.createElement('micro-app')
    const input = document.createElement('input')
    nested.appendChild(input)
    container.querySelector('micro-app-body')!.appendChild(nested)
    const cancel = jest.fn()
    ;(input as any).getAnimations = jest.fn(() => [{ cancel }])
    const app = createAppLike('snapshot-parent', container)
    app.umdHookUnmount = () => { nested.remove() }
    app.handleUnmounted = jest.fn(() => app.clearOptions(true))
    app.unmount({ destroy: true, clearData: true, keepRouteState: false })
    expect(cancel).not.toHaveBeenCalled()
    const ordinary = createAppLike('ordinary-snapshot', buildContainer())
    ordinary.handleUnmounted = jest.fn()
    ordinary.unmount({ destroy: false, clearData: false, keepRouteState: false })
    expect(ordinary.terminalDOMNodes).toBeUndefined()
  })

  test('snapshot releases detached animations even when hook clears container', () => {
    const container = buildContainer()
    const node = container.querySelector('micro-app-body')!.firstElementChild!
    const cancel = jest.fn()
    ;(node as any).getAnimations = jest.fn(() => [{ cancel }])
    const app = createAppLike('null-hook-container', container)
    app.umdHookUnmount = () => { container.innerHTML = ''; app.container = null }
    app.handleUnmounted = jest.fn(() => app.clearInstanceDOM())
    app.unmount({ destroy: true, clearData: true, keepRouteState: false })
    expect(cancel).toHaveBeenCalledTimes(1)
    app.clearInstanceDOM()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(app.terminalDOMNodes).toBeNull()
  })

  test('XHR terminal cancellation is instance-local; completion removes the request', () => {
    class FakeXHR extends EventTarget {
      abort = jest.fn(() => this.dispatchEvent(new Event('loadend')))
      send () {}
      open () {}
    }
    initGlobalEnv()
    const oldScope = createXMLHttpRequestScope()
    const newScope = createXMLHttpRequestScope()
    const OldXHR = createMicroXMLHttpRequest('http://localhost/', FakeXHR as any, oldScope)
    const NewXHR = createMicroXMLHttpRequest('http://localhost/', FakeXHR as any, newScope)
    const old = new OldXHR()
    const current = new NewXHR()
    old.send()
    current.send()
    expect(oldScope.requests.size).toBe(1)
    disposeXMLHttpRequestScope(oldScope)
    expect(old.abort).toHaveBeenCalledTimes(1)
    expect(oldScope.requests.size).toBe(0)
    expect(current.abort).not.toHaveBeenCalled()
    expect(newScope.requests.size).toBe(1)
    expect(() => old.send()).toThrow('destroyed sandbox')
    current.dispatchEvent(new Event('loadend'))
    expect(newScope.requests.size).toBe(0)
    disposeXMLHttpRequestScope(newScope)
    expect(current.abort).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    initGlobalEnv()
  })

  afterEach(() => {
    appInstanceMap.clear()
  })

  test('终态销毁会清空 micro-app-head/body 子树与 style 内容', () => {
    const container = buildContainer()
    const head = container.querySelector('micro-app-head')!
    const body = container.querySelector('micro-app-body')!
    const style = container.querySelector('style')!
    const app = createAppLike('terminal-dom-app', container)
    appInstanceMap.set('terminal-dom-app', app)

    app.clearOptions(true)

    // 深度清理：即使 head/body 之后被外部（子应用库的缓存 Map）持有，
    // 其子树与解析后的 CSS 也已经释放
    expect(head.childNodes.length).toBe(0)
    expect(body.childNodes.length).toBe(0)
    expect(style.textContent).toBe('')
    // 容器本身照旧被清空
    expect(container.childNodes.length).toBe(0)
  })

  test('普通卸载（destroy=false）不做深度清理，保持原有语义', () => {
    const container = buildContainer()
    const head = container.querySelector('micro-app-head')!
    const style = container.querySelector('style')!
    const app = createAppLike('normal-unmount-app', container)
    appInstanceMap.set('normal-unmount-app', app)

    app.clearOptions(false)

    // 容器被清空（head 已被摘下），但我们没有额外触碰 head 内部 —— 保活切换依赖原样保留
    expect(container.childNodes.length).toBe(0)
    expect(head.childNodes.length).toBe(1)
    expect(style.textContent).toBe('.a{color:red}')
  })

  test('直达终态销毁（未经 clearOptions、container 仍在）同样做深度清理', () => {
    const container = buildContainer()
    const head = container.querySelector('micro-app-head')!
    const app = createAppLike('direct-destroy-app', container)
    appInstanceMap.set('direct-destroy-app', app)

    app.actionsForCompletelyDestroy()

    expect(head.childNodes.length).toBe(0)
    expect(container.childNodes.length).toBe(0)
    expect(app.container).toBeNull()
    expect(app.destroyed).toBe(true)
    expect(() => app.actionsForCompletelyDestroy()).not.toThrow()
  })

  test('container 为 null 时终态销毁不抛异常', () => {
    const app = createAppLike('no-container-app', null)
    appInstanceMap.set('no-container-app', app)

    expect(() => app.actionsForCompletelyDestroy()).not.toThrow()
    expect(app.destroyed).toBe(true)
  })

  test('terminal destruction cancels owned animations, not nested or base animations', () => {
    const container = buildContainer()
    const own = container.querySelector('micro-app-body div')!
    const cancel = jest.fn()
    const getAnimations = jest.fn(() => [{ cancel }])
    Object.defineProperty(own, 'getAnimations', { value: getAnimations })
    const nested = document.createElement('micro-app')
    const nestedCancel = jest.fn()
    Object.defineProperty(nested, 'getAnimations', { value: () => [{ cancel: nestedCancel }] })
    container.appendChild(nested)
    const base = document.createElement('div')
    const baseCancel = jest.fn()
    Object.defineProperty(base, 'getAnimations', { value: () => [{ cancel: baseCancel }] })
    document.body.appendChild(base)
    try {
      createAppLike('animation-terminal', container).actionsForCompletelyDestroy()
      expect(getAnimations).toHaveBeenCalledWith()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(nestedCancel).not.toHaveBeenCalled()
      expect(baseCancel).not.toHaveBeenCalled()
    } finally { base.remove() }
  })

  test('ordinary unload preserves animations for a non-destroyed application', () => {
    const container = buildContainer()
    const cancel = jest.fn()
    Object.defineProperty(container.querySelector('micro-app-body')!, 'getAnimations', {
      value: () => [{ cancel }],
    })
    createAppLike('animation-stop', container).clearOptions(false)
    expect(cancel).not.toHaveBeenCalled()
  })

  test('one failed animation cancellation does not prevent remaining DOM cleanup', () => {
    const container = buildContainer()
    const cancel = jest.fn()
    Object.defineProperty(container.querySelector('micro-app-body')!, 'getAnimations', {
      value: () => [{ cancel: () => { throw new Error('animation failed') } }, { cancel }],
    })
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = createAppLike('animation-failure', container)
      expect(() => app.actionsForCompletelyDestroy()).not.toThrow()
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(container.childNodes).toHaveLength(0)
      expect(app.destroyed).toBe(true)
    } finally { error.mockRestore() }
  })

  test('terminal cleanup deletes insertRule CSSOM rules without Text nodes', () => {
    const container = buildContainer()
    document.body.appendChild(container)
    const style = container.querySelector('style')!
    style.textContent = ''
    const sheet = style.sheet!
    sheet.insertRule('.inserted { color: blue }', 0)
    expect(style.textContent).toBe('')
    expect(sheet.cssRules.length).toBe(1)
    createAppLike('cssom-terminal', container).actionsForCompletelyDestroy()
    expect(sheet.cssRules.length).toBe(0)
    container.remove()
  })

  test('pending mount cancellation releases options and ignores late readiness', async () => {
    let ready!: () => void
    const pending = new Promise<void>((resolve) => { ready = resolve })
    const app = createAppLike('pending-mount', null)
    app.loadSourceLevel = 2
    app.createSandbox = jest.fn()
    app.sandBox = { sandboxReady: pending }
    const execute = jest.spyOn(app, 'executePendingMount').mockImplementation(() => {})
    const options = { container: buildContainer(), routerMode: 'search' }
    app.mount(options)
    app.actionsForCompletelyDestroy()
    ready()
    await pending
    await Promise.resolve()
    expect(execute).not.toHaveBeenCalled()
    expect(options.container.childNodes.length).toBe(2)
  })

  test('script completion clears the retained payload after invoking the hook', () => {
    const original = appTasks.createAppTask
    let retained: any
    const spy = jest.spyOn(appTasks, 'createAppTask').mockImplementation((owner, value, cleanup) => {
      retained = value
      return original(owner, value, cleanup)
    })
    try {
      const app = createAppLike('script-payload', buildContainer())
      const hook = jest.fn(() => {
        expect(retained.app).toBe(app)
        expect(retained.initHook).toBe(hook)
      })
      execScripts(app, hook)
      expect(hook).toHaveBeenCalledWith(true)
      expect(retained.app).toBeNull()
      expect(retained.initHook).toBeNull()
      expect(retained.deferScriptInfo).toEqual([])
    } finally { spy.mockRestore() }
  })

  test('nested cleanup uses the matching instance unmount, preserving other Tabs', () => {
    const container = buildContainer()
    const nested = document.createElement('micro-app')
    nested.setAttribute('name', 'nested-owned')
    const nestedDOM = buildContainer()
    nested.appendChild(nestedDOM)
    container.querySelector('micro-app-body')!.appendChild(nested)
    const nestedStyle = nested.querySelector('style')!
    const child = createAppLike('nested-owned', nested)
    // Simulate asynchronous child teardown: parent must not clear its styles.
    child.unmount = jest.fn()
    const independent = createAppLike('independent-tab', buildContainer())
    independent.unmount = jest.fn()
    appInstanceMap.set(child.name, child)
    appInstanceMap.set(independent.name, independent)
    const parent = createAppLike('nested-parent', container)
    parent.actionsForCompletelyDestroy()
    expect(child.unmount).toHaveBeenCalledWith({ destroy: true, clearData: true, keepRouteState: false })
    expect(nestedStyle.textContent).toBe('.a{color:red}')
    expect(independent.unmount).not.toHaveBeenCalled()
    expect(independent.container.querySelector('style').textContent).toBe('.a{color:red}')
    expect(container.childNodes.length).toBe(0)
    child.actionsForCompletelyDestroy()
    expect(nestedStyle.textContent).toBe('')
    expect(nested.childNodes.length).toBe(0)
  })

  test('a stale nested element cannot destroy the same-name replacement', () => {
    const container = buildContainer()
    const stale = document.createElement('micro-app')
    stale.setAttribute('name', 'replacement-tab')
    container.appendChild(stale)
    const replacement = createAppLike('replacement-tab', buildContainer())
    replacement.unmount = jest.fn()
    appInstanceMap.set(replacement.name, replacement)
    createAppLike('stale-parent', container).actionsForCompletelyDestroy()
    expect(replacement.unmount).not.toHaveBeenCalled()
    expect(replacement.container.querySelector('style').textContent).toBe('.a{color:red}')
  })

  test('nested keep-alive app follows real unmount instead of remaining hidden', () => {
    const container = buildContainer()
    const nested = document.createElement('micro-app-test')
    nested.setAttribute('name', 'real-nested-app')
    nested.setAttribute('keep-alive', '')
    const nestedDOM = buildContainer()
    nested.appendChild(nestedDOM)
    container.querySelector('micro-app-body')!.appendChild(nested)
    const child = createAppLike('real-nested-app', nested)
    child.loadSourceLevel = 2
    appInstanceMap.set(child.name, child)
    const unmount = jest.spyOn(child, 'unmount')
    const style = nested.querySelector('style')!
    createAppLike('real-parent-app', container).actionsForCompletelyDestroy()
    expect(unmount).toHaveBeenCalledTimes(1)
    expect(child.destroyed).toBe(true)
    expect(child.container).toBeNull()
    expect(appInstanceMap.has(child.name)).toBe(false)
    expect(style.textContent).toBe('')
  })

  test('real hide/show methods preserve DOM identity and form state until destroy', () => {
    const container = buildContainer()
    const input = document.createElement('input')
    input.value = 'edited value'
    container.querySelector('micro-app-body')!.appendChild(input)
    const head = container.querySelector('micro-app-head')!
    const style = container.querySelector('style')!
    const app = createAppLike('keepalive-dom-app', container)
    app.loadSourceLevel = 2
    const cleanup = jest.spyOn(app, 'clearInstanceDOM')
    app.hiddenKeepAliveApp()
    const hiddenContainer = app.container
    expect(hiddenContainer.querySelector('input')).toBe(input)
    app.showKeepAliveApp(container)
    expect(container.querySelector('input')).toBe(input)
    expect(input.value).toBe('edited value')
    expect(container.querySelector('micro-app-head')).toBe(head)
    expect(style.textContent).toBe('.a{color:red}')
    expect(cleanup).not.toHaveBeenCalled()
    app.actionsForCompletelyDestroy()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(head.childNodes.length).toBe(0)
    expect(style.textContent).toBe('')
    expect(container.childNodes.length).toBe(0)
    // A fresh instance cannot recover the old input from the discarded tree.
    const fresh = createAppLike('keepalive-dom-app', buildContainer())
    expect(fresh.container.querySelector('input')).toBeNull()
    expect(fresh.container.querySelector('micro-app-head')).not.toBe(head)
  })
})
