import type {
  RequestIdleCallbackInfo,
  RequestIdleCallbackOptions,
} from '@micro-app/types'
import {
  isSupportModuleScript,
  isBrowser,
  getCurrentAppName,
  assign,
} from './utils'
import {
  rejectMicroAppStyle,
} from '../source/patch'
import {
  updateElementInfo,
} from '../sandbox/adapter'

declare global {
  interface Node {
    __MICRO_APP_NAME__?: string | null
    __PURE_ELEMENT__?: boolean
    __MICRO_APP_HAS_DPN__?: boolean
    data?: unknown
    rawParentNode?: ParentNode | null
  }

  interface HTMLStyleElement {
    __MICRO_APP_HAS_SCOPED__?: boolean
  }

  interface Window {
    requestIdleCallback (
      callback: (info: RequestIdleCallbackInfo) => void,
      opts?: RequestIdleCallbackOptions,
    ): number
    _babelPolyfill: boolean
    __MICRO_APP_ENVIRONMENT__?: boolean
    __MICRO_APP_UMD_MODE__?: boolean
    __MICRO_APP_BASE_APPLICATION__?: boolean
    __REACT_ERROR_OVERLAY_GLOBAL_HOOK__: boolean
    rawLocation: Location
    rawWindow: any
    rawDocument: any
  }
}

const globalEnv: Record<string, any> = {
  // active sandbox count
  activeSandbox: 0,
}

type DescriptorSnapshot = Map<object, Map<PropertyKey, PropertyDescriptor>>
// Proven raw-window escape in the logout snapshot. Do not snapshot/rollback
// every window property: base callbacks may legitimately change unrelated state.
const trackedRawWindowKeys: PropertyKey[] = ['regeneratorRuntime']
interface RawPropertyPatch {
  original?: PropertyDescriptor
  layers: Array<{
    installed?: PropertyDescriptor
    owners: Set<object>
  }>
}
const rawPropertyPatches = new Map<object, Map<PropertyKey, RawPropertyPatch>>()

function sameDescriptor (left?: PropertyDescriptor, right?: PropertyDescriptor): boolean {
  if (!left || !right) return left === right
  return (['configurable', 'enumerable', 'writable', 'value', 'get', 'set'] as const)
    .every((key) => Object.is(left[key], right[key]))
}

/** Snapshot only for synchronous child script execution, not arbitrary reads. */
export function beginRawGlobalObjectTracking (): DescriptorSnapshot {
  const snapshots = globalEnv.rawGlobalObjectPropertySnapshots as Array<{ target: object }> | undefined
  const before: DescriptorSnapshot = new Map((snapshots || []).map(({ target }) => [target, new Map(
    Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!]),
  )]))
  if (globalEnv.rawWindow) {
    const descriptors = new Map<PropertyKey, PropertyDescriptor>()
    trackedRawWindowKeys.forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalEnv.rawWindow, key)
      if (descriptor) descriptors.set(key, descriptor)
    })
    before.set(globalEnv.rawWindow, descriptors)
  }
  return before
}

export function finishRawGlobalObjectTracking (owner: object, before: DescriptorSnapshot): void {
  const snapshots = globalEnv.rawGlobalObjectPropertySnapshots as Array<{
    target: object, descriptors: Map<PropertyKey, PropertyDescriptor>,
  }> | undefined
  const targets = [...(snapshots || [])]
  if (globalEnv.rawWindow && before.has(globalEnv.rawWindow)) {
    targets.push({ target: globalEnv.rawWindow, descriptors: before.get(globalEnv.rawWindow)! })
  }
  targets.forEach(({ target, descriptors }) => {
    // A constructor discovered during execution was snapshotted on its first
    // proxy read, before the child could patch it.
    const original = before.get(target) || descriptors
    const keys = new Set(target === globalEnv.rawWindow
      ? trackedRawWindowKeys
      : [...original.keys(), ...Reflect.ownKeys(target)])
    keys.forEach((key) => {
      const previous = original.get(key)
      const installed = Object.getOwnPropertyDescriptor(target, key)
      if (sameDescriptor(previous, installed)) return
      const patches = rawPropertyPatches.get(target) || new Map<PropertyKey, RawPropertyPatch>()
      let patch = patches.get(key)
      const latestLayer = patch?.layers[patch.layers.length - 1]
      if (patch && latestLayer && !sameDescriptor(previous, latestLayer.installed)) {
        if (sameDescriptor(installed, latestLayer.installed)) {
          // A nested tracked script already registered the final value. Keep
          // its owner and extend the baseline to the outer script's baseline.
          patch.original = previous
          latestLayer.owners.add(owner)
          return
        } else {
          // Base/untracked code replaced the property between child scripts.
          // The newer baseline must survive; never restore an older base value.
          patch = undefined
        }
      }
      patch = patch || { original: previous, layers: [] }
      patch.layers.push({ installed, owners: new Set([owner]) })
      patches.set(key, patch)
      rawPropertyPatches.set(target, patches)
    })
  })
}

