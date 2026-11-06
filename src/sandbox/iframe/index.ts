import type {
  Func,
  microAppWindowType,
  MicroLocation,
  SandBoxStartParams,
  CommonEffectHook,
  SandBoxStopParams,
  releaseGlobalEffectParams,
  plugins,
} from '@micro-app/types'
import globalEnv, { clearActiveProxyWindow, releaseRawGlobalObjectSnapshots } from '../../libs/global_env'
import { runCleanupStep } from '../../libs/cleanup'
import microApp from '../../micro_app'
import {
  getEffectivePath,
  removeDomScope,
  pureCreateElement,
  assign,
  clearDOM,
  isPlainObject,
  isArray,
  defer,
  createURL,
  rawDefineProperties,
  isFunction,
  logError,
} from '../../libs/utils'
import {
  EventCenterForMicroApp,
  rebuildDataCenterSnapshot,
  recordDataCenterSnapshot,
  resetDataCenterSnapshot,
} from '../../interact'
import {
  patchRouter,
} from './router'
import {
  router,
  initRouteStateWithURL,
  clearRouteStateFromURL,
  addHistoryListener,
  removePathFromBrowser,
  updateBrowserURLWithLocation,
  patchHistory,
  releasePatchHistory,
  isRouterModeCustom,
} from '../router'
import {
  patchElementAndDocument,
  releasePatchElementAndDocument,
} from '../../source/patch'
import {
  patchWindow,
} from './window'
import {
  patchDocument,
} from './document'
import {
  patchElement,
} from './element'
import { createIframePropertyRestore } from './restore'
import { uniqueDocumentElement } from './special_key'
import {
  patchElementTree,
  releaseElementInfoTree,
} from '../adapter'
import { releaseWorkersByApp } from '../../proxies/worker'
import {
  activateEventTargetEffect,
  disposeEventTargetEffect,
  rebuildEventTargetSnapshot,
  recordEventTargetSnapshot,
  releaseEventTargetListeners,
  resetEventTargetSnapshot,
} from '../event_target'

interface IOption {
  container: HTMLElement | ShadowRoot | null,
  [key: string]: any
}

/**
 * Break framework development-runtime roots before the iframe realm is removed.
 * Vue's HMR runtime captures its proxy WeakMaps in method closures, so leaving
 * the runtime on Window can retain the complete component tree even after the
 * Vue application and the micro-app instance have both been destroyed.
 */
export function clearIframeFrameworkGlobals (microAppWindow: microAppWindowType): void {
  const collectionKeys = [
    '__VUE_INSTANCE_SETTERS__',
    '__VUE_SSR_SETTERS__',
    '__VUE_DEVTOOLS_PLUGINS__',
    'devtoolsFormatters',
  ]
  collectionKeys.forEach((key) => {
    const value = Reflect.get(microAppWindow, key)
    if (isArray(value)) value.splice(0)
    Reflect.set(microAppWindow, key, null)
    Reflect.deleteProperty(microAppWindow, key)
  })

  const objectKeys = [
    '__VUE_HMR_RUNTIME__',
    '__VUE_DEVTOOLS_HOOK_REPLAY__',
    '__vueuse_ssr_handlers__',
  ]
  objectKeys.forEach((key) => {
    Reflect.set(microAppWindow, key, null)
    Reflect.deleteProperty(microAppWindow, key)
  })
}

export default class IframeSandbox {
  static activeCount = 0 // number of active sandbox
  private active = false
  private destroyed = false
  private windowEffect!: CommonEffectHook
  private documentEffect!: CommonEffectHook
  private removeHistoryListener!: CallableFunction
  // Properties that can be escape to rawWindow
  public escapeProperties: PropertyKey[] = []
  public deleteIframeElement: (destroy?: boolean) => void
  public iframe!: HTMLIFrameElement | null
  // Promise used to mark whether the sandbox is initialized
  public sandboxReady!: Promise<void>
  public proxyWindow: WindowProxy & microAppWindowType
  public microAppWindow: microAppWindowType
  public proxyLocation!: MicroLocation
  public baseElement!: HTMLBaseElement
  public microHead!: HTMLHeadElement
  public microBody!: HTMLBodyElement
  // Keep the native creator from this iframe realm. Internal module scripts
  // must be created by the iframe document even when disableIframeRootDocument
  // deliberately redirects child application DOM creation to the base document.
  private rawMicroCreateElement!: Document['createElement']
  // TODO: 放到 super中定义，super(appName, url)，with沙箱也需要简化
  public appName: string
  public url: string
  public options: IOption
  // reset mount, unmount when stop in default mode
  public clearHijackUmdHooks!: () => void
  private restoreIframePatches!: () => void

