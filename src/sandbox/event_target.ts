import globalEnv from '../libs/global_env'
import {
  getCurrentAppName,
  getIframeCurrentAppName,
  isNode,
} from '../libs/utils'

type Listener = EventListenerOrEventListenerObject

interface ListenerRecord {
  target: EventTarget
  type: string
  listener: Listener
  options?: boolean | AddEventListenerOptions
  capture: boolean
}

interface AppEventTargetEffect {
  listeners: ListenerRecord[]
  snapshot: ListenerRecord[]
  retiredDom7: ListenerRecord[]
}

const appEventTargetEffects = new Map<string, AppEventTargetEffect>()
/**
 * NOTE(已知风险) 2026.9.12 by Claude Code
 * 这个 Set 只增不减：只有 activateEventTargetEffect(appName) 会移除条目，而它只在
 * sandbox.start() 时按同名调用。对于「每次实例都取唯一名字」的用法（如基座为每个
 * 组件实例生成 WS-Component-XXX-<时间戳> 作为 appName），名字不会重复出现，
 * 条目会随销毁次数缓慢累积（仅字符串，量级很小，但无上界）。
 * Review correction: 不采用 LRU/直接清空；淘汰墓碑后旧异步回调可能再次注册监听。
 * 完整解决需要实例级 generation token，而不能用“当前只剩一个沙箱”猜测归属。
 */
const disposedAppNames = new Set<string>()

function getEffect(appName: string): AppEventTargetEffect {
  let effect = appEventTargetEffects.get(appName)
  if (!effect) {
    effect = { listeners: [], snapshot: [], retiredDom7: [] }
    appEventTargetEffects.set(appName, effect)
  }
  return effect
}

function getCapture(options?: boolean | EventListenerOptions): boolean {
  return typeof options === 'boolean' ? options : Boolean(options?.capture)
}

function getDom7Entries(record: ListenerRecord): unknown[] | undefined {
  // Read data descriptors only; terminal cleanup must not execute library getters.
  const registry = Object.getOwnPropertyDescriptor(record.target, 'dom7Listeners')?.value
  if (!registry || typeof registry !== 'object') return
  const entries = Object.getOwnPropertyDescriptor(registry, record.type)?.value
  return Array.isArray(entries) ? entries : undefined
}

function matchesDom7Entry(entry: unknown, listener: Listener): boolean {
  if (!entry || typeof entry !== 'object') return false
  return ['listener', 'proxyListener'].some((key) => (
    Object.getOwnPropertyDescriptor(entry, key)?.value === listener
  ))
}

function retainDom7Cleanup(effect: AppEventTargetEffect, record: ListenerRecord): void {
  if (getDom7Entries(record)?.some((entry) => matchesDom7Entry(entry, record.listener)) &&
    !effect.retiredDom7.includes(record)) {
    // Ordinary UMD stop removes native listeners, not the library registry.
    // Retain only proven matching records until terminal disposal, not every
    // historical event target registered during the app's lifetime.
    effect.retiredDom7.push(record)
  }
}

/** Window/document wrappers use raw native methods and bypass this patch. */
export function retainSandboxDom7Cleanup(appName: string, record: {
  target: EventTarget,
  type: string,
  listener: Listener | null,
  handler: Listener | null,
}): void {
  if (disposedAppNames.has(appName)) return
  for (const listener of new Set([record.listener, record.handler])) {
    if (!listener) continue
    const candidate: ListenerRecord = { target: record.target, type: record.type, listener, capture: false }
    if (getDom7Entries(candidate)?.some((entry) => matchesDom7Entry(entry, listener))) {
      const effect = getEffect(appName)
      if (!effect.retiredDom7.some((old) => old.target === candidate.target &&
        old.type === candidate.type && old.listener === listener)) {
        retainDom7Cleanup(effect, candidate)
      }
    }
  }
}

function disposeDom7Entries(appName: string, effect: AppEventTargetEffect): void {
  effect.retiredDom7.forEach((record) => {
    const entries = getDom7Entries(record)
    if (!entries || Object.isFrozen(entries)) return
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (!matchesDom7Entry(entry, record.listener)) continue
      const shared = Array.from(appEventTargetEffects).some(([name, other]) => (
        name !== appName && [...other.listeners, ...other.snapshot, ...other.retiredDom7].some((candidate) => (
          candidate.target === record.target && candidate.type === record.type &&
          matchesDom7Entry(entry, candidate.listener)
        ))
      ))
      if (!shared) entries.splice(index, 1)
    }
  })
  effect.retiredDom7 = []
}

function getAppName(target: EventTarget): string | null {
  const nodeAppName = isNode(target) ? target.__MICRO_APP_NAME__ : null
  return nodeAppName || getIframeCurrentAppName() || getCurrentAppName()
}

function isSameListener(
  record: ListenerRecord,
  target: EventTarget,
  type: string,
  listener: Listener,
  capture: boolean,
): boolean {
  return record.target === target && record.type === type &&
    record.listener === listener && record.capture === capture
}

