jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import { initGlobalEnv } from '../../libs/global_env'
import { setCurrentAppName } from '../../libs/utils'
import WithSandBox from '../../sandbox/with'
import {
  activateEventTargetEffect,
  getDetachedEventTargetElements,
  disposeEventTargetEffect,
  patchEventTarget,
  rebuildEventTargetSnapshot,
  recordEventTargetSnapshot,
  releaseEventTargetListeners,
  releasePatchEventTarget,
} from '../../sandbox/event_target'

describe('EventTarget effect cleanup', () => {
  test('detached animation candidates require both an effect record and an app tag', () => {
    const owned = document.createElement('input')
    owned.__MICRO_APP_NAME__ = 'event-target-test'
    const base = document.createElement('input')
    const other = document.createElement('input')
    other.__MICRO_APP_NAME__ = 'other-event-target'
    activateEventTargetEffect('other-event-target')
    setCurrentAppName('event-target-test')
    const handler = jest.fn()
    owned.addEventListener('input', handler)
    base.addEventListener('input', handler)
    other.addEventListener('input', handler)
    setCurrentAppName(null)
    expect(getDetachedEventTargetElements('event-target-test')).toEqual([owned])
    // Snapshot candidates must not keep connected base DOM or other owners.
    document.body.appendChild(owned)
    expect(getDetachedEventTargetElements('event-target-test')).toEqual([])
    owned.remove()
    recordEventTargetSnapshot('event-target-test')
    releaseEventTargetListeners('event-target-test')
    expect(getDetachedEventTargetElements('event-target-test')).toEqual([owned])
    disposeEventTargetEffect('event-target-test')
    expect(getDetachedEventTargetElements('event-target-test')).toEqual([])
    disposeEventTargetEffect('other-event-target')
  })
  // Capture native descriptors once. Reinitializing globalEnv after a sandbox
  // has installed DOM patches can record the patch itself as the native setter.
  beforeAll(() => initGlobalEnv())

  beforeEach(() => {
    patchEventTarget()
    activateEventTargetEffect('event-target-test')
  })

  afterEach(() => {
    setCurrentAppName(null)
    disposeEventTargetEffect('event-target-test')
    releasePatchEventTarget()
  })

  test('removes events registered on the base documentElement', () => {
    const listener = jest.fn()
    setCurrentAppName('event-target-test')
    document.documentElement.addEventListener('micro-event-target-test', listener)
    setCurrentAppName(null)

    document.documentElement.dispatchEvent(new Event('micro-event-target-test'))
    expect(listener).toHaveBeenCalledTimes(1)

    releaseEventTargetListeners('event-target-test')
    document.documentElement.dispatchEvent(new Event('micro-event-target-test'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('removes events registered through a raw ownerDocument escape', () => {
    const listener = jest.fn()
    setCurrentAppName('event-target-test')
    const ownerDocument = document.documentElement.ownerDocument
    ownerDocument.addEventListener('micro-event-owner-document-test', listener)
    setCurrentAppName(null)

    ownerDocument.dispatchEvent(new Event('micro-event-owner-document-test'))
    expect(listener).toHaveBeenCalledTimes(1)

    releaseEventTargetListeners('event-target-test')
    ownerDocument.dispatchEvent(new Event('micro-event-owner-document-test'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('records and rebuilds listeners for keep-alive apps', () => {
    const listener = jest.fn()
    setCurrentAppName('event-target-test')
    document.documentElement.addEventListener('micro-event-target-rebuild', listener, true)
    setCurrentAppName(null)

    recordEventTargetSnapshot('event-target-test')
    releaseEventTargetListeners('event-target-test')
    document.documentElement.dispatchEvent(new Event('micro-event-target-rebuild'))
    expect(listener).not.toHaveBeenCalled()

    rebuildEventTargetSnapshot('event-target-test')
    document.documentElement.dispatchEvent(new Event('micro-event-target-rebuild'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('keeps element listeners live while a keep-alive sandbox is hidden', () => {
    const sandbox = new WithSandBox('event-target-test', 'http://localhost/')
    const listener = jest.fn()
    setCurrentAppName('event-target-test')
    document.documentElement.addEventListener('micro-event-target-keep-alive', listener)
    setCurrentAppName(null)

    sandbox.recordAndReleaseEffect({ keepAlive: true })
    document.documentElement.dispatchEvent(new Event('micro-event-target-keep-alive'))
    expect(listener).toHaveBeenCalledTimes(1)

    sandbox.rebuildEffectSnapshot()
    document.documentElement.dispatchEvent(new Event('micro-event-target-keep-alive'))
    expect(listener).toHaveBeenCalledTimes(2)

    sandbox.destroy()
    document.documentElement.dispatchEvent(new Event('micro-event-target-keep-alive'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('ignores late listeners after terminal destroy', () => {
    const listener = jest.fn()
    disposeEventTargetEffect('event-target-test')
    setCurrentAppName('event-target-test')
    document.documentElement.addEventListener('micro-event-target-late', listener)
    setCurrentAppName(null)

    document.documentElement.dispatchEvent(new Event('micro-event-target-late'))
    expect(listener).not.toHaveBeenCalled()
  })

  test('raw document wrapper also cleans library registry only on terminal destroy', () => {
    const sandbox = new WithSandBox('event-target-test', 'http://localhost/')
    const listener = jest.fn()
    const base = jest.fn()
    const entries = [{ listener, proxyListener: listener }, { listener: base, proxyListener: base }]
    Object.defineProperty(document, 'dom7Listeners', { configurable: true, value: { mousedown: entries } })
    try {
      sandbox.start({ umdMode: true, baseroute: '', defaultPage: '', disablePatchRequest: false })
      sandbox.proxyWindow.document.addEventListener('mousedown', listener)
      sandbox.stop({ umdMode: true, keepRouteState: true, destroy: false, clearData: false })
      expect(entries).toHaveLength(2)
      sandbox.destroy()
      expect(entries).toEqual([{ listener: base, proxyListener: base }])
    } finally {
      sandbox.destroy()
      Reflect.deleteProperty(document, 'dom7Listeners')
    }
  })

  test('raw window removal retains library cleanup until terminal destroy', () => {
    const sandbox = new WithSandBox('event-target-test', 'http://localhost/')
    sandbox.actionsBeforeExecScripts(document.createElement('div'), jest.fn())
    const listener = jest.fn()
    const base = jest.fn()
    const entries = [{ listener, proxyListener: listener }, { listener: base, proxyListener: base }]
    Object.defineProperty(window, 'dom7Listeners', { configurable: true, value: { mousedown: entries } })
    try {
      sandbox.start({ umdMode: false, baseroute: '', defaultPage: '', disablePatchRequest: false })
      sandbox.proxyWindow.addEventListener('mousedown', listener, true)
      sandbox.proxyWindow.removeEventListener('mousedown', listener, true)
      // Review correction: native removal must not discard the evidence needed
      // to remove a library's own registry on terminal disposal.
      expect(entries).toHaveLength(2)
      window.dispatchEvent(new Event('mousedown'))
      expect(listener).not.toHaveBeenCalled()
      sandbox.destroy()
      expect(entries).toEqual([{ listener: base, proxyListener: base }])
    } finally {
      sandbox.destroy()
      Reflect.deleteProperty(window, 'dom7Listeners')
    }
  })

  test('terminal disposal cleans only owned dom7 entries after ordinary stop', () => {
    const child = jest.fn()
    const base = jest.fn()
    const entries = [{ listener: child, proxyListener: child }, { listener: base, proxyListener: base }]
    Object.defineProperty(document.body, 'dom7Listeners', { configurable: true, value: { mousedown: entries } })
    try {
      setCurrentAppName('event-target-test')
      document.body.addEventListener('mousedown', child)
      setCurrentAppName(null)
      document.body.addEventListener('mousedown', base)
      recordEventTargetSnapshot('event-target-test')
      releaseEventTargetListeners('event-target-test')
      expect(entries).toHaveLength(2)
      rebuildEventTargetSnapshot('event-target-test')
      document.body.dispatchEvent(new Event('mousedown'))
      expect(child).toHaveBeenCalledTimes(1)
      disposeEventTargetEffect('event-target-test')
      expect(entries).toEqual([{ listener: base, proxyListener: base }])
      document.body.dispatchEvent(new Event('mousedown'))
      expect(child).toHaveBeenCalledTimes(1)
      expect(base).toHaveBeenCalledTimes(2)
    } finally {
      document.body.removeEventListener('mousedown', base)
      Reflect.deleteProperty(document.body, 'dom7Listeners')
    }
  })

  test('a shared dom7 entry survives until its other app owner is destroyed', () => {
    const listener = jest.fn()
    const entries = [{ listener, proxyListener: listener }]
    Object.defineProperty(document.body, 'dom7Listeners', { configurable: true, value: { mousedown: entries } })
    activateEventTargetEffect('event-target-other')
    try {
      for (const name of ['event-target-test', 'event-target-other']) {
        setCurrentAppName(name)
        document.body.addEventListener('mousedown', listener)
      }
      setCurrentAppName(null)
      disposeEventTargetEffect('event-target-test')
      expect(entries).toHaveLength(1)
      document.body.dispatchEvent(new Event('mousedown'))
      expect(listener).toHaveBeenCalledTimes(1)
      disposeEventTargetEffect('event-target-other')
      expect(entries).toHaveLength(0)
      document.body.dispatchEvent(new Event('mousedown'))
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      disposeEventTargetEffect('event-target-other')
      Reflect.deleteProperty(document.body, 'dom7Listeners')
    }
  })
})
