/* eslint-disable node/no-callback-literal, no-void */
import type {
  AppInterface,
  ScriptSourceInfo,
  plugins,
  Func,
  fiberTasks,
  AttrsType,
  microAppWindowType,
} from '@micro-app/types'
import { createAppTask } from '../libs/app_tasks'
import { fetchSource } from './fetch'
import {
  CompletionPath,
  promiseStream,
  createNonceSrc,
  pureCreateElement,
  defer,
  logError,
  isUndefined,
  isPlainObject,
  isArray,
  isFunction,
  getAttributes,
  injectFiberTask,
  serialExecFiberTasks,
  isInlineScript,
  isString,
} from '../libs/utils'
import {
  dispatchOnLoadEvent,
  dispatchOnErrorEvent,
} from './load_event'
import microApp from '../micro_app'
import globalEnv, {
  beginRawGlobalObjectTracking,
  finishRawGlobalObjectTracking,
  releaseSharedFunctionToStringPatch,
  releaseRawGlobalObjectPatches,
} from '../libs/global_env'
import { GLOBAL_CACHED_KEY } from '../constants'
import sourceCenter from './source_center'
// 2026.9.12 by Claude Code: 用于在"销毁后迟到的异步回调"里判断是否还能按 appName 清理
import { isAppNameOwner } from '../libs/app_registry'

export type moduleCallBack = Func & { moduleCount?: number, errorCount?: number }

const scriptTypes = ['text/javascript', 'text/ecmascript', 'application/javascript', 'application/ecmascript', 'module', 'systemjs-module', 'systemjs-importmap']

// whether use type='module' script
function isTypeModule (app: AppInterface, scriptInfo: ScriptSourceInfo): boolean {
  return scriptInfo.appSpace[app.name].module && (!app.useSandbox || app.iframe)
}

// special script element
function isSpecialScript (app: AppInterface, scriptInfo: ScriptSourceInfo): boolean {
  const attrs = scriptInfo.appSpace[app.name].attrs
  return attrs.has('id')
}

/**
 * whether to run js in inline mode
 * scene:
 * 1. inline config for app
 * 2. inline attr in script element
 * 3. module script
 * 4. script with special attr
 */
function isInlineMode (app: AppInterface, scriptInfo: ScriptSourceInfo): boolean {
  return (
    app.inline ||
    scriptInfo.appSpace[app.name].inline ||
    isTypeModule(app, scriptInfo) ||
    isSpecialScript(app, scriptInfo)
  )
}

// TODO: iframe重新插入window前后不一致，通过iframe Function创建的函数无法复用
function getEffectWindow (app: AppInterface): microAppWindowType {
  return app.iframe ? app.sandBox.microAppWindow : globalEnv.rawWindow
}

// Convert string code to function
function code2Function (app: AppInterface, code: string): Function {
  const targetWindow = getEffectWindow(app)
  return new targetWindow.Function(code)
}

/**
 * Create parsedFunction in the current app realm.
 * Functions must not be shared across application instances. Even when the
 * transformed source and base Window are identical, the compiled function's
 * feedback/closure templates participate in that instance's Vue and webpack
 * runtime graph. Cross-instance reuse can mix component lifecycle state.
 * @returns parsedFunction
 */
function getParsedFunction (
  app: AppInterface,
  parsedCode: string,
): Function {
  return code2Function(app, parsedCode)
}

// Prevent randomly created strings from repeating
function getUniqueNonceSrc (): string {
  const nonceStr: string = createNonceSrc()
  if (sourceCenter.script.hasInfo(nonceStr)) {
    return getUniqueNonceSrc()
  }
  return nonceStr
}

// transfer the attributes on the script to convertScript
function setConvertScriptAttr (convertScript: HTMLScriptElement, attrs: AttrsType): void {
  attrs.forEach((value, key) => {
    if ((key === 'type' && value === 'module') || key === 'defer' || key === 'async') return
    if (key === 'src') key = 'data-origin-src'
    globalEnv.rawSetAttribute.call(convertScript, key, value)
  })
}

// wrap code in sandbox
function isWrapInSandBox (app: AppInterface, scriptInfo: ScriptSourceInfo): boolean {
  return app.useSandbox && !isTypeModule(app, scriptInfo)
}

