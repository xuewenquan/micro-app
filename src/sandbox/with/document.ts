/* eslint-disable no-cond-assign */
import type {
  CommonEffectHook,
  MicroEventListener,
  WithSandBoxInterface,
  microAppWindowType,
} from '@micro-app/types'
import microApp from '../../micro_app'
import globalEnv from '../../libs/global_env'
import bindFunctionToRawTarget from '../bind_function'
import {
  throttleDeferForSetAppName,
  isFunction,
  rawDefineProperties,
} from '../../libs/utils'
import {
  appInstanceMap,
} from '../../create_app'
import {
  updateElementInfo,
} from '../adapter'
import createListenerEffect from '../listener_effect'
import { retainSandboxDom7Cleanup } from '../event_target'

/**
 * create proxyDocument and MicroDocument, rewrite document of child app
 * @param appName app name
 * @param microAppWindow Proxy target
 * @returns EffectHook
 */
export function patchDocument (
  appName: string,
  microAppWindow: microAppWindowType,
  sandbox: WithSandBoxInterface,
): CommonEffectHook {
  const { proxyDocument, documentEffect } = createProxyDocument(appName, sandbox)
  const { MicroDocument, dispose: disposeMicroDocument } = createMicroDocument(appName, proxyDocument)
  const disposeDocumentEffect = documentEffect.dispose
  documentEffect.dispose = () => {
    disposeMicroDocument()
    disposeDocumentEffect?.()
  }
  rawDefineProperties(microAppWindow, {
    document: {
      // This is a synthetic Window. Keep the descriptor removable so terminal
      // destroy can sever the proxyDocument closure and release child code.
      configurable: true,
      enumerable: true,
      get () {
        // return globalEnv.rawDocument
        return proxyDocument
      },
    },
    Document: {
      configurable: true,
      enumerable: false,
      get () {
        // return globalEnv.rawRootDocument
        return MicroDocument
      },
    }
  })

  return documentEffect
}

/**
 * Create new document and Document
 */
function createProxyDocument (
  appName: string,
  sandbox: WithSandBoxInterface,
): {
    proxyDocument: Document,
    documentEffect: CommonEffectHook,
  } {
  // Keep the proxy stable for code that cached `document`. Revoking it during
  // Vue/React teardown turns otherwise harmless late reads into a TypeError.
  // Mutable state is cleared by dispose so a retained proxy cannot retain the
  // application sandbox or continue attributing work to a destroyed app.
  let currentAppName: string | null = appName
  let currentSandbox: WithSandBoxInterface | null = sandbox
  let onClickHandler: unknown = null
  let sstOnClickHandler: unknown = null
  const {
    rawDocument,
    rawCreateElement,
    rawCreateElementNS,
    rawAddEventListener,
    rawRemoveEventListener,
  } = globalEnv
  const listenerEffect = createListenerEffect(rawAddEventListener, rawRemoveEventListener,
    (record) => retainSandboxDom7Cleanup(appName, record))

  function createElement (
    tagName: string,
    options?: ElementCreationOptions,
  ): HTMLElement {
    const element = rawCreateElement.call(rawDocument, tagName, options)
    return currentAppName ? updateElementInfo(element, currentAppName) : element
  }

  function createElementNS (
    namespaceURI: string,
    name: string,
    options?: string | ElementCreationOptions,
  ): HTMLElement {
    const element = rawCreateElementNS.call(rawDocument, namespaceURI, name, options)
    return currentAppName ? updateElementInfo(element, currentAppName) : element
  }

  /**
   * TODO:
   *  1. listener 是否需要绑定proxyDocument，否则函数中的this指向原生window
   *  2. 相似代码提取为公共方法(with, iframe)
   *  3. 如果this不指向proxyDocument 和 rawDocument，则需要特殊处理
   */
  function addEventListener (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions
  ): void {
    listenerEffect.add(rawDocument, type, listener, options)
  }

  function removeEventListener (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    listenerEffect.remove(rawDocument, type, listener, options)
  }

  // reset snapshot data
  const reset = (): void => {
    listenerEffect.reset()
    sstOnClickHandler = null
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
    /**
     * record onclick handler
     * onClickHandler maybe set again after prerender/keep-alive app hidden
     */
    sstOnClickHandler = onClickHandler || sstOnClickHandler

    // record document event
    listenerEffect.record()
  }

  // rebuild event and timer before remount app
  const rebuild = (): void => {
    // rebuild onclick event
    if (sstOnClickHandler && !onClickHandler) proxyDocument.onclick = sstOnClickHandler

    // rebuild document event
    listenerEffect.rebuild((record) => {
      proxyDocument.addEventListener(record.type, record.listener, record.options)
    })
  }

  // release all event listener & interval & timeout when unmount app
  const release = (): void => {
    // Clear the function bound by micro app through document.onclick
    if (isFunction(onClickHandler)) {
      rawRemoveEventListener.call(rawDocument, 'click', onClickHandler)
    }
    onClickHandler = null

    // Clear document binding event
    listenerEffect.release()
  }

  const genProxyDocumentProps = () => {
    // microApp framework built-in Proxy
    const builtInProxyProps = new Map([
      ['onclick', (value: unknown) => {
        if (isFunction(onClickHandler)) {
          rawRemoveEventListener.call(rawDocument, 'click', onClickHandler, false)
        }
        // TODO: listener 是否需要绑定proxyDocument，否则函数中的this指向原生window
        if (isFunction(value)) {
          rawAddEventListener.call(rawDocument, 'click', value, false)
        }
        onClickHandler = value
      }]
    ])
    // external custom proxy
    const customProxyDocumentProps = microApp.options?.customProxyDocumentProps || new Map()
    // External has higher priority than built-in
    const mergedProxyDocumentProps = new Map([
      ...builtInProxyProps,
      ...customProxyDocumentProps,
    ])
    return mergedProxyDocumentProps
  }

  const mergedProxyDocumentProps = genProxyDocumentProps()

  const proxyDocument = new Proxy(rawDocument, {
    get: (target: Document, key: PropertyKey): unknown => {
      if (currentAppName) throttleDeferForSetAppName(currentAppName)
      // TODO: 转换成数据形式，类似iframe的方式
      if (key === 'createElement') return createElement
      if (key === 'createElementNS') return createElementNS
      if (key === Symbol.toStringTag) return 'ProxyDocument'
      if (key === 'defaultView') return currentSandbox?.proxyWindow || rawDocument.defaultView
      if (key === 'onclick') return onClickHandler
      if (key === 'addEventListener') return addEventListener
      if (key === 'removeEventListener') return removeEventListener
      if (key === 'microAppElement') return currentAppName ? appInstanceMap.get(currentAppName)?.container : null
      if (key === '__MICRO_APP_NAME__') return currentAppName
      return bindFunctionToRawTarget<Document>(Reflect.get(target, key), rawDocument, 'DOCUMENT')
    },
    set: (target: Document, key: PropertyKey, value: unknown): boolean => {
      if (!currentSandbox) return true // Do not mutate base document after destroy.
      if (mergedProxyDocumentProps.has(key)) {
        const proxyCallback = mergedProxyDocumentProps.get(key)
        proxyCallback(value)
      } else if (key !== 'microAppElement') {
        /**
         * 1. Fix TypeError: Illegal invocation when set document.title
         * 2. If the set method returns false, and the assignment happened in strict-mode code, a TypeError will be thrown.
         */
        Reflect.set(target, key, value)
      }
      return true
    }
  })

  return {
    proxyDocument,
    documentEffect: {
      reset,
      record,
      rebuild,
      release,
      dispose: () => {
        listenerEffect.dispose()
        currentAppName = null
        currentSandbox = null
        onClickHandler = null
        sstOnClickHandler = null
      },
    }
  }
}

