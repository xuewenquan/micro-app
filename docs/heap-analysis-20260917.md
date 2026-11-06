# 最新两份堆快照的排查结论（2026-09-17 11:30 / 11:42）

分析对象：

| 快照 | 文件大小 | 节点数 | JS 堆（self） |
|---|---|---|---|
| `Heap-20260917T113052_本地-ws-web-已处理log日志.heapsnapshot` | 1678.8 MB | 16,006,933 | **654.3 MB** |
| `Heap-20260917T114212_远程-we-web-没有处理log日志.heapsnapshot` | 1729.5 MB | 16,279,145 | **689.3 MB** |

两份快照之间 heap 相差 **+35.0 MB**，全部可以解释（见下），**不是累积泄漏**。

---

## 一、先给结论

1. **框架的账已经清干净了。** 两份快照里：
   - 沙箱：`customWindow` 2 / 3 个，`unmarkedCustomWindow` = 0 / 1；
     `microDocument` 2 / 3；`createApp` 2 个且 `destroyed=false` ——
     正好等于当前活着的两个应用（`wonder-ws-dataDetail-global`、`Issues-Component-CreateIssue`）。
     远程那份多出来的 1 个 `CustomWindow` 已定位：`ordinal=13899323`，**只有 `__proto__` 和空属性表**
     （12 字节的空壳目标对象），不是带完整访问器的活沙箱 —— 属于可忽略的碎片。
   - 资源：828/830 个 URL、**重复副本 0**；解析后的 CSS 只在活应用里（14.21 / 16.57 MB）。
   - 测量污染：`consoleHandles` = **2**（本地）/ 61（远程）。
     对比 10:01 那份的 37,286 —— 说明"去掉 log / 改 Error 打印方式"**确实生效了**，
     控制台不再替我们钉住对象。
2. **35 MB 的差值是"多加载了一个子应用"，不是泄漏：**
   - `string` 类型 +18.3 MB（其中 `wonder_wses2_web` 的 chunk-vendors 源码 16.9 MB、xlsx 及
     localhost 依赖源码若干）→ 远程那份多带了一个 SES2 bundle；
   - `Object shape` +1.6 MB / `AccessorPair` +7,737 个 → 多一代 with 沙箱代理；
   - `attached` DOM +292、`detached` DOM +5（92,780 → 92,785，**几乎没动**）。
3. **真正还没放掉的东西只有两类**，而且都**不在 micro-app 里**：
   - **92,780 个游离 DOM（10.43 MB 自身）+ 撑着它们的 JS 图**：全部属于基座/业务组件，
     `markedByApp` 为空 —— 没有一个是 micro-app 标记的节点；
   - **micro-app 当前活着的两个应用的源码与编译产物约 120 MB**：应用还开着，属于必要开销。
4. **想再往下压，只有三条路**（按收益/成本排序见第四节）：
   ① 让基座不再保留"已经没有 Tab 的页面组件树"（收益最大，改业务代码）；
   ② Element Plus 弹层退出 `:teleported="false"`（收益中等，改 wonder-ui）；
   ③ 换 iframe 沙箱（收益只有源码那一块，已在 demo 做过 A/B，**不推荐**）。

---

## 二、654 MB 花在哪

### 2.1 按对象类型（`heap_composition.js`）

| 类型 | 个数 | 字节 |
|---|---|---|
| native | 3,616,708 | 188.0 MB |
| object | 5,012,975 | 141.0 MB |
| array | 1,344,140 | 139.4 MB |
| closure | 3,185,543 | 85.2 MB |
| string | 1,206,914 | 52.6 MB |
| code | 567,165 | 34.5 MB |
| 其余（number/object shape/…） | — | ~14 MB |

单个名字最大的几项：

