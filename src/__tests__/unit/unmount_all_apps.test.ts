jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import { appInstanceMap } from '../../create_app'
import { initGlobalEnv } from '../../libs/global_env'
import { unmountAllApps, unmountApp } from '../../micro_app'

describe('unmountAllApps terminal cleanup', () => {
  afterEach(() => {
    appInstanceMap.clear()
  })

  test('starts later cleanup in parallel but waits for each app unmount before destroy', async () => {
    let finishFirstUnmount!: () => void
    const firstDestroy = jest.fn(() => appInstanceMap.delete('first-app'))
    const firstUnmount = jest.fn(({ unmountcb }) => {
      finishFirstUnmount = () => {
        firstDestroy()
        unmountcb()
      }
    })
    const laterDestroy = jest.fn(() => appInstanceMap.delete('later-app'))
    initGlobalEnv()
    const mousedownListener = jest.fn()
    document.addEventListener('mousedown', mousedownListener)

    appInstanceMap.set('first-app', {
      isUnmounted: () => false,
      isPrefetch: false,
      isPrerender: false,
      isHidden: () => true,
      unmount: firstUnmount,
      actionsForCompletelyDestroy: firstDestroy,
    } as any)
    appInstanceMap.set('later-app', {
      isUnmounted: () => true,
      isPrefetch: false,
      isPrerender: false,
      actionsForCompletelyDestroy: laterDestroy,
    } as any)

    const unmountAllPromise = unmountAllApps({ destroy: true, clearData: true })
    await Promise.resolve()

    expect(firstUnmount).toHaveBeenCalledTimes(1)
    expect(firstDestroy).not.toHaveBeenCalled()
    expect(laterDestroy).toHaveBeenCalledTimes(1)
    expect(mousedownListener).not.toHaveBeenCalled()

    finishFirstUnmount()
    await expect(unmountAllPromise).resolves.toBe(true)
    expect(firstDestroy).toHaveBeenCalledTimes(1)
    expect(appInstanceMap.size).toBe(0)
    document.removeEventListener('mousedown', mousedownListener)
  })

  test('does not dispatch synthetic mouse events during terminal bulk cleanup', async () => {
    initGlobalEnv()
    const mousedownListener = jest.fn()
    document.addEventListener('mousedown', mousedownListener)
    appInstanceMap.set('destroy-event-path-app', {
      isUnmounted: () => true,
      isPrefetch: false,
      isPrerender: false,
      actionsForCompletelyDestroy: () => appInstanceMap.delete('destroy-event-path-app'),
    } as any)

    await unmountAllApps({ destroy: true })

    expect(mousedownListener).not.toHaveBeenCalled()
    document.removeEventListener('mousedown', mousedownListener)
  })

  test('terminally destroys an active app whose host was already removed', async () => {
    const destroy = jest.fn(() => appInstanceMap.delete('detached-active-app'))
    const unmount = jest.fn(({ unmountcb }) => {
      destroy()
      unmountcb()
    })
    appInstanceMap.set('detached-active-app', {
      container: null,
      isUnmounted: () => false,
      isPrefetch: false,
      isPrerender: false,
      isHidden: () => false,
      unmount,
      actionsForCompletelyDestroy: destroy,
    } as any)

    await expect(unmountApp('detached-active-app', {
      destroy: true,
      clearData: true,
    })).resolves.toBe(true)

    expect(unmount).toHaveBeenCalledWith(expect.objectContaining({
      destroy: true,
      clearData: true,
      keepRouteState: false,
    }))
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(appInstanceMap.has('detached-active-app')).toBe(false)
  })
})
