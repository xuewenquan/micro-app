import type {
  Func,
  AppInterface,
  sourceType,
  WithSandBoxInterface,
  MountParam,
  UnmountParam,
  OnLoadParam,
} from '@micro-app/types'
import { HTMLLoader } from './source/loader/html'
import { extractSourceDom } from './source/index'
import { execScripts } from './source/scripts'
import WithSandBox from './sandbox/with'
import IframeSandbox from './sandbox/iframe'
import { router, isRouterModeSearch } from './sandbox/router'
import {
  appStates,
  lifeCycles,
  keepAliveStates,
  microGlobalEvent,
  DEFAULT_ROUTER_MODE,
} from './constants'
import {
  isFunction,
  isPromise,
  logError,
  getRootContainer,
  execMicroAppGlobalHook,
  pureCreateElement,
  isDivElement,
  removeDomScope,
} from './libs/utils'
import dispatchLifecyclesEvent, {
  dispatchCustomEventToMicroApp,
} from './interact/lifecycles_event'
import globalEnv, { clearActiveProxyWindow, releaseRawGlobalObjectPatches } from './libs/global_env'
import microApp from './micro_app'
import sourceCenter from './source/source_center'
import { disposeDataCenterForApp } from './interact'
import { releaseScopedCSSObservers } from './sandbox/scoped_css_observers'
import { createAppTask, disposeAppTasks, AppTask } from './libs/app_tasks'
import { releaseElementInfoTree } from './sandbox/adapter'
import { releaseWorkersByApp } from './proxies/worker'
import { appInstanceMap, isAppNameOwner } from './libs/app_registry'
import { runCleanupStep } from './libs/cleanup'
import { getDetachedEventTargetElements } from './sandbox/event_target'

// Retain public/internal import compatibility while avoiding loader cycles.
export { appInstanceMap, isAppNameOwner } from './libs/app_registry'

// Outside mount's lexical scope: a retained readiness reaction must not keep
// the original container/parameters alive after cancellation or completion.
function runPendingMount (task: AppTask<{ app: CreateApp | null, options: MountParam | null }>): void {
  const state = task.current
  if (!state?.app || !state.options) return
  try {
    if (!state.app.isUnmounted() && !state.app.isDestroyed()) state.app.executePendingMount(state.options)
  } finally {
    task.complete()
  }
}

function createMountReadyCallback (task: AppTask<{ app: CreateApp | null, options: MountParam | null }>): () => void {
  return () => runPendingMount(task)
}

function createMountCancelCallback (task: AppTask<{ app: CreateApp | null, options: MountParam | null }>): () => void {
  return () => task.dispose()
}

function createBeforeMountCallback (app: CreateApp): () => void {
  const task = createAppTask(app, { app: app as CreateApp | null }, (state) => { state.app = null })
  return () => {
    const current = task.current
    try {
      if (current?.app && !current.app.isDestroyed()) {
        dispatchLifecyclesEvent(current.app.container, current.app.name, lifeCycles.BEFOREMOUNT)
      }
    } finally { task.complete() }
  }
}

function createScriptMountCallback (app: CreateApp): (finished: boolean) => void {
  const task = createAppTask(app, { app: app as CreateApp | null }, (state) => { state.app = null })
  return (finished) => {
    const current = task.current
    if (!current?.app || current.app.isDestroyed()) return
    if (finished) {
      try { if (!current.app.umdMode) current.app.handleMounted() } finally { task.complete() }
    }
  }
}

function createUmdRegistrationCallback (app: CreateApp): (mount: unknown, unmount: unknown) => void {
  const task = createAppTask(app, { app: app as CreateApp | null }, (state) => { state.app = null })
  return (mount, unmount) => task.current?.app?.registerMountHooks(mount, unmount)
}

// isAppNameOwner 的实现与语义说明见 libs/app_registry.ts。
// Review correction: this name guard protects a newer instance, but it is not
// generation ownership. Instance-specific tasks are disposed separately below;
// remaining name-keyed registries must not be blindly cleared by an old app.

// Deliberately outside CreateApp's method scope: pending Promise reactions must
// not share the method's lexical context (and its captured `this`).
function settleUnmountPromise (
  promise: Promise<unknown>,
  action: (() => void) | null,
  reportError: ((e: unknown) => void) | null,
  terminal: boolean,
): void {
  let timer: number | undefined
  const finish = () => {
    const next = action
    action = null
    reportError = null
    if (timer !== undefined) globalEnv.rawClearTimeout.call(globalEnv.rawWindow, timer)
    timer = undefined
    next?.()
  }
  if (terminal) timer = globalEnv.rawSetTimeout.call(globalEnv.rawWindow, finish, 3000)
  promise.then(finish, (e) => {
    reportError?.(e)
    finish()
  })
}

// params of CreateApp
export interface CreateAppParam {
  name: string
  url: string
  scopecss: boolean
  useSandbox: boolean
  inline?: boolean
  iframe?: boolean
  container?: HTMLElement | ShadowRoot
  ssrUrl?: string
  isPrefetch?: boolean
  prefetchLevel?: number
  attrs?: Record<string, string>,
  routerMode?: string
}

