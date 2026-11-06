jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
}))

import { initGlobalEnv } from '../../libs/global_env'
import { patchWindow } from '../../sandbox/iframe/window'
import IframeSandbox, { clearIframeFrameworkGlobals } from '../../sandbox/iframe'
import { releaseElementInfoTree, updateElementInfo } from '../../sandbox/adapter'
import { appInstanceMap } from '../../create_app'

describe('iframe native resource cleanup', () => {
  test('preserves UMD persistent resources on ordinary unmount but clears them on destroy', () => {
    const sandbox = Object.create(IframeSandbox.prototype) as any
    sandbox.appName = 'iframe-umd-resource-test'
    sandbox.windowEffect = { release: jest.fn() }
    sandbox.documentEffect = { release: jest.fn() }
    sandbox.microAppWindow = { microApp: { clearDataListener: jest.fn(), clearGlobalDataListener: jest.fn() } }
    sandbox.releaseGlobalEffect({ umdMode: true })
    expect(sandbox.windowEffect.release).toHaveBeenLastCalledWith(false)
    sandbox.releaseGlobalEffect({ umdMode: true, destroy: true })
    expect(sandbox.windowEffect.release).toHaveBeenLastCalledWith(true)
  })
  test('removes Vue development runtime roots on terminal destroy', () => {
    const plugins = [{ app: {} }]
    const formatters = [{}]
    const microAppWindow = {
      __VUE_INSTANCE_SETTERS__: [jest.fn()],
      __VUE_SSR_SETTERS__: [jest.fn()],
      __VUE_DEVTOOLS_PLUGINS__: plugins,
      __VUE_HMR_RUNTIME__: { createRecord: jest.fn() },
      __VUE_DEVTOOLS_HOOK_REPLAY__: [],
      __vueuse_ssr_handlers__: {},
      devtoolsFormatters: formatters,
    } as any

    clearIframeFrameworkGlobals(microAppWindow)

    expect(plugins).toHaveLength(0)
    expect(formatters).toHaveLength(0)
    expect(Reflect.ownKeys(microAppWindow)).toHaveLength(0)
  })

  test('removes instance-level adapters from a destroyed iframe DOM tree', () => {
    initGlobalEnv()
    appInstanceMap.set('iframe-resource-test', {
      iframe: true,
      sandBox: { proxyWindow: window },
    } as any)
    const root = document.createElement('div')
    const child = document.createTextNode('child')
    const foreignChild = document.createElement('span')
    root.append(child, foreignChild)

    updateElementInfo(root, 'iframe-resource-test')
    updateElementInfo(child, 'iframe-resource-test')
    const eventInvokerKey = Symbol('_vei')
    Object.defineProperties(child, {
      __vnode: { configurable: true, value: {} },
      __vueParentComponent: { configurable: true, value: {} },
      [eventInvokerKey]: { configurable: true, value: {} },
    })
    Object.defineProperty(foreignChild, '__MICRO_APP_NAME__', {
      configurable: true,
      value: 'another-app',
    })
    root.removeChild(child)

    releaseElementInfoTree(root, 'iframe-resource-test')

    expect(Object.prototype.hasOwnProperty.call(root, 'getRootNode')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(child, 'ownerDocument')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(child, '__vnode')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(child, '__vueParentComponent')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(child, eventInvokerKey)).toBe(true)
    expect((root as any).__MICRO_APP_NAME__).toBeUndefined()
    expect((foreignChild as any).__MICRO_APP_NAME__).toBe('another-app')
    appInstanceMap.delete('iframe-resource-test')
  })

  test('keeps resources while hidden and releases them on terminal unmount', () => {
    initGlobalEnv()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const microAppWindow = iframe.contentWindow as Window & Record<string, any>
    const clearInterval = jest.fn()
    const clearTimeout = jest.fn()
    let nextTimerId = 0

    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      close = jest.fn(() => this.dispatchEvent(new Event('close')))
    }

    Object.defineProperties(microAppWindow, {
      setInterval: {
        configurable: true,
        writable: true,
        value: jest.fn(() => ++nextTimerId),
      },
      setTimeout: {
        configurable: true,
        writable: true,
        value: jest.fn(() => ++nextTimerId),
      },
      clearInterval: {
        configurable: true,
        writable: true,
        value: clearInterval,
      },
      clearTimeout: {
        configurable: true,
        writable: true,
        value: clearTimeout,
      },
      WebSocket: {
        configurable: true,
        writable: true,
        value: FakeWebSocket,
      },
    })

    const effect = patchWindow('iframe-resource-test', microAppWindow as any, {
      escapeProperties: [],
      proxyLocation: {},
    } as any)
    const intervalId = microAppWindow.setInterval(jest.fn(), 100)
    const timeoutId = microAppWindow.setTimeout(jest.fn(), 100)
    const socket = new microAppWindow.WebSocket('ws://localhost') as FakeWebSocket

    effect.release(false)
    expect(clearInterval).not.toHaveBeenCalled()
    expect(clearTimeout).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()

    effect.release(true)
    expect(clearInterval).toHaveBeenCalledWith(intervalId)
    expect(clearTimeout).toHaveBeenCalledWith(timeoutId)
    expect(socket.close).toHaveBeenCalledTimes(1)

    iframe.remove()
  })

  test('does not lose an iframe window listener after a mismatched capture removal', () => {
    initGlobalEnv()
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const microAppWindow = iframe.contentWindow as Window & Record<string, any>
    const effect = patchWindow('iframe-listener-test', microAppWindow as any, {
      escapeProperties: [],
      proxyLocation: {},
    } as any)
    const listener = jest.fn()
    const eventName = 'iframe-capture-mismatch-event'

    microAppWindow.addEventListener(eventName, listener, true)
    microAppWindow.removeEventListener(eventName, listener, false)
    window.dispatchEvent(new Event(eventName))
    expect(listener).toHaveBeenCalledTimes(1)

    effect.dispose?.()
    window.dispatchEvent(new Event(eventName))
    expect(listener).toHaveBeenCalledTimes(1)
    iframe.remove()
  })
})
