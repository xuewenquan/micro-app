jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

jest.mock('../../sandbox/adapter', () => {
  const actual = jest.requireActual('../../sandbox/adapter')
  return {
    ...actual,
    releaseElementInfoTree: jest.fn(),
  }
})

import IframeSandbox from '../../sandbox/iframe'
import CreateApp, { appInstanceMap } from '../../create_app'
import { initGlobalEnv } from '../../libs/global_env'
import { releaseWorkersByApp } from '../../proxies/worker'
import { releaseElementInfoTree } from '../../sandbox/adapter'
import sourceCenter from '../../source/source_center'
import { createAppTask } from '../../libs/app_tasks'

describe('iframe terminal destroy safety', () => {
  beforeEach(() => {
    initGlobalEnv()
    jest.clearAllMocks()
  })

  afterEach(() => {
    appInstanceMap.clear()
  })

  /**
   * 2026.9.12 by Claude Code
   * patchIframe 是异步的，windowEffect / documentEffect 只在 iframe 提交后的回调里
   * 赋值。修复前 destroy() 里写的是 `this.windowEffect.dispose?.()` —— `?.` 只保护了
   * dispose，没保护 windowEffect 本身，因此在 iframe 提交前销毁会抛 TypeError。
   * 该异常会从 CreateApp.actionsForCompletelyDestroy 冒泡出去，让它后面的
   * container / sandBox 置空与 appInstanceMap.delete 全部跳过，app 记录永久残留。
   */
  test('destroy before patchIframe completes does not throw and severs references', () => {
    const sandbox = new IframeSandbox('iframe-early-destroy', 'http://localhost/', { container: null })
    // patchIframe 的回调还没执行，这两个字段仍是 undefined
    expect((sandbox as any).windowEffect).toBeUndefined()
    expect((sandbox as any).documentEffect).toBeUndefined()

    // destroy() 内部用 try/catch 兜底，所以"不抛异常"本身不足以证明修好了 ——
    // 必须断言完全没有记录 sandbox 异常日志，否则 TypeError 会被静默吞掉。
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => sandbox.destroy()).not.toThrow()

      const sandboxErrors = errorSpy.mock.calls.filter((args) =>
        String(args[0]).includes('iframe sandbox'))
      expect(sandboxErrors).toEqual([])

      expect((sandbox as any).destroyed).toBe(true)
      // finally 段必须断开对 realm 的引用
      expect((sandbox as any).microAppWindow).toBeNull()
      expect((sandbox as any).proxyWindow).toBeNull()
      expect((sandbox as any).options).toBeNull()
    } finally {
      errorSpy.mockRestore()
    }
  })

  /**
   * 2026.9.12 by Claude Code
   * WithSandBox.destroy 对 keep-alive / umd 应用补了这段兜底，iframe 之前漏了：
   * 应用先 stop({ umdMode: true, destroy: false }) 再终态销毁时走非活跃分支，
   * 而 stop() 内的 releaseWorkersByApp 被 `!umdMode || destroy` 挡住。
   */
  test('destroy releases workers even when the sandbox is already inactive', () => {
    const sandbox = new IframeSandbox('iframe-worker-release', 'http://localhost/', { container: null })
    expect((sandbox as any).active).toBe(false)

    sandbox.destroy()

    expect(releaseWorkersByApp).toHaveBeenCalledWith('iframe-worker-release')
  })

  test('destroy is idempotent', () => {
    const sandbox = new IframeSandbox('iframe-idempotent', 'http://localhost/', { container: null })
    sandbox.destroy()

    expect(() => sandbox.destroy()).not.toThrow()
    expect(releaseWorkersByApp).toHaveBeenCalledTimes(1)
  })

  /**
   * 2026.9.12 by Claude Code
   * iframe 沙箱在默认模式 unmount 后会被 clearOptions 置空，两步销毁
   * （先 unmount 再 destroy）时 sandBox 已是 null，sandBox?.destroy?.() 空转 ——
   * releaseElementInfoTree 与 releaseWorkersByApp 都只挂在 IframeSandbox.destroy 里，
   * 于是 adapter.ts 的 iframeAppNodeMap 会永久持有该应用整棵游离 DOM。
   * 这里验证 CreateApp 层的兜底不依赖 sandbox 实例。
   */
  test('actionsForCompletelyDestroy releases iframe resources when sandBox is already null', () => {
    const app: any = Object.create(CreateApp.prototype)
    app.name = 'iframe-two-step-destroy'
    app.iframe = true
    app.destroyed = false
    app.sandBox = null
    app.container = null
    app.umdHookMount = null
    app.umdHookUnmount = null
    app.preRenderEvents = null
    app.source = { html: null, links: new Set(), scripts: new Set() }
    appInstanceMap.set(app.name, app)

    app.actionsForCompletelyDestroy()

    expect(releaseElementInfoTree).toHaveBeenCalledWith(null, 'iframe-two-step-destroy')
    expect(releaseWorkersByApp).toHaveBeenCalledWith('iframe-two-step-destroy')
    expect(appInstanceMap.has('iframe-two-step-destroy')).toBe(false)
  })

  test('ordinary default iframe unmount disposes its old realm without clearing application data', () => {
    const app: any = Object.create(CreateApp.prototype)
    const destroy = jest.fn()
    app.name = 'iframe-default-discard'
    app.iframe = true
    app.umdMode = false
    app.container = null
    app.sandBox = { destroy, deleteIframeElement: jest.fn() }
    appInstanceMap.set(app.name, app)
    const task = createAppTask(app, { app })
    const releaseRealm = jest.spyOn(sourceCenter, 'releaseAppRealm').mockImplementation(() => {})
    try {
      app.clearOptions(false)
      expect(releaseRealm).toHaveBeenCalledWith(app.name)
      expect(destroy).toHaveBeenCalledWith(false)
      expect(task.current).toBeNull()
      expect(app.sandBox).toBeNull()
      expect(appInstanceMap.get(app.name)).toBe(app)
    } finally {
      releaseRealm.mockRestore()
    }
  })
})