| 名字 | 个数 | 字节 | 是什么 |
|---|---|---|---|
| `system / ExternalStringData` | 10,854 | 83.8 MB | 大字符串（脚本源码）的堆外存储 |
| `(object properties)` | 195,619 | 61.9 MB | 对象属性存储 |
| `Object` | 1,214,527 | 57.2 MB | 普通对象 |
| `get`（闭包） | **1,192,595** | 31.9 MB | **reactive/computed 的 getter** |
| `system / AccessorPair` | **1,257,349** | 14.4 MB | 与上面一一对应的访问器对 |
| `ReactiveEffect` | 217,005 | 8.3 MB | Vue effect |
| `ComputedRefImpl` | 113,240 | 5.2 MB | Vue computed |
| `Set` | 501,552 | 7.7 MB | 各类注册表 |

> `get` 闭包与 `AccessorPair` 都是 **百万级**：这是**基座 Vue 应用自身**（Pinia store、
> Element Plus、surely-table、路由）的响应式规模，不是 micro-app 沙箱的开销
> （沙箱对象如 `CustomWindow` 只有 2 个、`JSProxy` 23.7 万个）。

### 2.2 支配树前几名（`heap_partition.js`）

| retained | 对象 | 说明 |
|---|---|---|
| 42.54 MB | `system / Context / scope @390217` | **micro-app 的模块级作用域**（`sourceCenter` 所在） |
| 42.24 MB | `Object`（`{link, script, releaseAppRealm, releaseApp}`） | `sourceCenter.releaseApp/releaseAppRealm` 所在对象 |
| 35.90 MB | `Map`（`scriptList`）+ 支撑数组 | **两个活应用的 bundle 源码缓存**（WS 21.35 + Issues 12.03 + …） |
| 21.35 MB | `string` `(function anonymous(){…with(proxyWindow.__MICRO_APP_WINDOW__)…}` | WS 的 22.4 MB 整包源码（with 包裹） |
| 21.35 MB | `ExternalStringData` | 上面那份字符串的堆外存储 |
| 12.03 MB | `string` `(self["webpackChunkwonder_issues_web"]=…)` | Issues 的整包源码 |
| 10.29 MB | `string` `import { xlsx_exports } …` | 基座自己的 Vite 依赖源码 |
| 4.27 MB | `code system / Script / …/micro-app/lib/index.esm.js` | micro-app 自身编译产物 |

**没有一项是"已销毁应用"的残留。**

### 2.3 92,780 个游离 DOM 是什么（`heap_detached_ownership.js`）

- 自身只有 **10.43 MB**（均值 118 B/个），**没有任何 ≥1 KB 的游离子树**；
- 按标签：`Text` 31,753、`Comment` 21,916、`div` 13,908、`span` 5,205、
  `SVGSVGElement` 4,926、`SVGPathElement` 4,932、`li` 4,911、`i` 4,865；
  抽样里出现 `el-tree-node` / `el-tree-node__content` / `el-select-dropdown__item` /
  `surely-table-cell-inner` / `el-icon`；
- **`markedByApp` 为空** —— 一个都不属于 micro-app；
- **每个游离节点的唯一入边都是 `property:el`，来自一个 116 字节的 vnode 对象**：
  即"vnode 还在 → 它指向的 DOM 就还在"。体量在 **JS 侧**（vnode + 组件实例 + effect），
  不在 DOM 侧；
- 10:46 / 11:30 / 11:42 三份快照分别是 92,781 / 92,780 / 92,785 —— **它不涨**，
  是一块"沉在底下的旧页面组件树"，不是持续泄漏。

结论：**这是一棵已经 detach、但仍被 Vue 组件/vnode 引用着的旧页面树**
（Element Plus 树/下拉/表格 + surely-table），属于基座（wonder-core-web）侧的生命周期问题。

---

## 三、为什么"关掉 Tab 内存也不见掉"

关 Tab 时基座做了三件事（代码已核对）：

1. `multipleTab.closeTab()` → `takeMicroAppsForClosedTabs()` 记录归属 → `destroyMicroApps()`
   → `microApp.unmountApp(appName, { destroy: true, clearData: true })`；
2. `updateCacheTab()` 把该 Tab 从 `cacheTabList` 里删掉，`<keep-alive :include="getCaches">`
   随之把页面组件移出缓存；
