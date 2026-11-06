jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import { initGlobalEnv } from '../../libs/global_env'
import WithSandBox from '../../sandbox/with'
import createListenerEffect from '../../sandbox/listener_effect'

const createSandbox = (appName: string): WithSandBox => {
  initGlobalEnv()
  return new WithSandBox(appName, 'http://localhost/')
}

describe('capturing event listener cleanup', () => {
  test('removes capturing listeners registered through proxy document', () => {
    const sandbox = createSandbox('capture-document-test')
    const listener = jest.fn()

    sandbox.proxyWindow.document.addEventListener('capture-document-event', listener, true)
    document.dispatchEvent(new Event('capture-document-event'))
    expect(listener).toHaveBeenCalledTimes(1)

    sandbox.releaseGlobalEffect({ destroy: true })
    document.dispatchEvent(new Event('capture-document-event'))
    expect(listener).toHaveBeenCalledTimes(1)
    sandbox.destroy()
  })

  test('removes capturing listeners registered through proxy window', () => {
    const sandbox = createSandbox('capture-window-test')
    const listener = jest.fn()

    sandbox.proxyWindow.addEventListener('capture-window-event', listener, { capture: true })
    window.dispatchEvent(new Event('capture-window-event'))
    expect(listener).toHaveBeenCalledTimes(1)

    sandbox.releaseGlobalEffect({ destroy: true })
    window.dispatchEvent(new Event('capture-window-event'))
    expect(listener).toHaveBeenCalledTimes(1)
    sandbox.destroy()
  })

  test('a mismatched remove call does not lose the capturing window listener record', () => {
    const sandbox = createSandbox('capture-mismatch-window-test')
    const listener = jest.fn()
    const eventName = 'capture-mismatch-window-event'

    sandbox.proxyWindow.addEventListener(eventName, listener, { capture: true, passive: true })
    sandbox.proxyWindow.removeEventListener(eventName, listener)
    window.dispatchEvent(new Event(eventName))
    expect(listener).toHaveBeenCalledTimes(1)

    sandbox.destroy()
    window.dispatchEvent(new Event(eventName))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('destroy removes both capture registrations for the same window listener', () => {
    const sandbox = createSandbox('dual-capture-window-test')
    const listener = jest.fn()
    const eventName = 'dual-capture-window-event'

    sandbox.proxyWindow.addEventListener(eventName, listener, false)
    sandbox.proxyWindow.addEventListener(eventName, listener, true)
    window.dispatchEvent(new Event(eventName))
    expect(listener).toHaveBeenCalledTimes(2)

    sandbox.destroy()
    window.dispatchEvent(new Event(eventName))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('a captured addEventListener function cannot register after destroy', () => {
    const sandbox = createSandbox('late-window-listener-test')
    const lateAddEventListener = sandbox.proxyWindow.addEventListener
    const listener = jest.fn()
    const eventName = 'late-window-listener-event'

    sandbox.destroy()
    lateAddEventListener(eventName, listener)
    window.dispatchEvent(new Event(eventName))
    expect(listener).not.toHaveBeenCalled()
  })

  test('remove uses the target captured during add instead of a later fallback target', () => {
    const registeredTarget = new EventTarget()
    const laterTarget = new EventTarget()
    const listener = jest.fn()
    const listenerEffect = createListenerEffect(
      EventTarget.prototype.addEventListener,
      EventTarget.prototype.removeEventListener,
    )

    listenerEffect.add(registeredTarget, 'target-change-event', listener, true)
    listenerEffect.remove(laterTarget, 'target-change-event', listener, true)
    registeredTarget.dispatchEvent(new Event('target-change-event'))

    expect(listener).not.toHaveBeenCalled()
    listenerEffect.dispose()
  })

  test('removing one target preserves the same listener registered on another target', () => {
    const first = new EventTarget()
    const second = new EventTarget()
    const listener = jest.fn()
    const effect = createListenerEffect(EventTarget.prototype.addEventListener, EventTarget.prototype.removeEventListener)
    effect.add(first, 'shared-listener', listener)
    effect.add(second, 'shared-listener', listener)
    effect.remove(first, 'shared-listener', listener)
    first.dispatchEvent(new Event('shared-listener'))
    expect(listener).not.toHaveBeenCalled()
    second.dispatchEvent(new Event('shared-listener'))
    expect(listener).toHaveBeenCalledTimes(1)
    effect.dispose()
  })
})