export default class CreateApp implements AppInterface {
  private state: string = appStates.CREATED
  private destroyed = false
  private terminalDOMNodes: Element[] | null = null
  private keepAliveState: string | null = null
  private loadSourceLevel: -1|0|1|2 = 0
  private umdHookMount: Func | null = null
  private umdHookUnmount: Func | null = null
  private preRenderEvents?: CallableFunction[] | null
  public umdMode = false
  public source: sourceType
  // TODO: 类型优化，加上iframe沙箱
  public sandBox: WithSandBoxInterface | IframeSandbox | null = null
  public name: string
  public url: string
  public container: HTMLElement | ShadowRoot | null
  public scopecss: boolean
  public useSandbox: boolean
  public inline: boolean
  public iframe: boolean
  public ssrUrl: string
  public isPrefetch: boolean
  public isPrerender: boolean
  public prefetchLevel?: number
  public fiber = false
  public routerMode: string
  public attrs?: Record<string, string>
  public isReloading = false

  constructor ({
    name,
    url,
    container,
    scopecss,
    useSandbox,
    inline,
    iframe,
    ssrUrl,
    isPrefetch,
    prefetchLevel,
    routerMode,
    attrs,
  }: CreateAppParam) {
    appInstanceMap.set(name, this)
    // init actions
    this.name = name
    this.url = url
    this.useSandbox = useSandbox
    this.scopecss = this.useSandbox && scopecss
    this.attrs = attrs
    // exec before getInlineModeState
    this.iframe = iframe ?? false
    this.inline = this.getInlineModeState(inline)
    this.isReloading = false
    /**
     * NOTE:
     *  1. Navigate after micro-app created, before mount
     */
    this.routerMode = routerMode || DEFAULT_ROUTER_MODE

    // not exist when prefetch 👇
    this.container = container ?? null
    this.ssrUrl = ssrUrl ?? ''

    // exist only prefetch 👇
    this.isPrefetch = isPrefetch ?? false
    this.isPrerender = prefetchLevel === 3
    this.prefetchLevel = prefetchLevel

    this.source = { html: null, links: new Set(), scripts: new Set() }
    this.loadSourceCode()
    this.createSandbox()
  }

  // Load resources
  public loadSourceCode (): void {
    this.setAppState(appStates.LOADING)
    HTMLLoader.getInstance().run(this, extractSourceDom)
  }

  /**
   * When resource is loaded, mount app if it is not prefetch or unmount
   * defaultPage disablePatchRequest routerMode baseroute is only for prerender app
   */
  public onLoad ({
    html,
    // below params is only for prerender app
    defaultPage,
    routerMode,
    baseroute,
    disablePatchRequest,
  }: OnLoadParam): void {
    if (this.destroyed) {
      // 2026.9.12 by Claude Code
      // 本实例已销毁，但这次 onLoad 是迟到的：只有当 appName 没有落到同名新实例
      // 手里时才能按 name 释放源码元数据，否则会清掉新实例的 appSpace。
      if (isAppNameOwner(this)) sourceCenter.releaseApp(this.name)
      return
    }
    if (++this.loadSourceLevel === 2) {
      this.source.html = html
      if (this.isUnmounted()) return
      if (!this.isPrefetch) {
        getRootContainer(this.container!).mount(this)
      } else if (this.isPrerender) {
        /**
         * PreRender is an option of prefetch, it will render app during prefetch
         * Limit:
         * 1. fiber forced on
         * 2. only virtual router support
         *
         * NOTE: (Don't update browser url, dispatch popstateEvent, reload window, dispatch lifecycle event)
         * 1. pushState/replaceState in child can update microLocation, but will not attach router info to browser url
         * 2. prevent dispatch popstate/hashchange event to browser
         * 3. all navigation actions of location are invalid (In the future, we can consider update microLocation without trigger browser reload)
         * 4. lifecycle event will not trigger when prerender
         *
         * Special scenes
         * 1. unmount prerender app when loading
         * 2. unmount prerender app when exec js
         * 2. unmount prerender app after exec js
         */
        const container = pureCreateElement('div')
        container.setAttribute('prerender', 'true')
        this.sandBox?.setPreRenderState(true)
        this.mount({
          container,
          inline: this.inline,
          fiber: true,
          defaultPage: defaultPage || '',
          disablePatchRequest: disablePatchRequest ?? false,
          routerMode: routerMode!,
          baseroute: baseroute || '',
        })
      }
    }
  }

  /**
   * Error loading HTML
   * @param e Error
   */
  public onLoadError (e: Error): void {
    if (this.destroyed) return
    this.loadSourceLevel = -1

    if (!this.isUnmounted()) {
      this.onerror(e)
      this.setAppState(appStates.LOAD_FAILED)
    }
  }