  constructor (appName: string, url: string, options: IOption) {
    this.appName = appName
    this.url = url
    this.options = options
    const rawLocation = globalEnv.rawWindow.location
    const browserHost = rawLocation.protocol + '//' + rawLocation.host

    this.deleteIframeElement = this.createIframeElement(appName, browserHost + rawLocation.pathname, options)
    this.microAppWindow = this.iframe!.contentWindow

    this.patchIframe(this.microAppWindow, (resolve: CallableFunction) => {
      // refresh
      this.microAppWindow = this.iframe!.contentWindow
      // create new html to iframe
      this.createIframeTemplate(this.microAppWindow)
      this.rawMicroCreateElement = this.microAppWindow.Document.prototype.createElement
      // get escapeProperties from plugins
      this.getSpecialProperties(appName)
      // patch location & history of child app
      this.proxyLocation = patchRouter(appName, url, this.microAppWindow, browserHost)
      // patch window of child app
      this.windowEffect = patchWindow(appName, this.microAppWindow, this)
      this.restoreIframePatches = createIframePropertyRestore([
        { target: this.microAppWindow.Document.prototype },
        { target: this.microAppWindow.document, keys: uniqueDocumentElement },
        { target: this.microAppWindow.Node.prototype },
        { target: this.microAppWindow.Element.prototype },
        { target: this.microAppWindow.DocumentFragment.prototype },
        { target: this.microAppWindow.HTMLImageElement.prototype, keys: ['src'] },
        { target: this.microAppWindow.HTMLScriptElement.prototype, keys: ['src'] },
        { target: this.microAppWindow.HTMLLinkElement.prototype, keys: ['href'] },
        { target: this.microAppWindow.SVGImageElement.prototype, keys: ['href'] },
        {
          target: this.microAppWindow,
          keys: [
            'Image',
            'WebSocket',
            'setInterval',
            'setTimeout',
            'clearInterval',
            'clearTimeout',
          ],
        },
      ])
      // patch document of child app
      this.documentEffect = patchDocument(appName, this.microAppWindow)
      // patch Node & Element of child app
      patchElement(appName, url, this.microAppWindow)
      /**
       * create static properties
       * NOTE:
       *  1. execute as early as possible
       *  2. run after patchRouter & createProxyWindow
       */
      this.initStaticGlobalKeys(appName, url, this.microAppWindow)
      resolve()
    })
  }

  public createSandboxScriptElement (): HTMLScriptElement {
    const script = this.rawMicroCreateElement.call(this.microAppWindow.document, 'script') as HTMLScriptElement
    // patchIframeNode uses this marker to keep framework-owned script/base
    // elements inside the iframe instead of projecting application DOM into
    // the base document's micro-app container.
    script.__PURE_ELEMENT__ = true
    return script
  }

  /**
   * create iframe for sandbox
   * @param appName app name
   * @param browserPath browser origin
   * @returns release callback
   */
  createIframeElement (
    appName: string,
    browserPath: string,
    options?: Record<string, any>
  ): () => void {
    this.iframe = pureCreateElement('iframe')

    const iframeAttrs: Record<string, string> = {
      ...options?.attrs,
      id: appName,
      src: microApp.options.iframeSrc || browserPath,
      style: 'display: none',
      'powered-by': 'micro-app',
    }

    Object.keys(iframeAttrs).forEach((key) => this.iframe!.setAttribute(key, iframeAttrs[key]))

    // effect action during construct
    globalEnv.rawDocument.body.appendChild(this.iframe)

    /**
     * If dom operated async when unmount, premature deletion of iframe will cause unexpected problems
     * e.g.
     *  1. antd: notification.destroy()
     * WARNING:
     *  If async operation time is too long, defer cannot avoid the problem
     * TODO: more test
     */
    return (destroy = false) => {
      const iframe = this.iframe

      if (destroy && iframe) {
        let removed = false
        const removeIframe = () => {
          if (removed) return
          removed = true
          iframe.removeEventListener('load', removeIframe)
          iframe.parentNode?.removeChild(iframe)
          if (this.iframe === iframe) this.iframe = null
        }

        // Committing a same-origin empty document retires Blink's old
        // ScriptState/NativeContext before the iframe element is detached.
        // Direct removal can leave the old realm on C++ persistent roots.
        iframe.addEventListener('load', removeIframe, { once: true })
        iframe.setAttribute('src', 'about:blank')
        globalEnv.rawWindow.setTimeout(removeIframe, 100)
        return
      }

      defer(() => {
        // default mode or destroy, iframe will be deleted when unmount
        iframe?.parentNode?.removeChild(iframe)
        if (this.iframe === iframe) this.iframe = null
      })
    }
  }