function getSandboxType (app: AppInterface, scriptInfo: ScriptSourceInfo): 'with' | 'iframe' | 'disable' {
  return isWrapInSandBox(app, scriptInfo) ? app.iframe ? 'iframe' : 'with' : 'disable'
}

/**
 * Extract script elements
 * @param script script element
 * @param parent parent element of script
 * @param app app
 * @param isDynamic dynamic insert
 */
export function extractScriptElement (
  script: HTMLScriptElement,
  parent: Node | null,
  app: AppInterface,
  isDynamic = false,
): any {
  let replaceComment: Comment | null = null
  let src: string | null = script.getAttribute('src')
  if (src) src = CompletionPath(src, app.url)
  if (script.hasAttribute('exclude') || checkExcludeUrl(src, app.name)) {
    replaceComment = document.createComment('script element with exclude attribute removed by micro-app')
  } else if (
    (
      script.type &&
      !scriptTypes.includes(script.type)
    ) ||
    script.hasAttribute('ignore') ||
    checkIgnoreUrl(src, app.name)
  ) {
    // 配置为忽略的脚本，清空 rawDocument.currentScript，避免被忽略的脚本内获取 currentScript 出错
    if (globalEnv.rawDocument?.currentScript) {
      delete globalEnv.rawDocument.currentScript
    }
    return null
  } else if (
    (globalEnv.supportModuleScript && script.noModule) ||
    (!globalEnv.supportModuleScript && script.type === 'module')
  ) {
    replaceComment = document.createComment(`${script.noModule ? 'noModule' : 'module'} script ignored by micro-app`)
  } else if (src) { // remote script
    let scriptInfo = sourceCenter.script.getInfo(src)
    const appSpaceData = {
      async: script.hasAttribute('async'),
      defer: script.defer || script.type === 'module',
      module: script.type === 'module',
      inline: script.hasAttribute('inline'),
      pure: script.hasAttribute('pure'),
      attrs: getAttributes(script),
    }
    if (!scriptInfo) {
      scriptInfo = {
        code: '',
        isExternal: true,
        appSpace: {
          [app.name]: appSpaceData,
        }
      }
    } else {
      /**
       * Reuse when appSpace exists
       * NOTE:
       * 1. The same static script, appSpace must be the same (in fact, it may be different when url change)
       * 2. The same dynamic script, appSpace may be the same, but we still reuse appSpace, which should pay attention
       */
      scriptInfo.appSpace[app.name] = scriptInfo.appSpace[app.name] || appSpaceData
    }

    sourceCenter.script.setInfo(src, scriptInfo)

    if (!isDynamic) {
      app.source.scripts.add(src)
      replaceComment = document.createComment(`script with src='${src}' extract by micro-app`)
    } else {
      return { address: src, scriptInfo }
    }
  } else if (script.textContent) { // inline script
    /**
     * NOTE:
     * 1. Each inline script is unique
     * 2. Every dynamic created inline script will be re-executed
     * ACTION:
     * 1. Delete dynamic inline script info after exec
     * 2. Delete static inline script info when destroy
     */
    const nonceStr: string = getUniqueNonceSrc()
    const scriptInfo = {
      code: script.textContent,
      isExternal: false,
      appSpace: {
        [app.name]: {
          async: false,
          defer: script.type === 'module',
          module: script.type === 'module',
          inline: script.hasAttribute('inline'),
          pure: script.hasAttribute('pure'),
          attrs: getAttributes(script),
        }
      }
    }
    if (!isDynamic) {
      app.source.scripts.add(nonceStr)
      sourceCenter.script.setInfo(nonceStr, scriptInfo)
      replaceComment = document.createComment('inline script extract by micro-app')
    } else {
      // Because each dynamic script is unique, it is not put into sourceCenter
      return { address: nonceStr, scriptInfo }
    }
  } else if (!isDynamic) {
    /**
     * script with empty src or empty script.textContent remove in static html
     * & not removed if it created by dynamic
     */
    replaceComment = document.createComment('script element removed by micro-app')
  }

  if (isDynamic) {
    return { replaceComment }
  } else {
    return parent?.replaceChild(replaceComment!, script)
  }
}

/**
 * get assets plugins
 * @param appName app name
 */
