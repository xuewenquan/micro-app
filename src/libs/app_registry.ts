import type { AppInterface } from '@micro-app/types'

// Keep registry ownership separate from CreateApp implementation. Source
// loaders can check ownership without importing CreateApp and forming a cycle.
export const appInstanceMap = new Map<string, AppInterface>()

/**
 * 2026.9.12 by Claude Code
 * 判断某个 app 实例是否仍然“拥有”它的应用名。
 *
 * 背景：销毁之后的迟到异步回调（onLoad / fetchScriptSuccess / fetchLinkSuccess 等）
 * 都捕获的是**旧实例**，而 sourceCenter / appTaskMap / appStyleObservers / dataCenter /
 * iframeAppNodeMap / workerInstanceMap 这些注册表却是按 **appName** 索引的。
 * 如果旧实例被同名新实例替换后才执行（micro_app_element 的“先 destroy 再 create”、
 * prefetch 被真实应用替换、reload、快速 unmount/remount 都会走到），按 name 清理就会
 * 连带抹掉新实例的源码元数据与异步任务 —— 表现为 mount 中断、脚本被静默跳过，
 * 或应用永久停在 MOUNTING。
 *
 * 因此：只要当前 appName 已经被“另一个实例”占用，就跳过按 name 的清理，
 * 交给新实例自己销毁时处理；没有新实例时才正常清理。
 *
 * Review correction:
 * 这是“保护更新的实例”，**不是代际（generation）所有权**。实例级任务已单独按实例
 * 释放；其余按 name 索引的注册表不能被旧实例无条件清空，但也不代表代际问题已全部解决
 * —— 同名实例并发时仍需要 generation token 贯穿这些注册表。
 */
export function isAppNameOwner (app: AppInterface): boolean {
  const current = appInstanceMap.get(app.name)
  return !current || current === app
}