function releaseRawGlobalPropertyPatch (
  owner: object,
  target: object,
  key: PropertyKey,
  patches: Map<PropertyKey, RawPropertyPatch>,
): void {
  const patch = patches.get(key)
  if (!patch || !patch.layers.some((layer) => layer.owners.has(owner))) return

  const previousTop = patch.layers[patch.layers.length - 1]
  const current = Object.getOwnPropertyDescriptor(target, key)

  patch.layers.forEach((layer) => layer.owners.delete(owner))
  patch.layers = patch.layers.filter((layer) => layer.owners.size)

  // A base or otherwise untracked writer replaced the latest child value.
  // Preserve that newer value and drop the obsolete child descriptor stack.
  if (!sameDescriptor(current, previousTop.installed)) {
    patches.delete(key)
    return
  }

  const nextTop = patch.layers[patch.layers.length - 1]
  const restoredDescriptor = nextTop?.installed ?? patch.original
  if (!sameDescriptor(current, restoredDescriptor)) {
    const restored = restoredDescriptor
      ? Reflect.defineProperty(target, key, restoredDescriptor)
      : Reflect.deleteProperty(target, key)
    if (!restored) console.warn(`[micro-app] Unable to restore child intrinsic patch: ${String(key)}`)
  }

  if (!patch.layers.length) patches.delete(key)
}

/** Restore only proven child writes that have not since been replaced by base code. */
export function releaseRawGlobalObjectPatches (owner: object): void {
  rawPropertyPatches.forEach((patches, target) => {
    Array.from(patches.keys()).forEach((key) => releaseRawGlobalPropertyPatch(owner, target, key, patches))
    if (!patches.size) rawPropertyPatches.delete(target)
  })
}

/**
 * Do not leave a child's core-js toString wrapper on the shared prototype
 * between scripts. Restoring only at destroy is too late: another live app
 * can already have captured it with uncurryThis. Keep other polyfills intact.
 * This is synchronous boundary containment, not independent realm isolation.
 */
export function releaseSharedFunctionToStringPatch (owner: object): void {
  const target = globalEnv.rawWindow?.Function?.prototype
  if (!target) return
  const patches = rawPropertyPatches.get(target)
  if (!patches) return
  releaseRawGlobalPropertyPatch(owner, target, 'toString', patches)
  if (!patches.size) rawPropertyPatches.delete(target)
}

export function snapshotRawGlobalObjectProperties (...targets: object[]): void {
  const snapshots = globalEnv.rawGlobalObjectPropertySnapshots as Array<{
    target: object,
    descriptors: Map<PropertyKey, PropertyDescriptor>,
  }> | undefined
  if (!snapshots) return
  const targetsSeen: WeakSet<object> = globalEnv.rawGlobalObjectPropertySnapshotTargets ||
    (globalEnv.rawGlobalObjectPropertySnapshotTargets = new WeakSet(snapshots.map(({ target }) => target)))

  /**
   * NOTE(已修复性能问题) 2026.9.12 review
   * 这里的 `snapshots.some(...)` 是线性扫描，而本函数会在**每次从 proxyWindow 读取
   * 全局函数且该函数带 prototype** 时被调用（with/window.ts 的 proxy get 里）。
   * 快照数组初始约 90 项、并随运行期发现的原生构造函数增长，因此这是一个
   * “每次全局函数读取 × 数组长度”的开销。现已改成 WeakSet 去重，释放动态条目时重建。
   */
  targets.forEach((target) => {
    if (!target || targetsSeen.has(target)) return
    targetsSeen.add(target)
    snapshots.push({
      target,
      descriptors: new Map<PropertyKey, PropertyDescriptor>(
        Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!]),
      ),
    })
  })
}

/**
 * Remove the global execution pointer only when it still belongs to the
 * sandbox being destroyed. This avoids keeping the last sandbox realm alive
 * and prevents one app from clearing another active app's pointer.
 */
export function clearActiveProxyWindow (proxyWindow?: WindowProxy | null): void {
  if (
    proxyWindow &&
    globalEnv.rawWindow?.__MICRO_APP_PROXY_WINDOW__ === proxyWindow
  ) {
    Reflect.deleteProperty(globalEnv.rawWindow, '__MICRO_APP_PROXY_WINDOW__')
  }
}

