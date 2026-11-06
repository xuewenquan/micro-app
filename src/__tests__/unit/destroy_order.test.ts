import CreateApp from '../../create_app'
import globalEnv, { initGlobalEnv } from '../../libs/global_env'

describe('terminal destroy ordering', () => {
  beforeEach(() => initGlobalEnv())
  test('waits for an asynchronous child unmount before destructive cleanup', async () => {
    let finishUnmount!: () => void
    const childUnmount = new Promise<void>((resolve) => {
      finishUnmount = resolve
    })
    const app = Object.create(CreateApp.prototype) as any
    app.name = 'async-destroy-order-app'
    app.sandBox = null
    app.actionsAfterUnmounted = jest.fn()

    app.handleUnmounted(true, true, false, undefined, childUnmount)

    expect(app.actionsAfterUnmounted).not.toHaveBeenCalled()

    finishUnmount()
    await childUnmount
    await Promise.resolve()

    expect(app.actionsAfterUnmounted).toHaveBeenCalledTimes(1)
    expect(app.actionsAfterUnmounted).toHaveBeenCalledWith(expect.objectContaining({
      destroy: true,
      clearData: true,
    }))
  })

  test('terminal destroy completes once when a child unmount Promise never settles', async () => {
    let timeout!: () => void
    let resolveUnmount!: () => void
    const pending = new Promise<void>((resolve) => { resolveUnmount = resolve })
    const originalSetTimeout = globalEnv.rawSetTimeout
    const originalClearTimeout = globalEnv.rawClearTimeout
    globalEnv.rawSetTimeout = jest.fn((callback, delay) => {
      expect(delay).toBe(3000)
      timeout = callback
      return 123
    })
    globalEnv.rawClearTimeout = jest.fn()
    try {
      const app = Object.create(CreateApp.prototype) as any
      app.name = 'stalled-destroy-app'
      app.sandBox = null
      app.actionsAfterUnmounted = jest.fn()
      app.handleUnmounted(true, true, false, undefined, pending)
      expect(app.actionsAfterUnmounted).not.toHaveBeenCalled()
      timeout()
      expect(app.actionsAfterUnmounted).toHaveBeenCalledTimes(1)
      resolveUnmount()
      await pending
      await Promise.resolve()
      expect(app.actionsAfterUnmounted).toHaveBeenCalledTimes(1)
    } finally {
      globalEnv.rawSetTimeout = originalSetTimeout
      globalEnv.rawClearTimeout = originalClearTimeout
    }
  })
})