export function getAssetsPlugins (appName: string): plugins['global'] {
  const globalPlugins = microApp.options.plugins?.global || []
  const modulePlugins = microApp.options.plugins?.modules?.[appName] || []

  return [...globalPlugins, ...modulePlugins]
}

/**
 * whether the address needs to be excluded
 * @param address css or js link
 * @param plugins microApp plugins
 */
export function checkExcludeUrl (address: string | null, appName: string): boolean {
  if (!address) return false
  const plugins = getAssetsPlugins(appName) || []
  return plugins.some(plugin => {
    if (!plugin.excludeChecker) return false
    return plugin.excludeChecker(address)
  })
}

/**
 * whether the address needs to be ignore
 * @param address css or js link
 * @param plugins microApp plugins
 */
export function checkIgnoreUrl (address: string | null, appName: string): boolean {
  if (!address) return false
  const plugins = getAssetsPlugins(appName) || []
  return plugins.some(plugin => {
    if (!plugin.ignoreChecker) return false
    return plugin.ignoreChecker(address)
  })
}

/**
 *  Get remote resources of script
 * @param wrapElement htmlDom
 * @param app app
 */
export function fetchScriptsFromHtml (
  wrapElement: HTMLElement,
  app: AppInterface,
): void {
  const scriptList: Array<string> = Array.from(app.source.scripts)
  const fetchScriptPromise: Array<Promise<string> | string> = []
  const fetchScriptPromiseInfo: Array<[string, ScriptSourceInfo]> = []
  for (const address of scriptList) {
    const scriptInfo = sourceCenter.script.getInfo(address)!
    const appSpaceData = scriptInfo.appSpace[app.name]
    if ((!appSpaceData.defer && !appSpaceData.async) || (app.isPrefetch && !app.isPrerender)) {
      fetchScriptPromise.push(scriptInfo.code ? scriptInfo.code : fetchSource(address, app.name))
      fetchScriptPromiseInfo.push([address, scriptInfo])
    }
  }

  const fiberScriptTasks: fiberTasks = app.isPrefetch || app.fiber ? [] : null

  if (fetchScriptPromise.length) {
    promiseStream<string>(fetchScriptPromise, (res: {data: string, index: number}) => {
      injectFiberTask(fiberScriptTasks, () => fetchScriptSuccess(
        fetchScriptPromiseInfo[res.index][0],
        fetchScriptPromiseInfo[res.index][1],
        res.data,
        app,
      ))
    }, (err: {error: Error, index: number}) => {
      logError(err, app.name)
    }, () => {
      if (fiberScriptTasks) {
        fiberScriptTasks.push(() => Promise.resolve(app.onLoad({ html: wrapElement })))
        serialExecFiberTasks(fiberScriptTasks)
      } else {
        app.onLoad({ html: wrapElement })
      }
    })
  } else {
    app.onLoad({ html: wrapElement })
  }
}

/**
 * fetch js succeeded, record the code value
 * @param address script address
 * @param scriptInfo resource script info
 * @param data code
 */
export function fetchScriptSuccess (
  address: string,
  scriptInfo: ScriptSourceInfo,
  code: string,
  app: AppInterface,
): void {
  if (app.isDestroyed?.()) {
    // 2026.9.12 by Claude Code
    // 这是销毁之后才落地的取脚本回调，捕获的是旧实例。只有 appName 没被同名新实例
    // 接管时才能按 name 释放，否则会清掉新实例仍在使用的 appSpace。
    if (isAppNameOwner(app)) sourceCenter.releaseApp(app.name)
    return
  }
  // reset scriptInfo.code
  scriptInfo.code = code

  /**
   * Pre parse script for prefetch, improve rendering performance
   * NOTE:
   * 1. if global parseResult exist, skip this step
   * 2. if app is inline or script is esmodule, skip this step
   * 3. if global parseResult not exist, the current script occupies the position, when js is reused, parseResult is reference
   *
   * NOTE(注释已过期) 2026.9.12 by Claude Code
   * 上面第 1、3 条描述的是“跨 app 共享 parseResult”的旧机制：本轮改动已删除
   * getExistParseResult，现在只按当前 appSpace 判断，不存在全局 parseResult。
   * 另外 sourceCenter.releaseApp 在 appSpace 清空后会逐出整条 entry（已确认为有意），
   * 因此“prefetch 结果被同名真实应用复用”这条路径实际已不成立 ——
   * micro_app_element 的“先 destroy 再 create”会先把旧实例的 entry 清掉。
   * 保留原文仅为记录历史语义，不要据此推断当前行为。
   */
  if (app.isPrefetch && app.prefetchLevel === 2) {
    const appSpaceData = scriptInfo.appSpace[app.name]
    /**
     * When prefetch app is replaced by a new app in the processing phase, since the scriptInfo is common, when the scriptInfo of the prefetch app is processed, it may have already been processed.
     * This causes parsedCode to already exist when preloading ends
     * e.g.
     * 1. prefetch app.url different from <micro-app></micro-app>
     * 2. prefetch param different from <micro-app></micro-app>
     */
    if (!appSpaceData.parsedCode) {
      appSpaceData.parsedCode = bindScope(address, app, code, scriptInfo)
      appSpaceData.sandboxType = getSandboxType(app, scriptInfo)
      if (!isInlineMode(app, scriptInfo)) {
        try {
          appSpaceData.parsedFunction = getParsedFunction(app, appSpaceData.parsedCode)
        } catch (err) {
          logError('Something went wrong while handling preloaded resources', app.name, '\n', err)
        }
      }
    }
  }
}