3. `microAppDestroy.ts` 里再 `releaseOwnedBodyMounts()` + `unregisterMicroAppFromTabs()`。

micro-app 侧对应的释放路径也已核对过，`actionsForCompletelyDestroy()` 会执行：
`disposeAppTasks` → `releaseScopedCSSObservers` → **`sourceCenter.releaseApp(name)`** →
`disposeDataCenterForApp` → `clearActiveProxyWindow` → `sandBox.destroy()` →
`releaseRawGlobalObjectPatches` → `clearInstanceDOM`，并把 `sourceMap/html/links/scripts` 清空。

所以框架该放的在放。残留的是**基座自己**还握着的东西：

- **被 KeepAlive 缓存过的页面组件实例**（`getCachedTabList` 变了，但组件实例可能还被
  基座的 `globalPlugin`、`microAppTabRegistry` 的 Map、或 `useTabs` 的闭包引用）；
- **Element Plus 弹层**：`ApiSelect.vue`（wonder-ui `package/wd-form/components/ApiSelect.vue:13`）
  写着 `:teleported="false"` —— 下拉面板不 Teleport 到 body，而是留在组件内部；
  组件被缓存/被引用时，`el-tree-node`、`el-select-dropdown__item` 这些面板节点就一起被拖住；
- 上面两条叠加，就是 92,780 个游离节点 + 它们的 vnode/effect 图。

---

## 四、可以怎么做（按性价比）

### 方案 A（推荐先做，收益最大）：让基座彻底放掉"已关闭 Tab 的页面树"

在 `wonder-core-web` 侧，关闭 Tab 后确认三件事都做完：

1. `cacheTabList` 已删除该 key（现在已有）；
2. **组件实例不再被任何模块级 Map 引用** —— 重点查
   `src/utils/microAppTabRegistry.ts`（`tabApps / appTabs / appParents`）、
   `src/layouts/default/util/micoAppRef.ts`、`src/utils/globalPlugin.ts`
   里保存的 `microApp`/`microRef`/`createIssue` 等**长生命周期引用**，
   在 `destroyMicroApps()` 完成后一并置空；
3. 若使用了 `useTabs` / 右键菜单的 `closeLeftTabs/closeRightTabs/closeOtherTabs`，
   确认批量关闭路径也走到同一套清理（历史记录里这三条最容易漏）。

验收：关掉所有 Tab（只剩首页）→ 强制 GC ×3 → 快照里
`domAll.detached` 应从 92,780 掉到个位数级，heap 应掉 200 MB 以上。

### 方案 B（收益中等，改动小）：弹层不再 `:teleported="false"`

- `wonder-ui`：`package/wd-form/components/ApiSelect.vue:13`（以及 ApiCascader/ApiTreeSelect/
  ApiItemSelect 等同族组件）确认是否必须留在组件内；
- 若允许，改为 `:teleported="true"` + 需要时用 `:popper-append-to-body` / `teleported`
  的显隐控制，避免 Tab 隐藏时弹层留在 body 上；
- 收益：游离的 `el-select-dropdown__item` / `el-tree-node` 面板及其 vnode 可以随组件一起释放。

### 方案 C（不推荐）：换 iframe 沙箱

- 只能省掉"两个活应用的源码 + 编译产物"约 120 MB；
- 但 micro-app 的 `Script` 对象、`InstructionStream`、`FeedbackVector` 由 V8 持有，
  iframe 已经证明会在 `src/sandbox/iframe/index.ts` 里需要
  `about:blank` + 100 ms 延迟移除等额外处理；
- 代码历史里 demo 的 A/B 结论是"每轮增长速率相同（±0.1 MB/轮）"，且 WS 切 iframe 后
  立即出现 `globalPlugin.useMessage` 不可用。**收益不抵风险。**

---

## 五、下一步该怎么量（一条命令的验收协议）

