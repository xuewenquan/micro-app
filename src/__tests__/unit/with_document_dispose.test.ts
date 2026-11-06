jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import { initGlobalEnv } from '../../libs/global_env'
import WithSandBox from '../../sandbox/with'

describe('with sandbox document disposal', () => {
  test('detaches the per-app Document prototype proxy without revoking cached references', () => {
    initGlobalEnv()
    const sandbox = new WithSandBox('document-dispose-test', 'http://localhost/')
    sandbox.clearHijackUmdHooks = jest.fn()

    const MicroDocument = (sandbox.proxyWindow as any).Document as typeof Document
    const cachedDocument = sandbox.proxyWindow.document
    const microDocumentPrototype = MicroDocument.prototype
    const prototypeProxy = Object.getPrototypeOf(microDocumentPrototype)
    const cachedPrototypeAdd = Reflect.get(prototypeProxy, 'addEventListener')

    expect(prototypeProxy).not.toBe(Document.prototype)
    expect(typeof Reflect.get(prototypeProxy, 'querySelector')).toBe('function')

    sandbox.destroy()

    expect(Object.getPrototypeOf(microDocumentPrototype)).toBe(Document.prototype)
    expect(typeof Reflect.get(prototypeProxy, 'querySelector')).toBe('function')
    expect(() => cachedDocument.querySelector('body')).not.toThrow()
    expect(cachedDocument.defaultView).toBe(window)
    expect((cachedDocument as any).__MICRO_APP_NAME__).toBeNull()
    const listener = jest.fn()
    cachedPrototypeAdd('destroyed-document-event', listener)
    document.dispatchEvent(new Event('destroyed-document-event'))
    expect(listener).not.toHaveBeenCalled()
  })
})
