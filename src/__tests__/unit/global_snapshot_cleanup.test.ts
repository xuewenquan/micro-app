jest.mock('../../proxies/worker', () => ({
  __esModule: true,
  default: jest.fn(),
  releaseWorkersByApp: jest.fn(),
}))

import globalEnv, {
  initGlobalEnv,
  restoreRawGlobalObjectProperties,
  snapshotRawGlobalObjectProperties,
  releaseRawGlobalObjectSnapshots,
  beginRawGlobalObjectTracking,
  finishRawGlobalObjectTracking,
  releaseRawGlobalObjectPatches,
  releaseSharedFunctionToStringPatch,
} from '../../libs/global_env'
import { runScript } from '../../source/scripts'

describe('raw global object snapshots', () => {
  test('restores proven raw runtime escape without touching other window state', () => {
    initGlobalEnv()
    const key = 'regeneratorRuntime'
    const original = Object.getOwnPropertyDescriptor(window, key)
    const otherKey = '__TEST_BASE_RUNTIME_STATE__'
    const owner = {}
    try {
      const before = beginRawGlobalObjectTracking()
      Reflect.defineProperty(window, key, { configurable: true, writable: true, value: { wrap: () => owner } })
      Reflect.set(window, otherKey, 'base-state')
      finishRawGlobalObjectTracking(owner, before)
      releaseRawGlobalObjectPatches(owner)
      expect(Object.getOwnPropertyDescriptor(window, key)).toEqual(original)
      expect(Reflect.get(window, otherKey)).toBe('base-state')
    } finally {
      if (original) Reflect.defineProperty(window, key, original)
      else Reflect.deleteProperty(window, key)
      Reflect.deleteProperty(window, otherKey)
      releaseRawGlobalObjectPatches(owner)
    }
  })

  test('old runtime owner cannot overwrite a newer base replacement', () => {
    initGlobalEnv()
    const key = 'regeneratorRuntime'
    const original = Object.getOwnPropertyDescriptor(window, key)
    const owner = {}
    const base = { wrap: () => 'base' }
    try {
      const before = beginRawGlobalObjectTracking()
      Reflect.defineProperty(window, key, { configurable: true, writable: true, value: { wrap: () => owner } })
      finishRawGlobalObjectTracking(owner, before)
      Reflect.set(window, key, base)
      releaseRawGlobalObjectPatches(owner)
      expect(Reflect.get(window, key)).toBe(base)
    } finally {
      if (original) Reflect.defineProperty(window, key, original)
      else Reflect.deleteProperty(window, key)
      releaseRawGlobalObjectPatches(owner)
    }
  })
  test('runScript restores the wrapper at the boundary even when the script throws', () => {
    initGlobalEnv()
    const original = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!
    for (const shouldThrow of [false, true]) {
      const app: any = { name: 'boundary-app', url: 'http://localhost/', useSandbox: true, iframe: false }
      const scriptInfo: any = { code: '', appSpace: { [app.name]: {
        parsedCode: 'already parsed', sandboxType: 'with', attrs: new Map(),
        parsedFunction: () => {
          Object.defineProperty(Function.prototype, 'toString', { ...original, value: function () { return 'A wrapper' } })
          if (shouldThrow) throw new Error('expected script failure')
        },
      } } }
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        if (shouldThrow) expect(() => runScript('http://localhost/test.js', app, scriptInfo)).toThrow('expected script failure')
        else runScript('http://localhost/test.js', app, scriptInfo)
        expect(Object.getOwnPropertyDescriptor(Function.prototype, 'toString')).toEqual(original)
      } finally {
        warn.mockRestore()
        Object.defineProperty(Function.prototype, 'toString', original)
        releaseRawGlobalObjectPatches(app)
      }
    }
  })
  test('destroy-time restoration cannot revoke a wrapper captured by another app', () => {
    initGlobalEnv()
    const original = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!
    const owner = {}
    try {
      const before = beginRawGlobalObjectTracking()
      const childWrapper = function () { return 'child-A' }
      Object.defineProperty(Function.prototype, 'toString', { ...original, value: childWrapper })
      finishRawGlobalObjectTracking(owner, before)
      const call = Function.prototype.call
      const captured = call.bind(call, Function.prototype.toString)
      releaseRawGlobalObjectPatches(owner)
      expect(Function.prototype.toString).toBe(original.value)
      expect(captured()).toBe('child-A')
    } finally {
      Object.defineProperty(Function.prototype, 'toString', original)
      releaseRawGlobalObjectPatches(owner)
    }
  })

  test('script-boundary restoration prevents B from capturing A while A remains alive', () => {
    initGlobalEnv()
    const original = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!
    const owner = {}
    const otherKey = '__MICRO_APP_BOUNDARY_POLYFILL__'
    try {
      const before = beginRawGlobalObjectTracking()
      const childWrapper = function () { return 'child-A' }
      Object.defineProperty(Function.prototype, 'toString', { ...original, value: childWrapper })
      ;(Array.prototype as any)[otherKey] = 'retain-other-polyfill'
      finishRawGlobalObjectTracking(owner, before)
      releaseSharedFunctionToStringPatch(owner)
      expect(Object.getOwnPropertyDescriptor(Function.prototype, 'toString')).toEqual(original)
      expect((Array.prototype as any)[otherKey]).toBe('retain-other-polyfill')
      const call = Function.prototype.call
      const captured = call.bind(call, Function.prototype.toString)
      expect(captured(function namedB () {})).not.toBe('child-A')
      releaseRawGlobalObjectPatches(owner)
      expect((Array.prototype as any)[otherKey]).toBeUndefined()
    } finally {
      Object.defineProperty(Function.prototype, 'toString', original)
      delete (Array.prototype as any)[otherKey]
      releaseRawGlobalObjectPatches(owner)
    }
  })

  test('boundary cleanup does not overwrite an untracked base replacement', () => {
    initGlobalEnv()
    const original = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')!
    const owner = {}
    try {
      const before = beginRawGlobalObjectTracking()
      Object.defineProperty(Function.prototype, 'toString', { ...original, value: function () { return 'child' } })
      finishRawGlobalObjectTracking(owner, before)
      const base = function () { return 'base' }
      Object.defineProperty(Function.prototype, 'toString', { ...original, value: base })
      releaseSharedFunctionToStringPatch(owner)
      releaseRawGlobalObjectPatches(owner)
      expect(Function.prototype.toString).toBe(base)
    } finally {
      Object.defineProperty(Function.prototype, 'toString', original)
      releaseRawGlobalObjectPatches(owner)
    }
  })
  test('drops runtime snapshot targets after restoring their descriptors', () => {
    initGlobalEnv()
    const snapshots = globalEnv.rawGlobalObjectPropertySnapshots as Array<unknown>
    const baselineCount = globalEnv.rawGlobalObjectPropertySnapshotBaselineCount as number
    function RuntimeConstructor () {}

    snapshotRawGlobalObjectProperties(RuntimeConstructor, RuntimeConstructor.prototype)
    ;(RuntimeConstructor as any).childBundleValue = jest.fn()
    ;(RuntimeConstructor.prototype as any).childBundleMethod = jest.fn()

    expect(snapshots.length).toBe(baselineCount + 2)

    restoreRawGlobalObjectProperties()

    expect((RuntimeConstructor as any).childBundleValue).toBeUndefined()
    expect((RuntimeConstructor.prototype as any).childBundleMethod).toBeUndefined()
    expect(snapshots).toHaveLength(baselineCount)
  })

  test('normal teardown drops snapshot references without reverting base-app patches', () => {
    initGlobalEnv()
    function BaseConstructor () {}
    snapshotRawGlobalObjectProperties(BaseConstructor, BaseConstructor.prototype)
    const basePatch = jest.fn()
    ;(BaseConstructor.prototype as any).basePatch = basePatch
    releaseRawGlobalObjectSnapshots()
    expect((BaseConstructor.prototype as any).basePatch).toBe(basePatch)
    const count = globalEnv.rawGlobalObjectPropertySnapshotBaselineCount
    expect(globalEnv.rawGlobalObjectPropertySnapshots).toHaveLength(count)
    snapshotRawGlobalObjectProperties(BaseConstructor)
    expect(globalEnv.rawGlobalObjectPropertySnapshots).toHaveLength(count + 1)
    releaseRawGlobalObjectSnapshots()
  })

  test('restores an owned child patch but preserves a later base-app replacement', () => {
    initGlobalEnv()
    const key = '__MICRO_APP_OWNED_PATCH_TEST__'
    const target = Array.prototype as any
    const owner = {}
    const before = beginRawGlobalObjectTracking()
    target[key] = jest.fn()
    finishRawGlobalObjectTracking(owner, before)
    const baseReplacement = jest.fn()
    target[key] = baseReplacement
    releaseRawGlobalObjectPatches(owner)
    expect(target[key]).toBe(baseReplacement)
    delete target[key]
  })

  test('shared child patch chains restore the original only after all owners are gone', () => {
    initGlobalEnv()
    const key = '__MICRO_APP_SHARED_PATCH_TEST__'
    const target = Array.prototype as any
    const first = {}
    const second = {}
    const beforeFirst = beginRawGlobalObjectTracking()
    target[key] = jest.fn()
    finishRawGlobalObjectTracking(first, beforeFirst)
    const beforeSecond = beginRawGlobalObjectTracking()
    const secondPatch = target[key].bind(null)
    target[key] = secondPatch
    finishRawGlobalObjectTracking(second, beforeSecond)
    releaseRawGlobalObjectPatches(first)
    expect(target[key]).toBe(secondPatch)
    releaseRawGlobalObjectPatches(second)
    expect(Object.prototype.hasOwnProperty.call(target, key)).toBe(false)
  })

  test.each([
    ['Symbol constructor', Symbol as any],
    [
      'IteratorPrototype',
      Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
    ],
  ])('restores the previous live app layer on %s when the newer app is destroyed', (_label, target) => {
    initGlobalEnv()
    const key = '__MICRO_APP_LAYERED_PATCH_TEST__'
    const first = {}
    const second = {}
    const firstPatch = jest.fn()
    const secondPatch = jest.fn()
    try {
      const beforeFirst = beginRawGlobalObjectTracking()
      Reflect.defineProperty(target, key, { configurable: true, writable: true, value: firstPatch })
      finishRawGlobalObjectTracking(first, beforeFirst)

      const beforeSecond = beginRawGlobalObjectTracking()
      Reflect.defineProperty(target, key, { configurable: true, writable: true, value: secondPatch })
      finishRawGlobalObjectTracking(second, beforeSecond)

      releaseRawGlobalObjectPatches(second)
      expect(Reflect.get(target, key)).toBe(firstPatch)

      releaseRawGlobalObjectPatches(first)
      expect(Object.prototype.hasOwnProperty.call(target, key)).toBe(false)
    } finally {
      Reflect.deleteProperty(target, key)
      releaseRawGlobalObjectPatches(second)
      releaseRawGlobalObjectPatches(first)
    }
  })

  test('removes every descriptor layer installed by the same destroyed app', () => {
    initGlobalEnv()
    const key = '__MICRO_APP_SAME_OWNER_LAYER_TEST__'
    const target = Array.prototype as any
    const owner = {}
    try {
      const beforeFirst = beginRawGlobalObjectTracking()
      target[key] = jest.fn()
      finishRawGlobalObjectTracking(owner, beforeFirst)

      const beforeSecond = beginRawGlobalObjectTracking()
      target[key] = jest.fn()
      finishRawGlobalObjectTracking(owner, beforeSecond)

      releaseRawGlobalObjectPatches(owner)
      expect(Object.prototype.hasOwnProperty.call(target, key)).toBe(false)
    } finally {
      delete target[key]
      releaseRawGlobalObjectPatches(owner)
    }
  })

  test('layered cleanup preserves a later untracked base replacement', () => {
    initGlobalEnv()
    const key = '__MICRO_APP_LAYERED_BASE_REPLACEMENT_TEST__'
    const target = Array.prototype as any
    const first = {}
    const second = {}
    const baseReplacement = jest.fn()
    try {
      const beforeFirst = beginRawGlobalObjectTracking()
      target[key] = jest.fn()
      finishRawGlobalObjectTracking(first, beforeFirst)

      const beforeSecond = beginRawGlobalObjectTracking()
      target[key] = jest.fn()
      finishRawGlobalObjectTracking(second, beforeSecond)

      target[key] = baseReplacement
      releaseRawGlobalObjectPatches(second)
      releaseRawGlobalObjectPatches(first)
      expect(target[key]).toBe(baseReplacement)
    } finally {
      delete target[key]
      releaseRawGlobalObjectPatches(second)
      releaseRawGlobalObjectPatches(first)
    }
  })
})