/**
 * Child polyfills can add or replace properties on native constructors and
 * their prototypes. In with-sandbox mode these objects come from the base
 * realm, so an installed method can otherwise retain a destroyed child bundle.
 */
export function restoreRawGlobalObjectProperties (): void {
  const snapshots = globalEnv.rawGlobalObjectPropertySnapshots as Array<{
    target: object,
    descriptors: Map<PropertyKey, PropertyDescriptor>,
  }> | undefined
  if (!snapshots) return

  /**
   * TODO(待决定) 2026.9.12 by Claude Code
   * 这里会把 intrinsic 上“快照之后新增的一切属性”删除、并把快照里的描述符写回。
   * 由于本函数在 globalEnv.activeSandbox 归零（最后一个沙箱停止）时执行，如果
   * **基座应用自身**在 initGlobalEnv 之后给 Object/Array.prototype 等加了东西
   * （polyfill、埋点、猴子补丁），会被这里一并抹掉且无任何提示。
   * 子应用造成的污染确实是需要清除的，但无法在这里区分来源。
   * 待定：是否需要（a）记录并跳过基座自身的改动，或（b）至少在删除时打一条 warning。
   */
  // Review correction: this is an explicit controlled-session rollback helper,
  // NOT an automatic sandbox teardown step. There is no reliable attribution
  // for direct writes to shared intrinsic prototypes; silently reverting them
  // also reverts legitimate base-app patches and breaks UMD remounts.
  snapshots.forEach(({ target, descriptors }) => {
    Reflect.ownKeys(target).forEach((key) => {
      if (!descriptors.has(key)) Reflect.deleteProperty(target, key)
    })
    descriptors.forEach((descriptor, key) => {
      Reflect.defineProperty(target, key, descriptor)
    })
  })

  // Runtime-discovered constructors can belong to a child bundle. Keeping
  // their descriptor snapshots in this global array after restoration would
  // retain the function, its prototype and potentially the whole child realm.
  // Initial intrinsic snapshots are the reusable baseline; dynamic entries
  // are recreated on demand during the next sandbox session.
  releaseRawGlobalObjectSnapshots()
}

/** Drop child/runtime snapshot references without mutating the base realm. */
export function releaseRawGlobalObjectSnapshots (): void {
  const snapshots = globalEnv.rawGlobalObjectPropertySnapshots as Array<{ target: object }> | undefined
  const baselineCount = globalEnv.rawGlobalObjectPropertySnapshotBaselineCount as number | undefined
  if (!snapshots || typeof baselineCount !== 'number') return
  snapshots.splice(baselineCount)
  // Rebuild after trimming: WeakSet has no delete/clear, and a future session
  // must be able to snapshot a runtime target again.
  globalEnv.rawGlobalObjectPropertySnapshotTargets = new WeakSet(snapshots.map(({ target }) => target))
}

/**
 * Note loop nesting
 * Only prototype or unique values can be put here
 */