function recordListener(
  target: EventTarget,
  type: string,
  listener: Listener | null,
  options?: boolean | AddEventListenerOptions,
): boolean {
  if (!listener) return true
  const appName = getAppName(target)
  /**
   * TODO(待决定) 2026.9.12 by Claude Code
   *
   * 归属不到 app 的监听器在这里被**放行但完全不记账**，releaseEventTargetListeners
   * 永远删不到它，但“未归属”并不等于“子应用泄漏”。
   *
   * 触发条件：子应用在异步回调（setTimeout / Promise / 事件处理器）里给一个没有
   * __MICRO_APP_NAME__ 的目标（基座元素、尚未被 updateElementInfo 打点的元素）注册监听。
   * 此时 getAppName 里的 getCurrentAppName() 已被 throttleDeferForSetAppName 的 defer
   * 清空，只剩 target.__MICRO_APP_NAME__ 这一条线索可用。
   * Review correction: 后续脚本归属分析确认 658 个未标记 V8EventListener 来自基座，
   * 没有确认的子应用样本。游离 DOM/CustomWindow 数量不能证明这些监听器是锚点。
   *
   * 待选方案（风险递增，需要维护者决定）：
   *   A. 保持行为，仅加 dev 告警 + 计数 —— 零行为风险，但问题依然存在；
   *   B（禁止）. 仅当 globalEnv.activeSandbox === 1 时归属给该沙箱 —— 基座自身的异步代码
   *      若在此窗口内注册监听，会被误归属并在卸载时被删除；
   *   C（禁止）. 最后一个沙箱释放时移除所有"无主"监听器 —— 会误删合法基座监听器。
   */
  if (!appName) return true
  // Ignore late async effects from a terminally destroyed sandbox.
  if (disposedAppNames.has(appName)) return false

  const effect = getEffect(appName)
  const capture = getCapture(options)
  if (!effect.listeners.some((record) => isSameListener(record, target, type, listener, capture))) {
    effect.listeners.push({ target, type, listener, options, capture })
  }
  return true
}

function forgetListener(
  target: EventTarget,
  type: string,
  listener: Listener | null,
  options?: boolean | EventListenerOptions,
): void {
  if (!listener) return
  const capture = getCapture(options)
  appEventTargetEffects.forEach((effect) => {
    const index = effect.listeners.findIndex((record) => (
      isSameListener(record, target, type, listener, capture)
    ))
    if (index >= 0) {
      retainDom7Cleanup(effect, effect.listeners[index])
      effect.listeners.splice(index, 1)
    }
  })
}

/** Track events bound by a child app to DOM/EventTarget objects outside window/document. */
export function patchEventTarget(): void {
  const prototype = globalEnv.rawRootEventTarget.prototype
  prototype.addEventListener = function addEventListener(
    type: string,
    listener: Listener | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (recordListener(this, type, listener, options)) {
      globalEnv.rawAddEventListener.call(this, type, listener, options)
    }
  }
  prototype.removeEventListener = function removeEventListener(
    type: string,
    listener: Listener | null,
    options?: boolean | EventListenerOptions,
  ): void {
    forgetListener(this, type, listener, options)
    globalEnv.rawRemoveEventListener.call(this, type, listener, options)
  }
}

export function releasePatchEventTarget(): void {
  const prototype = globalEnv.rawRootEventTarget.prototype
  prototype.addEventListener = globalEnv.rawAddEventListener
  prototype.removeEventListener = globalEnv.rawRemoveEventListener
}

export function resetEventTargetSnapshot(appName: string): void {
  appEventTargetEffects.get(appName)?.snapshot.splice(0)
}

export function recordEventTargetSnapshot(appName: string): void {
  const effect = appEventTargetEffects.get(appName)
  if (effect) effect.snapshot = effect.listeners.slice()
}

export function rebuildEventTargetSnapshot(appName: string): void {
  const effect = appEventTargetEffects.get(appName)
  if (!effect?.snapshot.length) return

  effect.listeners = []
  effect.snapshot.forEach((record) => {
    const signal = typeof record.options === 'object'
      ? (record.options as AddEventListenerOptions & { signal?: AbortSignal }).signal
      : null
    if (!signal?.aborted) {
      globalEnv.rawAddEventListener.call(record.target, record.type, record.listener, record.options)
      effect.listeners.push(record)
    }
  })
  effect.snapshot = []
}

export function releaseEventTargetListeners(appName: string): void {
  const effect = appEventTargetEffects.get(appName)
  if (!effect) return

  effect.listeners.forEach((record) => {
    retainDom7Cleanup(effect, record)
    const shared = Array.from(appEventTargetEffects).some(([name, other]) => (
      name !== appName && other.listeners.some((candidate) => (
        isSameListener(candidate, record.target, record.type, record.listener, record.capture)
      ))
    ))
    if (!shared) globalEnv.rawRemoveEventListener.call(record.target, record.type, record.listener, record.options)
  })
  effect.listeners = []
}

/** Detached DOM can leave the container before terminal unmount starts. Only
 * return explicitly app-tagged element targets already in our own effect log;
 * never infer ownership for raw body/document or unmarked base listeners.
 */
export function getDetachedEventTargetElements(appName: string): Element[] {
  const effect = appEventTargetEffects.get(appName)
  if (!effect) return []
  const nodes = new Set<Element>()
  for (const record of [...effect.listeners, ...effect.snapshot, ...effect.retiredDom7]) {
    const target = record.target
    if (isNode(target) && target.nodeType === 1 && !target.isConnected &&
      target.__MICRO_APP_NAME__ === appName) nodes.add(target as Element)
  }
  return Array.from(nodes)
}

export function disposeEventTargetEffect(appName: string): void {
  releaseEventTargetListeners(appName)
  const effect = appEventTargetEffects.get(appName)
  if (effect) disposeDom7Entries(appName, effect)
  appEventTargetEffects.delete(appName)
  disposedAppNames.add(appName)
}

export function activateEventTargetEffect(appName: string): void {
  disposedAppNames.delete(appName)
}
