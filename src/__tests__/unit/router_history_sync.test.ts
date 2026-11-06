jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import type { AppInterface } from '@micro-app/types'
import { appInstanceMap } from '../../create_app'
import { initGlobalEnv } from '../../libs/global_env'
import WithSandBox from '../../sandbox/with'

describe('base history synchronizes search-mode child routes', () => {
  test('updates an active child on the first base replaceState', async () => {
    initGlobalEnv()
    const appName = 'history-sync-test'
    const sandbox = new WithSandBox(appName, 'http://child.example.com/')
    sandbox.clearHijackUmdHooks = jest.fn()
    appInstanceMap.set(appName, {
      routerMode: 'search',
      sandBox: sandbox,
      isPrefetch: false,
      isPrerender: false,
      isUnmounted: () => false,
      isHidden: () => false,
    } as unknown as AppInterface)

    sandbox.start({
      umdMode: false,
      baseroute: '',
      defaultPage: '/dashboard/guide',
      disablePatchRequest: false,
    })

    window.history.replaceState(
      {},
      '',
      '/wd/todo?history-sync-test=%2Fdashboard%2Fme%2Fmy-issues',
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((sandbox.proxyWindow.location as Location & { fullPath: string }).fullPath)
      .toBe('/dashboard/me/my-issues')

    sandbox.destroy()
    appInstanceMap.delete(appName)
    window.history.replaceState({}, '', '/')
  })

  test('coalesces intermediate base router writes and sends only the final child route', async () => {
    initGlobalEnv()
    const appName = 'history-sync-coalesce-test'
    const sandbox = new WithSandBox(appName, 'http://child.example.com/')
    sandbox.clearHijackUmdHooks = jest.fn()
    appInstanceMap.set(appName, {
      routerMode: 'search',
      sandBox: sandbox,
      isPrefetch: false,
      isPrerender: false,
      isUnmounted: () => false,
      isHidden: () => false,
    } as unknown as AppInterface)

    sandbox.start({
      umdMode: false,
      baseroute: '',
      defaultPage: '/dashboard/guide',
      disablePatchRequest: false,
    })

    window.history.replaceState({}, '', '/wd/todo?history-sync-coalesce-test=%2Fdashboard%2Fguide')
    window.history.replaceState({}, '', '/wd/todo?history-sync-coalesce-test=%2Fdashboard%2Fme%2Fmy-issues')

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((sandbox.proxyWindow.location as Location & { fullPath: string }).fullPath)
      .toBe('/dashboard/me/my-issues')

    sandbox.destroy()
    appInstanceMap.delete(appName)
    window.history.replaceState({}, '', '/')
  })
})