  /**
   * mount app
   * @param container app container
   * @param inline run js in inline mode
   * @param routerMode virtual router mode
   * @param defaultPage default page of virtual router
   * @param baseroute route prefix, default is ''
   * @param disablePatchRequest prevent rewrite request method of child app
   * @param fiber run js in fiber mode
   */
  public mount ({
    container,
    inline,
    routerMode,
    defaultPage,
    baseroute,
    disablePatchRequest,
    fiber,
  }: MountParam): void {
    if (this.loadSourceLevel !== 2) {
      /**
       * container cannot be null when load end
       * NOTE:
       *  1. render prefetch app before load end
       *  2. unmount prefetch app and mount again before load end
       */
      this.container = container
      // mount before prerender exec mount (loading source), set isPrerender to false
      this.isPrerender = false

      // dispatch state event to micro app
      // TODO: statechange 还是 state-change，保持一致
      dispatchCustomEventToMicroApp(this, 'statechange', {
        appState: appStates.LOADING
      })

      // reset app state to LOADING
      return this.setAppState(appStates.LOADING)
    }

    this.createSandbox()

    const task = createAppTask(this, {
      app: this as CreateApp | null,
      options: {
        container, inline, routerMode, defaultPage, baseroute, disablePatchRequest, fiber,
      } as MountParam | null
    }, (state) => { state.app = null; state.options = null })
    const ready = createMountReadyCallback(task)
    this.sandBox ? this.sandBox.sandboxReady.then(ready, createMountCancelCallback(task)) : ready()
  }

  public executePendingMount ({ container, inline, routerMode, defaultPage, baseroute, disablePatchRequest, fiber }: MountParam): void {
    // place inside of nextAction, make sure iframe ready
    this.setAppState(appStates.BEFORE_MOUNT)
    /**
       * Special scenes:
       * 1. mount before prerender exec mount (loading source)
       * 2. mount when prerender js executing
       * 3. mount after prerender js exec end
       * 4. mount after prerender unmounted
       *
       * TODO: test shadowDOM
       */
    if (
      this.isPrerender &&
        isDivElement(this.container) &&
        this.container.hasAttribute('prerender')
    ) {
      /**
         * current this.container is <div prerender='true'></div>
         * set this.container to <micro-app></micro-app>
         * NOTE:
         *  1. must exec before this.sandBox.rebuildEffectSnapshot
         *  2. must exec before this.preRenderEvents?.forEach((cb) => cb())
         */
      this.container = this.cloneContainer(container, this.container, false)
      /**
         * rebuild effect event of window, document, data center
         * explain:
         * 1. rebuild before exec mount, do nothing
         * 2. rebuild when js executing, recovery recorded effect event, because prerender fiber mode
         * 3. rebuild after js exec end, normal recovery effect event
         */
      this.sandBox?.rebuildEffectSnapshot()
      this.preRenderEvents?.forEach((cb) => cb())
      // reset isPrerender config
      this.isPrerender = false
      this.preRenderEvents = null
      // attach router info to browser url
      router.attachToURL(this.name)
      this.sandBox?.setPreRenderState(false)
    } else {
      this.container = container
      this.inline = this.getInlineModeState(inline)
      this.fiber = fiber
      this.routerMode = routerMode

      const dispatchBeforeMount = createBeforeMountCallback(this)

      if (this.isPrerender) {
        (this.preRenderEvents ??= []).push(dispatchBeforeMount)
      } else {
        dispatchBeforeMount()
      }

      this.setAppState(appStates.MOUNTING)

      // dispatch state event to micro app
      dispatchCustomEventToMicroApp(this, 'statechange', {
        appState: appStates.MOUNTING
      })

      // TODO: 兼容shadowRoot的场景
      this.cloneContainer(this.container, this.source.html, !this.umdMode)

      this.sandBox?.start({
        umdMode: this.umdMode,
        baseroute,
        defaultPage,
        disablePatchRequest,
      })

      if (!this.umdMode) {
        // patch element info of html
        this.sandBox?.actionsBeforeExecScripts(this.container, createUmdRegistrationCallback(this))

        execScripts(this, createScriptMountCallback(this))
      } else {
        this.sandBox?.rebuildEffectSnapshot()
        try {
          this.handleMounted(this.umdHookMount!(microApp.getData(this.name, true)))
        } catch (e) {
          logError('An error occurred when mount \n', this.name, e)
        }
      }
    }
  }

  public registerMountHooks (mount: unknown, unmount: unknown): void {
    if (!this.destroyed && !this.umdMode && !this.isUnmounted()) {
      this.umdHookMount = isFunction(mount) ? mount as Func : null
      // umdHookUnmount can works in default mode, register by window.unmount
      this.umdHookUnmount = isFunction(unmount) ? unmount as Func : null
      // if mount & unmount is function, the sub app is umd mode
      if (isFunction(this.umdHookMount) && isFunction(this.umdHookUnmount)) {
        this.sandBox?.markUmdMode(this.umdMode = true)
        try {
          // if appState is mounted, it means that isFinished is true and this.handleMounted has already been executed, just exec this.umdHookMount
          if (this.getAppState() === appStates.MOUNTED) {
            this.umdHookMount(microApp.getData(this.name, true))
          } else {
            this.handleMounted(this.umdHookMount(microApp.getData(this.name, true)))
          }
        } catch (e) {
          logError('An error occurred when mount \n', this.name, e)
        }
      }
    }
    /**
     * Initialization of sandbox is async, especially iframe sandbox are macro tasks
     * when child apps switch quickly, we need to pay attention to the following points:
     * NOTE:
     *  1. unmount app before exec nextAction (especially: iframe sandbox + default mode + remount)
     *     this.container is null, this.sandBox will not start
     *  2. remount app of note 1
     *  3. unmount app during exec js
     */
    // TODO: 可优化？
  }

