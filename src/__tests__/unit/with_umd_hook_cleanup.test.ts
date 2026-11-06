jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import { initGlobalEnv } from '../../libs/global_env'
import WithSandBox from '../../sandbox/with'

describe('WithSandBox UMD hook cleanup', () => {
  beforeEach(() => {
    initGlobalEnv()
  })

  test('removes generated UMD accessors so they cannot retain CreateApp', () => {
    const sandbox = new WithSandBox('umd-cleanup-test', 'http://localhost/')
    sandbox.actionsBeforeExecScripts(document.body, jest.fn())

    expect(Object.getOwnPropertyDescriptor(sandbox.microAppWindow, 'mount')?.get).toBeInstanceOf(Function)
    expect(Object.getOwnPropertyDescriptor(sandbox.microAppWindow, 'unmount')?.get).toBeInstanceOf(Function)
    expect(Object.getOwnPropertyDescriptor(sandbox.microAppWindow, 'micro-app-umd-cleanup-test')?.get).toBeInstanceOf(Function)

    sandbox.clearHijackUmdHooks()

    expect(Object.prototype.hasOwnProperty.call(sandbox.microAppWindow, 'mount')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sandbox.microAppWindow, 'unmount')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sandbox.microAppWindow, 'micro-app-umd-cleanup-test')).toBe(false)
  })

  test('restores descriptors that existed before UMD interception', () => {
    const sandbox = new WithSandBox('umd-restore-test', 'http://localhost/')
    const originalMount = jest.fn()
    Object.defineProperty(sandbox.microAppWindow, 'mount', {
      configurable: true,
      enumerable: true,
      value: originalMount,
      writable: true,
    })

    sandbox.actionsBeforeExecScripts(document.body, jest.fn())
    sandbox.clearHijackUmdHooks()

    const descriptor = Object.getOwnPropertyDescriptor(sandbox.microAppWindow, 'mount')
    expect(descriptor?.value).toBe(originalMount)
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.writable).toBe(true)
  })

  test('terminal destroy removes globals retained by an inactive keep-alive app', () => {
    const sandbox = new WithSandBox('inactive-umd-cleanup-test', 'http://localhost/')
    sandbox.actionsBeforeExecScripts(document.body, jest.fn())
    sandbox.start({
      umdMode: true,
      baseroute: '',
      defaultPage: '',
      disablePatchRequest: false,
    })

    const retainedRuntime = { webpackRuntime: true }
    Reflect.set(sandbox.proxyWindow, 'webpackChunkInactiveApp', retainedRuntime)
    sandbox.escapeProperties.push('__INACTIVE_UMD_ESCAPE_TEST__')
    Reflect.set(sandbox.proxyWindow, '__INACTIVE_UMD_ESCAPE_TEST__', retainedRuntime)

    sandbox.stop({
      umdMode: true,
      keepRouteState: true,
      destroy: false,
      clearData: false,
    })
    expect(Reflect.get(sandbox.microAppWindow, 'webpackChunkInactiveApp')).toBe(retainedRuntime)
    expect(Reflect.get(window, '__INACTIVE_UMD_ESCAPE_TEST__')).toBe(retainedRuntime)

    const microAppWindow = sandbox.microAppWindow
    sandbox.destroy()

    expect(Reflect.has(microAppWindow, 'webpackChunkInactiveApp')).toBe(false)
    expect(Reflect.has(window, '__INACTIVE_UMD_ESCAPE_TEST__')).toBe(false)
  })

  test('terminal destroy clears synthetic globals without revoking cached proxies', () => {
    const sandbox = new WithSandBox('proxy-revoke-test', 'http://localhost/')
    const proxyWindow = sandbox.proxyWindow
    const microAppWindow = sandbox.microAppWindow
    const proxyDocument = microAppWindow.document

    expect(Reflect.has(microAppWindow, 'window')).toBe(true)
    expect(Reflect.has(microAppWindow, 'document')).toBe(true)

    sandbox.destroy()

    expect(Reflect.get(proxyWindow, 'window')).toBe(proxyWindow)
    expect(() => Reflect.get(proxyDocument, 'title')).not.toThrow()
    const lateListener = jest.fn()
    proxyWindow.addEventListener('destroyed-window-event', lateListener)
    window.dispatchEvent(new Event('destroyed-window-event'))
    expect(lateListener).not.toHaveBeenCalled()
    expect(Reflect.has(microAppWindow, 'window')).toBe(false)
    expect(Reflect.has(microAppWindow, 'self')).toBe(false)
    expect(Reflect.has(microAppWindow, 'parent')).toBe(false)
    expect(Reflect.has(microAppWindow, 'document')).toBe(false)
    expect(Reflect.has(microAppWindow, 'Document')).toBe(false)
    expect(Reflect.has(microAppWindow, '__MICRO_APP_NAME__')).toBe(false)
  })

  test('keeps websocket while hidden and closes it on terminal destroy', () => {
    class FakeWebSocket extends EventTarget {
      close = jest.fn(() => this.dispatchEvent(new Event('close')))
    }
    const rawWebSocket = window.WebSocket
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    })

    try {
      const sandbox = new WithSandBox('websocket-cleanup-test', 'http://localhost/')
      const socket = new (sandbox.proxyWindow as any).WebSocket('ws://localhost') as FakeWebSocket

      sandbox.start({
        umdMode: true,
        baseroute: '',
        defaultPage: '',
        disablePatchRequest: false,
      })
      sandbox.stop({
        umdMode: true,
        keepRouteState: true,
        destroy: false,
        clearData: false,
      })
      expect(socket.close).not.toHaveBeenCalled()

      sandbox.destroy()
      expect(socket.close).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: rawWebSocket,
      })
    }
  })
})