1. 固定起点：刷新页面 → 只留首页（可不开任何子应用）→ DevTools 强制 GC ×3 → 抓 **A**；
2. 打开 2～4 个子应用 → 强制 GC ×3 → 抓 **B**；
3. 把 Tab 全部关掉（回到第 1 步的状态）→ 强制 GC ×3 → 抓 **C**；
4. 对比：

```powershell
node --max-old-space-size=12288 scripts/heap_diff2.js A.heapsnapshot C.heapsnapshot --top=20
node --max-old-space-size=16384 scripts/heap_metrics.js C.heapsnapshot --label=C
node --max-old-space-size=12288 scripts/heap_detached_ownership.js C.heapsnapshot --samples=6
```

判据（沿用报告 §13.46）：

- **合格**：`C ≈ A`（差 < 20 MB），`domAll.detached` 回到几百以内，
  `unmarkedCustomWindow = 0`、`createAppDestroyed = 0`、重复 bundle = 0；
- **不合格**：`C` 比 `A` 高 50 MB 以上，且差值随轮次线性增长 —— 这时把 `A`、`C`
  两份发我，`heap_diff2.js` 的 `grewShapes` 会直接指出是哪个形状的对象在涨，
  再 `heap_describe_edges.js --nodes=<ordinal>` 看它的入边就能定位到代码。

---

## 六、本次新增的分析工具

| 脚本 | 用途 |
|---|---|
| `scripts/heap_composition.js` | 单次扫描：按类型/名字前缀统计堆构成（快，先跑这个） |
| `scripts/heap_partition.js` | 支配树：按 retained size 排出"谁占了大头"+ 游离 DOM 顶层入口统计 |
| `scripts/heap_detached_ownership.js` | 游离 DOM 的标签分布、micro-app 归属、样本入边 |
| `scripts/heap_diff2.js` | 两份快照对比：类型差、形状差（找出"谁在涨"） |
| `scripts/heap_owner_buckets.js` | 抽样某类对象，向上 N 层持有者按脚本/应用聚合 |
| `scripts/heap_describe_edges.js` | 打印指定节点的出边/入边（含所属脚本） |
| `scripts/heap_list_named_nodes.js` | 按名称列出具体节点及其属性（把"计数"落到"哪几个对象"） |
| `scripts/extract_json.js` | 从混入 stderr 的输出文件里抽出 JSON |

---

# 附：验收结论（2026-09-17 16:14 ～ 16:28，四份快照）

按第五节的协议实测，结论是 **不再累积，可以收工**。

## 快照清单

| 代号 | 文件 | 文件大小 | JS 堆 | 节点数 |
|---|---|---|---|---|
| B | `Heap-20260917T161644_开了4个子应用` | 975.3 MB | 692.4 MB | 9,294,658 |
| C | `Heap-20260917T161814_ 全部关掉回首页` | 283.8 MB | 234.7 MB | 2,715,126 |
| A2 | `Heap-20260917T162628_重新只留首页` | 306.7 MB | 244.6 MB | 2,865,305 |
| C2 | `Heap-20260917T162857_关闭两次4个子应用` | 310.5 MB | 248.8 MB | 2,918,401 |

> `Heap-20260917T161432_只留首页` 那份被截断在正好 230,000,000 字节（末尾无 `}`），
> 不可解析，已弃用；上表用 16:26 的 A2 作为基线。

## 关键结论

1. **关闭路径有效**：B → C 释放 **457.7 MB / 658 万节点**；
   游离 DOM **31,773 → 212**（其中微应用标记的 31,701 → 0）；
   重复 bundle **2 → 0**；源码 **129.2 → 36.6 MB**。

2. **没有累积**：A2 → C2（中间又开了 4 个子应用两次）只差 **+4.2 MB / +53k 节点**，
   其中 C2 的 `consoleHandles` 是 69、A2 是 69（C 是 0），
   形状差全部是 `StyleRule`/`Context/scope`/`Object` 这类**每个 +0.02～0.07 KB 的碎片**，
   没有一条是"某个应用/某段源码没放掉"。