  /**
   * handle for promise umdHookMount
   * @param umdHookMountResult result of umdHookMount
   */
  public handleMounted (umdHookMountResult?: unknown): void {
    const dispatchAction = () => {
      const nextAction = () => this.actionsAfterMounted()
      if (isPromise(umdHookMountResult)) {
        umdHookMountResult
          .then(nextAction)
          .catch((e) => {
            logError('An error occurred in window.mount \n', this.name, e)
            nextAction()
          })
      } else {
        nextAction()
      }
    }

    if (this.isPrerender) {
      this.preRenderEvents?.push(dispatchAction)
      this.sandBox?.recordAndReleaseEffect({ isPrerender: true })
    } else {
      dispatchAction()
    }
  }

  /**
   * dispatch mounted event when app run finished
   */
  private actionsAfterMounted (): void {
    if (!this.isUnmounted()) {
      this.setAppState(appStates.MOUNTED)
      // call window.onmount of child app
      execMicroAppGlobalHook(
        this.getMicroAppGlobalHook(microGlobalEvent.ONMOUNT),
        this.name,
        microGlobalEvent.ONMOUNT,
        microApp.getData(this.name, true)
      )

      // dispatch state event to micro app
      dispatchCustomEventToMicroApp(this, 'statechange', {
        appState: appStates.MOUNTED
      })

      // dispatch mounted event to micro app
      dispatchCustomEventToMicroApp(this, 'mounted')

      // dispatch event mounted to parent
      dispatchLifecyclesEvent(
        this.container,
        this.name,
        lifeCycles.MOUNTED,
      )

      /**
       * Hidden Keep-alive app during resource loading, render normally to ensure their liveliness (running in the background) characteristics.
       * Actions:
       *  1. Record & release all global events after mount
       */
      if (this.isHidden()) {
        this.sandBox?.recordAndReleaseEffect({ keepAlive: true })
      }
    }
    /**
     * TODO: 这里增加一个处理，如果渲染完成时已经卸载，则进行一些操作
     * 如果是默认模式：删除所有事件和定时器
     * 如果是umd模式：重新记录和清空事件
     * 补充：非必需，优先级低
     */
  }

  /**
   * unmount app
   * NOTE:
   *  1. do not add any params on account of unmountApp
   *  2. this.container maybe null: Initialization of sandbox is async, child app may unmount before exec nextAction of mount
   *  3. unmount app when loading files (this.container is not null)
   * @param destroy completely destroy, delete cache resources
   * @param clearData clear data of dateCenter
   * @param keepRouteState keep route state when unmount, default is false
   * @param unmountcb callback of unmount
   */
  public unmount ({
    destroy,
    clearData,
    keepRouteState,
    unmountcb,
  }: UnmountParam): void {
    destroy = destroy || this.state === appStates.LOAD_FAILED

    // Review correction: Vue/transition hooks may detach nodes before the final
    // container traversal. Retain only this instance's current owned nodes,
    // and only for terminal unmount; never snapshot a keep-alive switch.
    if (destroy && !this.destroyed && !this.terminalDOMNodes) this.captureTerminalDOM()
    this.setAppState(appStates.UNMOUNT)

    let umdHookUnmountResult: unknown
    try {
      umdHookUnmountResult = this.umdHookUnmount?.(microApp.getData(this.name, true))
    } catch (e) {
      logError('An error occurred when unmount \n', this.name, e)
    }

    this.handleUnmounted(
      destroy,
      clearData,
      keepRouteState,
      unmountcb,
      umdHookUnmountResult,
    )
  }

  /**
   * handle for promise umdHookUnmount
   * @param destroy completely destroy, delete cache resources
   * @param clearData clear data of dateCenter
   * @param keepRouteState keep route state when unmount, default is false
   * @param unmountcb callback of unmount
   * @param umdHookUnmountResult result of umdHookUnmount
   */
  private handleUnmounted (
    destroy: boolean,
    clearData: boolean,
    keepRouteState: boolean,
    unmountcb?: CallableFunction,
    umdHookUnmountResult?: unknown,
  ): void {
    // dispatch state event to micro app
    dispatchCustomEventToMicroApp(this, 'statechange', {
      appState: appStates.UNMOUNT
    })

    // dispatch unmount event to micro app
    dispatchCustomEventToMicroApp(this, 'unmount')

    // call window.onunmount of child app
    execMicroAppGlobalHook(
      this.getMicroAppGlobalHook(microGlobalEvent.ONUNMOUNT),
      this.name,
      microGlobalEvent.ONUNMOUNT,
    )

    const nextAction = () => this.actionsAfterUnmounted({
      destroy,
      clearData,
      keepRouteState,
      unmountcb,
    })

    if (isPromise(umdHookUnmountResult)) {
      // async window.unmount will cause appName bind error in nest app
      removeDomScope()
      // Terminal destroy must not wait forever for an application-owned Promise.
      // Promise reactions capture only this mutable holder; after cleanup even a
      // permanently pending Promise no longer retains CreateApp/container/source.
      settleUnmountPromise(
        umdHookUnmountResult,
        nextAction,
        (e) => logError(`An error occurred in window.unmount: ${String(e)}`, this.name),
        destroy,
      )
    } else nextAction()
  }

