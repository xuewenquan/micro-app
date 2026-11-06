import type {
  microAppWindowType,
  CommonEffectHook,
  MicroEventListener,
  timeInfo,
  WithSandBoxInterface,
} from '@micro-app/types'
import globalEnv, { snapshotRawGlobalObjectProperties } from '../../libs/global_env'
import bindFunctionToRawTarget from '../bind_function'
import {
  SCOPE_WINDOW_EVENT_OF_WITH,
  SCOPE_WINDOW_ON_EVENT_OF_WITH,
  RAW_GLOBAL_TARGET,
} from '../../constants'
import {
  isString,
  includes,
  unique,
  throttleDeferForSetAppName,
  rawDefineProperty,
  rawHasOwnProperty,
  removeDomScope,
  getRootContainer,
  formatEventType,
  isFunction,
  isConstructor,
} from '../../libs/utils'
import {
  appInstanceMap,
} from '../../create_app'
import WorkerProxy from '../../proxies/worker'
import { patchMatchMedia, patchObserverConstructors } from '../observer'
import createListenerEffect from '../listener_effect'
import { createResourceFactoryScope } from '../resource_factory'
import { createTrustedTypesScope } from '../trusted_types'
import { retainSandboxDom7Cleanup } from '../event_target'
import { patchAnimationFrame } from '../animation_frame'

/**
 * patch window of child app
 * @param appName app name
 * @param microAppWindow microWindow of child app
 * @param sandbox WithSandBox
 * @returns EffectHook
 */
export function patchWindow (
  appName: string,
  microAppWindow: microAppWindowType,
  sandbox: WithSandBoxInterface,
): CommonEffectHook {
  patchWindowProperty(microAppWindow)
  const disposeProxyWindow = createProxyWindow(appName, microAppWindow, sandbox)
  const effect = patchWindowEffect(microAppWindow, appName)
  const disposeEffect = effect.dispose
  effect.dispose = () => {
    disposeEffect?.()
    disposeProxyWindow()
  }
  return effect
}

/**
 * rewrite special properties of window
 * @param appName app name
 * @param microAppWindow child app microWindow
 */
function patchWindowProperty (
  microAppWindow: microAppWindowType,
):void {
  const rawWindow = globalEnv.rawWindow
  Object.getOwnPropertyNames(rawWindow)
    .filter((key: string) => {
      return /^on/.test(key) && !SCOPE_WINDOW_ON_EVENT_OF_WITH.includes(key)
    })
    .forEach((eventName: string) => {
      const { enumerable, writable, set } = Object.getOwnPropertyDescriptor(rawWindow, eventName) || {
        enumerable: true,
        writable: true,
      }
      rawDefineProperty(microAppWindow, eventName, {
        enumerable,
        configurable: true,
        get: () => rawWindow[eventName],
        set: writable ?? !!set
          ? (value) => { rawWindow[eventName] = value }
          : undefined,
      })
    })
}

/**
 * create proxyWindow with Proxy(microAppWindow)
 * @param appName app name
 * @param microAppWindow micro app window
 * @param sandbox WithSandBox
 */
