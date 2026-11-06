/* eslint-disable no-return-assign */
import {
  isBoundFunction,
  isConstructor,
  rawDefineProperty,
  isFunction,
} from '../libs/utils'

const boundFunctionState = new WeakMap<CallableFunction, boolean>()
const constructorState = new WeakMap<FunctionConstructor, boolean>()
const boundFunctionCache = new WeakMap<CallableFunction, WeakMap<object, Map<string, CallableFunction>>>()

function isBoundedFunction (value: CallableFunction): boolean {
  if (!boundFunctionState.has(value)) boundFunctionState.set(value, isBoundFunction(value))
  return boundFunctionState.get(value)!
}

function isConstructorFunction (value: FunctionConstructor): boolean {
  if (!constructorState.has(value)) constructorState.set(value, isConstructor(value))
  return constructorState.get(value)!
}

function getBoundFunction (
  value: CallableFunction,
  rawTarget: object,
  key: string,
): CallableFunction | null {
  return boundFunctionCache.get(value)?.get(rawTarget)?.get(key) || null
}

function cacheBoundFunction (
  value: CallableFunction,
  rawTarget: object,
  key: string,
  boundFunction: CallableFunction,
): void {
  let targetCache = boundFunctionCache.get(value)
  if (!targetCache) {
    targetCache = new WeakMap()
    boundFunctionCache.set(value, targetCache)
  }

  let keyCache = targetCache.get(rawTarget)
  if (!keyCache) {
    keyCache = new Map()
    targetCache.set(rawTarget, keyCache)
  }
  keyCache.set(key, boundFunction)
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default function bindFunctionToRawTarget<T = Window, B = unknown> (value: any, rawTarget: T, key = 'WINDOW'): B {
  /**
   * In safari, nest app like: A -> B -> C
   * if B is iframe sandbox, and C is with sandbox, same property of document in C is abnormal
   * e.g:
   *  document.all:
   *    - typeof document.all ==> 'function'
   *    - document.all.bind ==> undefined
  */
  if (isFunction(value) && !isConstructorFunction(value) && !isBoundedFunction(value) && value.bind) {
    const cacheTarget = rawTarget as unknown as object
    const cachedFunction = getBoundFunction(value, cacheTarget, key)
    if (cachedFunction) return cachedFunction as unknown as B

    const bindRawObjectValue = value.bind(rawTarget)

    for (const key in value) {
      bindRawObjectValue[key] = value[key]
    }

    if (value.hasOwnProperty('prototype')) {
      rawDefineProperty(bindRawObjectValue, 'prototype', {
        value: value.prototype,
        configurable: true,
        enumerable: false,
        writable: true,
      })
    }

    cacheBoundFunction(value, cacheTarget, key, bindRawObjectValue)
    return bindRawObjectValue
  }

  return value
}