  /**
   * actions for unmount app
   * @param destroy completely destroy, delete cache resources
   * @param clearData clear data of dateCenter
   * @param keepRouteState keep route state when unmount, default is false
   * @param unmountcb callback of unmount
   */
  private actionsAfterUnmounted ({
    destroy,
    clearData,
    keepRouteState,
    unmountcb,
  }: UnmountParam): void {
    if (this.umdMode && this.container && !destroy) {
      runCleanupStep(this.name, 'clone UMD container', () => this.cloneContainer(this.source.html, this.container as HTMLElement, false))
    }
    const shouldClearData = this.isReloading ? false : (clearData || destroy)
    /**
     * this.container maybe contains micro-app element, stop sandbox should exec after cloneContainer
     * NOTE:
     * 1. if destroy is true, clear route state
     * 2. umd mode and keep-alive will not clear EventSource
     */
    runCleanupStep(this.name, 'stop sandbox after unmount', () => this.sandBox?.stop({
      umdMode: this.umdMode,
      keepRouteState: keepRouteState && !destroy,
      destroy,
      clearData: shouldClearData,
    }))

    // dispatch unmount event to base app
    runCleanupStep(this.name, 'dispatch base unmount lifecycle', () => dispatchLifecyclesEvent(
      this.container,
      this.name,
      lifeCycles.UNMOUNT,
    ))

    runCleanupStep(this.name, 'clear unmount options', () => this.clearOptions(destroy))
    // Even a DOM/prototype failure in clearOptions cannot skip terminal cleanup.
    if (destroy) this.actionsForCompletelyDestroy()

    runCleanupStep(this.name, 'complete unmount callback', () => { unmountcb?.() })
  }

  /**
   * 2026.9.12 by Claude Code
   * 终态销毁前的深度 DOM 清理。
   *
   * 背景：`container.innerHTML = ''` 只是把 <micro-app-head>/<micro-app-body> 从容器上
   * 摘下来，并不会清空它们自己的子树。而子应用的 UI 库常以 `document.head` 作为样式缓存的
   * key —— 在 with 沙箱里 `document.head` 解析到的正是 micro-app 造的 <micro-app-head>。
   * 一旦这个 head 被子应用侧的模块级 Map 长期持有，它的整棵子树以及 <style> 的
   * CSSStyleSheet（Blink 解析后的 StyleRule / CSSSelector::RareData /
   * CSSPropertyValueSet）就会一起活着。13:42 快照实测：单个 style 元素即可独占
   * 2.03 MB、31,330 个原生节点。
   *
   * 所以在摘除容器之前，先清空这些元素的子树与 style 内容：即使外部仍持有 head/body，
   * 解析后的 CSS 也能立刻释放。这是**缓解**——它不解决“子应用库拿基座共享元素做 key”的根因，
   * 但能保证框架自己拥有的 DOM 子树不再被拖住。
   *
   * 约束（务必保持）：
   *  1. 只在终态 destroy 路径调用，**不能**用于 keep-alive / umd 的切换与保活；
   *  2. 只处理本实例容器内的 micro-app-head / micro-app-body，
   *     **绝不触碰基座真实的 document.head / document.body**；
   *  3. 幂等：重复调用只是空查询。
   */
  private captureTerminalDOM (): void {
    const nodes: Element[] = []
    const visit = (node: Element): void => {
      const tag = node.tagName.toLowerCase()
      if (tag.startsWith('micro-app') && tag !== 'micro-app-head' && tag !== 'micro-app-body') return
      nodes.push(node)
      Array.from(node.children).forEach(visit)
    }
    Array.from(this.container?.children || []).forEach(visit)
    // Also cover already-detached, explicitly marked listener targets. Name-
    // keyed effect logs must not be read by a stale same-name instance.
    if (isAppNameOwner(this)) {
      getDetachedEventTargetElements(this.name).forEach((node) => {
        if (!nodes.includes(node)) nodes.push(node)
      })
    }
    this.terminalDOMNodes = nodes
  }