3. **框架对象只剩 2.3 MB**（C2 支配树实测）：
   `microAppObjects.count = 42`，顶层入口 retained 合计 **2.32 MB**，
   最大的一项是**活着**的应用对应的那个 `CreateApp`（2.14 MB）。
   没有已销毁应用的对象残留。

4. **剩下 248.8 MB 是什么**（C2 支配树前几名，全部是"活着的两个常驻全局应用 + 基座 dev 环境"）：

   | retained | 对象 | 归属 |
   |---|---|---|
   | 21.35 MB | WS 整包源码（with 包裹）+ 其 `ExternalStringData` | `wonder-ws-web` |
   | 12.03 MB | Issues 整包源码 | `Issues-Component-CreateIssue` |
   | 12.14 MB | `Map`（`sourceCenter.scriptList`）+ 支撑数组 | micro-app 源码中心 |
   | 10.29 MB | xlsx 依赖源码字符串 | 基座 dev 环境 |
   | 4.27 / 3.79 / 3.30 / 3.06 MB | micro-app 自身 / jsoneditor / chunk / xlsx 的 `Script`（编译产物） | 基座 dev 环境 |
   | 各 ~2 MB | `@charset …micro-app[name=…]…` 作用域 CSS、`<style>`+`CSSStyleSheet` | 活应用的作用域样式 |

   其中 **85.7 MB 是 `system / ExternalStringData`** —— Vite dev server 把基座所有模块源码
   转成 JS 文本放在堆里，这一块在生产构建下会大幅缩小，之外还有 `InstructionStream` +
   `BytecodeArray` 约 10 MB、Blink 解析后的 CSS 约 11 MB。

## 判据对照（第五节定的标准）

| 判据 | 实测 | 结论 |
|---|---|---|
| `C ≈ A`（<20 MB） | A2 244.6 / C2 248.8（**+4.2 MB**） | ✅ 合格 |
| `domAll.detached` 回到几百以内 | C2 = 243（B 是 31,773） | ✅ 合格 |
| `unmarkedCustomWindow = 0` | C2 = 1（12 字节空壳） | ✅ 合格 |
| 重复 bundle = 0 | 0 | ✅ 合格 |
| 差值随轮次线性增长 | 两轮后仅 +4.2 MB，且形状全为碎片 | ✅ 合格 |

## 因此

- **第四步的 A、B 两项都不必做**（不需要改基座的 Tab 清理，也不需要改 `ApiSelect` 的 teleported）；
- 想继续压，只剩三类**收益低、风险高**的方向，不建议现在动：
  生产构建比对（量化 dev 的 Vite 源码与 sourcemap 开销）、
  避免"带时间戳的动态组件名"（`WS-Component-TypeRenderMenu-1789632918977` 这类，
  会持续新建隐藏类）、清理基础库体积。
- 下次若怀疑回归，直接重跑本节的协议（A2 → 开 4 个 → 关光 → C2），
  两个 diff 都 <20 MB 即为正常。

---

# 附二：「GC 后 JS 堆 125 MB，为什么任务管理器占 475 MB」（2026-09-18 08:54 实测）

用户执行：

```
node scripts/gc_once.js --url-match=localhost:3000 --clear-console
[08:54:03] GC×3  used 521.71 → 124.96 MB   (释放 396.75 MB)   total 126.85 MB
```

同时任务管理器里该标签约 **475 MB**。下面是把这两个数拆开的实测过程与结论。

## 测量

新增 `scripts/cdp_memory_probe.js`（在页面自己上下文里取样）与
`scripts/heap_v8_overhead.js` / `scripts/heap_css_audit.js`（从堆快照统计 V8 元数据与 CSS）。

### 1. 进程级（任务管理器口径）

调试实例（PID 由 `SystemInfo.getProcessInfo` 取得）：

| 进程 | Working Set | Private |
|---|---|---|
| renderer（页面所在） | **519.8 MB** | **454.4 MB** |
| browser | 290.5 MB | 167.6 MB |
| GPU | 104.2 MB | 151.2 MB |
| 其余 5 个（utility / 其它 renderer） | 241.7 MB | 102.3 MB |
| **合计** | **1155.8 MB** | **875.4 MB** |

