import { createAppTask, disposeAppTasks } from '../../libs/app_tasks'

describe('application async task cleanup', () => {
  test('opt-in disposer clears externally retained payload once on completion or cancellation', () => {
    for (const cancel of [false, true]) {
      const payload = { app: {} as object | null, initHook: (() => {}) as (() => void) | null }
      const cleanup = jest.fn((state: typeof payload) => { state.app = null; state.initHook = null })
      const task = createAppTask({}, payload, cleanup)
      expect(payload.app).not.toBeNull()
      cancel ? task.dispose() : task.complete()
      expect(payload).toEqual({ app: null, initHook: null })
      task.dispose()
      expect(cleanup).toHaveBeenCalledTimes(1)
    }
  })

  test('generic tasks do not mutate caller-owned objects', () => {
    const payload = { app: { name: 'caller-owned' } }
    createAppTask({}, payload).dispose()
    expect(payload.app.name).toBe('caller-owned')
  })
  test('terminal disposal severs references held by pending promise callbacks', async () => {
    const retained = {
      app: { name: 'pending-app' },
      container: document.createElement('micro-app'),
      sourceInfo: { code: 'large child bundle' },
    }
    const task = createAppTask('pending-app', retained)
    let resolvePending!: () => void
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve
    })
    const callback = jest.fn(() => task.current?.app)
    const reaction = pending.then(callback)

    disposeAppTasks('pending-app')

    expect(task.cancelled).toBe(true)
    expect(task.current).toBeNull()

    resolvePending()
    await reaction
    expect(callback).toHaveReturnedWith(undefined)
  })

  test('completion releases a task without marking it cancelled', () => {
    const task = createAppTask('completed-app', { app: { name: 'completed-app' } })
    task.complete()

    expect(task.cancelled).toBe(false)
    expect(task.current).toBeNull()
  })

  test('disposes falsy payloads including null exactly once', () => {
    for (const value of [0, '', false, null]) {
      const task = createAppTask('falsy-task', value)
      task.dispose()
      expect(task.cancelled).toBe(true)
      expect(task.current).toBeNull()
      task.complete()
      expect(task.cancelled).toBe(true)
    }
  })

  test('same-name application generations have independent task owners', () => {
    const oldApp = { name: 'reused-name' }
    const newApp = { name: 'reused-name' }
    const oldTask = createAppTask(oldApp, { app: oldApp })
    const newTask = createAppTask(newApp, { app: newApp })
    disposeAppTasks(oldApp)
    expect(oldTask.current).toBeNull()
    expect(newTask.current?.app).toBe(newApp)
    disposeAppTasks(newApp)
  })
})