/**
 * Execute js in the mount lifecycle
 * @param app app
 * @param initHook callback for umd mode
 */
export function execScripts (
  app: AppInterface,
  initHook: moduleCallBack,
): void {
  executeScriptTask(createScriptTask(app, initHook))
}

function createScriptTask (app: AppInterface, initHook: moduleCallBack) {
  return createAppTask(app, {
    app,
    initHook,
    fiberScriptTasks: (app.fiber ? [] : null) as fiberTasks,
    deferScriptPromise: [] as Array<Promise<string>|string>,
    deferScriptInfo: [] as Array<[string, ScriptSourceInfo]>,
  }, (payload) => {
    // ErrorStackData may retain a local `current` snapshot even after the
    // holder is cleared. Sever this framework-owned payload itself as well.
    payload.app = null as unknown as AppInterface
    payload.initHook = null as unknown as moduleCallBack
    payload.fiberScriptTasks = null
    payload.deferScriptPromise = []
    payload.deferScriptInfo = []
  })
}

// No app/initHook parameters in this callback-owning scope. Retained current
// snapshots point to the explicitly cleared state, not an immutable app slot.
function executeScriptTask (task: ReturnType<typeof createScriptTask>): void {
  const scriptList = Array.from(task.current!.app.source.scripts)
  const invokeInitHook = (isFinished: boolean): void => {
    const current = task.current
    if (!current) return
    try {
      current.initHook(isFinished)
    } finally {
      if (isFinished) task.complete()
    }
  }
  // Module script elements can keep their onload handler indefinitely. Give
  // them a task-backed callback rather than the CreateApp-capturing initHook.
  const moduleInitHook = ((isFinished: boolean) => invokeInitHook(isFinished)) as moduleCallBack
  ;(['moduleCount', 'errorCount'] as const).forEach((key) => {
    Object.defineProperty(moduleInitHook, key, {
      configurable: true,
      get: () => task.current?.initHook?.[key],
      set: (value: number | undefined) => {
        const current = task.current
        if (current) current.initHook[key] = value
      },
    })
  })
  for (const address of scriptList) {
    const context = task.current
    if (!context) break
    const scriptInfo = sourceCenter.script.getInfo(address)!
    const appSpaceData = scriptInfo.appSpace[context.app.name]
    // Notice the second render
    if (appSpaceData.defer || appSpaceData.async) {
      // TODO: defer和module彻底分开，不要混在一起
      if (scriptInfo.isExternal && !scriptInfo.code && !isTypeModule(context.app, scriptInfo)) {
        context.deferScriptPromise.push(fetchSource(address, context.app.name))
      } else {
        context.deferScriptPromise.push(scriptInfo.code)
      }
      context.deferScriptInfo.push([address, scriptInfo])

      isTypeModule(context.app, scriptInfo) && (context.initHook.moduleCount = context.initHook.moduleCount ? ++context.initHook.moduleCount : 1)
    } else {
      injectFiberTask(context.fiberScriptTasks, () => {
        const current = task.current
        const currentScriptInfo = sourceCenter.script.getInfo(address)
        if (!current || !currentScriptInfo) return
        runScript(address, current.app, currentScriptInfo)
        invokeInitHook(false)
      })
    }
  }

  const context = task.current
  if (!context) return
  if (context.deferScriptPromise.length) {
    const deferCount = context.deferScriptPromise.length
    promiseStream<string>(context.deferScriptPromise, (res: {data: string, index: number}) => {
      const current = task.current
      if (!current) return
      const scriptInfo = current.deferScriptInfo[res.index]?.[1]
      if (!scriptInfo) return
      scriptInfo.code = scriptInfo.code || res.data
    }, (err: {error: Error, index: number}) => {
      const current = task.current
      if (!current) return
      current.initHook.errorCount = current.initHook.errorCount ? ++current.initHook.errorCount : 1
      logError(err, current.app.name)
    }, () => {
      const current = task.current
      if (!current) return
      current.deferScriptInfo.forEach(([address, scriptInfo]) => {
        if (isString(scriptInfo.code)) {
          injectFiberTask(current.fiberScriptTasks, () => {
            const running = task.current
            const currentScriptInfo = sourceCenter.script.getInfo(address)
            if (!running || !currentScriptInfo) return
            runScript(address, running.app, currentScriptInfo, moduleInitHook)
            !isTypeModule(running.app, currentScriptInfo) && invokeInitHook(false)
          })
        }
      })

      /**
       * Fiber wraps js in requestIdleCallback and executes it in sequence
       * NOTE:
       * 1. In order to ensure the execution order, wait for all js loaded and then execute
       * 2. If js create a dynamic script, it may be errors in the execution order, because the subsequent js is wrapped in requestIdleCallback, even putting dynamic script in requestIdleCallback doesn't solve it
       *
       * BUG: NOTE.2 - execution order problem
       */
      if (current.fiberScriptTasks) {
        current.fiberScriptTasks.push(() => {
          const running = task.current
          if (!running) return Promise.resolve()
          return Promise.resolve(invokeInitHook(
            isUndefined(running.initHook.moduleCount) ||
            running.initHook.errorCount === deferCount
          ))
        })
        serialExecFiberTasks(current.fiberScriptTasks)
      } else {
        invokeInitHook(
          isUndefined(current.initHook.moduleCount) ||
          current.initHook.errorCount === deferCount
        )
      }
    })
  } else {
    if (context.fiberScriptTasks) {
      context.fiberScriptTasks.push(() => {
        const running = task.current
        if (running) invokeInitHook(true)
        return Promise.resolve()
      })
      serialExecFiberTasks(context.fiberScriptTasks)
    } else {
      invokeInitHook(true)
    }
  }
}