> 任务管理器里那个"475 MB"就是 **renderer 进程的 private/working set**，
> 而 `gc_once.js` 报的 `used 124.96 MB` 是 **这个进程里 V8 堆中"活对象"的字节数**。
> 两者不是同一层口径。

### 2. V8 侧（GC×3 之后）

```json
"v8": { "usedMB": 115.03, "totalMB": 116.4,
        "embedderMB": 26.96, "backingMB": 52.35 }
```

- `used 115 MB` ≈ `gc_once.js` 的 124.96 MB（同一读数，取样时刻略有差异）；
- `embedderHeapUsedSize 26.96 MB`：DOM 节点等"被嵌入者"对象（**不在** 115 MB 里）；
- `backingStorageSize 52.35 MB`：ArrayBuffer / TypedArray 的堆外后备存储（**也不在** 115 MB 里）。

页面自身读数（`performance.memory`）：`usedJSHeapSize = 167.39 MB`，正好等于
**115.03 + 52.35** —— 两个数并不矛盾，只是 `getHeapUsage` 不含 backing store。

### 3. 页面上有什么

```json
"domCounters": { "documents": 5, "nodes": 7932, "jsEventListeners": 843 }
"pageSelfReport": {
  "resourceCount": 250, "scriptResourceCount": 242,
  "transferMB": 0.06, "decodedMB": 18.36,
  "styleSheetCount": 220, "styleRuleTotal": 25814,
  "domNodes": 2891, "microAppNodes": 3
}
```

注意 **242 个脚本、220 个样式表**——这是 Vite dev server 的模块化加载（生产构建会是几十个）。

### 4. V8 元数据 / 编译产物（C2 快照统计，共 **112.86 MB / 占堆的 45.4%**）

| 项目 | 个数 | MB |
|---|---|---|
| `ExternalStringData`（堆外字符串，dev 模块源码正文） | 5,025 | **85.66** |
| `InstructionStream`（机器码） | 6,861 | 5.44 |
| `BytecodeArray`（字节码） | 23,987 | 5.20 |
| `SharedFunctionInfo` | 97,616 | 4.41 |
| `TrustedByteArray` | 38,156 | 2.48 |
| `ObjectBoilerplateDescription` | 55,500 | 2.24 |
| `script line ends`（行号表） | 873 | 1.84 |
| `FeedbackCell` / `FeedbackVector`（编译反馈） | 121,134 | 2.50 |
| `DescriptorArray`（隐藏类） | 14,937 | 1.57 |
| `PropertyArray` | 66,067 | 1.45 |
| `Script` 对象本身 | 880 | 0.07 |

### 5. CSS（C2 快照统计，共 **18.89 MB**）

`StyleRule` 57,565 条 / 5.27 MB、`CSSPropertyValueSet` 56,835 / 4.68 MB、
CSS 变量与函数 88,102 / 3.43 MB、`CSSSelector` 51,899 / 3.38 MB、
`StyleSheetContents` 307 个、`<style>` 元素 408 个、`<link>` 只有 6 个。

## 结论：475 MB 的构成

| 组成 | 约数 | 说明 |
|---|---|---|
| V8 活对象（GC 后 `used`） | **115 MB** | 就是 `gc_once.js` 报的数 |
| ArrayBuffer / TypedArray 后备存储 | **52 MB** | 不在 `used` 里，`performance.memory` 里含 |
| DOM/CSS/脚本对象等 embedder 堆 | **27 MB** | 不在 `used` 里 |
| 解析/编译产物合计（元数据 + CSS） | **~132 MB** | dev 模式特有：242 个模块、220 个样式表 |
| renderer 代码段、ICU、IPC/共享内存、malloc 余量、V8 保留但未归还的页 | **~190 MB** | 每个渲染进程都有的底噪，GC 不会归还 |