  public start ({
    baseroute,
    defaultPage,
    disablePatchRequest,
  }: SandBoxStartParams): void {
    if (this.active || this.destroyed) return
    activateEventTargetEffect(this.microAppWindow.__MICRO_APP_NAME__)
    this.active = true
    /* --- memory router part --- start */
    /**
     * Sync router info to iframe when exec sandbox.start with disable or enable memory-router
     * e.g.:
     *  vue-router@4.x get target path by remove the base section from rawLocation.pathname
     *  code: window.location.pathname.slice(base.length) || '/'; (base is baseroute)
     * NOTE:
     *  1. iframe router and browser router are separated, we should update iframe router manually
     *  2. withSandbox location is browser location when disable memory-router, so no need to do anything
     */
    this.initRouteState(defaultPage)

    // unique listener of popstate event for child app
    this.removeHistoryListener = addHistoryListener(
      this.microAppWindow.__MICRO_APP_NAME__,
    )

    if (isRouterModeCustom(this.microAppWindow.__MICRO_APP_NAME__)) {
      this.microAppWindow.__MICRO_APP_BASE_ROUTE__ = this.microAppWindow.__MICRO_APP_BASE_URL__ = baseroute
    }
    /* --- memory router part --- end */

    /**
     * create base element to iframe
     * WARNING: This will also affect a, image, link and script
     */
    if (!disablePatchRequest) {
      this.createIframeBase()
    }

    if (++globalEnv.activeSandbox === 1) {
      patchElementAndDocument()
      patchHistory()
    }

    if (++IframeSandbox.activeCount === 1) {
      // TODO: 多层嵌套兼容
    }
  }

  public stop ({
    umdMode,
    keepRouteState,
    destroy,
    clearData,
  }: SandBoxStopParams): void {
    // sandbox.stop may exec before sandbox.start, e.g: iframe sandbox + default mode + remount
    if (!this.active) return

    /**
     * NOTE(已修复行为差异) 2026.9.12 review
     *
     * 这里只传了 { clearData }，丢掉了 umdMode / destroy；而 releaseGlobalEffect 的
     * 开关是 (!keepAlive && !isPrerender) || destroy，**不含 umdMode**。结果是
     * iframe + umd 应用 unmount 时会清掉 interval/timeout、close 所有 WebSocket、
     * 断开 observer —— 而 with 沙箱不会（with/index.ts 用
     * (!umdMode && !keepAlive && !isPrerender) || destroy）。
     *
     * Review 裁定：该差异不是可忽略的“有意行为”，它会破坏 UMD 再挂载。
     * 现已传递 umdMode/destroy，并让 releaseGlobalEffect 与 with 沙箱保持一致。
     * 原实现的两个副作用（现已消除）：
     *  1. ./window.ts 顶部“四模式”注释写着 `umd-mode(normal): not clear timers`，
     *     与现状矛盾 —— 那句注释是错的；
     *  2. remount 走 rebuildEffectSnapshot() 只重建**事件**、不重建 timer，且 umd
     *     子应用 JS 不会重跑，因此子应用的轮询/长连接在 unmount 后无法恢复。
     *     若将来要支持恢复，需要让 rebuild 也重建 timer（或改为 umd 不清 timer）。
     */
    // Review correction: UMD remount does not rerun bundle initialization, so
    // timers/observers/sockets must survive ordinary unmount and die on destroy.
    this.recordAndReleaseEffect({ clearData, umdMode, destroy }, !umdMode || destroy)

    /* --- memory router part --- start */
    // if keep-route-state is true, preserve microLocation state
    this.clearRouteState(keepRouteState)

    // release listener of popstate for child app
    this.removeHistoryListener?.()
    /* --- memory router part --- end */

    if (!umdMode || destroy) {
      clearActiveProxyWindow(this.proxyWindow)
      this.deleteIframeElement(destroy)
      this.clearHijackUmdHooks()
      releaseWorkersByApp(this.microAppWindow.__MICRO_APP_NAME__)
    }

    if (--globalEnv.activeSandbox === 0) {
      releaseRawGlobalObjectSnapshots()
      releasePatchElementAndDocument()
      releasePatchHistory()
    }

    if (--IframeSandbox.activeCount === 0) {
      // TODO: Is there anything to do?
    }

    this.active = false
  }

