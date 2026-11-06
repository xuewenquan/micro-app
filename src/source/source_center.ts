import type { LinkSourceInfo, ScriptSourceInfo, SourceAddress } from '@micro-app/types'
import { isInlineScript } from '../libs/utils'

export interface SourceCenter<L = LinkSourceInfo, S = ScriptSourceInfo> {
  link: {
    setInfo (address: SourceAddress, info: L): void,
    getInfo (address: SourceAddress): L | null,
    hasInfo (address: SourceAddress): boolean,
    deleteInfo (address: SourceAddress): boolean,
  },
  script: {
    setInfo (address: SourceAddress, info: S): void,
    getInfo (address: SourceAddress): S | null,
    hasInfo (address: SourceAddress): boolean,
    deleteInfo (address: SourceAddress): boolean,
    deleteInlineInfo (addressList: Set<SourceAddress>): void,
  },
  releaseApp (appName: string): void,
  releaseAppRealm (appName: string): void,
}

export type LinkListType = Map<SourceAddress, LinkSourceInfo>
export type ScriptListType = Map<SourceAddress, ScriptSourceInfo>

/**
 * SourceCenter is a resource management center
 * All html, js, css will be recorded and processed here
 * NOTE:
 * 1. All resources are global and shared between apps
 * 2. Pay attention to the case of html with parameters
 * 3. The resource is first processed by the plugin
 */
function createSourceCenter (): SourceCenter {
  const linkList: LinkListType = new Map()
  const scriptList: ScriptListType = new Map()

  function createSourceHandler <P, T extends Map<SourceAddress, P>> (targetList: T): SourceCenter<P>['link'] | SourceCenter<LinkSourceInfo, P>['script'] {
    return {
      setInfo (address: SourceAddress, info: P): void {
        targetList.set(address, info)
      },
      getInfo (address: SourceAddress): P | null {
        return targetList.get(address) ?? null
      },
      hasInfo (address: SourceAddress): boolean {
        return targetList.has(address)
      },
      deleteInfo (address: SourceAddress): boolean {
        return targetList.delete(address)
      }
    }
  }

  return {
    link: createSourceHandler<LinkSourceInfo, LinkListType>(linkList),
    script: {
      ...createSourceHandler<ScriptSourceInfo, ScriptListType>(scriptList),
      deleteInlineInfo (addressList: Set<SourceAddress>): void {
        addressList.forEach((address) => {
          if (isInlineScript(address)) {
            scriptList.delete(address)
          }
        })
      }
    },
    // Default iframe remount creates a new realm. Keep URL/source metadata but
    // never reuse a Function compiled by the iframe that was just discarded.
    releaseAppRealm (appName: string): void {
      scriptList.forEach((sourceInfo) => {
        const appSpace = sourceInfo.appSpace[appName]
        if (appSpace) delete appSpace.parsedFunction
      })
    },
    /**
     * Release all app-scoped source metadata when an app is permanently destroyed.
     *
     * Source code can be shared, but appSpace may contain DOM nodes and Functions
     * created in a child realm. Keeping it after destroy prevents that realm from
     * being garbage-collected. Scanning the source maps also covers dynamic remote
     * assets, which are not recorded in app.source.
     *
     * NOTE(已知取舍) 2026.9.12 by Claude Code
     * 本函数在 appSpace 清空后会把整条 entry 逐出（sourceList.delete(address)），
     * 这一点经复核**确认保持现状**（内存优先：destroy 后连源码文本一起释放）。
     *
     * 由此产生的已知副作用，不要再当成 bug 排查：
     * 1. prefetch 得到的 code / parsedCode / parsedFunction 无法被“同名真实应用”复用。
     *    micro_app_element 的“先 destroy 再 create”会走到这条路径（新旧实例共用同一个
     *    appName 作为 appSpace key），于是真实应用需要重新下载 + 重新 bind + 重新 parse。
     * 2. 连带使 src/source/scripts.ts 中“依赖同名复用”的那段注释不再成立。
     *
     * 若将来要恢复复用：把 realm 无关的源码文本 code 留在 entry 级（不随 appSpace 空而
     * 逐出），只让 parsedFunction 等 realm 相关内容随 appSpace 释放。
     */
    releaseApp (appName: string): void {
      const releaseFrom = <T extends LinkSourceInfo | ScriptSourceInfo>(sourceList: Map<SourceAddress, T>): void => {
        sourceList.forEach((sourceInfo, address) => {
          if (sourceInfo.appSpace[appName]) {
            delete sourceInfo.appSpace[appName]
            if (!Object.keys(sourceInfo.appSpace).length) {
              sourceList.delete(address)
            }
          }
        })
      }

      releaseFrom(linkList)
      releaseFrom(scriptList)
    },
  }
}

export default createSourceCenter()