export function initGlobalEnv (): void {
  if (isBrowser) {
    const rawWindow = window.rawWindow || Function('return window')()
    const rawDocument = window.rawDocument || Function('return document')()
    const rawRootDocument = rawWindow.Document || Function('return Document')()
    const rawRootElement = rawWindow.Element
    const rawRootNode = rawWindow.Node
    const rawRootEventTarget = rawWindow.EventTarget
    const rawDocumentFragment = rawWindow.DocumentFragment
    const rawArrayIterator = rawWindow.Array.prototype[rawWindow.Symbol.iterator].call(new rawWindow.Array())
    const rawIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(rawArrayIterator))
    const intrinsicNames = [
      'Object', 'Function', 'Array', 'String', 'Boolean', 'Number', 'BigInt', 'Symbol',
      'Date', 'RegExp', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
      'TypeError', 'URIError', 'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet',
      'Promise', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array',
      'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
      'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Math', 'JSON',
      'Reflect', 'Atomics', 'Intl', 'WebAssembly',
    ]
    const rawGlobalObjectPropertyTargets = new Set<object>([rawIteratorPrototype])
    intrinsicNames.forEach((key) => {
      const target = rawWindow[key]
      if ((typeof target === 'object' && target) || typeof target === 'function') {
        rawGlobalObjectPropertyTargets.add(target)
        if (target.prototype) rawGlobalObjectPropertyTargets.add(target.prototype)
      }
    })
    const rawGlobalObjectPropertySnapshots = Array.from(rawGlobalObjectPropertyTargets).map((target) => ({
      target,
      descriptors: new Map<PropertyKey, PropertyDescriptor>(
        Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!]),
      ),
    }))

    // save patch raw methods, pay attention to this binding
    const rawAppendChild = rawRootNode.prototype.appendChild
    const rawInsertBefore = rawRootNode.prototype.insertBefore
    const rawReplaceChild = rawRootNode.prototype.replaceChild
    const rawRemoveChild = rawRootNode.prototype.removeChild
    const rawSetAttribute = rawRootElement.prototype.setAttribute
    const rawAppend = rawRootElement.prototype.append
    const rawPrepend = rawRootElement.prototype.prepend
    const rawFragmentAppend = rawDocumentFragment.prototype.append
    const rawFragmentPrepend = rawDocumentFragment.prototype.prepend
    const rawCloneNode = rawRootNode.prototype.cloneNode
    const rawElementQuerySelector = rawRootElement.prototype.querySelector
    const rawElementQuerySelectorAll = rawRootElement.prototype.querySelectorAll
    const rawInsertAdjacentElement = rawRootElement.prototype.insertAdjacentElement
    const rawInnerHTMLDesc = Object.getOwnPropertyDescriptor(rawRootElement.prototype, 'innerHTML')
    const rawParentNodeDesc = Object.getOwnPropertyDescriptor(rawRootNode.prototype, 'parentNode')

    // Document proto methods
    const rawCreateElement = rawRootDocument.prototype.createElement
    const rawCreateElementNS = rawRootDocument.prototype.createElementNS
    const rawCreateTextNode = rawRootDocument.prototype.createTextNode
    const rawCreateDocumentFragment = rawRootDocument.prototype.createDocumentFragment
    const rawCreateComment = rawRootDocument.prototype.createComment
    const rawQuerySelector = rawRootDocument.prototype.querySelector
    const rawQuerySelectorAll = rawRootDocument.prototype.querySelectorAll
    const rawGetElementById = rawRootDocument.prototype.getElementById
    const rawGetElementsByClassName = rawRootDocument.prototype.getElementsByClassName
    const rawGetElementsByTagName = rawRootDocument.prototype.getElementsByTagName
    const rawGetElementsByName = rawRootDocument.prototype.getElementsByName

    // TODO: 将ImageProxy移出去
    const ImageProxy = new Proxy(rawWindow.Image, {
      construct (Target, args): HTMLImageElement {
        return updateElementInfo(new Target(...args), getCurrentAppName())
      },
    })

    /**
     * save effect raw methods
     * pay attention to this binding, especially setInterval, setTimeout, clearInterval, clearTimeout
     */
    const rawSetInterval = rawWindow.setInterval
    const rawSetTimeout = rawWindow.setTimeout
    const rawClearInterval = rawWindow.clearInterval
    const rawClearTimeout = rawWindow.clearTimeout
    const rawPushState = rawWindow.history.pushState
    const rawReplaceState = rawWindow.history.replaceState
    const rawAddEventListener = rawRootEventTarget.prototype.addEventListener
    const rawRemoveEventListener = rawRootEventTarget.prototype.removeEventListener
    const rawDispatchEvent = rawRootEventTarget.prototype.dispatchEvent

    // mark current application as base application
    window.__MICRO_APP_BASE_APPLICATION__ = true

    assign(globalEnv, {
      supportModuleScript: isSupportModuleScript(),

      // common global vars
      rawWindow,
      rawDocument,
      rawRootDocument,
      rawRootElement,
      rawRootNode,
      rawRootEventTarget,
      rawDocumentFragment,
      rawGlobalObjectPropertySnapshots,
      rawGlobalObjectPropertySnapshotBaselineCount: rawGlobalObjectPropertySnapshots.length,

      // source/patch
      rawSetAttribute,
      rawAppendChild,
      rawInsertBefore,
      rawReplaceChild,
      rawRemoveChild,
      rawAppend,
      rawPrepend,
      rawFragmentAppend,
      rawFragmentPrepend,
      rawCloneNode,
      rawElementQuerySelector,
      rawElementQuerySelectorAll,
      rawInsertAdjacentElement,
      rawInnerHTMLDesc,
      rawParentNodeDesc,

      rawCreateElement,
      rawCreateElementNS,
      rawCreateDocumentFragment,
      rawCreateTextNode,
      rawCreateComment,
      rawQuerySelector,
      rawQuerySelectorAll,
      rawGetElementById,
      rawGetElementsByClassName,
      rawGetElementsByTagName,
      rawGetElementsByName,
      ImageProxy,

      // sandbox/effect
      rawSetInterval,
      rawSetTimeout,
      rawClearInterval,
      rawClearTimeout,
      rawPushState,
      rawReplaceState,
      rawAddEventListener,
      rawRemoveEventListener,
      rawDispatchEvent,

      // iframe
    })

    // global effect
    rejectMicroAppStyle()
  }
}

export default globalEnv