  /**
   * Terminal cleanup for iframe realms. Capture and schedule iframe removal,
   * then sever every framework-owned Window/Document reference synchronously.
   */
  public destroy (clearData = true): void {
    if (this.destroyed) return
    this.destroyed = true

    // 2026.9.12 by Claude Code
    // patchIframe 是异步的：windowEffect / documentEffect / restoreIframePatches
    // 只在 iframe 提交后的回调里赋值。若在提交前销毁（同 tick 挂载又卸载、
    // LOAD_FAILED、对未完成 mount 的应用执行 destroy），它们仍是 undefined，
    // 直接 `this.windowEffect.dispose?.()` 会抛 TypeError —— 注意 `?.` 只保护了
    // dispose，没有保护 windowEffect 本身。
    // 这个异常会从 CreateApp.actionsForCompletelyDestroy 冒泡出去，使紧随其后的
    // container / sandBox 置空与 appInstanceMap.delete 全部跳过，app 记录永久残留，
    // 正是本次要消灭的那类泄漏。
    // Review correction: 两段 try 仍会跳过同段后续操作；现每项清理独立捕获。
    try {
      if (this.active) {
        this.stop({
          umdMode: false,
          keepRouteState: false,
          destroy: true,
          clearData,
        })
      } else {
        this.releaseGlobalEffect({ clearData, destroy: true })
        this.deleteIframeElement(true)
      }
    } catch (e) {
      logError('An error occurred when release iframe sandbox \n', this.appName, e)
    }

    try {
      // Review correction: each resource gets its own error boundary. A broken
      // prototype restore must not skip Worker/event/native-effect disposal.
      const cleanup = (label: string, action: () => void) => runCleanupStep(this.appName, label, action)
      cleanup('release iframe nodes', () => releaseElementInfoTree(this.options?.container ?? null, this.appName))
      cleanup('clear execution pointer', () => clearActiveProxyWindow(this.proxyWindow))
      cleanup('clear UMD hooks', () => this.clearHijackUmdHooks?.())
      cleanup('restore iframe patches', () => this.restoreIframePatches?.())
      cleanup('reset effect snapshots', () => this.resetEffectSnapshot())

      // 2026.9.12 by Claude Code
      // WithSandBox.destroy 对 keep-alive / umd 应用补了同样的兜底，iframe 之前漏了：
      // 应用若先 stop({ umdMode: true, destroy: false }) 再终态销毁，走的是非活跃
      // 分支，而 stop() 内的 releaseWorkersByApp 被 `!umdMode || destroy` 挡住，
      // 结果 workerInstanceMap 里的 Worker、blob URL 与 onmessage 闭包永不释放。
      // releaseWorkersByApp 幂等，可安全重复调用。
      cleanup('release workers', () => releaseWorkersByApp(this.appName))

      if (this.microAppWindow) {
        cleanup('dispose EventTarget effects', () => disposeEventTargetEffect(this.appName))
        cleanup('clear iframe framework globals', () => clearIframeFrameworkGlobals(this.microAppWindow))
        ;[
          '__MICRO_APP_WINDOW__',
          '__MICRO_APP_PROXY_WINDOW__',
          '__MICRO_APP_SANDBOX__',
          'microApp',
          'rawWindow',
          'rawDocument',
        ].forEach((key) => cleanup(`clear ${key}`, () => { Reflect.deleteProperty(this.microAppWindow, key) }))
      }

      // 2026.9.12 by Claude Code
      // 两个 dispose 放在本段最后：它们还原被补丁的原型，是最可能
      // 与"半初始化 realm"交互失败的一步；放最后可保证即使它们失败，前面的清理
      // （节点表释放、Worker 释放、framework 全局清理）都已经完成。
      // 注意 `?.` 必须同时保护对象本身：windowEffect / documentEffect 只在
      // patchIframe 的回调里赋值，在 iframe 提交前销毁时仍是 undefined，
      // 写成 `this.windowEffect.dispose?.()` 会抛 TypeError。
      cleanup('dispose window effects', () => this.windowEffect?.dispose?.())
      cleanup('dispose document effects', () => this.documentEffect?.dispose?.())
    } catch (e) {
      logError('An error occurred when destroy iframe sandbox \n', this.appName, e)
    } finally {
      // 无论上面哪一步失败，都要断开本实例对 realm 的引用，
      // 否则 sandbox 对象会把已死亡的 iframe Window 一直拖住。
      if (this.options) this.options.container = null
      ;(this as any).windowEffect = null
      ;(this as any).documentEffect = null
      ;(this as any).removeHistoryListener = null
      ;(this as any).sandboxReady = null
      ;(this as any).clearHijackUmdHooks = null
      ;(this as any).restoreIframePatches = null
      ;(this as any).rawMicroCreateElement = null
      ;(this as any).proxyLocation = null
      ;(this as any).baseElement = null
      ;(this as any).microHead = null
      ;(this as any).microBody = null
      ;(this as any).proxyWindow = null
      ;(this as any).microAppWindow = null
      ;(this as any).options = null
    }
  }

