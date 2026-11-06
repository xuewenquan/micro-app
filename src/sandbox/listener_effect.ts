import type { MicroEventListener } from '@micro-app/types'

type ListenerOptions = boolean | AddEventListenerOptions | EventListenerOptions

interface ListenerRecord {
  target: EventTarget
  type: string
  listener: MicroEventListener
  handler: MicroEventListener
  options?: ListenerOptions
  capture: boolean
}

interface ListenerEffect {
  add(
    target: EventTarget,
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
    handler?: MicroEventListener,
  ): void
  remove(
    fallbackTarget: EventTarget,
    type: string,
    listener: MicroEventListener,
    options?: boolean | EventListenerOptions,
    fallbackHandler?: MicroEventListener,
  ): void
  reset(): void
  record(): void
  rebuild(register: (record: ListenerRecord) => void): void
  release(): void
  dispose(): void
}

type NativeAddEventListener = typeof EventTarget.prototype.addEventListener
type NativeRemoveEventListener = typeof EventTarget.prototype.removeEventListener

/**
 * Track the exact native registration rather than attaching bookkeeping to the
 * listener function. A listener can legally be registered twice when capture
 * differs, and the target used by a sandbox can change during unmount.
 */
export default function createListenerEffect (
  rawAddEventListener: NativeAddEventListener,
  rawRemoveEventListener: NativeRemoveEventListener,
  beforeRemove?: (record: ListenerRecord) => void,
): ListenerEffect {
  let listeners: ListenerRecord[] = []
  let snapshot: ListenerRecord[] = []
  let disposed = false

  const getCapture = (options?: ListenerOptions): boolean => (
    typeof options === 'boolean' ? options : Boolean(options?.capture)
  )

  const isSameRegistration = (
    record: ListenerRecord,
    target: EventTarget,
    type: string,
    listener: MicroEventListener,
    capture: boolean,
  ): boolean => record.target === target && record.type === type &&
    record.listener === listener && record.capture === capture

  const add = (
    target: EventTarget,
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
    handler: MicroEventListener = listener,
  ): void => {
    if (!listener || disposed) return
    const capture = getCapture(options)
    const signal = typeof options === 'object'
      ? (options as AddEventListenerOptions & { signal?: AbortSignal }).signal
      : null
    if (signal?.aborted) return

    if (!listeners.some((record) => isSameRegistration(record, target, type, listener, capture))) {
      listeners.push({ target, type, listener, handler, options, capture })
    }
    rawAddEventListener.call(target, type, handler, options)
  }

  const remove = (
    fallbackTarget: EventTarget,
    type: string,
    listener: MicroEventListener,
    options?: boolean | EventListenerOptions,
    fallbackHandler: MicroEventListener = listener,
  ): void => {
    if (!listener) return
    const capture = getCapture(options)
    /**
     * NOTE(目标匹配已修正) 2026.9.12 review
     * 原实现按 (type, listener, capture) 匹配，忽略 target：因为一个 listener
     * 可能被注册到多个 target 上，而调用方给的 target 在容器被摘除后可能已经变了。
     * 代价：若子应用把同一个 listener 注册到两个不同元素、只对其中一个调用
     * removeEventListener，两个注册都会被摘掉（原生实现只摘一个）。
     * 现优先匹配调用方 target；只有 target 已经因沙箱路由变化而不在记录中时才兜底。
     */
    const candidates = listeners.filter((record) => (
      record.type === type && record.listener === listener && record.capture === capture
    ))
    const exactMatches = candidates.filter((record) => record.target === fallbackTarget)
    // Preserve target-specific DOM semantics whenever the requested target was
    // registered. Only use recorded targets as a fallback when sandbox routing
    // changed after its container was detached.
    const matches = exactMatches.length ? exactMatches : candidates

    if (matches.length) {
      // Use the target captured at add time. Recomputing it after the app
      // container is detached can silently remove from the wrong EventTarget.
      matches.forEach((record) => {
        beforeRemove?.(record)
        rawRemoveEventListener.call(record.target, record.type, record.handler, record.capture)
      })
      listeners = listeners.filter((record) => !matches.includes(record))
    } else {
      // Preserve native removeEventListener behaviour for registrations which
      // were not made through this sandbox wrapper.
      rawRemoveEventListener.call(fallbackTarget, type, fallbackHandler, options)
    }
  }

  const reset = (): void => {
    snapshot = []
  }

  const record = (): void => {
    listeners.forEach((listenerRecord) => {
      if (!snapshot.some((record) => isSameRegistration(
        record,
        listenerRecord.target,
        listenerRecord.type,
        listenerRecord.listener,
        listenerRecord.capture,
      ))) {
        snapshot.push(listenerRecord)
      }
    })
  }

  const rebuild = (register: (record: ListenerRecord) => void): void => {
    if (!disposed) snapshot.forEach(register)
    reset()
  }

  const release = (): void => {
    listeners.forEach((record) => {
      beforeRemove?.(record)
      rawRemoveEventListener.call(record.target, record.type, record.handler, record.capture)
    })
    listeners = []
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    release()
    reset()
  }

  return { add, remove, reset, record, rebuild, release, dispose }
}

export type { ListenerRecord }
