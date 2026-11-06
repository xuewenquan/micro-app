import type { microAppWindowType } from '@micro-app/types'
import { isFunction, rawDefineProperty } from '../libs/utils'

type ObserverInstance = {
  observe?: (...args: any[]) => any,
  disconnect: (...args: any[]) => any,
}

const OBSERVER_CONSTRUCTOR_NAMES = [
  'MutationObserver',
  'WebKitMutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'PerformanceObserver',
]

/**
 * Observers may register against nodes owned by the base application. Blink then
 * keeps their callbacks alive even after the micro application's DOM is removed.
 * Wrap constructors exposed to a child so all live observers can be disconnected
 * when the sandbox is permanently released.
 */
export function patchObserverConstructors (
  microAppWindow: microAppWindowType,
  sourceWindow: Window,
): (clearObserver: boolean) => void {
  const observerSet = new Set<ObserverInstance>()

  OBSERVER_CONSTRUCTOR_NAMES.forEach((name) => {
    const RawObserver = Reflect.get(sourceWindow, name)
    if (!isFunction(RawObserver)) return

    const ObserverProxy: typeof RawObserver = new Proxy(RawObserver, {
      construct (target, args, newTarget) {
        const observer = Reflect.construct(
          target,
          args,
          newTarget === ObserverProxy ? target : newTarget,
        ) as ObserverInstance
        const rawObserve = observer.observe
        const rawDisconnect = observer.disconnect

        observerSet.add(observer)

        if (isFunction(rawObserve)) {
          rawDefineProperty(observer, 'observe', {
            configurable: true,
            writable: true,
            value: function (...observeArgs: any[]) {
              observerSet.add(observer)
              return rawObserve.apply(observer, observeArgs)
            },
          })
        }

        if (isFunction(rawDisconnect)) {
          rawDefineProperty(observer, 'disconnect', {
            configurable: true,
            writable: true,
            value: function (...disconnectArgs: any[]) {
              observerSet.delete(observer)
              return rawDisconnect.apply(observer, disconnectArgs)
            },
          })
        }

        return observer
      },
    })

    rawDefineProperty(microAppWindow, name, {
      configurable: true,
      writable: true,
      value: ObserverProxy,
    })
  })

  return (clearObserver: boolean): void => {
    if (!clearObserver) return
    observerSet.forEach((observer) => {
      try {
        observer.disconnect()
      } catch (_) {
        // An observer supplied by a polyfill may throw during teardown.
      }
    })
    observerSet.clear()
  }
}

type MediaQueryListener = (this: MediaQueryList, event: MediaQueryListEvent) => any

interface MediaQueryListenerRecord {
  mediaQueryList: MediaQueryList
  listener: MediaQueryListener
}

/**
 * Old versions of responsive UI libraries use MediaQueryList.addListener.
 * Unlike addEventListener, addListener does not pass through EventTarget's
 * prototype, so Blink can retain its callback after the sandbox is destroyed.
 */
export function patchMatchMedia (
  microAppWindow: microAppWindowType,
  sourceWindow: Window,
): (clearListeners: boolean) => void {
  const rawMatchMedia = sourceWindow.matchMedia
  if (!isFunction(rawMatchMedia)) return () => undefined

  const listenerRecords = new Set<MediaQueryListenerRecord>()

  rawDefineProperty(microAppWindow, 'matchMedia', {
    configurable: true,
    writable: true,
    value: function (query: string): MediaQueryList {
      const mediaQueryList = rawMatchMedia.call(sourceWindow, query)
      const rawAddListener = mediaQueryList.addListener
      const rawRemoveListener = mediaQueryList.removeListener

      if (isFunction(rawAddListener) && isFunction(rawRemoveListener)) {
        rawDefineProperty(mediaQueryList, 'addListener', {
          configurable: true,
          writable: true,
          value: function (listener: MediaQueryListener): void {
            listenerRecords.add({ mediaQueryList, listener })
            rawAddListener.call(mediaQueryList, listener)
          },
        })
        rawDefineProperty(mediaQueryList, 'removeListener', {
          configurable: true,
          writable: true,
          value: function (listener: MediaQueryListener): void {
            listenerRecords.forEach((record) => {
              if (record.mediaQueryList === mediaQueryList && record.listener === listener) {
                listenerRecords.delete(record)
              }
            })
            rawRemoveListener.call(mediaQueryList, listener)
          },
        })
      }

      return mediaQueryList
    },
  })

  return (clearListeners: boolean): void => {
    if (!clearListeners) return
    listenerRecords.forEach(({ mediaQueryList, listener }) => {
      try {
        mediaQueryList.removeListener(listener)
      } catch (_) {
        // A browser/polyfill may throw while its realm is being torn down.
      }
    })
    listenerRecords.clear()
  }
}