  /**
   * create static properties
   * NOTE:
   *  1. execute as early as possible
   *  2. run after patchRouter & createProxyWindow
   * TODO: 设置为只读变量
   */
  private initStaticGlobalKeys (
    appName: string,
    url: string,
    microAppWindow: microAppWindowType,
  ): void {
    microAppWindow.__MICRO_APP_ENVIRONMENT__ = true
    microAppWindow.__MICRO_APP_NAME__ = appName
    microAppWindow.__MICRO_APP_URL__ = url
    microAppWindow.__MICRO_APP_PUBLIC_PATH__ = getEffectivePath(url)
    microAppWindow.__MICRO_APP_BASE_ROUTE__ = ''
    microAppWindow.__MICRO_APP_WINDOW__ = microAppWindow
    microAppWindow.__MICRO_APP_PRE_RENDER__ = false
    microAppWindow.__MICRO_APP_UMD_MODE__ = false
    microAppWindow.__MICRO_APP_PROXY_WINDOW__ = this.proxyWindow
    microAppWindow.__MICRO_APP_SANDBOX__ = this
    microAppWindow.__MICRO_APP_SANDBOX_TYPE__ = 'iframe'
    microAppWindow.rawWindow = globalEnv.rawWindow
    microAppWindow.rawDocument = globalEnv.rawDocument
    microAppWindow.microApp = assign(new EventCenterForMicroApp(appName), {
      removeDomScope,
      pureCreateElement,
      location: this.proxyLocation,
      router,
    })
  }

  /**
   * Record global effect and then release (effect: global event, timeout, data listener)
   * Scenes:
   * 1. unmount of default/umd app
   * 2. hidden keep-alive app
   * 3. after init prerender app
   * @param options {
   *  @param clearData clear data from base app
   *  @param isPrerender is prerender app
   *  @param keepAlive is keep-alive app
   * }
   * @param preventRecord prevent record effect events (default or destroy)
   */
  public recordAndReleaseEffect (
    options: releaseGlobalEffectParams,
    preventRecord = false,
  ): void {
    if (preventRecord) {
      this.resetEffectSnapshot()
    } else {
      this.recordEffectSnapshot()
      if (options.keepAlive || options.isPrerender) {
        resetEventTargetSnapshot(this.microAppWindow.__MICRO_APP_NAME__)
      }
    }
    this.releaseGlobalEffect(options)
  }