/**
 * create proto Document
 * @param appName app name
 * @param proxyDocument proxy(document)
 * @returns Document
 */
function createMicroDocument (
  appName: string,
  proxyDocument: Document,
): {
    MicroDocument: Function,
    dispose: () => void,
  } {
  const { rawDocument, rawRootDocument } = globalEnv
  let currentProxyDocument: Document | null = proxyDocument
  let currentAppName: string | null = appName
  let disposed = false
  const ignoreLateListener = () => {}

  class MicroDocument {
    static [Symbol.hasInstance] (target: unknown) {
      let proto = target
      while (proto) {
        proto = Object.getPrototypeOf(proto)
        if (proto === MicroDocument.prototype) {
          return true
        }
      }
      return (
        target === currentProxyDocument ||
        target instanceof rawRootDocument
      )
    }
  }

  /**
   * TIP:
   * 1. child class __proto__, which represents the inherit of the constructor, always points to the parent class
   * 2. child class prototype.__proto__, which represents the inherit of methods, always points to parent class prototype
   * e.g.
   * class B extends A {}
   * B.__proto__ === A // true
   * B.prototype.__proto__ === A.prototype // true
   */
  Object.setPrototypeOf(MicroDocument, rawRootDocument)
  // Object.create(rawRootDocument.prototype) will cause MicroDocument and proxyDocument methods not same when exec Document.prototype.xxx = xxx in child app
  const prototypeProxy = new Proxy(rawRootDocument.prototype, {
    get (target: Document, key: PropertyKey): unknown {
      if (currentAppName) throttleDeferForSetAppName(currentAppName)
      // Route prototype access through the same effect wrappers. A function
      // cached before destroy must not bypass disposed listener bookkeeping.
      if (key === 'addEventListener') return currentProxyDocument?.addEventListener || ignoreLateListener
      if (key === 'removeEventListener' && currentProxyDocument) return currentProxyDocument.removeEventListener
      return bindFunctionToRawTarget<Document>(Reflect.get(target, key), rawDocument, 'DOCUMENT')
    },
    set (target: Document, key: PropertyKey, value: unknown): boolean {
      if (!currentAppName) return true
      Reflect.set(target, key, value)
      return true
    }
  })
  Object.setPrototypeOf(MicroDocument.prototype, prototypeProxy)

  return {
    MicroDocument,
    dispose: () => {
      if (disposed) return
      disposed = true
      currentProxyDocument = null
      currentAppName = null
      // Detach the per-app proxy. Do not revoke it: framework teardown can still
      // hold a reference to the old prototype and is allowed to read it safely.
      Object.setPrototypeOf(MicroDocument.prototype, rawRootDocument.prototype)
    },
  }
}
