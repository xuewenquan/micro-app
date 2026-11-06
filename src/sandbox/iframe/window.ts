import type {
  microAppWindowType,
  MicroEventListener,
  CommonEffectHook,
} from '@micro-app/types'
import type IframeSandbox from './index'
import globalEnv from '../../libs/global_env'
import bindFunctionToRawTarget from '../bind_function'
import {
  rawDefineProperty,
  isFunction,
  logWarn,
  includes,
  instanceOf,
  isConstructor,
} from '../../libs/utils'
import {
  GLOBAL_KEY_TO_WINDOW,
  SCOPE_WINDOW_EVENT_OF_IFRAME,
  SCOPE_WINDOW_ON_EVENT_OF_IFRAME,
} from '../../constants'
import {
  UN_PROXY_INSTANCEOF_KEYS,
  escape2RawWindowKeys,
  escape2RawWindowRegExpKeys,
} from './special_key'
import WorkerProxy from '../../proxies/worker'
import microApp from '../../micro_app'
import { patchMatchMedia, patchObserverConstructors } from '../observer'
import createListenerEffect from '../listener_effect'
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
  sandbox: IframeSandbox,
): CommonEffectHook {
  patchWindowProperty(appName, microAppWindow, sandbox)
  createProxyWindow(microAppWindow, sandbox)
  return patchWindowEffect(microAppWindow)
}
/**
 * rewrite special properties of window
 * @param appName app name
 * @param microAppWindow child app microWindow
 */
function patchWindowProperty (
  appName: string,
  microAppWindow: microAppWindowType,
  sandbox: IframeSandbox,
):void {
  const rawWindow = globalEnv.rawWindow

  escape2RawWindowKeys.forEach((key: string) => {
    microAppWindow[key] = bindFunctionToRawTarget(rawWindow[key], rawWindow)
  })

  Object.getOwnPropertyNames(microAppWindow)
    .filter((key: string) => {
      escape2RawWindowRegExpKeys.some((reg: RegExp) => {
        if (reg.test(key) && key in microAppWindow.parent) {
          if (isFunction(rawWindow[key])) {
            microAppWindow[key] = bindFunctionToRawTarget(rawWindow[key], rawWindow)
          } else {
            const { configurable, enumerable } = Object.getOwnPropertyDescriptor(microAppWindow, key) || {
              configurable: true,
              enumerable: true,
            }
            if (configurable) {
              rawDefineProperty(microAppWindow, key, {
                configurable,
                enumerable,
                get: () => rawWindow[key],
                set: (value) => { rawWindow[key] = value },
              })
            }
          }
          return true
        }
        return false
      })

      /**
       * In FireFox, iframe Element.prototype will point to native Element.prototype after insert to document
       * Rewrite all constructor's Symbol.hasInstance of iframeWindow
       * NOTE:
       *  1. native event instanceof iframe window.Event
       *  2. native node instanceof iframe window.Node
       *  3. native element instanceof iframe window.Element
       *  4. native url instanceof iframe window.URL
       *  ...
       */
      if (
        isConstructor(microAppWindow[key]) &&
        key in rawWindow &&
        !UN_PROXY_INSTANCEOF_KEYS.includes(key) &&
        !microApp.options.excludeRewriteIframeConstructor?.includes(key)
      ) {
        rawDefineProperty(microAppWindow[key], Symbol.hasInstance, {
          configurable: true,
          enumerable: false,
          value (target: unknown): boolean {
            return instanceOf(target, rawWindow[key]) || instanceOf(target, microAppWindow[key])
          },
        })
      }

      return /^on/.test(key) && !SCOPE_WINDOW_ON_EVENT_OF_IFRAME.includes(key)
    })
    .forEach((eventName: string) => {
      const { enumerable, writable, set } = Object.getOwnPropertyDescriptor(microAppWindow, eventName) || {
        enumerable: true,
        writable: true,
      }
      try {
        rawDefineProperty(microAppWindow, eventName, {
          enumerable,
          configurable: true,
          get: () => rawWindow[eventName],
          set: writable ?? !!set
            ? (value) => { rawWindow[eventName] = isFunction(value) ? value.bind(microAppWindow) : value }
            : undefined,
        })
      } catch (e) {
        logWarn(e, appName)
      }
    })

  /**
   * In esmodule(vite) proxyWindow will not take effect,
   * escapeProperties should define to microAppWindow
   */
  sandbox.escapeProperties.forEach((key: PropertyKey) => {
    let rawValue = microAppWindow[key]
    rawDefineProperty(microAppWindow, key, {
      enumerable: true,
      configurable: true,
      get () {
        return rawValue ?? bindFunctionToRawTarget(rawWindow[key], rawWindow)
      },
      set (value: unknown) {
        rawValue = value
      }
    })
  })
}