  /**
   * reset effect snapshot data in default mode or destroy
   * Scenes:
   *  1. unmount hidden keep-alive app manually
   *  2. unmount prerender app manually
   */
  public resetEffectSnapshot (): void {
    this.windowEffect?.reset()
    this.documentEffect?.reset()
    resetEventTargetSnapshot(this.appName)
    resetDataCenterSnapshot(this.microAppWindow?.microApp)
  }

  /**
   * record umd snapshot before the first execution of umdHookMount
   * Scenes:
   * 1. exec umdMountHook in umd mode
   * 2. hidden keep-alive app
   * 3. after init prerender app
   */
  public recordEffectSnapshot (): void {
    this.windowEffect?.record()
    this.documentEffect?.record()
    recordEventTargetSnapshot(this.microAppWindow.__MICRO_APP_NAME__)
    recordDataCenterSnapshot(this.microAppWindow.microApp)
  }

  // rebuild umd snapshot before remount umd app
  public rebuildEffectSnapshot (): void {
    this.windowEffect?.rebuild()
    this.documentEffect?.rebuild()
    rebuildEventTargetSnapshot(this.microAppWindow.__MICRO_APP_NAME__)
    rebuildDataCenterSnapshot(this.microAppWindow.microApp)
  }

  /**
   * clear global event, timeout, data listener
   * Scenes:
   * 1. unmount of normal/umd app
   * 2. hidden keep-alive app
   * 3. after init prerender app
   * @param clearData clear data from base app
   * @param isPrerender is prerender app
   * @param keepAlive is keep-alive app
   */
  public releaseGlobalEffect ({
    umdMode = false,
    clearData = false,
    keepAlive = false,
    isPrerender = false,
    destroy = false,
  }: releaseGlobalEffectParams): void {
    this.windowEffect?.release((!umdMode && !keepAlive && !isPrerender) || destroy)
    this.documentEffect?.release()
    if ((!keepAlive && !isPrerender) || destroy) {
      releaseEventTargetListeners(this.microAppWindow.__MICRO_APP_NAME__)
    }
    this.microAppWindow.microApp?.clearDataListener()
    this.microAppWindow.microApp?.clearGlobalDataListener()
    if (clearData) {
      microApp.clearData(this.appName)
      this.microAppWindow.microApp?.clearData()
    }
  }

  // set __MICRO_APP_PRE_RENDER__ state
  public setPreRenderState (state: boolean): void {
    this.microAppWindow.__MICRO_APP_PRE_RENDER__ = state
  }

  // record umdMode
  public markUmdMode (state: boolean): void {
    this.microAppWindow.__MICRO_APP_UMD_MODE__ = state
  }

  // TODO: RESTRUCTURE
  private patchIframe (microAppWindow: microAppWindowType, cb: CallableFunction): void {
    const oldMicroDocument = microAppWindow.document
    this.sandboxReady = new Promise<void>((resolve) => {
      (function iframeLocationReady () {
        setTimeout(() => {
          try {
            /**
             * NOTE:
             *  1. In browser, iframe document will be recreated after iframe initial
             *  2. In jest, iframe document is always the same
             */
            if (microAppWindow.document === oldMicroDocument && !__TEST__) {
              iframeLocationReady()
            } else {
              /**
               * NOTE:
               *  1. microAppWindow will not be recreated
               *  2. the properties of microAppWindow may be recreated, such as document
               *  3. the variables added to microAppWindow may be cleared
               */
              microAppWindow.stop()
              cb(resolve)
            }
          } catch (e) {
            iframeLocationReady()
          }
        }, 0)
      })()
    })
  }

  // TODO: RESTRUCTURE
  private createIframeTemplate (microAppWindow: microAppWindowType): void {
    const microDocument = microAppWindow.document
    clearDOM(microDocument)
    const html = microDocument.createElement('html')
    html.innerHTML = '<head></head><body></body>'
    microDocument.appendChild(html)

    // 记录iframe原生body
    this.microBody = microDocument.body
    this.microHead = microDocument.head
  }

  /**
   * baseElement will complete the relative address of element according to the URL
   * e.g: a image link script fetch ajax EventSource
   */
  private createIframeBase (): void {
    this.baseElement = pureCreateElement('base')
    this.updateIframeBase()
    this.microHead.appendChild(this.baseElement)
  }