  private clearInstanceDOM (): void {
    // Drop the holder first, including when container was cleared by the hook.
    // A retained unmount Promise must not retain this temporary node snapshot.
    const detachedCandidates = this.terminalDOMNodes
    this.terminalDOMNodes = null
    const container = this.container
    detachedCandidates?.forEach((node) => {
      // Reparented live nodes may now belong to another application. Detached
      // nodes from the pre-hook snapshot remain ours; do not scan document.
      if (node.isConnected && (!container || !container.contains(node))) return
      runCleanupStep(this.name, 'cancel pre-unmount owned animations', () => {
        node.getAnimations?.().forEach((animation) => {
          runCleanupStep(this.name, 'cancel detached owned animation', () => animation.cancel())
        })
      })
    })
    if (!container) return
    // 1) 先清 style 内容：部分 UI 库单独缓存 style 元素，只清子树覆盖不到它
    // Review: traverse only owned DOM. A nested application's internals must be
    // cleaned by its own unmount chain, not by this parent's style traversal.
    const visit = (node: Element): void => {
      const tag = node.tagName.toLowerCase()
      if (tag.startsWith('micro-app') && tag !== 'micro-app-head' && tag !== 'micro-app-body') {
        const child = appInstanceMap.get(node.getAttribute('name') || '')
        // Identity, not name alone: do not destroy a replacement/other Tab.
        if (child && child !== this && child.container && getRootContainer(child.container) === node && !child.isDestroyed?.()) {
          runCleanupStep(this.name, 'unmount owned nested app', () => child.unmount({ destroy: true, clearData: true, keepRouteState: false }))
        }
        return
      }
      // Review correction (2026-09-14): DocumentTimeline can retain detached
      // animation targets and their Vue event invokers after the DOM is emptied.
      // Cancel only this node's animations, never document.getAnimations() or
      // subtree:true: nested applications own their separate teardown sequence.
      runCleanupStep(this.name, 'cancel owned DOM animations', () => {
        if (typeof node.getAnimations !== 'function') return
        node.getAnimations().forEach((animation) => {
          runCleanupStep(this.name, 'cancel owned animation', () => animation.cancel())
        })
      })
      Array.from(node.children).forEach(visit)
      if (tag === 'style') {
        // CSSOM insertRule need not create Text nodes. Empty the owned sheet
        // before detaching it; inaccessible sheets must not abort teardown.
        runCleanupStep(this.name, 'clear owned CSSOM rules', () => {
          const sheet = (node as HTMLStyleElement).sheet
          if (sheet) while (sheet.cssRules.length) sheet.deleteRule(sheet.cssRules.length - 1)
        })
        node.textContent = ''
      }
      if (tag === 'micro-app-head' || tag === 'micro-app-body') node.innerHTML = ''
    }
    Array.from(container.children).forEach(visit)
    // Also cover direct terminal destruction and non-head/body wrapper nodes.
    container.innerHTML = ''
  }

  private clearOptions (destroy: boolean): void {
    this.isPrerender = false
    this.preRenderEvents = null
    this.setKeepAliveState(null)
    if (this.container) {
      // 2026.9.12 by Claude Code: 仅终态销毁做深度清理；普通卸载/保活切换保持原行为
      if (destroy) runCleanupStep(this.name, 'clear instance dom', () => this.clearInstanceDOM())
      this.container.innerHTML = ''
      this.container = null
    } else if (!this.umdMode) {
      /**
       * this.container is null means sandBox.start has not exec, so sandBox.stop won't exec either
       * we should remove iframeElement in default mode manually
       */
      this.sandBox?.deleteIframeElement?.()
    }
    // in iframe sandbox & default mode, delete the sandbox & iframeElement
    /**
     * TODO:
     *  1. with沙箱与iframe沙箱保持一致：with沙箱默认模式下删除 或者 iframe沙箱umd模式下保留
     *  2. 接1.0，this.sandBox置空，还需要注意后续app.sandBox相关操作，比如 scripts.ts --> app.iframe ? app.sandBox!.microBody : app.querySelector('micro-app-body')，如果是fiber或者预加载，会存在卸载后js还在处理的情况
     */
    if (this.iframe && !this.umdMode && !destroy) {
      // Default iframe remount requires a fresh realm. Do not discard the only
      // sandbox handle before disposing its patches/native effects; also drop
      // Functions compiled in that realm while preserving reloadable metadata.
      if (isAppNameOwner(this)) {
        runCleanupStep(this.name, 'release discarded iframe functions', () => sourceCenter.releaseAppRealm(this.name))
      }
      runCleanupStep(this.name, 'dispose discarded iframe tasks', () => disposeAppTasks(this))
      // Dispose only the old realm; ordinary unmount still preserves app data.
      runCleanupStep(this.name, 'dispose discarded iframe', () => (this.sandBox as IframeSandbox | null)?.destroy(false))
      this.sandBox = null
    }
    if (destroy) this.actionsForCompletelyDestroy()
    removeDomScope()
  }