/**
 * create proxyWindow with Proxy(microAppWindow)
 * @param microAppWindow micro app window
 * @param sandbox IframeSandbox
 */
function createProxyWindow (
  microAppWindow: microAppWindowType,
  sandbox: IframeSandbox,
): void {
  const rawWindow = globalEnv.rawWindow
  const customProperties = new Set<PropertyKey>()

  Object.defineProperty(microAppWindow, 'Worker', {
    value: WorkerProxy,
    configurable: true,
    writable: true,
  })

  /**
   * proxyWindow will only take effect in certain scenes, such as window.key
   * e.g:
   *  1. window.key in normal app --> fall into proxyWindow
   *  2. window.key in module app(vite), fall into microAppWindow(iframeWindow)
   *  3. if (key)... --> fall into microAppWindow(iframeWindow)
   */
  const proxyWindow = new Proxy(microAppWindow, {
    get: (target: microAppWindowType, key: PropertyKey): unknown => {
      if (key === 'Worker') {
        return WorkerProxy
      }
      if (key === 'location') {
        return sandbox.proxyLocation
      }

      if (includes(GLOBAL_KEY_TO_WINDOW, key)) {
        return proxyWindow
      }

      if (customProperties.has(key)) {
        return Reflect.get(target, key)
      }

      /**
       * Same as proxyWindow, escapeProperties will only take effect in certain scenes
       * e.g:
       *  1. window.key in normal app --> fall into proxyWindow, escapeProperties will effect
       *  2. window.key in module app(vite), fall into microAppWindow(iframeWindow), escapeProperties will not take effect
       *  3. if (key)... --> fall into microAppWindow(iframeWindow), escapeProperties will not take effect
       */
      if (includes(sandbox.escapeProperties, key) && !Reflect.get(target, key)) {
        return bindFunctionToRawTarget(Reflect.get(rawWindow, key), rawWindow)
      }

      return bindFunctionToRawTarget(Reflect.get(target, key), target)
    },
    set: (target: microAppWindowType, key: PropertyKey, value: unknown): boolean => {
      if (key === 'location') {
        return Reflect.set(rawWindow, key, value)
      }

      if (!Reflect.has(target, key)) {
        customProperties.add(key)
      }

      // sandbox.escapeProperties will not set to rawWindow from rc.9
      Reflect.set(target, key, value)

      return true
    },
    has: (target: microAppWindowType, key: PropertyKey) => key in target,
    deleteProperty: (target: microAppWindowType, key: PropertyKey): boolean => {
      if (Reflect.has(target, key)) {
        return Reflect.deleteProperty(target, key)
      }
      return true
    },
  })

  sandbox.proxyWindow = proxyWindow
}