  // Update the base.href when initial and each redirect
  public updateIframeBase = (): void => {
    // origin must be child app origin
    this.baseElement?.setAttribute('href', createURL(this.url).origin + this.proxyLocation.pathname)
  }

  /**
   * get escapeProperties from plugins & adapter
   * @param appName app name
   */
  private getSpecialProperties (appName: string): void {
    if (isPlainObject(microApp.options.plugins)) {
      this.commonActionForSpecialProperties(microApp.options.plugins.global)
      this.commonActionForSpecialProperties(microApp.options.plugins.modules?.[appName])
    }
  }

  // common action for global plugins and module plugins
  private commonActionForSpecialProperties (plugins: plugins['global']) {
    if (isArray(plugins)) {
      for (const plugin of plugins) {
        if (isPlainObject(plugin)) {
          if (isArray(plugin.escapeProperties)) {
            this.escapeProperties = this.escapeProperties.concat(plugin.escapeProperties)
          }
        }
      }
    }
  }

  private initRouteState (defaultPage: string): void {
    initRouteStateWithURL(
      this.microAppWindow.__MICRO_APP_NAME__,
      this.microAppWindow.location as MicroLocation,
      defaultPage,
    )
  }

  private clearRouteState (keepRouteState: boolean): void {
    clearRouteStateFromURL(
      this.microAppWindow.__MICRO_APP_NAME__,
      this.microAppWindow.__MICRO_APP_URL__,
      this.microAppWindow.location as MicroLocation,
      keepRouteState,
    )
  }

  public setRouteInfoForKeepAliveApp (): void {
    updateBrowserURLWithLocation(
      this.microAppWindow.__MICRO_APP_NAME__,
      this.microAppWindow.location as MicroLocation,
    )
  }

  public removeRouteInfoForKeepAliveApp (): void {
    removePathFromBrowser(this.microAppWindow.__MICRO_APP_NAME__)
  }

  /**
   * Format all html elements when init
   * @param container micro app container
   */
  public patchStaticElement (container: Element | ShadowRoot): void {
    patchElementTree(container, this.microAppWindow.__MICRO_APP_NAME__)
  }

  /**
   * action before exec scripts when mount
   * Actions:
   * 1. patch static elements from html
   * 2. hijack umd hooks -- mount, unmount, micro-app-appName
   * @param container micro app container
   */
  public actionsBeforeExecScripts (container: Element | ShadowRoot, handleUmdHooks: Func): void {
    this.patchStaticElement(container)
    this.clearHijackUmdHooks = this.hijackUmdHooks(this.appName, this.microAppWindow, handleUmdHooks)
  }

  // hijack mount, unmount, micro-app-appName hook to microAppWindow
  private hijackUmdHooks (
    appName: string,
    microAppWindow: microAppWindowType,
    handleUmdHooks: Func,
  ): () => void {
    let mount: Func | null, unmount: Func | null, microAppLibrary: Record<string, unknown> | null
    const hookKeys = ['mount', 'unmount', `micro-app-${appName}`]
    const restoreHookDescriptors = createIframePropertyRestore([
      { target: microAppWindow, keys: hookKeys },
    ])
    let cleared = false
    rawDefineProperties(microAppWindow, {
      mount: {
        configurable: true,
        get: () => mount,
        set: (value) => {
          if (this.active && isFunction(value) && !mount) {
            handleUmdHooks(mount = value, unmount)
          }
        }
      },
      unmount: {
        configurable: true,
        get: () => unmount,
        set: (value) => {
          if (this.active && isFunction(value) && !unmount) {
            handleUmdHooks(mount, unmount = value)
          }
        }
      },
      [`micro-app-${appName}`]: {
        configurable: true,
        get: () => microAppLibrary,
        set: (value) => {
          if (this.active && isPlainObject(value) && !microAppLibrary) {
            microAppLibrary = value
            handleUmdHooks(microAppLibrary.mount, microAppLibrary.unmount)
          }
        }
      }
    })

    return () => {
      if (cleared) return
      cleared = true
      mount = unmount = microAppLibrary = null
      restoreHookDescriptors()
    }
  }

  public setStaticAppState (state: string): void {
    this.microAppWindow.__MICRO_APP_STATE__ = state
  }
}
