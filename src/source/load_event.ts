import { isFunction } from '../libs/utils'

function eventHandler (event: Event, element: HTMLLinkElement | HTMLScriptElement): void {
  Object.defineProperties(event, {
    currentTarget: {
      configurable: true,
      value: element,
    },
    srcElement: {
      configurable: true,
      value: element,
    },
    target: {
      configurable: true,
      value: element,
    },
  })
}

export function dispatchOnLoadEvent (element: HTMLLinkElement | HTMLScriptElement): void {
  const event = new CustomEvent('load')
  eventHandler(event, element)
  if (isFunction(element.onload)) {
    element.onload!(event)
  } else {
    element.dispatchEvent(event)
  }
}

export function dispatchOnErrorEvent (element: HTMLLinkElement | HTMLScriptElement): void {
  const event = new CustomEvent('error')
  eventHandler(event, element)
  if (isFunction(element.onerror)) {
    element.onerror!(event)
  } else {
    element.dispatchEvent(event)
  }
}