  // actions for completely destroy
  public actionsForCompletelyDestroy (): void {
    if (this.destroyed) return
    this.destroyed = true

    const sandBox = this.sandBox
    // Tasks belong to an app instance, not a reusable name. Always release old
    // instance tasks even when a same-name replacement is already registered.
    runCleanupStep(this.name, 'dispose instance tasks', () => disposeAppTasks(this))

    // 2026.9.12 by Claude Code
    // 下面这些清理全部按 appName 作用于**全局注册表**（源码中心、异步任务表、
    // scopedCSS observer、数据中心、iframe 节点表、Worker 表）。如果本次销毁的是
    // 已被同名新实例替换掉的旧实例，按 name 清理会连带抹掉新实例的状态，所以统一用
    // isAppNameOwner 守卫：只在"本实例仍拥有该名字"时清理，否则交给新实例销毁时处理。
    // 注意 sandbox 自身的清理不在此列 —— 它是实例级的，无论名字归谁都必须执行。
    if (isAppNameOwner(this)) {
      // Remove global owners first; appSpace may contain Functions from iframe realms.
      runCleanupStep(this.name, 'dispose named tasks', () => disposeAppTasks(this.name))
      runCleanupStep(this.name, 'release scoped CSS', () => releaseScopedCSSObservers(this.name))
      runCleanupStep(this.name, 'release source metadata', () => sourceCenter.releaseApp(this.name))
      runCleanupStep(this.name, 'dispose data center', () => disposeDataCenterForApp(this.name))

      // iframe 沙箱在默认模式 unmount 后就会被置空（见 clearOptions），所以两步销毁
      // （先 unmount 再 destroy）走到这里时 sandBox 已经是 null，下面的
      // sandBox?.destroy?.() 会空转 —— 而 releaseElementInfoTree 与 releaseWorkersByApp
      // 只挂在 IframeSandbox.destroy 里，于是都不会执行：
      //  1. adapter.ts 的 iframeAppNodeMap 是模块级 Map，会永久持有该应用整棵游离 DOM；
      //  2. workerInstanceMap 里的 Worker 永不 terminate。
      // 这里补一层不依赖 sandbox 实例的兜底。两个函数都是幂等的，且
      // releaseElementInfoTree 在 trackedNodes 缺失且 container 为 null 时是空操作。
      if (this.iframe) {
        runCleanupStep(this.name, 'release iframe nodes', () => releaseElementInfoTree(null, this.name))
        runCleanupStep(this.name, 'release iframe workers', () => releaseWorkersByApp(this.name))
      }
    }

    runCleanupStep(this.name, 'clear execution pointer', () => clearActiveProxyWindow(sandBox?.proxyWindow))
    runCleanupStep(this.name, 'destroy sandbox', () => sandBox?.destroy?.())
    runCleanupStep(this.name, 'restore owned intrinsic patches', () => releaseRawGlobalObjectPatches(this))

    this.umdHookMount = null
    this.umdHookUnmount = null
    this.preRenderEvents = null
    this.source.html = null
    this.source.links.clear()
    this.source.scripts.clear()
    // 2026.9.12 by Claude Code
    // 直达终态销毁的路径（如 micro_app.ts 中 isUnmounted()/isPrefetch 且 destroy 的分支）
    // 不会经过 clearOptions，此时 container 可能仍然存在 —— 补一次深度清理。
    // 走正常 unmount→destroy 路径时 clearOptions 已清过，这里是幂等的空查询。
    runCleanupStep(this.name, 'clear instance dom', () => this.clearInstanceDOM())
    this.container = null
    this.sandBox = null

    // Do not delete a newer instance that reused the same app name.
    if (appInstanceMap.get(this.name) === this) {
      appInstanceMap.delete(this.name)
    }
  }

  // hidden app when disconnectedCallback called with keep-alive
  public hiddenKeepAliveApp (callback?: CallableFunction): void {
    this.setKeepAliveState(keepAliveStates.KEEP_ALIVE_HIDDEN)
    /**
     * afterhidden事件需要提前发送，原因如下：
     *  1. 此时发送this.container还指向micro-app元素，而不是临时div元素
     *  2. 沙箱执行recordAndReleaseEffect后会将appstate-change方法也清空，之后再发送子应用也接受不到了
     *  3. 对于this.loadSourceLevel !== 2的情况，unmount是同步执行的，所以也会出现2的问题
     * TODO: 有可能导致的问题
     *  1. 在基座接受到afterhidden方法后立即执行unmount，彻底destroy应用时，因为unmount时同步执行，所以this.container为null后才执行cloneContainer
     */
    dispatchCustomEventToMicroApp(this, 'appstate-change', {
      appState: 'afterhidden',
    })

    // dispatch afterHidden event to base app
    dispatchLifecyclesEvent(
      this.container,
      this.name,
      lifeCycles.AFTERHIDDEN,
    )

    if (isRouterModeSearch(this.name)) {
      // called after lifeCyclesEvent
      this.sandBox?.removeRouteInfoForKeepAliveApp()
    }

    /**
     * Hidden app before the resources are loaded, then unmount the app
     */
    if (this.loadSourceLevel !== 2) {
      getRootContainer(this.container!).unmount()
    } else {
      this.container = this.cloneContainer(
        pureCreateElement('div'),
        this.container,
        false,
      )

      this.sandBox?.recordAndReleaseEffect({ keepAlive: true })
    }

    callback?.()
  }