/**
 * run code
 * @param address script address
 * @param app app
 * @param scriptInfo script info
 * @param callback callback of module script
 */
export function runScript (
  address: string,
  app: AppInterface,
  scriptInfo: ScriptSourceInfo,
  callback?: moduleCallBack,
  replaceElement?: HTMLScriptElement,
): void {
  if (app.isDestroyed?.()) return
  const rawPropertySnapshot = app.iframe || !app.useSandbox ? null : beginRawGlobalObjectTracking()
  try {
    actionsBeforeRunScript(app)
    const appSpaceData = scriptInfo.appSpace[app.name]
    const sandboxType = getSandboxType(app, scriptInfo)
    /**
     * NOTE:
     * 1. plugins and wrapCode will only be executed once
     * 2. if parsedCode not exist, parsedFunction is not exist
     * 3. if parsedCode exist, parsedFunction does not necessarily exist
     */
    if (!appSpaceData.parsedCode || appSpaceData.sandboxType !== sandboxType) {
      appSpaceData.parsedCode = bindScope(address, app, scriptInfo.code, scriptInfo)
      appSpaceData.sandboxType = sandboxType
      appSpaceData.parsedFunction = null
    }

    /**
     * TODO: 优化逻辑
     * 是否是内联模式应该由外部传入，这样自外而内更加统一，逻辑更加清晰
     */
    if (isInlineMode(app, scriptInfo)) {
      const scriptElement = replaceElement || createRunScriptElement(app)
      runCode2InlineScript(
        address,
        appSpaceData.parsedCode,
        isTypeModule(app, scriptInfo),
        scriptElement,
        appSpaceData.attrs,
        callback,
      )

      /**
       * TODO: 优化逻辑
       * replaceElement不存在说明是初始化执行，需要主动插入script
       * 但这里的逻辑不清晰，应该明确声明是什么环境下才需要主动插入，而不是用replaceElement间接判断
       * replaceElement还有可能是注释类型(一定是在后台执行)，这里的判断都是间接判断，不够直观
       */
      if (!replaceElement) {
        // TEST IGNORE
        const parent = app.iframe ? app.sandBox?.microBody : app.querySelector('micro-app-body')
        parent?.appendChild(scriptElement)
      }
    } else {
      runParsedFunction(app, scriptInfo)
    }
  } catch (e) {
    console.warn(`[micro-app from ${replaceElement ? 'runDynamicScript' : 'runScript'}] app ${app.name}: ${String(e)}`, address)
    // throw error in with sandbox to parent app
    const error = e as Error
    let throwError = true
    if (typeof microApp?.options?.excludeRunScriptFilter === 'function') {
      throwError = microApp.options.excludeRunScriptFilter(address, error, app.name, app.url) !== true
    }
    if (throwError) {
      throw e
    }
  } finally {
    if (rawPropertySnapshot) {
      finishRawGlobalObjectTracking(app, rawPropertySnapshot)
      releaseSharedFunctionToStringPatch(app)
      // A child can synchronously destroy itself while executing this script.
      if (app.isDestroyed?.()) releaseRawGlobalObjectPatches(app)
    }
  }
}

