jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import CreateApp, { appInstanceMap, isAppNameOwner } from '../../create_app'
import sourceCenter from '../../source/source_center'
import { fetchScriptSuccess } from '../../source/scripts'
import { createAppTask } from '../../libs/app_tasks'

// 构造一个只满足 actionsForCompletelyDestroy 所需字段的 app 实例
function createAppLike (name: string): any {
  const app: any = Object.create(CreateApp.prototype)
  app.name = name
  app.destroyed = false
  app.iframe = false
  app.sandBox = null
  app.container = null
  app.umdHookMount = null
  app.umdHookUnmount = null
  app.preRenderEvents = null
  app.source = { html: null, links: new Set(), scripts: new Set() }
  return app
}

describe('app name ownership guard', () => {
  afterEach(() => {
    appInstanceMap.clear()
    jest.restoreAllMocks()
  })

  /**
   * 2026.9.12 by Claude Code
   * 销毁后的迟到回调（onLoad / fetchScriptSuccess / fetchLinkSuccess）捕获的是旧实例，
   * 而 sourceCenter / appTaskMap / dataCenter 等注册表按 appName 索引。旧实例被同名
   * 新实例替换后，按 name 清理会误伤新实例。
   */
  test('isAppNameOwner: 无占用者 / 自己持有 / 被新实例接管', () => {
    const app = { name: 'owner-app' } as any

    expect(isAppNameOwner(app)).toBe(true)

    appInstanceMap.set('owner-app', app)
    expect(isAppNameOwner(app)).toBe(true)

    const replacement = { name: 'owner-app' } as any
    appInstanceMap.set('owner-app', replacement)
    expect(isAppNameOwner(app)).toBe(false)
  })

  test('旧实例被同名新实例替换后销毁时，不得清理按 name 索引的注册表', () => {
    const releaseSpy = jest.spyOn(sourceCenter, 'releaseApp').mockImplementation(() => undefined)

    const oldApp = createAppLike('replaced-app')
    appInstanceMap.set('replaced-app', oldApp)
    // 模拟 micro_app_element 的"先 destroy 再 create"/reload 造成的替换
    const newApp = createAppLike('replaced-app')
    appInstanceMap.set('replaced-app', newApp)
    const oldTask = createAppTask(oldApp, { app: oldApp })
    const newTask = createAppTask(newApp, { app: newApp })

    oldApp.actionsForCompletelyDestroy()

    expect(releaseSpy).not.toHaveBeenCalled()
    // 新实例必须仍然在册，且没有被顺手删掉
    expect(appInstanceMap.get('replaced-app')).toBe(newApp)
    expect(oldTask.current).toBeNull()
    expect(newTask.current?.app).toBe(newApp)
    newTask.dispose()
  })

  test('没有同名新实例时，销毁仍按 name 正常清理', () => {
    const releaseSpy = jest.spyOn(sourceCenter, 'releaseApp').mockImplementation(() => undefined)

    const soloApp = createAppLike('solo-app')
    appInstanceMap.set('solo-app', soloApp)

    soloApp.actionsForCompletelyDestroy()

    expect(releaseSpy).toHaveBeenCalledWith('solo-app')
    expect(appInstanceMap.has('solo-app')).toBe(false)
  })

  test('fetchScriptSuccess 的迟到回调在名字被接管时不清理，未被接管时才清理', () => {
    const releaseSpy = jest.spyOn(sourceCenter, 'releaseApp').mockImplementation(() => undefined)
    const scriptInfo: any = { code: '', isExternal: true, appSpace: {} }

    const orphanApp: any = { name: 'late-script-app', isDestroyed: () => true }
    fetchScriptSuccess('http://localhost/late.js', scriptInfo, 'code', orphanApp)
    expect(releaseSpy).toHaveBeenCalledWith('late-script-app')

    releaseSpy.mockClear()

    const replacedApp: any = { name: 'late-script-replaced', isDestroyed: () => true }
    appInstanceMap.set('late-script-replaced', { name: 'late-script-replaced' } as any)
    fetchScriptSuccess('http://localhost/late2.js', scriptInfo, 'code', replacedApp)
    expect(releaseSpy).not.toHaveBeenCalled()
  })
})
