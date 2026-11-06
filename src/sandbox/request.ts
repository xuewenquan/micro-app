import globalEnv from '../libs/global_env'
import {
  isFunction,
  isUndefined,
  isString,
  createURL,
  isURL,
  removeDomScope,
  isConstructor,
} from '../libs/utils'

/**
 * https://developer.mozilla.org/en-US/docs/Web/API/fetch
 * Promise<Response> fetch(input[, init])
 * input: string/Request
 * init?: object
 * @param url app url
 * @param target proxy target
 */
export function createMicroFetch (url: string, target?: Window['fetch']): Window['fetch'] {
  const rawFetch = !isUndefined(target) ? target : globalEnv.rawWindow.fetch
  if (!isFunction(rawFetch)) return rawFetch
  return function microFetch (
    input: RequestInfo | URL | string,
    init?: RequestInit,
    ...rests: unknown[]
  ): Promise<Response> {
    if (isString(input) || isURL(input)) {
      input = createURL(input, url).toString()
    }
    /**
     * When fetch rewrite by baseApp, domScope still active when exec rawWindow.fetch
     * If baseApp operate dom in fetch, it will cause error
     * The same for XMLHttpRequest, EventSource
     */
    removeDomScope()
    return rawFetch.call(globalEnv.rawWindow, input, init, ...rests)
  }
}

/**
 * https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest
 * https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/Using_XMLHttpRequest
 * @param url app url
 * @param target proxy target
 */
export interface XMLHttpRequestScope {
  disposed: boolean
  requests: Set<XMLHttpRequest>
}

export function createXMLHttpRequestScope (): XMLHttpRequestScope {
  return { disposed: false, requests: new Set() }
}

export function disposeXMLHttpRequestScope (scope: XMLHttpRequestScope): void {
  if (scope.disposed) return
  scope.disposed = true
  Array.from(scope.requests).forEach((request) => {
    try { request.abort() } catch (error) {
      console.warn(`[micro-app] XMLHttpRequest abort failed: ${String(error)}`)
    } finally { scope.requests.delete(request) }
  })
}

export function createMicroXMLHttpRequest (url: string, target?: XMLHttpRequest, scope?: XMLHttpRequestScope): any {
  const rawXMLHttpRequest = !isUndefined(target) ? target : globalEnv.rawWindow.XMLHttpRequest
  if (!isConstructor(rawXMLHttpRequest)) return rawXMLHttpRequest
  class MicroXMLHttpRequest extends rawXMLHttpRequest {
    send (...args: unknown[]): void {
      if (scope?.disposed) throw new Error('[micro-app] XMLHttpRequest belongs to a destroyed sandbox')
      if (scope) {
        const request = this as unknown as XMLHttpRequest
        // A duplicate send must preserve the original in-flight registration
        // when the native API rejects it with InvalidStateError.
        if (scope.requests.has(request)) { super.send(...args); return }
        scope.requests.add(request)
        const complete = () => {
          scope.requests.delete(request)
          globalEnv.rawRemoveEventListener.call(this, 'loadend', complete, false)
        }
        globalEnv.rawAddEventListener.call(this, 'loadend', complete, false)
        try { super.send(...args) } catch (error) {
          complete()
          throw error
        }
      } else super.send(...args)
    }

    open (method: string, reqUrl: string, ...rests: unknown[]): void {
      if ((isString(reqUrl) && !/^f(ile|tp):\/\//.test(reqUrl)) || isURL(reqUrl)) {
        reqUrl = createURL(reqUrl, url).toString()
      }
      removeDomScope()
      super.open(method, reqUrl, ...rests)
    }
  }
  // The methods defined by class are hung on the prototype, and enumerable is false by default
  MicroXMLHttpRequest.prototype && Object.defineProperty(MicroXMLHttpRequest.prototype, 'open', { enumerable: true })
  return MicroXMLHttpRequest
}

export interface EventSourceInstance {
  close(): void;
}

export interface EventSourceApi {
  createMicroEventSource(appName: string, url: string, target?: EventSource): any
  clearMicroEventSource (appName: string): void
}

export function useMicroEventSource (): EventSourceApi {
  let eventSourceMap: Map<string, Set<EventSourceInstance>>

  /**
   * https://developer.mozilla.org/en-US/docs/Web/API/EventSource
   * pc = new EventSource(url[, configuration])
   * url: string/Request
   * configuration?: object
   * @param url app url
   * @param target proxy target
   */
  function createMicroEventSource (appName: string, url: string, target?: EventSource): any {
    const rawEventSource = !isUndefined(target) ? target : globalEnv.rawWindow.EventSource
    if (!isConstructor(rawEventSource)) return rawEventSource
    return class MicroEventSource extends rawEventSource {
      constructor (
        eventSourceUrl: string | URL,
        eventSourceInitDict?: EventSourceInit,
        ...rests: unknown[]
      ) {
        if (isString(eventSourceUrl) || isURL(eventSourceUrl)) {
          eventSourceUrl = createURL(eventSourceUrl, url).toString()
        }
        removeDomScope()
        super(eventSourceUrl, eventSourceInitDict, ...rests)

        if (eventSourceMap) {
          const eventSourceList = eventSourceMap.get(appName)
          if (eventSourceList) {
            eventSourceList.add(this)
          } else {
            eventSourceMap.set(appName, new Set([this]))
          }
        } else {
          eventSourceMap = new Map([[appName, new Set([this])]])
        }
      }

      close (): void {
        super.close()
        eventSourceMap.get(appName)?.delete(this)
      }
    }
  }

  function clearMicroEventSource (appName: string): void {
    const eventSourceList = eventSourceMap?.get(appName)
    if (eventSourceList?.size) {
      eventSourceList.forEach(item => {
        item.close()
      })
      eventSourceList.clear()
    }
  }

  return {
    createMicroEventSource,
    clearMicroEventSource,
  }
}