/**
 * Get dynamically created remote script
 * @param address script address
 * @param app app instance
 * @param scriptInfo scriptInfo
 * @param originScript origin script element
 */
export function runDynamicRemoteScript (
  address: string,
  app: AppInterface,
  scriptInfo: ScriptSourceInfo,
  originScript: HTMLScriptElement,
): HTMLScriptElement | Comment {
  const replaceElement = isInlineMode(app, scriptInfo) ? pureCreateElement('script') : document.createComment(`dynamic script with src='${address}' extract by micro-app`)

  const dispatchScriptOnLoadEvent = () => dispatchOnLoadEvent(originScript)

  const runDynamicScript = () => {
    if (app.isDestroyed?.()) return
    const descriptor = Object.getOwnPropertyDescriptor(globalEnv.rawDocument, 'currentScript')
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(globalEnv.rawDocument, 'currentScript', {
        value: originScript,
        configurable: true,
      })
    }

    runScript(address, app, scriptInfo, dispatchScriptOnLoadEvent, replaceElement as HTMLScriptElement)

    !isTypeModule(app, scriptInfo) && dispatchScriptOnLoadEvent()
  }

  if (scriptInfo.code || isTypeModule(app, scriptInfo)) {
    defer(runDynamicScript)
  } else {
    fetchSource(address, app.name).then((code: string) => {
      scriptInfo.code = code
      runDynamicScript()
    }).catch((err) => {
      logError(err, app.name)
      dispatchOnErrorEvent(originScript)
    })
  }

  return replaceElement
}

/**
 * Get dynamically created inline script
 * @param address script address
 * @param app app instance
 * @param scriptInfo scriptInfo
 */
export function runDynamicInlineScript (
  address: string,
  app: AppInterface,
  scriptInfo: ScriptSourceInfo,
): HTMLScriptElement | Comment {
  const replaceElement = isInlineMode(app, scriptInfo) ? pureCreateElement('script') : document.createComment('dynamic inline script extract by micro-app')

  runScript(address, app, scriptInfo, void 0, replaceElement as HTMLScriptElement)

  return replaceElement
}

/**
 * common handle for inline script
 * @param address script address
 * @param code bound code
 * @param module type='module' of script
 * @param scriptElement target script element
 * @param attrs attributes of script element
 * @param callback callback of module script
 */