function createProxyWindow (
  initialAppName: string,
  microAppWindow: microAppWindowType,
  initialSandbox: WithSandBoxInterface,
): () => void {
  const rawWindow = globalEnv.rawWindow
  let appName: string | null = initialAppName
  let sandbox: WithSandBoxInterface | null = initialSandbox
  const ignoreLateEffect = () => 0
  const resourceFactories = createResourceFactoryScope()
  const trustedTypes = createTrustedTypesScope()

  rawDefineProperty(microAppWindow, 'Worker', {
    value: WorkerProxy,
    configurable: true,
    writable: true,
  })

  // Like document, window must remain readable by cached framework teardown.
  // Dispose severs mutable sandbox context instead of revoking the Proxy.
  const proxyWindow = new Proxy(microAppWindow, {
    get: (target: microAppWindowType, key: PropertyKey): unknown => {
      // A registered native policy outlives its child. Its callback must not.
      if (key === 'trustedTypes') return trustedTypes.wrap(Reflect.get(target, key) ?? rawWindow.trustedTypes)
      if (!sandbox) {
        if (includes(['window', 'self', 'globalThis', 'parent', 'top'], key)) return proxyWindow
        if (includes(['addEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'], key)) return ignoreLateEffect
        // Cached child callbacks can re-read globalPlugin after destruction.
        // Keep factory ownership guards on this late-read path as well.
        return resourceFactories.wrap(bindFunctionToRawTarget(Reflect.get(target, key) ?? Reflect.get(rawWindow, key), rawWindow))
      }
      if (appName) throttleDeferForSetAppName(appName)
      // return WorkerProxy if child app accesses window.Worker
      if (key === 'Worker') {
        return WorkerProxy
      }
      if (
        Reflect.has(target, key) ||
        (isString(key) && /^__MICRO_APP_/.test(key)) ||
        includes(sandbox.scopeProperties, key)
      ) {
        if (includes(RAW_GLOBAL_TARGET, key)) removeDomScope()
        return resourceFactories.wrap(Reflect.get(target, key))
      }

      const rawValue = Reflect.get(rawWindow, key)
      if (isFunction(rawValue) && rawValue.prototype) {
        snapshotRawGlobalObjectProperties(rawValue, rawValue.prototype)
      }
      return resourceFactories.wrap(bindFunctionToRawTarget(rawValue, rawWindow))
    },
    set: (target: microAppWindowType, key: PropertyKey, value: unknown): boolean => {
      if (!sandbox) return true // Late child writes must not escape to the base.
      if (includes(sandbox.rawWindowScopeKeyList, key)) {
        Reflect.set(rawWindow, key, value)
      } else if (
        // target.hasOwnProperty has been rewritten
        !rawHasOwnProperty.call(target, key) &&
        rawHasOwnProperty.call(rawWindow, key) &&
        !includes(sandbox.scopeProperties, key)
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, key)
        const { configurable, enumerable, writable, set } = descriptor!
        // set value because it can be set
        rawDefineProperty(target, key, {
          value,
          configurable,
          enumerable,
          writable: writable ?? !!set,
        })

        sandbox.injectedKeys.add(key)
      } else {
        // all scopeProperties will add to injectedKeys, use for key in window (Proxy.has)
        if (!Reflect.has(target, key) || includes(sandbox.scopeProperties, key)) {
          sandbox.injectedKeys.add(key)
        }
        Reflect.set(target, key, value)
      }

      if (
        (
          includes(sandbox.escapeProperties, key) ||
          (
            // TODO: staticEscapeProperties 合并到 escapeProperties
            includes(sandbox.staticEscapeProperties, key) &&
            !Reflect.has(rawWindow, key)
          )
        ) &&
        !includes(sandbox.scopeProperties, key)
      ) {
        !Reflect.has(rawWindow, key) && sandbox.escapeKeys.add(key)
        Reflect.set(rawWindow, key, value)
      }

      return true
    },
    has: (target: microAppWindowType, key: PropertyKey): boolean => {
      if (!sandbox) return Reflect.has(target, key) || Reflect.has(rawWindow, key)
      /**
       * Some keywords, such as Vue, need to meet two conditions at the same time:
       * 1. window.Vue --> undefined
       * 2. 'Vue' in window --> false
       * Issue https://github.com/jd-opensource/micro-app/issues/686
       */
      if (includes(sandbox.scopeProperties, key)) {
        if (sandbox.injectedKeys.has(key)) {
          return Reflect.has(target, key) // true
        }
        return !!target[key] // false
      }
      return Reflect.has(target, key) || Reflect.has(rawWindow, key)
    },
    // Object.getOwnPropertyDescriptor(window, key)
    getOwnPropertyDescriptor: (target: microAppWindowType, key: PropertyKey): PropertyDescriptor|undefined => {
      if (rawHasOwnProperty.call(target, key)) {
        return Object.getOwnPropertyDescriptor(target, key)
      }

      if (rawHasOwnProperty.call(rawWindow, key)) {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, key)
        if (descriptor && !descriptor.configurable) {
          descriptor.configurable = true
        }
        return descriptor
      }

      return undefined
    },
    // Object.defineProperty(window, key, Descriptor)
    defineProperty: (target: microAppWindowType, key: PropertyKey, value: PropertyDescriptor): boolean => {
      if (!sandbox) return Reflect.defineProperty(target, key, value)
      if (includes(sandbox.rawWindowScopeKeyList, key)) {
        return Reflect.defineProperty(rawWindow, key, value)
      }

      const result = Reflect.defineProperty(target, key, value)
      if (!result) return false

      sandbox.injectedKeys.add(key)
      if (
        (
          includes(sandbox.escapeProperties, key) ||
          (
            includes(sandbox.staticEscapeProperties, key) &&
            !Reflect.has(rawWindow, key)
          )
        ) &&
        !includes(sandbox.scopeProperties, key)
      ) {
        !Reflect.has(rawWindow, key) && sandbox.escapeKeys.add(key)
        return Reflect.defineProperty(rawWindow, key, value)
      }

      return true
    },
    // Object.getOwnPropertyNames(window)
    ownKeys: (target: microAppWindowType): Array<string | symbol> => {
      return unique(Reflect.ownKeys(rawWindow).concat(Reflect.ownKeys(target)))
    },
    deleteProperty: (target: microAppWindowType, key: PropertyKey): boolean => {
      if (!sandbox) return Reflect.deleteProperty(target, key)
      if (rawHasOwnProperty.call(target, key)) {
        sandbox.injectedKeys.has(key) && sandbox.injectedKeys.delete(key)
        sandbox.escapeKeys.has(key) && Reflect.deleteProperty(rawWindow, key)
        return Reflect.deleteProperty(target, key)
      }
      return true
    },
  })

  initialSandbox.proxyWindow = proxyWindow
  return () => {
    trustedTypes.dispose()
    resourceFactories.dispose()
    sandbox = null
    appName = null
  }
}

