export interface AppTask<T> {
  current: T | null
  cancelled: boolean
  complete (): void
  dispose (): void
}

type TaskOwner = string | object
const appTaskMap = new Map<TaskOwner, Set<AppTask<unknown>>>()

/**
 * Keep asynchronous work behind a mutable holder. Promise reactions only
 * capture the holder, so terminal destroy can sever references to CreateApp,
 * DOM containers and source metadata even when a child-owned Promise stalls.
 */
export function createAppTask<T>(owner: TaskOwner, value: T, cleanup?: (value: T) => void): AppTask<T> {
  const tasks = appTaskMap.get(owner) || new Set<AppTask<unknown>>()
  let currentOwner: TaskOwner | null = owner
  let released = false
  let releasePayload = cleanup

  const task: AppTask<T> = {
    current: value,
    cancelled: false,
    complete: () => release(false),
    dispose: () => release(true),
  }

  const release = (cancelled: boolean): void => {
    /**
     * NOTE(已知边界) 2026.9.12 by Claude Code
     * 原实现用真值判断做幂等保护，falsy payload 会漏掉清理。
     * 2026.9.12 review: 已改为独立 released 标志，同时释放 instance owner。
     */
    // Review correction: null/falsy values are valid T values. Use an explicit
    // release flag, and clear the instance owner as well as the task payload.
    // Otherwise a retained task's complete/dispose closures retain the old app.
    if (released) return
    released = true
    task.cancelled = cancelled
    const payload = task.current
    task.current = null
    const disposePayload = releasePayload
    releasePayload = undefined
    tasks.delete(task as AppTask<unknown>)
    if (!tasks.size && currentOwner !== null) appTaskMap.delete(currentOwner)
    currentOwner = null
    // Opt-in only: never mutate arbitrary caller-owned payloads. Consumers
    // release their own state on both completion and cancellation.
    if (payload !== null) disposePayload?.(payload)
  }

  tasks.add(task as AppTask<unknown>)
  appTaskMap.set(owner, tasks)
  return task
}

export function disposeAppTasks(owner: TaskOwner): void {
  const tasks = appTaskMap.get(owner)
  if (!tasks) return
  Array.from(tasks).forEach((task) => task.dispose())
  appTaskMap.delete(owner)
}