function patchWindowEffect (microAppWindow: microAppWindowType): CommonEffectHook {
  const appName = microAppWindow.__MICRO_APP_NAME__
  const { rawWindow, rawAddEventListener, rawRemoveEventListener, rawDispatchEvent } = globalEnv
  const intervalIdMap = new Set<number>()
  const timeoutIdMap = new Set<number>()
  const webSocketSet = new Set<WebSocket>()
  const rawSetInterval = microAppWindow.setInterval
  const rawSetTimeout = microAppWindow.setTimeout
  const rawClearInterval = microAppWindow.clearInterval
  const rawClearTimeout = microAppWindow.clearTimeout
  const RawWebSocket = microAppWindow.WebSocket
  const releaseObservers = patchObserverConstructors(microAppWindow, microAppWindow)
  const releaseMediaQueryListeners = patchMatchMedia(microAppWindow, microAppWindow)
  const animationFrames = patchAnimationFrame(microAppWindow, microAppWindow)
  const listenerEffect = createListenerEffect(rawAddEventListener, rawRemoveEventListener,
    (record) => retainSandboxDom7Cleanup(appName, record))

  microAppWindow.setInterval = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ): number {
    const intervalId = rawSetInterval.call(microAppWindow, handler, timeout, ...args)
    intervalIdMap.add(intervalId)
    return intervalId
  }

  microAppWindow.setTimeout = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ): number {
    const setTimeoutHandler = function (...handlerArgs: any[]): void {
      timeoutIdMap.delete(timeoutId)
      typeof handler === 'function' && handler(...handlerArgs)
    }
    /**
     * NOTE(已知小泄漏) 2026.9.12 by Claude Code
     * 字符串 handler（`setTimeout('code', n)`）无法插入清理逻辑，因此它走的是原始
     * 字符串分支：触发后 timeoutIdMap 里对应的 id 不会被删除，只能等 release() 时统一
     * 清理。对高频使用字符串定时器的老库，这个 Map 会呈现“只增不减”的增长。
     * 若要收敛：该分支不登记 id（代价是 destroy 时无法统一取消），或改用
     * 触发即清的包装（例如包成 setTimeoutHandler 后再 eval，但会改变 eval 作用域语义）。
     */
    const handlerWithCleanup: TimerHandler = typeof handler === 'string' ? handler : setTimeoutHandler
    const timeoutId = rawSetTimeout.call(microAppWindow, handlerWithCleanup, timeout, ...args)
    timeoutIdMap.add(timeoutId)
    return timeoutId
  }

  microAppWindow.clearInterval = function (intervalId: number): void {
    intervalIdMap.delete(intervalId)
    rawClearInterval.call(microAppWindow, intervalId)
  }

  microAppWindow.clearTimeout = function (timeoutId: number): void {
    timeoutIdMap.delete(timeoutId)
    rawClearTimeout.call(microAppWindow, timeoutId)
  }

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

  function getEventTarget (type: string): Window {
    /**
     * TODO: SCOPE_WINDOW_EVENT_OF_IFRAME的事件非常少，有可能导致问题
     *  1、一些未知的需要绑定到iframe的事件被错误的绑定到原生window上
     */
    let escapeSandboxEvent: Array<string> = []
    if (Array.isArray(microApp?.options?.escapeIframeWindowEvents)) {
      escapeSandboxEvent = microApp.options.escapeIframeWindowEvents
    }
    const scopeWindowEvent = SCOPE_WINDOW_EVENT_OF_IFRAME.filter(item => !escapeSandboxEvent.includes(item))
    return scopeWindowEvent.includes(type) ? microAppWindow : rawWindow
  }

  // TODO: listener 是否需要绑定microAppWindow，否则函数中的this指向原生window
  microAppWindow.addEventListener = function (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    listenerEffect.add(getEventTarget(type), type, listener, options)
  }

  microAppWindow.removeEventListener = function (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    listenerEffect.remove(getEventTarget(type), type, listener, options)
  }

  microAppWindow.dispatchEvent = function (event: Event): boolean {
    return rawDispatchEvent.call(getEventTarget(event?.type), event)
  }

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
   *
   * NOTE(差异已修复) 2026.9.12 review
   * 上面第 2 条对 iframe 沙箱**不成立**：iframe/index.ts 的 stop() 只传 { clearData }，
   * 且其 releaseGlobalEffect 的开关是 (!keepAlive && !isPrerender) || destroy（不含
   * umdMode），所以 iframe + umd 应用 unmount 时会清除 timer / 关闭 WebSocket，
   * 与这里写的“not clear timers”相反。
   * Review 裁定：不能把无法恢复 timer/socket 当成有意行为。
   * 现 stop 传递 umdMode/destroy，普通 UMD unmount 保留资源，destroy 强制释放。
   * （with 沙箱的行为才是与注释一致的：with/index.ts 用
   *  (!umdMode && !keepAlive && !isPrerender) || destroy。）
   *
   * TODO: 现在的 清除、记录和恢复操作分散的太零散，sandbox、create_app中都有分散，将代码再优化一下，集中处理
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

  const release = (clearEffect = true): void => {
    animationFrames.release(clearEffect)
    releaseMediaQueryListeners(clearEffect)
    releaseObservers(clearEffect)
    // Clear window binding events
    listenerEffect.release()

    // Keep resources running while a keep-alive app is only hidden, but always
    // terminate them on a real unmount/destroy so Blink can release the iframe realm.
    if (clearEffect) {
      intervalIdMap.forEach((intervalId) => rawClearInterval.call(microAppWindow, intervalId))
      timeoutIdMap.forEach((timeoutId) => rawClearTimeout.call(microAppWindow, timeoutId))
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