/**
 * Rewrite side-effect events
 * @param microAppWindow micro window
 */
function patchWindowEffect (microAppWindow: microAppWindowType, appName: string): CommonEffectHook {
  const intervalIdMap = new Map<number, timeInfo>()
  const timeoutIdMap = new Map<number, timeInfo>()
  const webSocketSet = new Set<WebSocket>()
  const {
    rawWindow,
    rawAddEventListener,
    rawRemoveEventListener,
    rawDispatchEvent,
    rawSetInterval,
    rawSetTimeout,
    rawClearInterval,
    rawClearTimeout,
  } = globalEnv
  const releaseObservers = patchObserverConstructors(microAppWindow, rawWindow)
  const releaseMediaQueryListeners = patchMatchMedia(microAppWindow, rawWindow)
  const animationFrames = patchAnimationFrame(microAppWindow, rawWindow)
  const RawWebSocket = rawWindow.WebSocket
  const listenerEffect = createListenerEffect(rawAddEventListener, rawRemoveEventListener,
    (record) => retainSandboxDom7Cleanup(appName, record))

  if (isConstructor(RawWebSocket)) {
    rawDefineProperty(microAppWindow, 'WebSocket', {
      configurable: true,
      writable: true,
      value: new Proxy(RawWebSocket, {
        construct (Target, args, NewTarget) {
          const socket = Reflect.construct(Target, args, NewTarget) as WebSocket
          webSocketSet.add(socket)
          socket.addEventListener('close', () => webSocketSet.delete(socket), { once: true })
          return socket
        },
      }),
    })
  }

  /**
   * All events will bind to microAppElement or rawWindow
   * Some special events, such as popstate、load、unmount、appstate-change、statechange..., bind to microAppElement, others bind to rawWindow
   * NOTE:
   *  1、At first, microAppWindow = new EventTarget(), but it can not compatible with iOS 14 or below, so microAppElement was used instead. (2024.1.22)
   * @param type event name
   * @returns microAppElement/rawWindow
   */
  function getEventTarget (type: string): EventTarget {
    if (SCOPE_WINDOW_EVENT_OF_WITH.includes(type) && appInstanceMap.get(appName)?.container) {
      return getRootContainer(appInstanceMap.get(appName)!.container!)
    }
    return rawWindow
  }

  /**
   * listener may be null, e.g test-passive
   * TODO:
   *  1. listener 是否需要绑定microAppWindow，否则函数中的this指向原生window
   *  2. 如果this不指向proxyWindow 或 microAppWindow，应该要做处理
   *  window.addEventListener.call(非window, type, listener, options)
   */
  microAppWindow.addEventListener = function (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    type = formatEventType(type, appName)
    listenerEffect.add(getEventTarget(type), type, listener, options)
  }

  microAppWindow.removeEventListener = function (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    type = formatEventType(type, appName)
    listenerEffect.remove(getEventTarget(type), type, listener, options)
  }

  microAppWindow.dispatchEvent = function (event: Event): boolean {
    return rawDispatchEvent.call(getEventTarget(event?.type), event)
  }

  microAppWindow.setInterval = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ): number {
    const intervalId = rawSetInterval.call(rawWindow, handler, timeout, ...args)
    intervalIdMap.set(intervalId, { handler, timeout, args })
    return intervalId
  }

  microAppWindow.setTimeout = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ): number {
    const setTimeoutHander = function(...args: any[]) {
      timeoutIdMap.delete(timeoutId)
      typeof handler === 'function' && handler(...args)
    }
    const handlerWithCleanup: TimerHandler = typeof handler === 'string' ? handler : setTimeoutHander
    const timeoutId = rawSetTimeout.call(rawWindow, handlerWithCleanup, timeout, ...args)
    timeoutIdMap.set(timeoutId, { handler: handlerWithCleanup, timeout, args })
    return timeoutId
  }

  microAppWindow.clearInterval = function (intervalId: number) {
    intervalIdMap.delete(intervalId)
    rawClearInterval.call(rawWindow, intervalId)
  }

  microAppWindow.clearTimeout = function (timeoutId: number) {
    timeoutIdMap.delete(timeoutId)
    rawClearTimeout.call(rawWindow, timeoutId)
  }

  // reset snapshot data
  const reset = (): void => {
    listenerEffect.reset()
  }

  /**
   * NOTE:
   *  1. about timer(events & properties should record & rebuild at all modes, exclude default mode)
   *  2. record maybe call twice when unmount prerender, keep-alive app manually with umd mode
   * 4 modes: default-mode、umd-mode、prerender、keep-alive
   * Solution:
   *  1. default-mode(normal): clear events & timers, not record & rebuild anything
   *  2. umd-mode(normal): not clear timers, record & rebuild events
   *  3. prerender/keep-alive(default, umd): not clear timers, record & rebuild events
   */
  const record = (): void => {
    // record window event
    listenerEffect.record()
  }

  // rebuild event and timer before remount app
  const rebuild = (): void => {
    // rebuild window event
    listenerEffect.rebuild((record) => {
      microAppWindow.addEventListener(record.type, record.listener, record.options)
    })
  }

  // release all event listener & interval & timeout when unmount app
  const release = (clearTimer: boolean): void => {
    animationFrames.release(clearTimer)
    releaseMediaQueryListeners(clearTimer)
    // Clear window binding events
    listenerEffect.release()

    // default mode(not keep-alive or isPrerender)
    if (clearTimer) {
      releaseObservers(true)
      intervalIdMap.forEach((_, intervalId: number) => {
        rawClearInterval.call(rawWindow, intervalId)
      })

      timeoutIdMap.forEach((_, timeoutId: number) => {
        rawClearTimeout.call(rawWindow, timeoutId)
      })

      intervalIdMap.clear()
      timeoutIdMap.clear()
      webSocketSet.forEach((socket) => {
        try {
          socket.close()
        } catch (_) {
          // Ignore sockets that have already entered a terminal native state.
        }
      })
      webSocketSet.clear()
    }
  }

  return {
    reset,
    record,
    rebuild,
    release,
    dispose () {
      animationFrames.dispose()
      listenerEffect.dispose()
    },
  }
}