  // show app when connectedCallback called with keep-alive
  public showKeepAliveApp (container: HTMLElement | ShadowRoot): void {
    /**
     * NOTE:
     *  1. this.container must set to container(micro-app element) before exec rebuildEffectSnapshot
     *    ISSUE: https://github.com/jd-opensource/micro-app/issues/1115
     *  2. rebuildEffectSnapshot must exec before dispatch beforeshow event
     */
    const oldContainer = this.container
    this.container = container
    this.sandBox?.rebuildEffectSnapshot()

    // dispatch beforeShow event to micro-app
    dispatchCustomEventToMicroApp(this, 'appstate-change', {
      appState: 'beforeshow',
    })

    // dispatch beforeShow event to base app
    dispatchLifecyclesEvent(
      container,
      this.name,
      lifeCycles.BEFORESHOW,
    )

    this.setKeepAliveState(keepAliveStates.KEEP_ALIVE_SHOW)

    this.cloneContainer(
      this.container,
      oldContainer,
      false,
    )

    /**
     * TODO:
     *  问题：当路由模式为custom时，keep-alive应用在重新展示，是否需要根据子应用location信息更新浏览器地址？
     *  暂时不这么做，因为无法确定二次展示时新旧地址是否相同，是否带有特殊信息
     */
    if (isRouterModeSearch(this.name)) {
      // called before lifeCyclesEvent
      this.sandBox?.setRouteInfoForKeepAliveApp()
    }

    // dispatch afterShow event to micro-app
    dispatchCustomEventToMicroApp(this, 'appstate-change', {
      appState: 'aftershow',
    })

    // dispatch afterShow event to base app
    dispatchLifecyclesEvent(
      this.container,
      this.name,
      lifeCycles.AFTERSHOW,
    )
  }

  /**
   * app rendering error
   * @param e Error
   */
  public onerror (e: Error): void {
    // dispatch state event to micro app
    dispatchCustomEventToMicroApp(this, 'statechange', {
      appState: appStates.LOAD_FAILED
    })

    dispatchLifecyclesEvent(
      this.container,
      this.name,
      lifeCycles.ERROR,
      e,
    )
  }

  /**
   * Parse htmlString to DOM
   * NOTE: iframe sandbox will use DOMParser of iframeWindow, with sandbox will use DOMParser of base app
   * @param htmlString DOMString
   * @returns parsed DOM
   */
  public parseHtmlString (htmlString: string): HTMLElement {
    const DOMParser = this.sandBox?.proxyWindow
      ? this.sandBox.proxyWindow.DOMParser
      : globalEnv.rawWindow.DOMParser
    return (new DOMParser()).parseFromString(htmlString, 'text/html').body
  }

  /**
   * clone origin elements to target
   * @param target Accept cloned elements
   * @param origin Cloned element
   * @param deep deep clone or transfer dom
   */
  private cloneContainer <T extends HTMLElement | ShadowRoot | null> (
    target: T,
    origin: T,
    deep: boolean,
  ): T {
    // 在基座接受到afterhidden方法后立即执行unmount，彻底destroy应用时，因为unmount时同步执行，所以this.container为null后才执行cloneContainer
    if (origin && target) {
      target.innerHTML = ''
      Array.from(deep ? this.parseHtmlString(origin.innerHTML).childNodes : origin.childNodes).forEach((node) => {
        target.appendChild(node)
      })
    }
    return target
  }

  /**
   * Scene:
   *  1. create app
   *  2. remount of default mode with iframe sandbox
   *    In default mode with iframe sandbox, unmount app will delete iframeElement & sandBox, and create sandBox when mount again, used to solve the problem that module script cannot be execute when append it again
   */
  private createSandbox (): void {
    if (this.useSandbox && !this.sandBox) {
      const iframeOption = {
        attrs: this.attrs,
        container: this.container
      }
      this.sandBox = this.iframe ? new IframeSandbox(this.name, this.url, iframeOption) : new WithSandBox(this.name, this.url)
    }
  }

  // set app state
  public setAppState (state: string): void {
    this.state = state

    // set window.__MICRO_APP_STATE__
    this.sandBox?.setStaticAppState(state)
  }

  // get app state
  public getAppState (): string {
    return this.state
  }

  // set keep-alive state
  private setKeepAliveState (state: string | null): void {
    this.keepAliveState = state
  }

  // get keep-alive state
  public getKeepAliveState (): string | null {
    return this.keepAliveState
  }

  // is app unmounted
  public isUnmounted (): boolean {
    return appStates.UNMOUNT === this.state
  }

  public isDestroyed (): boolean {
    return this.destroyed
  }

  // is app already hidden
  public isHidden (): boolean {
    return keepAliveStates.KEEP_ALIVE_HIDDEN === this.keepAliveState
  }

  private getMicroAppGlobalHook (eventName: string): Func | null {
    const listener = (this.sandBox?.proxyWindow as Record<string, any>)?.[eventName]
    return isFunction(listener) ? listener : null
  }

  public querySelector (selectors: string): Node | null {
    return this.container ? globalEnv.rawElementQuerySelector.call(this.container, selectors) : null
  }

  public querySelectorAll (selectors: string): NodeListOf<Node> {
    return this.container ? globalEnv.rawElementQuerySelectorAll.call(this.container, selectors) : []
  }

  /**
   * NOTE:
   * 1. If the iframe sandbox no longer enforces the use of inline mode in the future, the way getElementsByTagName retrieves the script from the iframe by default needs to be changed, because in non inline mode, the script in the iframe may be empty
   * @param inline inline mode config
   */
  private getInlineModeState (inline?: boolean): boolean {
    return (this.iframe || inline) ?? false
  }
}

// iframe route mode
export function isIframeSandbox (appName: string): boolean {
  return appInstanceMap.get(appName)?.iframe ?? false
}
