import { createTrustedTypesScope } from '../../sandbox/trusted_types'
import { initGlobalEnv } from '../../libs/global_env'
import WithSandBox from '../../sandbox/with'

function fakeFactory (): any {
  return {
    createPolicy: jest.fn((_name: string, options: any) => options),
    isHTML (value: unknown): boolean { return value === this },
  }
}

describe('terminal Trusted Types callback isolation', () => {
  test('forwards sanitizer and arguments; disposal fails closed and isolates instances', () => {
    const factory = fakeFactory()
    const a = createTrustedTypesScope()
    const b = createTrustedTypesScope()
    const callback = jest.fn((text: string, suffix: string) => text + suffix)
    const pa = a.wrap(factory)
    expect(a.wrap(factory)).toBe(pa)
    expect(pa.isHTML(factory)).toBe(true)
    const old = pa.createPolicy('a', { createHTML: callback })
    const current = b.wrap(factory).createPolicy('b', { createHTML: callback })
    expect(old.createHTML('safe', '!')).toBe('safe!')
    a.dispose()
    a.dispose()
    expect(() => old.createHTML('unsafe')).toThrow('destroyed')
    expect(() => pa.createPolicy('late', {})).toThrow('destroyed')
    expect(current.createHTML('safe', '!')).toBe('safe!')
    expect(callback).toHaveBeenCalledTimes(2)
  })

  test('registration failure propagates without retaining callable callbacks', () => {
    const error = new Error('duplicate policy')
    let captured: any
    const factory = { createPolicy: (_name: string, options: any) => { captured = options; throw error } }
    const scope = createTrustedTypesScope()
    expect(() => scope.wrap(factory).createPolicy('x', { createHTML: () => 'x' })).toThrow(error)
    expect(() => captured.createHTML('x')).toThrow('destroyed')
  })

  test('UMD stop preserves policies; destroy blocks cached policies and late factory reads', () => {
    initGlobalEnv()
    const sandbox = new WithSandBox('trusted-types-test', 'http://localhost/')
    Reflect.set(sandbox.proxyWindow, 'trustedTypes', fakeFactory())
    const proxy = sandbox.proxyWindow
    const factory = (proxy as any).trustedTypes
    const policy = factory.createPolicy('test', { createHTML: (s: string) => s })
    sandbox.start({ umdMode: true, baseroute: '', defaultPage: '', disablePatchRequest: false })
    sandbox.stop({ umdMode: true, keepRouteState: true, destroy: false, clearData: false })
    expect(policy.createHTML('safe')).toBe('safe')
    sandbox.destroy()
    expect(() => policy.createHTML('safe')).toThrow('destroyed')
    expect(() => factory.createPolicy('late', {})).toThrow('destroyed')
    // This fake was child-owned; terminal cleanup removes it entirely.
    expect((proxy as any).trustedTypes).toBeUndefined()
  })
})