function runCode2InlineScript (
  address: string,
  code: string,
  module: boolean,
  scriptElement: HTMLScriptElement,
  attrs: AttrsType,
  callback?: moduleCallBack,
): void {
  if (module) {
    globalEnv.rawSetAttribute.call(scriptElement, 'type', 'module')
    if (isInlineScript(address)) {
      /**
       * inline module script cannot convert to blob mode
       * Issue: https://github.com/jd-opensource/micro-app/issues/805
       */
      scriptElement.textContent = code
    } else {
      scriptElement.src = address
    }
    if (callback) {
      const onloadHandler = () => {
        callback.moduleCount && callback.moduleCount--
        callback(callback.moduleCount === 0)
      }
      /**
       * NOTE:
       *  1. module script will execute onload method only after it insert to document/iframe
       *  2. we can't know when the inline module script onload, and we use defer to simulate, this maybe cause some problems
       */
      if (isInlineScript(address)) {
        defer(onloadHandler)
      } else {
        scriptElement.onload = onloadHandler
      }
    }
  } else {
    scriptElement.textContent = code
  }

  setConvertScriptAttr(scriptElement, attrs)
}

// init & run code2Function
function runParsedFunction (app: AppInterface, scriptInfo: ScriptSourceInfo) {
  const appSpaceData = scriptInfo.appSpace[app.name]
  if (!appSpaceData.parsedFunction) {
    appSpaceData.parsedFunction = getParsedFunction(app, appSpaceData.parsedCode!)
  }
  appSpaceData.parsedFunction.call(getEffectWindow(app))
}

/**
 * Native module scripts inherit their execution realm from the document which
 * creates them. In iframe mode a base-document script adopted into the iframe
 * can make absolute ESM imports resolve through the base application's module
 * map. Always create framework-owned script elements in the iframe realm.
 *
 * This is intentionally independent from disableIframeRootDocument: that
 * option controls child application DOM APIs, not micro-app's script loader.
 */
export function createRunScriptElement (app: AppInterface): HTMLScriptElement {
  if (app.iframe && isFunction(app.sandBox?.createSandboxScriptElement)) {
    return app.sandBox.createSandboxScriptElement()
  }
  return pureCreateElement('script')
}

/**
 * bind js scope
 * @param app app
 * @param code code
 * @param scriptInfo source script info
 */
function bindScope (
  address: string,
  app: AppInterface,
  code: string,
  scriptInfo: ScriptSourceInfo,
): string {
  // TODO: 1、cache 2、esm code is null
  if (isPlainObject(microApp.options.plugins)) {
    code = usePlugins(address, code, app.name, microApp.options.plugins)
  }

  if (isWrapInSandBox(app, scriptInfo)) {
    return app.iframe ? `(function(window,self,global,location){;${code}\n${isInlineScript(address) ? '' : `//# sourceURL=${address}\n`}}).call(window.__MICRO_APP_SANDBOX__.proxyWindow,window.__MICRO_APP_SANDBOX__.proxyWindow,window.__MICRO_APP_SANDBOX__.proxyWindow,window.__MICRO_APP_SANDBOX__.proxyWindow,window.__MICRO_APP_SANDBOX__.proxyLocation);` : `;(function(proxyWindow){with(proxyWindow.__MICRO_APP_WINDOW__){(function(${GLOBAL_CACHED_KEY}){;${code}\n${isInlineScript(address) ? '' : `//# sourceURL=${address}\n`}}).call(proxyWindow,${GLOBAL_CACHED_KEY})}})(window.__MICRO_APP_PROXY_WINDOW__);`
  }

  return code
}

/**
 * actions before run script
 */
function actionsBeforeRunScript (app: AppInterface): void {
  setActiveProxyWindow(app)
}

/**
 * set active sandBox.proxyWindow to window.__MICRO_APP_PROXY_WINDOW__
 */
function setActiveProxyWindow (app: AppInterface): void {
  if (app.sandBox) {
    globalEnv.rawWindow.__MICRO_APP_PROXY_WINDOW__ = app.sandBox.proxyWindow
  }
}

/**
 * Call the plugin to process the file
 * @param address script address
 * @param code code
 * @param appName app name
 * @param plugins plugin list
 */
function usePlugins (address: string, code: string, appName: string, plugins: plugins): string {
  const newCode = processCode(plugins.global, code, address)

  return processCode(plugins.modules?.[appName], newCode, address)
}

function processCode (configs: plugins['global'], code: string, address: string) {
  if (!isArray(configs)) {
    return code
  }

  return configs.reduce((preCode, config) => {
    if (isPlainObject(config) && isFunction(config.loader)) {
      return config.loader(preCode, address)
    }

    return preCode
  }, code)
}