所以 **"JS 堆 125 MB" 与 "进程 475 MB" 不冲突**：前者只数活对象，后者是整进程物理占用。
`GC×3` 释放的 396 MB 中，很大一部分也**不会立刻回到操作系统**
（V8 按 `MemoryReducer` 惰性归还，任务管理器可能仍显示几百 MB）。

## 对"继续压内存"的指导

1. **别拿任务管理器数字做验收**。口径应该是：DevTools 抓快照看 `heapSelfMB`（或 `gc_once.js` 的 `used`），
   配合 `domAll.detached`、`unmarkedCustomWindow`、重复 bundle 三个结构指标。
2. **想在任务管理器上看到明显下降，唯一有效手段是生产构建**：
   dev 模式的 86 MB 源码正文 + 数十 MB 编译产物 + 220 个样式表在生产下会大幅缩小
   （`transferMB` 只有 0.06 MB 却 `decodedMB` 18.36 MB，说明 dev 模块是明文直传、逐模块编译）。
3. **`renderer` 那 ~190 MB 底噪无法通过改业务代码消除**：它包含 V8 保留页、
   代码段、共享库与 IPC 缓冲；只要标签活着就存在。

---

# 附三：无头浏览器（本地已装好，但**不能在受限沙箱里**启动）

## 现状

本机已经有一个可用的无头 Chromium（上一轮排查时装的 Playwright 浏览器缓存，
位于标准路径，本次未重复下载）：

```
C:\Users\81017\AppData\Local\ms-playwright\chromium-1187\chrome-win\chrome.exe        (Chromium 140.0.7339.16)
C:\Users\81017\AppData\Local\ms-playwright\chromium_headless_shell-1187\...\headless_shell.exe
```

同目录还有 firefox-1490 / webkit-2203 / ffmpeg-1011。

另外本仓库已安装 `playwright-core@1.50.1`（`--no-save`，未写入 package.json）。

## 关键限制：在 DSH 沙箱里起不来

从受限沙箱内启动 Chromium **必然失败**，实测三种组合都一样：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: . : 拒绝访问。(0x5)
ERROR:crashpad_client_win.cc:423] OpenProcess: 拒绝访问。(0x5)
ERROR:crashpad_client_win.cc:144] crash server failed to launch, self-terminating
```

原因：Chrome 的进程内 IPC（Mojo）需要**命名管道**，crashpad 需要打开同级进程；
这两项在受限沙箱里被拒绝，浏览器随即自终止。这与启动参数无关
（`--no-sandbox` / `--disable-gpu` / `--disable-crash-reporter` / Chrome 153 全部试过，结果相同）。
因此**浏览器必须在一个普通（非沙箱）终端里启动**，之后既有 CDP 脚本可以正常连它。

## 怎么用

**方式一（推荐，双击即可）**：`scripts\start-headless-browser.cmd`
自动挑 Chromium（找不到则回退系统 Chrome），带
`--remote-debugging-port=9222 --remote-allow-origins=* --headless=new --js-flags=--expose-gc`，
末尾用 `curl /json/version` 自检。

**方式二（普通终端里跑 Node 脚本）**：

```powershell
node scripts\start_headless_browser.js                        # 无头 + localhost:3000
node scripts\start_headless_browser.js --url=http://localhost:3000/wd/dashboard --expose-gc
node scripts\start_headless_browser.js --headless=false       # 想看得见界面时
node scripts\start_headless_browser.js --port=9222 --kill     # 关掉
```

启动后用既有工具验证（与手动开的调试浏览器完全一致）：

```powershell
node scripts\gc_once.js --port=9222 --url-match=localhost:3000 --clear-console
node scripts\cdp_memory_probe.js --port=9222 --url-match=localhost:3000
node scripts\cdp_heap_snapshot.js --port=9222
```

## 设计说明

`start_headless_browser.js` **刻意不用 `playwright.launch()`**：Playwright 会接管浏览器
并在私有管道上通信，`gc_once.js` / `cdp_*.js` 这套 CDP 脚本就连不上了。
本脚本只把浏览器拉起来并保持标准 DevTools 入口（9222），两套工具共用同一个实例。



