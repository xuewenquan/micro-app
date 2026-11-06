import { createResourceFactoryScope, RESOURCE_FACTORY_MARK } from '../../sandbox/resource_factory'
import { initGlobalEnv } from '../../libs/global_env'
import WithSandBox from '../../sandbox/with'

describe('instance-owned base realm factories', () => {
  test('late proxy reads cannot resurrect base-realm resources; new instances remain usable', () => {
    initGlobalEnv()
    const key = '__TEST_SHARED_RESOURCE_FACTORY__'
    const descriptor = Object.getOwnPropertyDescriptor(window, key)
    const factory = Object.assign(jest.fn(() => ({ dispose: jest.fn() })), { [RESOURCE_FACTORY_MARK]: true })
    Reflect.defineProperty(window, key, { configurable: true, value: { create: factory } })
    const old = new WithSandBox('late-factory-test', 'http://localhost/')
    const proxy = old.proxyWindow
    let current: WithSandBox | undefined
    try {
      old.destroy()
      // No cached factory: this is a fresh read through the dead proxy.
      expect(() => (proxy as any)[key].create()).toThrow('destroyed')
      expect(factory).not.toHaveBeenCalled()
      current = new WithSandBox('late-factory-test', 'http://localhost/')
      const resource = (current.proxyWindow as any)[key].create()
      expect(factory).toHaveBeenCalledTimes(1)
      old.destroy()
      expect(resource.dispose).not.toHaveBeenCalled()
      current.destroy()
      expect(resource.dispose).toHaveBeenCalledTimes(1)
    } finally {
      old.destroy()
      current?.destroy()
      if (descriptor) Reflect.defineProperty(window, key, descriptor)
      else Reflect.deleteProperty(window, key)
    }
  })
  test('terminal disposal is isolated; cached factories refuse late recreation', () => {
    const factory = Object.assign(jest.fn(() => ({ dispose: jest.fn() })), { [RESOURCE_FACTORY_MARK]: true })
    const base = { factory, ordinary: () => 1 }
    const a = createResourceFactoryScope()
    const b = createResourceFactoryScope()
    const pa = a.wrap(base) as typeof base
    const pb = b.wrap(base) as typeof base
    expect(a.wrap(base)).toBe(pa)
    expect(pa.factory).toBe(pa.factory)
    expect(pa.ordinary).toBe(base.ordinary)
    const old = pa.factory()
    const current = pb.factory()
    a.dispose()
    a.dispose()
    expect(old.dispose).toHaveBeenCalledTimes(1)
    expect(current.dispose).not.toHaveBeenCalled()
    expect(() => pa.factory()).toThrow('destroyed')
    b.dispose()
    expect(current.dispose).toHaveBeenCalledTimes(1)
  })

  test('unmarked objects and native-like objects retain identity', () => {
    const scope = createResourceFactoryScope()
    const value = { method: () => 1 }
    expect(scope.wrap(value)).toBe(value)
    expect(scope.wrap(window)).toBe(window)
  })

  test('sandbox stop preserves resources; terminal destroy releases them', () => {
    initGlobalEnv()
    const sandbox = new WithSandBox('shared-factory-test', 'http://localhost/')
    const resource = { dispose: jest.fn() }
    const factories = { create: Object.assign(() => resource, { [RESOURCE_FACTORY_MARK]: true }) }
    Reflect.set(sandbox.proxyWindow, '__TEST_FACTORIES__', factories)
    const scoped = Reflect.get(sandbox.proxyWindow, '__TEST_FACTORIES__') as typeof factories
    scoped.create()
    sandbox.start({ umdMode: true, baseroute: '', defaultPage: '', disablePatchRequest: false })
    sandbox.stop({ umdMode: true, keepRouteState: true, destroy: false, clearData: false })
    expect(resource.dispose).not.toHaveBeenCalled()
    sandbox.destroy()
    expect(resource.dispose).toHaveBeenCalledTimes(1)
    expect(() => scoped.create()).toThrow('destroyed')
  })
})
