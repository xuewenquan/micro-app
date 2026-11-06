jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import WithSandBox from '../../sandbox/with'
import globalEnv, {
  initGlobalEnv,
  beginRawGlobalObjectTracking,
  finishRawGlobalObjectTracking,
  releaseRawGlobalObjectPatches,
} from '../../libs/global_env'

describe('Vue runtime global isolation', () => {
  test('does not share Vue runtime setter arrays with the base window', () => {
    const rawWindow = window as unknown as Record<string, unknown>
    const baseInstanceSetters = [jest.fn()]
    const baseSSRSetters = [jest.fn()]
    Object.defineProperties(window, {
      __VUE_INSTANCE_SETTERS__: {
        value: baseInstanceSetters,
        configurable: true,
        writable: true,
      },
      __VUE_SSR_SETTERS__: {
        value: baseSSRSetters,
        configurable: true,
        writable: true,
      },
    })
    initGlobalEnv()

    const sandbox = new WithSandBox('vue-runtime-test', 'http://localhost/')
    const proxyWindow = sandbox.proxyWindow as unknown as Record<string, unknown>

    expect(proxyWindow.__VUE_INSTANCE_SETTERS__).toBeUndefined()
    expect(proxyWindow.__VUE_SSR_SETTERS__).toBeUndefined()

    const childInstanceSetters = [jest.fn()]
    const childSSRSetters = [jest.fn()]
    proxyWindow.__VUE_INSTANCE_SETTERS__ = childInstanceSetters
    proxyWindow.__VUE_SSR_SETTERS__ = childSSRSetters

    expect(proxyWindow.__VUE_INSTANCE_SETTERS__).toBe(childInstanceSetters)
    expect(proxyWindow.__VUE_SSR_SETTERS__).toBe(childSSRSetters)
    expect(rawWindow.__VUE_INSTANCE_SETTERS__).toBe(baseInstanceSetters)
    expect(rawWindow.__VUE_SSR_SETTERS__).toBe(baseSSRSetters)

    sandbox.destroy()
    Reflect.deleteProperty(window, '__VUE_INSTANCE_SETTERS__')
    Reflect.deleteProperty(window, '__VUE_SSR_SETTERS__')
  })

  test('defineProperty does not overwrite an existing base-window property', () => {
    const rawWindow = window as unknown as Record<string, unknown>
    const propertyName = '__MICRO_APP_EXISTING_RAW_PROPERTY__'
    const baseValue = { owner: 'base' }
    Object.defineProperty(window, propertyName, {
      value: baseValue,
      configurable: true,
      writable: true,
    })
    initGlobalEnv()

    const sandbox = new WithSandBox('define-property-test', 'http://localhost/')
    const proxyWindow = sandbox.proxyWindow as unknown as Record<string, unknown>
    const childValue = () => 'child'

    // Polyfills commonly inspect the descriptor before redefining a global.
    expect(Object.getOwnPropertyDescriptor(proxyWindow, propertyName)?.value).toBe(baseValue)
    Object.defineProperty(proxyWindow, propertyName, {
      value: childValue,
      configurable: true,
      writable: true,
    })

    expect(proxyWindow[propertyName]).toBe(childValue)
    expect(rawWindow[propertyName]).toBe(baseValue)
    expect(sandbox.injectedKeys.has(propertyName)).toBe(true)

    sandbox.destroy()
    Reflect.deleteProperty(window, propertyName)
  })

  test('restores tracked core-js Symbol configuration hooks when their owner is destroyed', () => {
    const rawSymbol = window.Symbol as typeof Symbol & Record<string, unknown>
    const rawIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
    const originalUseSetter = Object.getOwnPropertyDescriptor(rawSymbol, 'useSetter')
    const originalUseSimple = Object.getOwnPropertyDescriptor(rawSymbol, 'useSimple')
    const originalDrop = Object.getOwnPropertyDescriptor(rawIteratorPrototype, 'drop')
    initGlobalEnv()

    const sandbox = new WithSandBox('symbol-pollution-test', 'http://localhost/')
    sandbox.clearHijackUmdHooks = jest.fn()
    sandbox.start({
      umdMode: false,
      baseroute: '',
      defaultPage: '',
      disablePatchRequest: false,
    })
    const before = beginRawGlobalObjectTracking()
    rawSymbol.useSetter = () => 'child-setter'
    rawSymbol.useSimple = () => 'child-simple'
    Object.defineProperty(rawIteratorPrototype, 'drop', {
      configurable: true,
      value: () => 'child-drop',
    })

    finishRawGlobalObjectTracking(sandbox, before)
    sandbox.destroy()
    releaseRawGlobalObjectPatches(sandbox)

    expect(Object.getOwnPropertyDescriptor(rawSymbol, 'useSetter')).toEqual(originalUseSetter)
    expect(Object.getOwnPropertyDescriptor(rawSymbol, 'useSimple')).toEqual(originalUseSimple)
    expect(Object.getOwnPropertyDescriptor(rawIteratorPrototype, 'drop')).toEqual(originalDrop)
  })

  test('restores native DOM prototype methods installed by a child app', () => {
    const originalRemove = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'remove')
    initGlobalEnv()
    expect(globalEnv.rawWindow.HTMLSelectElement).toBe(HTMLSelectElement)

    const sandbox = new WithSandBox('dom-prototype-pollution-test', 'http://localhost/')
    sandbox.clearHijackUmdHooks = jest.fn()
    sandbox.start({
      umdMode: false,
      baseroute: '',
      defaultPage: '',
      disablePatchRequest: false,
    })

    const before = beginRawGlobalObjectTracking()
    const childRemove = function () {
      return sandbox.proxyWindow
    }
    const childHTMLSelectElement = (sandbox.proxyWindow as any).HTMLSelectElement
    expect(globalEnv.rawGlobalObjectPropertySnapshots.some(
      (snapshot: {target: object}) => snapshot.target === HTMLSelectElement.prototype,
    )).toBe(true)
    Object.defineProperty(childHTMLSelectElement.prototype, 'remove', {
      configurable: true,
      writable: true,
      value: childRemove,
    })
    expect(HTMLSelectElement.prototype.remove).toBe(childRemove)

    finishRawGlobalObjectTracking(sandbox, before)
    sandbox.destroy()
    releaseRawGlobalObjectPatches(sandbox)

    expect(Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'remove')).toEqual(originalRemove)
  })

  test('restores Function.prototype methods installed by a child polyfill', () => {
    const originalToString = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')
    initGlobalEnv()

    const sandbox = new WithSandBox('function-prototype-pollution-test', 'http://localhost/')
    sandbox.clearHijackUmdHooks = jest.fn()
    sandbox.start({
      umdMode: false,
      baseroute: '',
      defaultPage: '',
      disablePatchRequest: false,
    })

    const before = beginRawGlobalObjectTracking()
    const childToString = function () {
      return sandbox.proxyWindow as any
    }
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: childToString,
    })
    expect(Function.prototype.toString).toBe(childToString)

    finishRawGlobalObjectTracking(sandbox, before)
    sandbox.destroy()
    releaseRawGlobalObjectPatches(sandbox)

    expect(Object.getOwnPropertyDescriptor(Function.prototype, 'toString')).toEqual(originalToString)
  })
})
