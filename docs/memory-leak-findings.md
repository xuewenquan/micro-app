# micro-app 内存不释放问题排查报告

> 排查日期：2026-09-11 ~ 09-12
> 排查对象：`micro-app`（1.0.0-rc.32，with 沙箱，子应用为 Vue 3 / webpack 企业应用）
>
> **本文档中的域名、应用名已做代号化处理**（`app-prod` / `app-ws` / `app-cpu` / `app-proc`，域名写作 `<业务域名>`）。
> 如需内部分发版本，把代号替换回真实站点与微应用名即可；快照文件名、节点序号与本文数字一一对应。

---

## 一、结论摘要

| # | 结论 | 证据强度 |
|---|---|---|
| 1 | 21:53 快照的泄漏点已定位并修复：基座 window 上残留的子应用事件监听器，单个闭包独占 **225.4 MB** | 已实测（切断即释放） |
| 2 | 22:55 快照仍有 **404.1 MB / 810 万节点（占堆 62%）** 未释放，但**不存在可切断的单一外部引用** | 已实测（15 轮边界增长 + 支配树） |
| 3 | 该 404 MB 是一个**跨至少 3 个已销毁应用的强连通体**，枢纽是 `with(proxyWindow.__MICRO_APP_WINDOW__)` 的作用域上下文 | 已实测 |
| 4 | 方向不是"找外部引用"，而是**让 bundle 内部变为不可达**；但**在框架层通用清 webpack 运行时已被复核否定**（见 11.3），落地位置改为"框架消除外部属性边 + 业务侧按自身构建系统清理" | 方向：实测推断；落地方案：已复核修订 |
| 5 | 09-12 08:51 快照：第六节两项建议已落地，**404 MB 强连通体被打散**（最大 JS 锚点 273.7 MB → 9.3 MB，堆 −13%、节点 −16%，且在应用数更多的情况下）。**残留约 430 MB**，主体变为包裹源码 + 模块闭包 | 已实测（见第十节） |

---

## 二、分析方法与工具

排查全部基于 V8 `*.heapsnapshot`（Chrome DevTools Memory 面板导出），用自研脚本离线解析。
本次新增脚本位于 `scripts/`，共 16 个（另有排查前已存在的 `inspect_heap_snapshot.js`）：

| 脚本 | 用途 |
|---|---|
| `heap_dominators.js` | **核心工具**。支配树 + 真实 retained size；`--path=` 输出支配链，`--children=` 输出某节点的支配子树 |
| `heap_grow_boundary.js` | **核心工具**。把一个泄漏团块的边界逐层外推，直到触达 GC roots |
| `heap_exclusive_size.js` | 切断指定节点后能释放多少内存（等价于单节点 retained size） |
| `heap_ingress.js` | 某区域的"外部入边"（谁在引用它）+ 从 GC roots 直接进入的边 |
| `heap_retainers.js` | 向上逐层列出**全部**持有者（区别于最短路径），并按 bundle 归属 |
| `heap_path_to_root.js` | 从 GC root 到目标的最短保留路径（注意：**会误导**，见第八节） |
| `heap_native_handles.js` | 原生节点（Blink）直接持有的 JS 对象，按 bundle 归属 |
| `heap_accessors.js` | 堆里所有 `get X` / `set X` 访问器及其安装点 |
| `heap_detached_dom.js` | 游离（detached）DOM 节点统计（V8 的 `detachedness` 字段） |
| `heap_scan_edges.js` | 按属性名批量扫描边并输出直方图 |
| `heap_find_edges.js` | 按属性名查找边，输出两端节点 |
| `heap_find_large_nodes.js` | 列出最大的单个节点（可按名字过滤） |
| `heap_symbol_summary.js` | 按 `(type, name)` 聚合节点，定位"什么被创建了 100 万次" |
| `heap_describe.js` | 描述指定节点：类型、属性、所属 Script（bundle） |
| `heap_bfs_from.js` | 从指定节点做有界前向 BFS（用于解码 Blink 原生结构） |
| `diff_heap_snapshots.js` | 两份快照按 `(type, name)` 做增量对比 |

**方法要点**

- **不用最短路径判断保留关系**。`heap_path_to_root` 给的是最短路径，会指向"顺便可达"的引用；权威结论一律以 **支配树（dominator tree）** 为准。
- **支配树需要收敛**。本报告中的支配树均在 **353 轮迭代收敛到 0 changes** 后取用（未收敛的结果不可用）。
- **切断实验是最终裁判**。任何"这就是泄漏点"的判断，都必须用 `heap_exclusive_size` 验证：切断后确实释放了预期内存。
- 注意脚本的节点索引容量必须 ≥ 快照 `node_count`（从文件头读取），否则图会被静默截断、结果失真。

---

## 三、21:53 快照：已定位并修复的泄漏

**规模**：780 MB / 7,198,547 节点 / 34,341,269 边 / 堆 selfSize 640 MB

### 3.1 泄漏点

**单个事件监听器闭包 `closure 5151711 "s"`**，保留链：

```
synthetic (GC roots)
└─ Window (基座 http://<base>)            ← 基座 window
   └─ blink::EventTargetData → RegisteredEventListener → EventListener → V8EventListener
      └─ closure 5151711 "s"                        225.4 MB  ← 就是它
         └─ Context scope @4573757                  225.4 MB
            ├─ string ×5  117.3 MB  （子应用 app-ws 打包源码的 5 份包裹副本）
            ├─ BytecodeArray ×58,312   12.5 MB
            ├─ InstructionStream ×10,784  8.0 MB
            ├─ Object ×198,116 / closure ×311,363
            └─ blink::StyleRule ×17,335   2.0 MB
```

**切断它一个，释放 225.4 MB / 2,831,135 节点（占堆 35%）。**

关键证据：
- 该函数带 micro-app 自己的标记 `__MICRO_APP_MARK_OPTIONS__` → 是子应用经 `microAppWindow.addEventListener` 注册到基座 `rawWindow` 上的；
- 但它**已不在 `eventListenerMap` 里**（引用者只有 2 个：闭包上下文 + `V8EventListener`）；
- 91 个这类监听器中，**48 个的 options 是对象，抽查的 6 个内容均为 `{passive: true, capture: true}`**（即 capture 阶段注册）。

### 3.2 根因（代码）

`src/sandbox/with/window.ts`（当时实现）：

```ts
microAppWindow.removeEventListener = function (type, listener, options) {
  type = formatEventType(type, appName)
  const listenerList = eventListenerMap.get(type)
  if (listenerList?.size && listenerList.has(listener)) {
    listenerList.delete(listener)          // ← 无论原生删除是否成功，记账一律删除
  }
  rawRemoveEventListener.call(getEventTarget(type), type, listener, options)
}
```

`release()` 只能遍历 `eventListenerMap` 来删除。于是：

1. 子应用以 `{capture: true}` 注册监听；
2. 之后调用 `removeEventListener(type, fn)` **不带 capture**（或同一函数以不同 capture 注册两次，Set 去重后标记被覆盖）；
3. 记账条目被删，但原生删除因 capture 阶段不匹配而**静默失败**，监听器留在基座 window 上；
4. 卸载时 `release()` 的遍历列表里已经没有它 → 永远删不掉。

`src/sandbox/with/document.ts` 当时是完全相同的写法。

### 3.3 修复与验证

新增 `src/sandbox/listener_effect.ts`：改为**记录精确的原生注册四元组** `(target, type, listener, capture)`，`remove` 时按记录中的 capture 匹配、并按**注册时的 target** 删除（不再重算 `getEventTarget`）。

**验证**（22:55 快照）：
- 切断全部 251 个带标记监听器，只释放 **7.6 KB**（修复前是 225.4 MB）→ **该路径已失效**；
- `__MICRO_APP_URL__` / `__MICRO_APP_SANDBOX_TYPE__` 从 12 个降到 **0 个**；
- `__MICRO_APP_PROXY_WINDOW__` 残留 **0**；
- `parsedCode` / `parsedFunction` 残留 **0**。

---

## 四、22:55 快照：仍未释放的 404 MB

**规模**：1.09 GB / 9,695,675 节点 / 48,050,177 边 / 堆 selfSize 648 MB
（比 21:53 更差：节点 +35%，体积 +40%）

### 4.1 应用对象已全部回收

```
14 个 CreateApp 实例：全部 destroyed=true, sandBox=null, container=null
WithSandBox 实例：0
```

但 **22 个 `CustomWindow` 仍然存活**，游离 DOM 节点 **26,631 个**；`find MicroDocument` 命中 **23 个闭包**（含 1 个 `createMicroDocument` 函数本体）。

### 4.2 顶层锚点：前 10 个吃掉堆的 69%

GC roots 有 771,820 个直接子节点，但最大的 10 个合计约 **450 MB / 648 MB**：

| retained | 节点 |
|---|---|
| 273.7 MB | `closure 4630163`（app-prod 的模块导出） |
| 23.1 MB | `closure 3357365`（app-ws 的 chunk-vendors 模块） |
| 22.4 MB ×3、17.3、16.9、15.8、13.3、12.0 MB | **8 份包裹后的子应用 bundle 源码字符串** |
| 10.3 MB | 一段 `import { xlsx_exports } from "/node_modules/.vite/deps/..."` 字符串 |

那 8 份源码字符串本身就是 **约 160 MB 的纯重复源码**——根源是 `bindScope()` 按 app 维度生成 `parsedCode`，同一个 URL 被多个应用加载就多一份全量副本。

### 4.3 273.7 MB 的进入点只有 3 条，且必须全删

独占在 `closure 4630163`（来自 `app-prod/js/chunk-vendors.5ee2c242.js`，Script 上带
`eval_from_shared_or_wrapped_arguments = code2Function`）之下的区域：
**5,060,449 节点 / 273.7 MB**。

从外部进入它的引用**只有 3 条**：

| # | 引用来源 | 类型 |
|---|---|---|
| 1 | `Context scope @11808415` 槽位 `s` | webpack 运行时作用域 |
| 2 | 带 `inspectSource`/`versions`/`wks`/`keys`/`state` 的对象 | webpack 运行时对象 |
| 3 | 模块记录 `{id, loaded, exports}`，被 77,793 项的模块表持有 | webpack 模块表 |

**切断实验**：

```
单独切任意一条        → 释放 0
三条一起切            → 释放 273.7 MB / 5,060,459 节点
```

即三条是**并行**的，删一条无效。

### 4.4 支配链：②③ 汇聚到同一个网关

```
(GC roots)
├─ 入口①：ctx @11808415                    ← idom 直接是 GC roots
└─ closure 3357365  [app-ws/js/chunk-vendors.a695a*.js]   ← 网关
   └─ ctx @6406913 ──context:a──▶ native_bind 3357369
      └─ closure 4426915  [app-ws/js/chunk-vendors.a695a*.js]
         └─ ctx @6123345 ─▶ ctx @5231545
            ├─ 入口②：inspectSource 运行时对象
            └─ ctx @5688515 ──context:t──▶ 模块表 ──element:#77793──▶ 入口③ 模块记录
```

**`closure 3357365` 属于 app-ws——另一个已销毁应用。** 即：一个已销毁应用的 vendor bundle 咬住了另一个的模块图。

### 4.5 边界增长：15 轮推到根，团块 404 MB，且**没有单一锚点**

以 `{4630163, 7592680, 7611083, 7611521, 3357365}` 为起点，逐轮把入边吸收进边界：

| 轮 | 团块 | 入边 / 来源 |
|---|---|---|
| 1 | 296.8 MB / 5,646,844 | **7 / 7** |
| 2 | 296.8 MB | 21 / 21 |
| 3 | 297.4 MB | 852 / 851 |
| 8 | 302.6 MB | 10,964 / 9,793 |
| 9 | 337.2 MB | 94 / 85 |
| 14 | 353.6 MB | 18,362 / 16,788 |
| **15** | **404.1 MB / 8,102,299** | 11,346 / 9,074 ← **触到 GC roots，边界完成** |

**最终边界的真相：**

```
从 GC roots 直接伸进团块的边：3 条，且都是普通页面管线
   C++ Persistent roots ──▶ blink::WebLocalFrameImpl   (288 B)
   C++ Persistent roots ──▶ blink::Page                (2008 B)
   C++ Persistent roots ──▶ blink::DevToolsSession     (264 B)
```

**没有任何可疑的全局句柄。** 团块是被"活着的 JS 引用"吊住的——只是入口有几百个：

| 边数 | 来源 |
|---|---|
| 386 | 匿名闭包 ×386，基座 `node_modules/.vite/deps/chunk-*.js`（Vue/jQuery 依赖块） |
| 873 | `system / AccessorPair` |
| 798 | app-prod bundle 闭包 |
| 793 | `Module` 对象 |
| **404** | **基座闭包**（含 micro-app 自己的 `lib/index.esm.js`） |
| 362 + 187 | app-ws bundle 闭包 |

### 4.6 枢纽：`with` 作用域上下文

`MicroDocument` 类的持有者中有一个关键 context —— `scope @2786453`，它有 **38 个槽**：

```
history, location, navigator, console, performance, JSON, Reflect,
parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
encodeURI, decodeURI, RegExp, Error, TypeError, Map, Set, WeakSet,
Node, Element, … , Document => MicroDocument
```

**这 38 个名字正是 `with(proxyWindow.__MICRO_APP_WINDOW__)` 作用域里被动态解析的全局名。**
该 context 有 **2,386 个入边**，其中 **1,744 个来自 `app-cpu/js/chunk-vendors.de22e702.js` 的闭包**。

链条（每一跳都是唯一持有者，已验证）：

```
app-cpu bundle 的 1,744 个闭包
  └─ with 作用域 context (scope @2786453)
       └─ context:Document → MicroDocument
            └─ MicroDocument.prototype → Map → System / JSProxy
                 └─ handler { get, set }   ← micro-app 闭包，捕获沙箱作用域
                      └─ 回到 404 MB 团块内部（回环，无出口）
```

对应的源码是 `src/sandbox/with/document.ts:279`：

```ts
Object.setPrototypeOf(MicroDocument.prototype, new Proxy(rawRootDocument.prototype, {
  get (target, key) { throttleDeferForSetAppName(appName); return bindFunctionToRawTarget(Reflect.get(target, key), rawDocument, 'DOCUMENT') },
  set (target, key, value) { Reflect.set(target, key, value); return true }
}))
```

---

## 五、最终判断

> **这 404 MB 是一个跨至少 3 个已销毁应用的强连通体，不存在可切断的单一外部引用。**

支撑证据：

1. 从 GC roots 直接进入团块的边只有 3 条，且都是 frame / page / DevTools 这类普通管线；
2. 团块入边有 9,074 个来源、几百条来自活着的基座代码；
3. 向上逐层游走 8 层（第 8 层 29,294 个 retainer，被 fanout 截断）**没有任何基座闭包**，保留者全是子应用 bundle；
4. 结构上，`with` 作用域把所有沙箱全局、`MicroDocument`、以及捕获沙箱作用域的 Proxy handler 串成一个环——任何一处活着，整块活着。

**这解释了"改了几处、看着都合理、内存却不降"**：每修掉一个入口，团块仍从别的方向活着。

---

## 六、可立即执行的两项代码改进

1. **`createMicroDocument` 的 Proxy handler 不应捕获 per-app 作用域**
   （`src/sandbox/with/document.ts:279`）
   `get` / `set` 只用到 `appName` 与 `rawDocument`；`rawDocument` 是全局的，`appName` 可用 `getCurrentAppName()` 动态取。
   → 该 Proxy 可做成**模块级单例**，不再每应用一份、也不再需要拆除。
   现状：堆里 `find MicroDocument` 命中 23 个闭包（每次 `patchDocument` 新增一份）。

2. **不要让每次 `patchDocument` 都新建 Proxy**
   若必须 per-app，destroy 时需拆除：恢复 `MicroDocument.prototype` 的原型并断开对 handler 的引用。
   目前 `releasePatchElementAndDocument()` 只恢复了被改写的原型方法，没有处理这一处。

---

## 七、根治方向（候选方案）

既然没有单一切口，就不应继续"找外部引用"，而应**让 bundle 内部变为不可达**：

- **destroy 时清空子应用的 webpack 运行时**：`__webpack_require__.c`（模块缓存）、`.m`（模块表）、以及模块作用域中的 `bind` 缓存；
- webpack 模块图高度互联，把根表清掉，即使仍有几百条外部引用指向其中某个函数，那个函数也带不出其他模块；
- 这也能一并缓解 8 份重复包裹源码（约 160 MB）的问题（`bindScope` 按 app 生成 `parsedCode`）。

> ⚠️ **本节方案在第十一节 11.3 中被复核否定（不适合在框架层通用实施）。**
> 复核理由：`__webpack_require__` 通常位于 bundle 自己的闭包里而非沙箱全局，micro-app 无法可靠取得；且不同 webpack 版本 / 模块联邦 / 共享依赖的运行时结构不一致，强行扫描清空可能破坏保活应用或共享 runtime。
>
> 因此本节保留为**问题定性**（"必须让 bundle 内部不可达"这个方向成立），但**落地位置**应改为：框架侧继续消除所有外部属性边（第十一节 11.1），bundle 自身的运行时清理交由业务应用在其卸载钩子中按自己的构建系统实施，或由框架提供文档化的钩子。

---

## 八、排查过程中被推翻的判断（以免重复踩坑）

| 假设 | 推翻依据 |
|---|---|
| "659 个未打标记的 `V8EventListener` 就是泄漏的子应用监听器" | 修好 bundle 归属后：**658 个属于基座**（Vue/vue-router/jQuery/SortableJS/`clickOutside.ts`），**0 个属于子应用**。原生→JS 边数量本身不是泄漏指标。 |
| "链顶是 `(GC roots)` ⇒ 被原生句柄持有" | 从 GC roots **直接**伸进团块的边为 **0**。`idom = 根节点` 只表示"多路径可达、无更近的共同支配者"，不等于原生持有。 |
| （方法学）"最短路径能指出保留者" | `heap_path_to_root` 两次把结论引向 `document.body.dom7Listeners` 和 `window.__VUE_INSTANCE_SETTERS__`，**切断两者各释放 0**。保留关系必须用支配树。 |

---

## 九、复现命令

```bash
# 支配树 + 顶层锚点（约 20 分钟，353 轮收敛）
node --max-old-space-size=16384 scripts/heap_dominators.js <snapshot> 40 \
  --children=1 --depth=3

# 某节点的支配链（可多个 --path）
node --max-old-space-size=16384 scripts/heap_dominators.js <snapshot> 60 \
  --path=7592680 --path=7611083 --path=7611521

# 切断实验：这些节点被移除后能释放多少
node --max-old-space-size=16384 scripts/heap_exclusive_size.js <snapshot> \
  7592680 7611083 7611521

# 边界外推，直到触达 GC roots
node --max-old-space-size=16384 scripts/heap_grow_boundary.js <snapshot> \
  4630163 7592680 7611083 7611521 3357365 --rounds=16 --cap=400000

# 原生句柄 & 访问器安装点
node --max-old-space-size=16384 scripts/heap_native_handles.js <snapshot> 40
node --max-old-space-size=16384 scripts/heap_accessors.js <snapshot> --filter="micro-app"

# 游离 DOM
node --max-old-space-size=16384 scripts/heap_detached_dom.js <snapshot> 20
```

> **注意**：报告中的节点序号（如 `4630163`）只对 2026-09-11 22:55 那份快照有效；第十节的序号（`876859` / `408771` 等）只对 2026-09-12 08:51 那份有效。换快照必须重新定位。
>
> 脚本要求 Node ≥ 18（使用了 `fs.createReadStream` 的异步迭代与 TypedArray）。支配树类脚本在大快照（>800 万节点）上需要 `--max-old-space-size=16384`。

---

## 十、修复进展与验证（2026-09-12 08:51 快照）

本轮针对第六节的两项建议做了修复：

- **`src/sandbox/with/document.ts`**：`createMicroDocument` 改用 `Proxy.revocable`，新增 `dispose()` —— 撤销 document proxy 与 prototype proxy，并摘除 `MicroDocument.prototype` 上挂的原型。destroy 时会断开 `proxyDocument` 闭包。
- **`src/sandbox/bind_function.ts`**：把挂在函数对象上的三个标记属性（`__MICRO_APP_IS_BOUND_FUNCTION__` / `__MICRO_APP_IS_CONSTRUCTOR__` / `__MICRO_APP_BOUND_*_FUNCTION__`）改为 **WeakMap**（含 `value → rawTarget → key` 二级缓存），不再往共享的基础库函数对象上写属性。

### 10.1 硬指标对比

| 指标 | 21:53 | 22:55 | **09-12 08:51** | 变化 |
|---|---|---|---|---|
| 快照文件 | 780 MB | 1.09 GB | **910 MB** | −17% |
| 节点数 | 7,198,547 | 9,695,675 | **8,153,903** | −16% |
| 边数 | 34,341,269 | 48,050,177 | **39,854,679** | −17% |
| 堆 selfSize | 640.4 MB | 648.0 MB | **562.8 MB** | **−13%** |
| `__MICRO_APP_MARK_OPTIONS__` | 91 | 251 | **0** | ✅ 归零 |
| `__MICRO_APP_BOUND_` | — | 18 | **0** | ✅ 归零 |
| `__MICRO_APP_URL__` / `parsedCode` | 0 | 0 | **0** | — |
| 游离（detached）DOM 节点 | 7,603 | 26,631 | **10,167** | **−62%** |
| `CustomWindow` 对象 | 12 | 22 | **18** | −18% |
| `MicroDocument` 闭包 | — | 23 | **19** | −17% |
| `WithSandBox` 实例 | 0 | 0 | **0** | — |
| `CreateApp` 实例（全部 `destroyed=true`） | 12 | 14 | **12** | — |
| **最大单一 JS 锚点（retained）** | 225.4 MB | **273.7 MB** | **9.3 MB** | **−97%** |
| 在场应用数 | 13 | 13 | **18** | 更多 |

> 最后两行要一起看：本次在场的应用**比上次多（18 vs 13）**，堆反而小了 13%，所以这是净改善，不是"少访问了几个页面"。

### 10.2 结构性变化：273.7 MB 的单点簇已被打散

新快照的顶层锚点（支配树 353 轮收敛）：

```
248.2 MB  synthetic  11  (Global handles)        ← GC 根类别节点，非 JS 对象
 22.4 MB  string  876859   (function anonymous() { ;(function(proxyWindow){with(...
 22.4 MB  string  138282   self["webpackChunkwonder_ws_web"]=...
 16.9 MB  string 4517124   (function anonymous() { ... })
 16.9 MB  string  573262   (function anonymous() { ... })
 16.9 MB  string  138309   self["webpackChunkses2_web"]=...
 12.0 MB  string 3900063   (function anonymous() { ... })
 10.3 MB  string  136520   import { xlsx_exports } from "/node_modules/.vite/deps/...
  9.3 MB  closure 408771 "se"   [ses2/js/chunk-vendors.a2fdb50d.js]
  9.3 MB  closure 1597998 "se"  [同上]
  9.3 MB  closure  594780 "se"  [同上]
```

**上一轮独占 273.7 MB 的 `closure 4630163` 已不在榜上，最大的 JS 对象降到 9.3 MB。** 第四节描述的那个 404 MB 强连通体确实被打散了。

最大的锚点整体是 `Global handles`（248.2 MB），但那是 GC 根类别节点，不指向具体泄漏点。

### 10.3 仍然存在的泄漏（约 430 MB）

堆 562.8 MB，对照初始快照的 129 MB，仍有约 430 MB 死应用残留，但已分散为许多独立小块：

1. **6 份大块包裹 bundle 源码**（22.4×2、16.9×3、12.0 MB）+ 若干小块 ≈ **110 MB**。
   其中两份是 **`self["webpackChunkwonder_ws_web"]=...` / `self["webpackChunkses2_web"]=...`** —— 子应用的 **webpack chunk 引导代码**仍作为 Script 源码存活，说明 `webpackChunk*` 全局可能还挂在基座 realm 上。
2. **18 个 `CustomWindow` / 19 个 `MicroDocument`** 仍被 `with` 作用域（`internal:extension`）与 micro-app 闭包（`context:microAppWindow`）持有，持有形状与上一轮相同。
3. **10,167 个游离 DOM 节点**（其中 `wonder-bpm-webcompleteddetails` 一家 5,383 个）。
4. `bindScope()` 按 app 生成全量源码副本的问题仍在（就是上面那 6 份大字符串）。

### 10.4 残留形态与后续观察点

残留主体已经从"无法下手的巨型强连通体"变成三类具体形态，按第十一节 11.1 的修复清单继续收敛即可：

1. **包裹源码字符串**（6 份大块 ≈ 110 MB）——对应 `bindScope` 的 per-app 全量副本，以及 `self["webpackChunk<name>"]` 引导源码仍存活；
2. **`with` 作用域对沙箱对象的持有**（18 个 `CustomWindow` / 19 个 `MicroDocument`）——持有者是 `with` 作用域的 `internal:extension`，而非 `microAppWindow` 自身的属性，所以"清属性"不足以释放；
3. **游离 DOM**（10,167 个）。

> ⚠️ 关于 webpack 运行时：虽然本节数据表明残留主体是"模块闭包"，但**在框架层通用清 `__webpack_require__.c/.m` 已被复核否定**，理由见 11.3。bundle 自身的运行时清理应交给业务应用在其卸载钩子中实施，或由框架提供文档化的钩子。
>
> 本节的节点序号（`876859` / `408771` 等）只对 2026-09-12 08:51 那份快照有效。

---

## 十一、框架侧修复清单与实施边界（2026-09-12 复核）

根据支配树、切断实验和源码生命周期重新复核后，修复项按证据强度分为三类：

### 11.1 已实施：有明确保留链或确定存在长期强引用

| 修复项 | 处理方式 | 保活语义 |
|---|---|---|
| window/document 监听器 capture 与 target 记账错误 | 使用 `(target, type, listener, capture)` 精确记录；按注册目标和 capture 删除 | 隐藏时记录快照，终态销毁时彻底释放 |
| 任意 DOM/EventTarget、Observer、MediaQuery、Worker、WebSocket 等外部资源 | 按 app 记录，终态销毁时断开/关闭 | keep-alive 隐藏不做终态清理 |
| UMD hook、数据中心、路由监听、异步任务、sourceCenter appSpace | destroy 时删除 descriptor、listener、task 和 app 维度源码元数据 | 仅 destroy 清理 |
| iframe 原型补丁、资源节点及沙箱引用 | 保存原 descriptor，destroy 时恢复并断开 iframe Window/Document | 仅 destroy 清理 |
| `MicroDocument.prototype` 的 per-app Proxy | 保持 Proxy 不可撤销；destroy 时恢复原生 prototype，并清空可变沙箱上下文 | 缓存 Proxy 的迟到 teardown 不抛 TypeError |
| 异步 `window.unmount()` | 正常等待 settle；终态 destroy 最多等待 3 秒，随后一次性收尾，并断开 Promise reaction 捕获的 app 引用 | 普通 unmount 不强制超时；destroy 不会永久卡住 |
| `bindFunctionToRawTarget` 在源函数上写 `__MICRO_APP_BOUND_*` | 改用 WeakMap 按“源函数 + target + key”缓存；不再向原生函数或子应用函数写强引用属性 | 函数身份和 this 绑定保持不变 |
| 运行期追加的原生对象 descriptor 快照 | 子应用同步脚本前后记录实际变化，实例级所有权；最终释放时仅恢复仍等于子应用写入值的 descriptor；动态快照去重使用 WeakSet | 基座后续覆盖的值不被回滚；UMD 普通 unmount 不恢复 |
| 监听器诊断标记与 iframe bound handler expando | 精确记账已不依赖函数属性；移除标记，iframe handler 改用局部 WeakMap | 不改变 add/remove 行为 |
| 基座路由一次导航产生多次 history 中间态 | search 模式按 app 合并本轮 `pushState/replaceState`，只把最终 URL 同步给子应用 | 不写死 todo/bpm 路由 |

### 11.2 需要新快照验证，不能提前宣称已根治

- `CustomWindow`、`MicroDocument`、游离 DOM 是否归零；
- 之前 4 组 `document.ts` Proxy `get/set` 访问器是否消失；
- `__MICRO_APP_BOUND_DOCUMENT_FUNCTION__`、`__MICRO_APP_MARK_OPTIONS__` 是否不再新增；
- 最大 retained 节点是否仍为包裹后的 bundle 字符串或 webpack 模块闭包；
- 相同操作循环多次后，强制 GC 的堆基线是否持续增长，而不是只比较“首次加载前/首次加载后”。

### 11.3 暂不实施：证据不足且破坏风险高

**不在框架中通用清空 `__webpack_require__.c/.m`。** 原因是这些变量通常位于 bundle 闭包而非沙箱全局，micro-app 无法可靠取得；不同 webpack 版本、模块联邦、共享依赖和运行时拆包结构也不一致。强行扫描和清空可能破坏仍保活的应用、共享 runtime，或造成重新打开后模块初始化异常。

404 MB 边界增长结果证明存在大型强连通图，但没有证明“清 webpack 缓存”是安全且充分的切口。只有新快照确认框架所有外部资源与属性边均已消失、仍由业务应用自身的全局单例/模块缓存保留时，才应在具体子应用的卸载钩子中按其构建系统实施定向清理，而不是在 micro-app 内做通用猜测。

---

## 十二、后续验证基线

修复后重新抓快照，应看到：

- [x] 切断全部带 `__MICRO_APP_MARK_OPTIONS__` 的监听器 → 释放量保持 KB 级（22:55 已达成为 7.6 KB）；09-12 标记数归 0
- [x] 支配树中最大的 retained size 节点 → 不再是大块强连通体（273.7 MB → 9.3 MB）；**但仍存在包裹源码字符串（22.4 MB 级）**
- [ ] `CustomWindow` 存活数 → 0（当前 18）
- [ ] `MicroDocument` 闭包数 → 0（当前 19）
- [ ] 游离 DOM 节点数 → 接近 0（当前 10,167）
- [ ] 重复的包裹源码副本数 → 每个 URL 至多 1 份（当前仍有 6 份大块）
- [ ] `webpackChunk*` 引导源码不再作为存活 Script 源码出现

---

## 十三、已确认但暂不修改的项（2026-09-12 决策记录）

> 历史记录：13.1、13.3 已由下面第十四节的代码评审裁定覆盖，不再作为当前行为说明。

以下三项经复核后确认**保持现状**，此处记录结论与已知的副作用，避免后续重复排查。

### 13.1 iframe 沙箱在 umd 模式下 unmount 会清 timer / 关 WebSocket —— 确认为有意行为

- 现状：`iframe/index.ts` 的 `stop()` 只传 `{ clearData }`（丢掉了 `umdMode` / `destroy`），
  `releaseGlobalEffect` 的开关是 `(!keepAlive && !isPrerender) || destroy`，**不含 `umdMode`**；
  而 `with/index.ts:452` 是 `(!umdMode && !keepAlive && !isPrerender) || destroy`。
- 决策：**保持 iframe 的现状**，即 iframe + umd 应用 unmount 时会释放 timer / WebSocket / observer。
- 已知副作用（需要接受或后续单独处理）：
  1. `iframe/window.ts` 中"四模式"注释写着 `umd-mode(normal): not clear timers`，与现状矛盾，**注释是错的**；
  2. remount 走 `rebuildEffectSnapshot()` 只重建**事件**、不重建 timer，且 umd 子应用 JS 不会重跑 ——
     子应用的轮询/长连接在 unmount 后无法恢复。

### 13.2 `sourceCenter.releaseApp` 在 appSpace 为空时整条逐出 entry —— 确认为有意（内存优先）

- 现状：`source_center.ts` 的 `releaseApp` 在 `appSpace` 清空后直接 `sourceList.delete(address)`。
- 决策：**维持整条逐出**，destroy 后连源码文本一起释放，优先保证内存回收。
- 已知副作用：
  1. prefetch 结果无法被同名真实应用复用 —— 真实应用需要重新下载 + 重新 bind + 重新 parse；
  2. `scripts.ts` 中那段"依赖同名复用"的注释（`getExistParseResult` 相关说明）已不再成立，**注释是过期的**。

### 13.3 `formatAppURL('abc')` 的行为与两处测试的规格冲突 —— 待定

**这是本次复核发现的一处真实不一致，没有修改任何代码。**

- 现状：`formatAppURL('abc')` 返回 `'http://localhost/abc'`。
  原因见 `libs/utils.ts:317`：`createURL(addProtocol(url), location.href)` 传了 base，
  裸相对串会被解析成相对当前页面的绝对地址。
- 冲突方一：`src/__tests__/unit/utils.test.ts` 断言 `formatAppURL('abc')` 应为 `''`。
- 冲突方二：`src/__tests__/micro_app_element.test.ts:90` 用 `url="abc"` 并期望元素层报错，
  而 `formatAppURL` 返回 `''` **正是**元素层判断"url 非法"的信号（`micro_app_element.ts:155`）。
- 即：两处测试都把"裸相对字符串非法"当作契约，而实现会把它解析成一个看似正常、实际 404 的地址。
- 影响面：若按测试修实现（返回 `''`），依赖相对 url 的用户会受影响；若按实现改测试，
  等于正式承认"相对 url 合法"。**两者都是产品决策，留待维护者裁定。**
- 现状记录：`utils.test.ts` 中该断言保持失败（本地 `yarn test` 可见）。
  另需说明：**本仓库的 GitHub workflow 不执行 jest**，因此不会让 CI 变红。

> 附：`utils.test.ts` 中"目录型 url 应补尾斜杠"的那条断言已按 `utils.ts` 中
> `BUG FIX: Never using '/' to complete url`（issue #1147）修正为不补斜杠。

---

## 十四、Claude Code 改动复核与实施（2026-09-12）

### 已采用并补全

- 保留 destroyed/迟到回调保护、同名新实例保护、iframe 提前销毁的 optional chaining。
- 将 appInstanceMap/ownership 判断移至独立 app_registry，避免 source loader 反向导入 CreateApp 的循环依赖。
- 异步脚本任务改为实例所有权，旧实例销毁会释放自己的任务，不清除同名新实例任务；payload/owner 都会清空。
- terminal cleanup 每一项独立捕获异常；日志打印错误文本而非 Error 对象，避免 DevTools 长期持有错误栈上下文。
- 默认 iframe 普通卸载时释放旧沙箱与旧 realm 编译的 Function，保留源码元数据和数据，重新挂载使用新 realm。
- iframe UMD 普通 unmount 保留 timer/observer/socket，destroy 必须释放，与 with 沙箱保持一致。
- 裸相对 app URL 判为非法，协议相对 URL 仍支持；不补目录尾斜杠的测试修正保留。

### 撤销的高风险兜底

- 不再 revoke Window/Document/Document.prototype Proxy；缓存引用可安全完成迟到 teardown，dispose 只清上下文并拆除原型链，销毁后的事件/定时器新增会被阻止。
- 不再向基座派发伪造 mousedown/mouseup；最后 MouseEvent 的清理应属于实际保存它的 click-outside 组件。
- 不再删除 Vue 私有 __vnode/__vueParentComponent/__vue_app__/_vei 字段；框架只删除自身安装的 DOM adapter。
- 不在最后一个沙箱 stop 时无差别回滚共享原生对象所有 descriptor；改为脚本执行期变化记账和实例级条件恢复，保留 polyfill 引用链的清理能力。
- 不按“活跃沙箱数量”猜测无主监听器归属，不批量删除基座监听器，也不 LRU 淘汰 disposed app 墓碑。
- 保留 createtype 前置 tsc 声明生成：构建实测证明原脚本缺少 lib/lib/index.d.ts 会失败，撤销最初“与修复无关应回退”的评审判断。

### 仍需明确的边界

- appSpace、全局 EventTarget/Worker/样式注册表仍按 appName 索引；同名实例并发的完整隔离需要 generation token 贯穿这些注册表。当前任务已实例隔离，其他表继续使用 ownership guard，不声称代际问题全部解决。
- 同步沙箱脚本执行期的 intrinsic 变化已按实例记账；异步回调中的直接修改，以及子应用同步调用基座代码后发生的共享原型改动，仍不能完全凭来源区分。基座后续覆盖的 descriptor 会被保留；不声称覆盖所有异步污染。
- sourceCenter 终态 destroy 仍采用内存优先逐出；prefetch 原始源码缓存与 realm 缓存的分层复用属于后续独立优化。
- 以上修改不等于快照验证完成；CustomWindow/MicroDocument/游离 DOM 和多轮 GC 基线需要重新抓取验证。

### 本轮验证记录

- TypeScript `--noEmit --types node`、修改源码 ESLint 通过。
- 15 个定向生命周期/原型/路由套件、77 个用例全部通过。
- micro-app production build、类型声明生成和 afterbuild 通过；未打包 wonder-core-web。
- 完整 Jest 为 24 个套件通过、3 个失败；131 个用例通过、12 个失败、3 个跳过。
  剩余失败均在本轮评审前已出现：create_app/main 集成生命周期超时、日志文案断言、ShadowRoot 使用 Element.querySelector 的调用错误。
  这些未通过用例不被删除、不改断言掩盖，也不能据定向测试通过宣称全量回归完成。

---

## 十五、13:42 快照分析与 `style` 锚点（2026-09-12）

### 14.1 硬指标对比

| 指标 | 22:55 | 08:51 | **13:42** | vs 08:51 |
|---|---|---|---|---|
| 快照文件 | 1.09 GB | 910 MB | **504 MB** | **−45%** |
| 节点数 | 9,695,675 | 8,153,903 | **4,422,602** | **−46%** |
| 边数 | 48,050,177 | 39,854,679 | **20,841,467** | −48% |
| 堆 selfSize | 648.0 MB | 562.8 MB | **343.8 MB** | **−39%** |
| `__MICRO_APP_MARK_OPTIONS__` 等 5 项标记 | — | 全 0 | **全 0** | — |
| 游离（detached）DOM | 26,631 | 10,167 | **6,387** | −37% |
| `CustomWindow` 对象 | 22 | 18 | **8** | −56% |
| `MicroDocument` 闭包 | 23 | 19 | **9** | −53% |
| `CreateApp` 对象（全部 `destroyed=true`） | 14 | 12 | **5** | — |
| **在场微应用数** | 13 | **18** | **6** | **−67%** |

分类型（13:42 vs 08:51）：`native` −53%、`code` −52%、`closure` −59%、`object` −47%、`string` −26%。

> ⚠️ **必须注意最后一行**：本次只有 **6 个**微应用，而 08:51 是 **18 个**。
> 因此节点 −46%、堆 −39% 里有多少来自修复、多少来自工作负载变轻，**单次快照无法区分**。
> 结论：**不能据此判定"已修复"**，见 14.5 的可比基线建议。

### 14.2 结构性变化：最大锚点易主

```
(GC roots)
├─ 101.2 MB  native       HTMLDocument                       ← 新第一大锚点（基座 document）
├─  34.9 MB  object shape  system / Map
├─  22.4 MB  string        (function anonymous() {...})      ← 包裹源码
├─  22.4 MB  string        self["webpackChunkwonder_ws_web"]=...   ← 仍是它（见 10.3）
├─  17.2 MB  object        Window [JSGlobalObject] / localhost:3000
├─  12.0 MB  string        (function anonymous() {...})
├─  10.3 MB  string        import { xlsx_exports } ...
├─   4.0 MB  code          Script / @fs/E:/work/micro-app/lib/...   ← micro-app 自己的 bundle
└─   2.0 MB  native        <style data-origin-href="/css/chunk-vendors.8d92a5f8.css">   ← 见 14.4
```

支配树 **401 轮**收敛（0 changes）。
**上一轮那种"单个闭包独占 273.7 MB"的强连通体已不存在**；第一大锚点变成"能从活的基座 document 走到的全部"。

### 14.3 剩余最大热点：`wonder-ws-web` 的 6,181 个游离节点

占全部游离 DOM 的 **96.8%**。该应用在堆里有 **2 个 `<micro-app name="wonder-ws-web">` 容器元素**（而 `CreateApp` 只有 1 个），说明本次会话挂载过两次。

两条保留链（都指向同一个容器）：

```
① 基座 Vue 树侧
   Vue 组件实例 → __vueParentComponent / __vnode / subTree / ctx
     └─ <micro-app name="wonder-ws-web"> 容器（147587，已游离）
          仍挂着 micro-app 的 handleAttributeUpdate
        └─ 整棵子树 6,181 个节点

② micro-app 侧
   closure "nextAction"（147584，属于 lib/index.esm.js）
     ← 匿名闭包 1831364（与 AppTask payload 1831363 同批分配）
     → nextAction 捕获 this(CreateApp 147586) → container(147587) → 整棵 DOM
   该 CreateApp：state=unmount、umdMode=true、iframe=false、useSandbox=true
```

**与上一轮的差异**：08:51 时链条主要走 `with` 作用域 + 沙箱对象；现在**基座 Vue 侧的引用比重上升**。
`nextAction` 那条是 micro-app 侧的：`CreateApp.mount` 里的 `nextAction` 被一个仍在的闭包捕获，而它闭包持有 `this` 与 `container`。

### 14.4 `style` 锚点：2.03 MB 已解析 CSS（完整链条已验证）

**现象**：堆里有一个 2.0 MB 的 `<style data-origin-href="/css/chunk-vendors.8d92a5f8.css">`（节点 1831739）是顶层锚点。

**切断它释放**：`2.03 MB / 31,330 个节点，全部是 native`

| 类型 | 数量 | 字节 |
|---|---|---|
| `blink::StyleRule` | 5,026 | 569,968 |
| `blink::ImmutableCSSPropertyValueSet` | 5,640 | 498,816 |
| `blink::CSSSelector::RareData` | 6,434 | 463,248 |
| `blink::CSSVariableData` | 2,900 | 210,704 |
| `blink::CSSValueList` / `CSSUnparsedDeclarationValue` / `CSSFunctionValue` / `CSSNumericLiteralValue` | … | … |

**完整的持有链（每一跳都用 `incoming` 验证）**：

```
子应用 wonder-ws-web 的 chunk-vendors.a695a4d2.js 里的 11 个闭包
   （s / c / u / d / h / p / f / v / m / hq / jL —— 全部出自该 bundle）
└─ Context  scope @1831495  槽位 l
   └─ Map (915042)                      ← table 里存着 <micro-app-head>
      └─ internal:table → array (3903493) → internal:6 → <micro-app-head> (1831763)
         └─ <style …chunk-vendors.8d92a5f8.css> (1831739)
            └─ CSSStyleSheet                 ← 只被这个 style 元素自己持有
               └─ 5,026 条已解析 CSS 规则
```

**机制（因果方向要注意）**：

1. 同一 `<micro-app-head>` 下还有大量 `data-vc-order="prependQueue" data-css-hash="…"` 的 `<style>` —— 特征指向 **ant-design-vue 的 cssinjs**。
2. 子应用的 UI 库把 **`document.head` 作为缓存 Map 的 key**；而在 with 沙箱里，子应用的 `document.head` 解析到的正是 micro-app 造的 **`<micro-app-head>`** 元素。
3. 该 Map 是模块级、长期存活的 → 钉住 `<micro-app-head>` → 钉住整棵子树 → 钉住 `<style>` 的 `CSSStyleSheet` → 钉住 5,026 条已解析规则。

即：**是「子应用的库 → 基座共享元素」，不是「micro-app → 子应用」。** micro-app 无法知道子应用把共享元素存进了哪个 Map，所以这条**没法在框架侧直接切断**。

**为什么现有的 `container.innerHTML = ''` 没救回来**：
它把 `<micro-app-head>` 从容器里摘掉，但**没有清空 head 自己的子节点**。head 被外部 Map 拿着，它的子节点、以及 `<style>` 的 `CSSStyleSheet`（连同 5,026 条规则）就一起活着 —— 而 CSS 解析结果的成本远大于 DOM 节点本身。

**建议的缓解（尚未实施，待决定）**：
在 destroy 路径里对 `micro-app-head` / `micro-app-body` 也做一次 `innerHTML = ''`（或至少清空所有 `<style>` 的 `textContent`）。
- 收益：每个应用可释放 MB 级的已解析 CSS（本例单个 style 就是 2 MB）；
- 风险：极低 —— 应用已进入终态销毁，这些 DOM 本来就要丢弃，且 `container.innerHTML = ''` 已在做同类操作；
- **局限：这是缓解不是根治** —— 根因是"子应用库用基座共享元素做 key"，同样的模式若 key 的是别的共享元素（如 `document.body`）仍需逐个处理。

### 14.5 下一步：先让基线可比

绝对值下降明显，但因工作负载不同（6 vs 18 个应用）**无法归因**。在继续优化前，建议先建立可复现基线：

1. 固定操作序列：挂 A → 卸 A → 挂 B → 卸 B …… 循环 N 次（N ≥ 10）；
2. 每轮结束手动触发 GC 后记录堆大小；
3. 观察**基线是否随循环次数单调增长**，而不是只比较"首次加载前 / 首次加载后"。

只有这样才能区分"修好了"与"这次用得少"。这也是第十二节基线项里唯一还没落地的一条。

**仍待处理的具体项**（按优先级）：
- （a）`self["webpackChunk<name>"]` 引导源码仍作为存活 Script（22.4 MB），见 10.3；
- （b）`wonder-ws-web` 的 6,181 个游离节点（双容器 + Vue 树 + `nextAction`）；
- （c）`style` 锚点的解析后 CSS 缓解，见 14.4；
- （d）约 92 MB 的包裹 bundle 源码字符串（22.4 / 21.3 / 16.9×2 / 12.0 MB …）。

### 终态 DOM 清理的边界补充（2026-09-12，Codex）

- 直达 `actionsForCompletelyDestroy` 也清空容器，不只断开实例字段。顺序为本实例 style 内容、head/body 子树、容器。
- 遍历遇到嵌套 micro-app（含自定义后缀）停止深入；只有注册实例的容器/ShadowRoot host 与该节点一致，才调用其自己的 `unmount({ destroy: true, clearData: true, keepRouteState: false })`。不按名字误销毁同名替换实例。异步子应用卸载沿用已有终态等待机制，父清理不会提前抹掉子应用 style 内容。
- 普通卸载不深清；真实 `hiddenKeepAliveApp` / `showKeepAliveApp` 方法测试验证节点身份、输入值及样式保持，随后终态清空。
- 定向三套件 14 项测试通过；生产类型检查 `tsc --noEmit --types node`、源码及测试显式 lint、micro-app build 通过。未打包 wonder-core-web。完整 `tsc --noEmit` 受现有 `@types/babel__traverse` 声明兼容错误阻挡。
- 测试使用真实 CreateApp 隐藏/展示及同步子应用卸载方法，但不是完整浏览器/公司菜单端到端测试；iframe 隔离嵌套框架、跨注册表代际归属仍需实际验证。本次不清 webpack 私有模块表，也未解决 Error 栈持有者。

---

## 十六、可复现的内存基线（2026-09-12 定稿）

### 16.1 为什么必须做这个

截至目前的四份快照，在场微应用数分别是 **6 / 17 / 21** 个（见十五节与十四节），
**彼此不可横比**。已出现过的两次误判都源于此：

- 13:42 的"堆 −39%" 是因为只挂了 6 个应用，不是修复收益；
- 14:41 的"体积翻倍" 是因为挂了 21 个应用，不是回归。

**只有固定操作序列、记录每轮 GC 后的数值，才能回答"是否仍在累积"。**

### 16.2 固定这些变量（否则数据不可比）

| 变量 | 要求 |
|---|---|
| 应用集合 | 明确列出，建议只用 2 个固定应用；**不要用 `WS-Component-XXX-<时间戳>` 这类每次唯一命名**的应用（它们天然产生新条目） |
| 操作序列 | `挂A → 等T → 卸A(destroy) → 等T → 挂B → 等T → 卸B(destroy) → 等T` = 1 轮 |
| 等待时间 T | 固定值（建议 2s），全程一致 |
| 轮次 | ≥ 10 轮，每轮都记录 |
| GC | 每轮结束后强制 GC，且方式固定（见 16.3） |
| DevTools | 全程同一模式：要么一直开着 Memory 面板，要么一直只用 CDP 脚本。**不能中途切换** |
| keep-alive | 明确开或关；两种语义不同，不能混在同一组数据里 |
| 采集点 | 固定在"destroy 完成 + GC 之后" |

### 16.3 两种采集模式

**模式 A：DevTools Memory 面板**
手工点垃圾桶按钮触发 GC，再点 "Take snapshot"。
简单，但面板会启用 InspectorCSSAgent / InspectorDOMAgent 等 agent ——
实测某份快照里 `blink::InspectorCSSAgent` 独占 6.3 MB 并成为顶层锚点。

**模式 B：CDP 脚本（推荐）**
不打开面板，只开调试端口：

```powershell
# 先完全退出 Chrome，再启动（--user-data-dir 必须给）
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\chrome-heap-profile" `
  --js-flags="--expose-gc" `
  http://localhost:3000
```

```bash
# 每轮抓一份（--gc 会做两轮强制 GC 并各等 800ms，让终结器跑完）
node scripts/cdp_heap_snapshot.js --out=E:/Heap-round1.heapsnapshot --gc
```

> **注意**：模式 B 仍会建立 `DevToolsSession`（实测 9 个节点），只是不启用那些面板 agent。
> 因此**不要把模式 A/B 的结果混着比** —— 选了就一直用同一种。

### 16.4 每轮记一行

```bash
node --max-old-space-size=16384 scripts/heap_metrics.js <snapshot> \
  --label=round-3 --out=heap-baseline.jsonl
```

`heap_metrics.js` 只做 1 次节点扫描 + 1 次边扫描，**1 GB 快照约 13 秒**，适合每轮都跑。
输出一行 JSON（见脚本头部注释的字段说明），追加到 `heap-baseline.jsonl` 后可直接看趋势。

支配树很慢（大文件约 20 分钟），**默认关闭**；只在「初始化 / 首轮 / 末轮」三份上加
`--dominators`，用于对比最大锚点是否变化。

### 16.5 记录表模板

| 轮次 | 时间 | usedJSHeapSize | 堆 selfSize | 节点数 | 游离DOM | CustomWindow | MicroDocument | apps | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| 初始化 | | | | | | | | | 首屏，未挂任何微应用 |
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| … | | | | | | | | | |
| 10 | | | | | | | | | |

（上表可用 `heap_metrics.js --out=` 自动填后六列，`usedJSHeapSize` 用 16.6 的片段取。）

### 16.6 取页面侧内存数字（可选）

粘进 console（模式 A）或 `Runtime.evaluate`（模式 B），在每轮 destroy+GC 后执行：

```js
(() => {
  const m = performance.memory
  console.log(JSON.stringify({
    t: new Date().toISOString(),
    usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1),
    totalMB: +(m.totalJSHeapSize / 1048576).toFixed(1)
  }))
})()
```

### 16.7 判据

- ❌ **不要求严格单调增长** —— 首次加载增长、随后平台化可能是正常缓存；
- ✅ 看**后几轮（如第 6~10 轮）关闭后的基线是否持续抬升**；
- ✅ 看**每轮增量是否收敛**：若 `第 N 轮 − 第 N-1 轮` 维持一个稳定正值，即为累积泄漏；
- ✅ 三个快照（初始化 / 首轮结束 / 第 10 轮结束）用 `--dominators` 对比最大锚点是否换人。

### 16.8 已知偏差源（读数前先排除）

1. **DevTools 自身持有**：`InspectorCSSAgent` 实测 6.3 MB；被 console 打印过的 `Error`
   会连带钉住其栈上捕获的整个作用域链（这正是十四、十五节追到的那类锚点）。
2. **工作负载**：应用数、访问过的页面数差异会直接改变堆大小，必须固定（16.2）。
3. **抓快照本身的开销**：snapshot 会短暂放大堆；固定"何时抓"比抓几次更重要。
4. **`heap_metrics.js` 的一个陷阱（已修）**：CSS 节点按名字匹配时**必须排除 string 类节点**
   —— string 节点的 name 就是内容，包裹后的 bundle 源码里含 `StyleRule`/`CSSSelector` 字样，
   会让 `parsedCSS` 从 ~27 MB 虚高到 ~98 MB。若将来改动匹配逻辑，务必与
   `heap_symbol_summary.js`（它跳过 string 类型）交叉验证一次。

### 16.9 复现命令汇总

```bash
# 单快照一行指标
node --max-old-space-size=16384 scripts/heap_metrics.js <snapshot> --label=round-N --out=heap-baseline.jsonl

# 单快照一行指标 + 最大锚点（慢，只在三份关键快照上跑）
node --max-old-space-size=16384 scripts/heap_metrics.js <snapshot> --label=init --dominators

# 关掉 DevTools 面板抓快照
node scripts/cdp_heap_snapshot.js --out=E:/Heap-roundN.heapsnapshot --gc
```

## 十七、累积保留的防御性修复（2026-09-13，Codex）

- AppTask 新增可选 payload disposer。仅框架主动传入时释放自己的字段，不遍历修改任意调用方对象；complete/dispose 都在摘除注册记录后执行一次。
- execScripts 任务显式清空 app、initHook、fiber/defer 状态；任务创建与执行作用域分离，执行回调不再共享 app/initHook 参数槽。正常结束先调用 hook，再释放 payload。
- mount 就绪、失败、BEFOREMOUNT、UMD 注册与脚本完成回调改用模块级工厂及可释放状态；就绪任务完成/取消后清空实例和参数引用。容器参数不再进入脚本完成 hook 的词法作用域。未改路由策略。
- 终态清理实例拥有的 style 时先删除 CSSOM rules，再清 textContent；不可访问样式表独立兜底，不阻断其它销毁步骤。保活切换仍不清理。
- 五套定向测试 28 项通过，包括外部保留 payload、通用任务不修改调用方对象、正常脚本 hook 执行顺序、迟到 readiness 不执行、insertRule 规则释放及保活/嵌套边界。尚未用浏览器固定轮次证明增长消失。
- 这是针对已确认引用形状的防御性切口，不代表找到了 Error 的最终活持有者。未修改子应用 CycleException、未清 webpack 私有模块表。handleMounted 的 UMD Promise 回调等其它生命周期作用域仍需后续快照验证。

## 十八、根路径分析：这是一个环，不是一条链（2026-09-13，Claude Code）

> 独立复核最新 `E:/heap-baseline/round-10`（Codex）：共 1211.9 MB。屏蔽 DevTools console 后为 709.3 MB，独占变化 502.6 MB；联合屏蔽全部 XMLHttpRequest 及 Error 4005，按 WeakMap key 条件修正后为 501.4 MB。这是快照图切割，不是实际 GC 验证。旧窗口 4043230 的真实入口包括 Pending activities → XHR 9642341/9642353 → Axios onloadend → Promise → Vue/审批回调。8337036/wonder-dashboard 与 6370617/wonder-ws-dataDetail-global 是合法存活实例，Symbol.useSetter 到 dashboard 不是旧窗口泄漏。
>
> 源码证据：wonder-bpm-web/src/utils/axios/index.ts 从底座 `globalPlugin.useAxios()` 创建 Axios；底座 createAxios 默认 timeout 为 `36000 * 1000`（10 小时）、ignoreCancelToken=true。因此微应用 XHR URL 代理不覆盖共享工厂内部的底座 XHR。新增 with 沙箱实例级 XHR 终态 abort 仅覆盖真正通过该代理创建的请求；共享工厂请求还需要独立生命周期绑定，不能宣称该补丁解决上述根链。尚未修改底座 Axios 文件。

> 2026-09-13 Codex 实施补充：本节保留历史分析；当前局部实现是在 with 沙箱的同步 `runScript` finally 中，完成写入记账后立即条件恢复 `Function.prototype.toString`，不再等到 destroy。见 `releaseSharedFunctionToStringPatch`。仅恢复已归属本实例且当前描述符仍匹配的补丁；其它 polyfill 不提前恢复，基座后续替换不覆盖。它不依赖更换 Function 身份、不删库内部模块表、不修改业务路由。作用是限制下一段脚本读取前的共享补丁暴露期，而不是独立 realm 隔离。
>
> 五套定向回归 24 项通过、源码 lint 和 micro-app build 通过，未打包 wonder-core-web。测试覆盖销毁恢复无法撤销捕获、边界恢复阻止后续捕获、其它 polyfill 保持、基座替换保护、runScript 正常/抛错 finally 路径，以及保活/路由回归。真实产品安装/捕获身份对账尚未完成；未重新分析整份 GB 级快照或证明全部入口消失。
>
> 兼容边界：core-js 对原生函数源码的伪装不再持续影响共享原型；库若依赖脚本间持续的伪装可能有差异，须验证。脚本执行中触发另一应用、异步或 ESM 执行后的原型写入未被此同步边界完全覆盖。必须重启底座使用新产物，重复 baseline2 同序列；若增长不变，不能继续宣称此切口解决了主泄漏。此前对原生入口的联合切割，只排除指定入口，不能视为全部原生持有的上界。

十七节结尾写着"不代表找到了 Error 的最终活持有者"。本节就是去回答这个问题。结论是：**那个"最终持有者"不存在——被保留的不是一条从根到叶的链，而是一个闭合的环。**

数据源：`round-5.heapsnapshot`（25,417,618 节点 / 134,627,161 边 / 1,754.9 MB）。

### 18.1 先纠正一个前提：快照里几乎所有对象都是可达的

从 `(GC roots)` 做一次全图前向 BFS（跳过 weak 边）：

```
可达 25,417,540 / 25,417,618 节点（99.9997%）
不可达仅 78 个
可达节点 self_size 合计 1,754.9 MB
```

**heap snapshot 按定义只包含可达对象。** 所以"它为什么可达"没有区分度——任何节点都可达。有区分度的问题是**"从哪条边可达"**，以及**"切掉哪条边它会不可达"**。此前所有"找到了根"的判断，都栽在把最短路径当成了唯一路径。

### 18.2 三条候选根，逐个切割证伪

| 候选 | 边 | 切掉后释放 | 目标是否仍可达 |
|---|---|---|---|
| DevTools 控制台 | `(Global handles) --internal:509 / DevTools console--> Array` | 3,670 节点 / 0.1 MB | **是**（43 跳 → 111 跳，改走另一条） |
| 全局句柄持有的 Error | `(Global handles) --internal:1394--> Error` | **7 节点** | **是**（退回控制台那条路） |
| micro-app 活作用域 | —— | —— | 从未成立，见 18.6 |

那个 Error（节点 4300）的全部持有者是：

```
(Global handles) --internal:1394-->  [4300] Error      ← 唯一强边
(Global handles) --weak:2883------>  [4300] Error      ← 弱边，不保留
```

**它没有任何 JS 侧持有者**——纯粹挂在原生句柄上。但即使如此，切掉它也只释放 7 个节点。

两条路互为备份，切任一条另一条顶上。**"最短路径"每次指向不同节点却都不断——因为在环上最短路径本来就是任意的。**

### 18.3 穷举持有者：被销毁的 CreateApp 只有 2 个

改用反向 CSR 索引列出**全部**入边（不是最短路径）：

```
[6089104]  Object            --property:app-->  CreateApp
[17463293] Context @3865153  --context:this-->  CreateApp      ← 只有这两条
```

`3147771` 同样只有 2 条。第二层 4 条、第三层 9 条；边界扩展显示**每层恰好 ~4 条入口边**——对应 4 个被销毁的应用，是四条平行单链。

其中 `context:this` 是 **V8 Context 的 `this` 槽**（`mount()` 的词法作用域把 `this` 绑定到 CreateApp）。**JS 层没有任何 API 能清空它**——这正是十七节采纳"把回调移出 `mount` 词法作用域"（方案 B）的根本理由。

### 18.4 关键否证：CreateApp 是乘客，不是载体

```
拦截 4 个 CreateApp 的全部出边 → 仅 109 个节点 / 0.00 MB 变为不可达
六轮边界扩展后                 → cluster 457 节点 / 0.02 MB
```

被销毁的 CreateApp 上 `container = null`、`sandBox = null`，**它后面几乎没有东西**。

所以"切断 payload.app 和 context:this"能回收的只有 110 个节点——**与 270 MB/轮 无关**。这个结论推翻了此前"方案 B 是唯一切口"的推理链。

### 18.5 那 880 MB 的持有者结构（正常，不是泄漏）

5 份 23,496,120 字节（11,748,062 字符）的包裹源码，每轮一份。对其中一份做**完整**持有者枚举，L1 只有 3 类共 884 条：

```
882 × sliced string        --internal:parent-->   ← V8 字符串表示层，SlicedString 保父串
  1 × concatenated string  --internal:first-->    ← 同上
  1 × system / Script      --internal:source-->   ← 唯一的结构性持有者
```

该 Script 被 **40,000+ 个 `SharedFunctionInfo`** 通过 `internal:script` 持有——即 bundle 里每一个函数：

```
10155 SFI(匿名) / 1366 SFI(setup) / 903 SFI(value) / 647 SFI(Z) / …
     --internal:script-->  system / Script  --internal:source-->  23.5 MB 源码
```

**这是完全正常的结构**：源码由 Script 持有，Script 由该 bundle 的函数持有。它唯一说明的是**"这个 bundle 还活着"**，而不是"有人错误缓存了源码"。追到这里触底，再往上没有可归因的框架侧错误。

### 18.6 CustomWindow：闭合环

73 个 `CustomWindow` 实例（+1 个类闭包），完整入边聚合：

| 条数 | 持有者 | 边 |
|---|---|---|
| 73 | `native / JSProxy` | `hidden:` |
| 73 | `Context @6017183`（73 个不同 Context） | `context:microAppWindow` |
| 73 | `Context @6017221`（73 个不同 Context） | `context:microAppWindow` |
| **17** | `WithSandBox` | `property:microAppWindow` |
| 3~8 | 子应用函数作用域 | `internal:extension` |

注意 **17 vs 73**：`WithSandBox` 只持有 17 个，而存活应用正是 17 个——**所有已销毁应用的 sandbox 对象确实被释放了**，`destroy()` 在这一步没有失职。剩下 56 个 CustomWindow 没有任何 sandbox 持有者。

再追两跳：

```
L1:  Context @6017221 --context:getEventTarget-->  closure "getEventTarget"
     （每个闭包的唯一持有者就是它自己的作用域）
L2:  389 条 = 231 匿名闭包 + 73 getEventTarget + 17×5 (record/reset/construct/rebuild/release)
L3:  CustomWindow --property:setTimeout/addEventListener/removeEventListener/
                          dispatchEvent/setInterval/clearInterval-->  闭包
```

于是：

```
CustomWindow.addEventListener = 闭包 ──┐
CustomWindow.setTimeout       = 闭包   │ 这些闭包由 Context @6017221 创建
        ↑                              ↓
        │                    Context @6017221
        │                     ├─ getEventTarget   ← 自指
        └──── microAppWindow ─┴─ microAppWindow   ← 局部变量槽
```

**整条环完全在沙箱内部闭合。** 离开这个环的边只有两条：`JSProxy --hidden-->` 和子应用作用域的 `internal:extension`——**都在子应用那边**。

**`destroy()` 清不掉它，不是漏清了属性，而是这些引用是 V8 Context 的局部变量槽（`microAppWindow`），JS 层写不到。** 清 `sandBox.microAppWindow` 不影响 `Context @6017221` 里的同名槽。

（这也修正了此前转述的一条外部判断："`WithSandBox.destroy()` 没有彻底清空 CustomWindow 的属性和代理引用"——**位置指对了，机制说错了**：不是漏清，是清不到。）

#### 18.6.1 独立快照复现（2026-09-13，`E:\heap-baseline2\round-3`）

上面的结构来自 `round-5`。为排除"这只是那一份快照的偶然"，在另一套**完全独立**的会话上复测——不同的操作序列、不同的浏览器状态、45 个 CustomWindow：

| 结构 | round-5 | round-3（独立复现） |
|---|---|---|
| `CustomWindow` 实例 | 73 | 45 |
| `JSProxy --hidden-->` | 73（1:1） | 45（1:1） |
| 两组 `Context --context:microAppWindow-->` | 73 + 73 | 44 + 44 |
| **`WithSandBox --property:microAppWindow-->`** | **17** | **17** |
| `closure getEventTarget --internal:context-->` | 73 | 44 |
| `closure native_bind --internal:bound_this-->` | 357 | 226 |
| `Object --property:exports/global/element-->` | 673 | 415 |
| **孤儿 CustomWindow（无 sandbox 持有者）** | **56** | **28** |

两次都**恰好 17 个**有 `WithSandBox`，而两次的存活应用数都正好是 17。所以 18.6 的机制是稳定的：

> **`destroy()` 每次都如实释放了 sandbox 对象，孤儿窗口每次都留下。** 45 个实例里 28 个无主，且这个比例随轮次累积。

`getEventTarget`、`native_bind`（core-js 把 `this` 绑到代理上）、子应用模块导出持有代理——三条边两次都在。

**这个环的代价可以量化**（round-1 → round-3，共 2 轮，总增长 531.5 MB；每轮 265.8 MB）：

```
+209.3 MB = 39.4%  包裹后的 bundle 源码：10 个 bundle，每个每轮恰好 +1 份副本
                   单份大小 22.41 / 21.33 / 17.30 / 16.93 / 16.92 / 2.74 / 2.46 / 1.90 / 1.89 / 0.77 MB
+ 36.5 MB =  6.9%  array (object properties)        ×197,153
+ 29.9 MB =  5.6%  Object                           ×1,063,441
+ 20.1 MB =  3.8%  array (object elements)          ×460,124
+ 19.8 MB =  3.7%  code InstructionStream           ×26,372
+ 13.0 MB =  2.5%  closure ""                       ×454,557
+  8.2 MB =  1.5%  code FeedbackCell                ×534,273
+  5.5 MB =  1.0%  code UncompiledDataWithoutPreparseData ×287,243
+ 19.9 MB =  3.7%  CSS（StyleRule 5.9 / CSSSelector::RareData 5.8 /
                       ImmutableCSSPropertyValueSet 5.0 / CSSVariableData 2.2 / CSSValueList 0.9）
```

**"每轮每个 bundle 恰好 +1 份"** 这个数字很锐利：它精确对应"每轮挂载、销毁、留下一个 realm"。`FeedbackCell +53 万` / `UncompiledDataWithoutPreparseData +29 万` / `ScopeInfo +8.8 万` 与之同源，都是重复编译的指纹。

CSS 占比 **3.7%**，与 14.4 早先的估计一致——CSS 确实是次要项，不应在这上面投入主要精力。

两个基线的横向对比（**完全同型**，说明结论可跨会话复现）：

| | 旧基线 `E:\heap-baseline` | 新基线 `E:\heap-baseline2` |
|---|---|---|
| 每轮堆增长 | +264 ~ +291 MB | +265.8 MB |
| 包裹源码占比 | 36% | 39.4% |
| CSS 占比 | ~4% | 3.7% |
| 每轮 `customWindow` | +14 | +14 |
| `parsedCode` 标记 | 稳定 | **稳定（68，三轮不变）** |

附带一条观察：`closure "s"`（本次调查最开头定位到的那个泄漏 window 事件监听器闭包）在新基线里每轮仍增加约 9 万个（+2.6 MB）。这不推翻"`listener_effect.ts` 修复已生效"的验证（那次切割全部 251 个标记监听器只释放 7.6 KB），更可能是**新一批 `"s"` 来自另一次挂载周期**——但说明监听器这条线在新基线下仍有残余，值得单独复查。

#### 18.6.2 逐层剥离：四条不同类别的根（2026-09-13 追加）

单点切割在这个图上无效，但**逐层剥离**有效：每切掉一层，切割后的 BFS 会自动暴露下一层入口。在 `round-3`（`E:\heap-baseline2`，1,219.2 MB）上连续剥四层：

| 层 | 切掉 | 释放 | 目标可达性 | 下一层入口变成 |
|---|---|---|---|---|
| 1 | `DevTools console` 句柄 | 237,533 节点 / **9.2 MB** | 全部仍可达 | `(Global handles) --internal:1272-->` 无名字柄 `Error` |
| 2 | ＋该 `Error` 句柄 | **只多 11 节点** | 全部仍可达 | `(Eternal handles)` → `FunctionTemplateInfo` → `FileReader` → `EventTarget.prototype` |
| 3 | ＋`__core-js_shared__` | **0** | 全部仍可达 | `C++ Persistent roots` → `blink::WebLocalFrameImpl` → `blink::HistoryItem` → `blink::DocumentState` → `<input type="file">` |
| 4 | —（未切，会波及基座） | — | — | — |

**四层分属四个完全不同的根类别**：inspector 句柄、V8 无名全局句柄、Blink 永恒句柄（DOM 绑定）、Blink C++ 持久句柄。这是 18.7「是环不是链」迄今最强的证据——不是同一条链的不同段，而是四种不同性质的根各自提供入口。

> **重要限定（见 18.7 第 1 条）**：某一层"释放 0"**不能**用来排除该路径。切割测的是**独占可达性变化**——零独占只说明还有并行入口，不说明这条路径不保留内存。要测真实收益必须**同时切掉全部并行入口**，而上面四层只切了三层。

#### 18.6.3 具名引用链一：共享 DOM 原型 → micro-app 注册表（**经核实不是泄漏**）

剥离前三层后，`round-3` 上通往已销毁 bundle 模块表 `[10264944]` 的最短路径（99 跳）前 15 跳：

```
 6. [2022174] EventTarget.prototype                      ← 页面共享、永恒句柄可达
 7.    └─property:addEventListener→ [2578732] closure "addEventListener" <lib/index.esm.js>
 8.       └─internal:context→ [324244] scope @648979
 9.          └─context:appInstanceMap→ [3714265] Map
10.             └─internal:table→ array → #29→ [7446269] CreateApp
12.                └─property:sandBox→ WithSandBox
13.                   └─property:microAppWindow→ [8203226] CustomWindow
14.                      └─property:__core-js_shared__→ [7999850] Object
15.                         └─property:inspectSource→ [8937131] closure <app-ws/chunk-vendors>
```

**必须记录两次自我否证**（否则这一节会被误读成"找到了跨应用泄漏"）：

1. **`__core-js_shared__` 不是共享的。** 对 store `[7999850]` 做穷举持有者枚举：`CustomWindow --property:__core-js_shared__-->` 的持有者**恰好 1 个**。它是每应用一份。
2. **链上那个 CreateApp 是活的。** `--describe=7446269` 给出 `destroyed=false`，应用名为 `app-ws`（域名见文首代号说明）。而 `[8937131]` 的脚本正是 `app-ws/chunk-vendors`——**就是这个应用自己的 bundle**。

**所以链 1 的前半段完全合法**：活应用的注册表项 → 它自己的 sandbox → 它自己的 window → 它自己的 core-js store → 它自己的 bundle 闭包。**零跨应用引用。**

**推论（重要）**：micro-app 的 DOM 补丁装载在共享的 `EventTarget.prototype` 上、其闭包作用域捕获 `appInstanceMap`——**这本身不是泄漏**。活应用的注册表本来就应当可达，缩小补丁捕获范围**不会**解决注册表本就应保留的内容。要查的是：**注册表里每个 CreateApp 是否仍合法存活**（链 1 里这个是），以及**它的 store 为什么指向了别的实例**（链 1 里并没有）。

#### 18.6.4 具名引用链二：Blink `DocumentState` → `<input type="file">` → Vue invoker → 已销毁 bundle

第 4 层入口往下（同一份 99 跳路径的第 4–15 跳）：

```
 4. blink::WebLocalFrameImpl --element:#7→ blink::HistoryItem
 5. blink::HistoryItem --element:#1→ blink::DocumentState
 6. blink::DocumentState --element:#3→ [9459148] <input type="file" id="right-menu-upload…>
 7.    └─property:<symbol _vei>→ [9459149] Object          ← Vue 3 的 vnode event invoker 缓存
 8.       └─property:onChange→ [9459144] closure "n" <app-ws/chunk-vendors>
 9.          └─property:value→ [2631654] closure <app-ws/app.ac339412.js>
13.             └─context:__webpack_module_cache__→ [12416338] Object
```

**这是一条完整、具名、可复现的保留链**：Chromium 为历史回退保存表单状态（`DocumentState`），因此那个 `<input type="file">` 元素即使容器已被清空仍然存活；元素身上挂着 Vue 的 `_vei` invoker 对象；invoker 的 `onChange` 是已销毁应用的 bundle 闭包；闭包的作用域链直通整份 `__webpack_module_cache__`。

**历史状态根本身不代表无法清理其下游 JS 引用**——`DocumentState` 保存的是元素，而**下游的 JS 引用（Vue invoker、闭包、模块表）是应用侧的**。这一条原本被列为「后续最值得继续拆的切口」。

> **2026-09-13 核实后更正：这条链不构成泄漏。**
>
> 用 18.6.6 的定向走查对链上两个闭包判定：
>
> ```
> [2631654] closure <app-ws/js/app.ac339412.js>    5 跳 → CustomWindow [8203226]   ← 存活
> [9459144] closure "n" <app-ws/chunk-vendors>     4 跳 → CustomWindow [8203226]   ← 存活
> ```
>
> 两个闭包都属**存活**的 `app-ws` 实例。元素本身的描述也否证了「已被清空容器、只剩 Blink 持有」的假设：
>
> ```
> [9459148] <input type="file" id="right-menu-upload-file">   detached = attached
>    --property:__MICRO_APP_NAME__--> "app-ws"      ← micro-app 自己打的归属标记
>    --element:#11--> HTMLDocument                   ← 仍在文档树里
> ```
>
> **元素是 attached、在文档里、归属标记正确。** 它的 Vue `_vei` invoker、`onChange` 闭包、以及最终到达的模块表 `[12416338]` **全部属于这个存活实例**。
>
> **结论：这一段是活应用的正常结构。** 第 4 层入口（`C++ Persistent roots → HistoryItem → DocumentState → <input>`）指向的是**活应用**的数据，切割它不会释放已销毁应用的内存——这与 18.6.2 里「切到第 4 层收益仍为 9.2 MB」的数据一致。
>
> 跨实例的那一跳仍然只在 18.6.5 / 18.6.6 的 `native_bind` 链上：
>
> ```
> 活 ws 的 input → 活 ws 的 Vue invoker → 活 ws 的模块表 → 活 ws 的 core-js
>    → 【native_bind 链，横跨 5 个 bundle】→ 死 ws 实例的 __webpack_require__ [2529578]
>       → 死实例的模块表 [10264944]
> ```
>
> **`DocumentState` 那一段在活的一侧，不是跨实例的那一跳。**

#### 18.6.5 尚未定论：`native_bind` / `bound_argument_0` 的跨 bundle 跳转

链 1 的第 16–96 跳是一条形态固定的重复链：

```
scope --context:X→ closure "native_bind" --shortcut:bound_argument_0→ closure <另一个 bundle>
     ← internal:context -- scope --context:Y→ closure "native_bind" --bound_argument_0→ …
```

在 `app-ws → app-cpu → app-ws → app-bpm → app-flow → app-ws → app-bpm → app-cpu → app-ses` 之间反复跳转。

**已核实的部分**：链上这些 `native_bind` 闭包**不是共享对象**——对 `[12543289] [5817698] [6575346] [11383430]` 做穷举持有者枚举，每个只有**约 1 个强持有者**（对应 `scope --context:a` / `--context:s` 这类 core-js 局部变量槽），其余入边都是 weak。

**未核实的部分**：这究竟是**真实的跨应用赋值**，还是 BFS 在多应用各自的 core-js 辅助对象之间穿行。区分方法已经明确：**确认链尾那个 `__webpack_module_cache__`（`[10264944]`）是活 `app-ws` 实例自己的缓存，还是某个已销毁 ws 实例的缓存**——这一个事实就决定链 1 到底有没有跨应用引用。在拿到这个答案之前，不得声称存在跨应用泄漏。

> **已于 18.6.6 定论**：链尾缓存属于一个**已销毁**的 `app-ws` 实例（`CustomWindow [4430354]` 在孤儿名单内）。链一是真实的跨实例引用。

#### 18.6.6 定论：链一是跨实例引用，并量化了副本累积（2026-09-13 追加）

**判定手段**：新增「定向走查」。with 沙箱的包裹形式是

```js
with (proxyWindow.__MICRO_APP_WINDOW__) { (function (window, self, globalThis, …) { /* bundle */ }) }
```

所以**每份 bundle 副本的某个外层作用域里必然有一个槽指向它自己的代理**，而代理 `hidden:` 指向它自己的 `CustomWindow`。沿 `internal:context → internal:previous` 向上爬到第一个带 `window` 槽的作用域，就能判定「这份副本属于哪个实例」。这是广度反向枚举做不到的——广度会把同一 bundle 的所有副本混在一起。

对链尾 `__webpack_require__ [2529578]` 走查：

```
[2529578] __webpack_require__ <app-ws/js/app.ac339412.js>
   --internal:context→ scope @3427551
      --internal:previous→ scope @3427561
         --context:window→ system / JSProxy  --hidden→ CustomWindow [4430354]
```

**[4430354] 在 18.6.1 的 28 个孤儿名单内 → 已销毁实例。** 链一确实是「活应用 → 已销毁实例」的引用。

**对全部 47 份 `__webpack_require__` 副本做同样走查：**

| live | dead | 其它（其余存活应用的 window） | 未找到 | bundle |
|---|---|---|---|---|
| **1** | **12** | 7 | 0 | `app-ws/js/app.ac339412.js` |
| 0 | 6 | 3 | 0 | `app-ses/js/app.3df7ab01.js` |
| 0 | 5 | 3 | 0 | `app-bpm/js/app.f82bfcdd.js` |
| 0 | 4 | 2 | 0 | `app-cpu/js/app.2588e739.js` |
| 0 | 2 | 1 | 0 | `app-flow/js/app.5a3b4562.js` |
| 0 | 0 | 0 | 1 | （无 `source_url`，非微应用脚本） |

**合计 live = 17，dead = 29。** `round-3` 的指标是 `createApp: 29 / destroyed: 12 / 存活 17`。

> **17 个 live 副本恰好等于 17 个存活应用。** 这是对走查工具本身的强自校验：若存在假阳性，live 数不会正好等于存活应用数。

**由此得到两个新结论：**

1. **bundle 副本是「每次执行一份」，不是「每次编译一份」。** `sourceCenter` 的 `parsedCode`（源码）按应用名缓存，但 `parsedFunction` **每次调用都产生一份全新的模块图**。这解释了 18.6.1 的数字矛盾：
   - 源码字符串：`app-ws` 的包裹源码在 round-3 只有 **3 份**（每轮 +1）
   - `__webpack_require__` 闭包：同名 bundle 有 **20 份**（1 live + 12 dead + 7 其它）

   **20 份执行副本共用 3 份源码** —— 泄漏是**按执行次数**累积的，不是按编译次数。

2. **dead 副本数（29）大于已销毁实例数（12）**，说明同一次销毁会留下多于一份副本（多个应用名加载同一个 bundle URL），或者更早轮次的 CreateApp 已被回收而副本仍在。

**方法学修正（已实施）**：`scriptUrlOf` 原先有一个回退分支——「在 Script 节点名字里匹配第一个像 URL 的子串」。它会把不同脚本归属到同一 URL，使所有按 URL 分组的统计失去可信度。**现已改为只认 Script 的 `source_url`，拿不到就返回 `null`**（micro-app 的 `code2Function` 注入了 `//# sourceURL=`，所以连 `new Function` 产生的 Script 也带正确 URL）。事后核对：上面这张表在修复前后数值**一致**，说明本次未被该分支污染；但修复仍有必要，因为它是随时会发作的隐患。

#### 18.6.7 跨实例保留入口：已核实的位置与待证实的机制（2026-09-13，同日降级）

> **标题修正记录**：本节最初题为「跨实例赋值的**确切位置与机制**（定论）」。经复核，**只有"位置"是已核实的**，「补丁安装 → 被另一实例捕获 → 销毁时还原」这条时序**仍是推断**，不足以称"定论"。标题与下文措辞已相应降级。

**边**：链上第一次跨实例发生在

```
[12543289] closure "native_bind"        ← 属【存活】ws（持有者 scope @23359247，变量槽 a）
   --internal:bound_function--> [4569] closure "call"        ← Function.prototype.call
   --internal:bound_this-->     [4569] closure "call"
   --shortcut:bound_argument_0--> [5817698] closure "" <app-cpu/chunk-vendors>
                                     └─property:name--> "toString"
                                     └─context: scope @11640611（槽位含 hasOwn / defineProperty）
```

**`[5817698]` 走查为 `CustomWindow [6575372]`，在孤儿名单内 → 已销毁实例。**

**机制**：`bound_function = call` + `bound_this = call` + 一个作为 `bound_argument_0` 的 `toString` 函数，这是 **core-js 的 `uncurryThis(Function.prototype.toString)`** 形态。

**为什么会共享 `Function.prototype`：根源是「子应用与基座在同一个 realm 里执行」，不是 `GLOBAL_CACHED_KEY`。**

with 沙箱不创建新 realm——子应用代码直接运行在基座 realm 中，所以内建对象（`Function`、`Array`、`Object` …）及其原型**本来就是同一批对象**。这是**同 realm 执行的必然结果**，与框架缓存了哪个引用无关。

> **必须避免的错误归因（本文档此前犯过，此处更正）**：曾把根因写成 `GLOBAL_CACHED_KEY`（`src/constants.ts:68`）缓存了 `Function`。
>
> **这个归因是错的。** `GLOBAL_CACHED_KEY` 的作用见其自身注释——`window.Promise = newValue` 之后子应用仍应读到原值，它解决的是**重新赋值**问题。
>
> **即便把 `Function` 从该列表里删掉，`Function` 依然是同一个对象，不会获得任何隔离**——隔离与否由「是否同 realm」决定，与是否缓存这个引用无关。**不要试图通过调整该列表来解决这条链。**

该列表保留在下面仅供对照，**它不是这条链的成因**：

```js
export const GLOBAL_CACHED_KEY = 'window,self,globalThis,document,Document,Array,Object,String,
  Boolean,Math,Number,Symbol,Date,Function,Proxy,WeakMap,WeakSet,Set,Map,Reflect,Element,Node,
  RegExp,Error,TypeError,JSON,isNaN,...,history'
```

#### 机制推演（已核实 / 推断，分开标注）

**已核实 —— 共享确实存在**：

- 基座 realm 的 `Function.prototype` 是**单节点 `[4535]`**。它就是链里到处出现的那个 `closure ""`，同时是**全部 5 个子应用 bundle 闭包的 `__proto__`**。所以 `Function.prototype` 确实是基座与所有子应用共用的同一个对象。
- 存活 app-ws 的 core-js 作用域里确实存着一个绑定函数，其 `bound_argument_0` 是**已销毁实例**（`CustomWindow [6575372]`）的 `toString` 闭包。
- 该 `toString` 闭包的当前持有者只有：那个 `native_bind` 的 `bound_argument_0`、一个 `(bound arguments)` 数组、三个 core-js 模块作用域。**没有任何 `Function.prototype --property:toString-->` 的持有者。**

**推断 —— 需第二份快照或运行期验证才能坐实**：

1. 已销毁的 app-cpu 实例的 core-js 曾把 `toString` 装在共享的 `Function.prototype` 上；
2. 之后 app-ws 的 core-js 执行 `uncurryThis(Function.prototype.toString)`，读到的是 app-cpu 那个 `toString`；
3. 绑定函数存进 app-ws 自己的 core-js 作用域，`bound_argument_0` 永久指向 app-cpu 已销毁实例的闭包；
4. 该闭包的作用域链直通 app-cpu 已销毁实例的整个模块图。

**第 1 步是推断而非观测。** 但「该 `toString` 已不在任何原型上，却仍被一个活应用的绑定函数独占持有」**正是「先被装上共享原型、被别的实例读取捕获、之后被 `releaseRawGlobalObjectPatches` 还原」留下的指纹**。单份快照无法区分「曾被安装后还原」与「从未安装」，要坐实需要：同一会话的两份快照差分，或在 `releaseRawGlobalObjectPatches` 的还原分支上加计数。

**验证手段（已尝试后回滚，且本身不充分）**：曾在 `releaseRawGlobalObjectPatches` 的还原分支加一条日志（已按要求回滚，`lib/` 已重建回原状）。

**但必须指出：这类日志即使出现，也只证明「发生过一次对 `Function.prototype.toString` 的还原」，并不能证明「app-ws 捕获的就是那个被还原的函数」。** 坐实机制还需要**身份确认**——把「被还原的函数」与「app-ws 绑定函数实际持有的 `bound_argument_0`」对上。

**更可靠的做法是最小复现（见 18.6.8），而不是在真实产品的还原分支上打点。**

**若上述推断成立，它就解释了整条 `native_bind` 链为什么在 5 个 bundle 之间反复跳转**——每个应用的 `uncurryThis` 都会绑到"最先打补丁的那个应用"的函数上。这也印证了此前被列为"待查"的假设（**with 沙箱的全局读取与对象共享策略让 core-js 获取了其它应用修改过的对象**）——**「共享确实存在」已核实，「core-js 由此被串联」是推断**。

**顺带观测**：堆里有 **58 个名为 `Function` 的 object**，它们**不是** `Function.prototype`，而是 **dayjs 的 locale 对象**（属性 `unix`/`months`/`weekdaysShort`/`monthsShort`/`extend` 均为访问器，getter 是 `native_bind`，`default` 指向 `app-ws/chunk-vendors` 的闭包）。58 个对应 47 份副本中加载了 dayjs 的那些——**每份副本各留一套 locale 对象**，与"按执行次数累积"的结论一致。按名字找节点时不要把这类同名对象误当作内建原型。

**micro-app 现有的缓解按构造无法解决。** `releaseRawGlobalObjectPatches(owner)`（`src/libs/global_env.ts:110`）确实会在销毁时还原子应用的内建补丁，且其判定是对的（只在描述符仍是子应用安装的那一个时才还原）。但：

- **还原无法撤销已经发生的捕获**：app-ws 的绑定函数在 app-cpu 销毁**之前**就已创建并持有引用，事后还原 `Function.prototype.toString` 不影响它。
- 该机制解决的是"共享对象被改写"，解决不了"共享对象被**读取后捕获**"。

**要决策的问题（不是可以直接改的小修）**：**同 realm 执行**决定了内建对象及其原型在所有沙箱间共享——**这不是某一处缓存策略的副作用，而是 `with` 沙箱的定义性特征**。要根治只有让每个沙箱拥有自己的内建对象，即 **iframe 沙箱天然具备、而 `with` 沙箱不具备的能力**。这是一个有兼容成本的架构取舍，**需要明确决定，不宜作为顺手修复**（候选方案对比见 18.6.8）。

#### 18.6.8 下一步：最小复现与候选方案对比（2026-09-13）

**先做最小复现，不要直接在真实产品的还原分支上打点。**

**复现目标**：把「A 安装补丁 → B 捕获 → 销毁 A → B 仍持有 A 的函数」这条时序在可控环境里跑通，**并做身份对账**（B 捕获到的就是 A 安装的那个函数）。

**最小复现（纯 JS，不需要浏览器）**：

```js
const original = Function.prototype.toString
let aCalls = 0
const aToString = function () { aCalls++; return 'patched by A' }

try {
  // A：安装补丁
  Reflect.defineProperty(Function.prototype, 'toString', { value: aToString, configurable: true, writable: true })

  // B：按 core-js 的形态捕获 —— uncurryThis 产生一个绑定函数，
  //    其 bound_function / bound_this = Function.prototype.call，bound_argument_0 = 被捕获的函数
  const call = Function.prototype.call
  const capturedByB = call.bind(call, Function.prototype.toString)

  // A 销毁：还原共享原型（等价于 releaseRawGlobalObjectPatches 的还原分支）
  Reflect.defineProperty(Function.prototype, 'toString', { value: original, configurable: true, writable: true })

  // 断言。**注意比较对象**：捕获的是「函数」，而 capturedByB() 返回的是该函数的**返回值**。
  const before = aCalls
  console.assert(Function.prototype.toString === original, '共享原型已还原')
  console.assert(capturedByB() === 'patched by A' && aCalls > before,
    '还原后 B 仍在调用 A 的那个函数（用调用计数 + 返回值共同判定，而不是拿返回值去比函数）')
} finally {
  // 无论如何都恢复原始描述符，避免示例本身污染环境
  Reflect.defineProperty(Function.prototype, 'toString', { value: original, configurable: true, writable: true })
}
```

**实跑结果（2026-09-13，Node，已执行）**：

```
A 安装后: Function.prototype.toString === aToString ? true
B 捕获后: 调用 capturedByB() = "patched by A"
还原后:   Function.prototype.toString === original ? true
还原后调用 capturedByB() = "patched by A"  aToString 被调用次数 +1

结论：共享原型已还原 ✓  且  B 仍在调用 A 的函数 ✓  —— 两者同时成立
```

**这个复现能证明什么、不能证明什么**（必须写清，避免又一次过度解读）：

- ✅ 能证明：**还原共享原型无法撤销已经发生的捕获**——这正是"现有恢复机制不足以处理这条链"的直接依据。
- ❌ **不能**证明真实产品里发生过这条时序。要证明那一点，还需要记录真实产品中的**安装 / 捕获 / 还原**三个事件，并做**身份对账**（被还原的函数 === B 实际持有的 `bound_argument_0`）。

**产品侧记录：外部注入属于「受控诊断」，不是"无侵入"。**

做法：用 CDP 在页面里注入观察器，包装 `Reflect.defineProperty` / `Object.defineProperty`，记录「目标为 `Function.prototype` 且属性为 `toString`」的调用（含调用**栈字符串**），跑一轮开关 tab 后取回。这样**不修改仓库、不需要重新构建**。

**但必须同时写明它的三类影响，不能称其为"无侵入"：**

1. **会改变运行行为。** 包装 `Object.defineProperty` / `Reflect.defineProperty` 可能影响第三方库的**特性检测**（不少库会检查这些 API 的原生性），也可能改变描述符的处理路径。**只应作为受控诊断在一次性会话里使用。**
2. **覆盖不全。** 直接赋值 `Function.prototype.toString = fn` **不经过** `defineProperty`，会被漏掉；在注入**之前**就被缓存的 API 引用（某个库早已存下了 `Object.defineProperty`）同样会绕开包装。因此**"没记录到"不能作为"没发生"的证据**。
3. **记录本身会制造新的保留。** **不要**在日志里长期保存函数对象或 Error 对象——那会让诊断自己钉住目标。**只记录字符串**（目标名、属性名、调用栈字符串、时间戳）。

（本轮曾用"改源码打日志"的方式做过，已按要求回滚。即便那条日志生效，它同样只证明"发生过还原"，**不足以完成身份对账**。）

**机制坐实后再比较两条方案：**

| | 方案 1：调整 with 沙箱的共享原型补丁策略 | 方案 2：对受影响应用试点 iframe realm 隔离 |
|---|---|---|
| 做法 | 在 with 沙箱内把内建对象或其原型换成 per-sandbox 包装，或约束/拦截子应用对这些原型的写入 | 对确实需要的应用改用 iframe 沙箱，天然获得独立 realm |
| 隔离程度 | 有限：取决于包装覆盖面，容易留下遗漏面 | 彻底：内建对象、原型、全局状态全部独立 |
| 兼容风险 | **需要单独评估**：改变内建对象身份可能影响 `instanceof`、跨应用对象传递、第三方库的特性检测 | 已知成本：跨应用通信、DOM 互操作、性能特征都要重新验证 |
| 落地方式 | 需要设计 | **试点，不是直接全量切换** |

**执行顺序是固定的**：

1. **先做真实产品中的安装 / 捕获 / 恢复身份对账**（见本节上文，受控诊断，只记字符串）；
2. **机制确认后**再评估方案 1 与方案 2；
3. **不要直接修改内建对象的身份**——那是方案 1 的核心动作，在机制未坐实、兼容风险未评估前动它，等于用一次全局性的语义变更去赌一个尚未确认的假设。

### 18.7 结论

1. **不存在独占的"那条边"，但这不等于各条路径无效。** 切割实验分别释放 0.1 MB / 7 节点 / 110 节点 / 9.2 MB，而增长是 270 MB/轮。
   **必须避免的推理错误**：切割测的是**独占可达性变化**——释放 0 只说明**还有并行入口**，**不能**用来排除该路径。18.6.2 的四层剥离显示，切掉的每一层都会立刻出现同等甚至更短的替代路径，所以正确的结论是"**入口是并行的多个，必须同时切断才有收益**"，而不是"这些路径不保留内存"。要量化某条路径的真实贡献，必须**同时切掉全部并行入口**再测——而目前四层只切了三层。
2. 被保留的不是链而是**环**，环的锚在子应用侧：子应用自己的模块表、它自己抛出的 Error、它 `console.log` 出来的对象，以及至少两个原生句柄。
   > **2026-09-13 修正**：本条原写「环的锚在子应用侧」，读起来像"框架无从下手"。**该结论已被后续证据修正**——18.6.7 找到了一条**位于框架可控范围内**的跨实例入口：**同 realm 执行导致内建原型共享**，子应用 A 对 `Function.prototype.toString` 的补丁会被子应用 B 的 `uncurryThis` 捕获，从而在 B 侧永久钉住 A 的整个模块图。**锚不是"只在子应用侧"。**
3. 十七节的修复（A/B/CSSOM）**在各自范围内仍然正确**——它们切断的是 micro-app 唯一能控制的那部分引用（`mount()` 的 Context、AppTask payload、实例拥有的 DOM 子树）。但要**明确预期：这些改动大概率不能消除 270 MB/轮**。
   > **2026-09-13 修正**：本条原写「因为环的锚不在 micro-app 能触及的范围内」。**该理由不成立**（见第 2 条修正）。正确表述是：这些改动**不触及 18.6.7 那条共享原型链**，因此不足以处理它——问题出在切口选错，不是"够不着"。
4. **不要再找"那条唯一的边"，而应当逐条列出并同时切断并行入口。** 18.6.2 的剥离法已经可以直接用于枚举入口：切一层，看下一层，直到无法再切。**不应就此停止定位。** 目前唯一已确认的跨实例切口是 **18.6.5 / 18.6.6 的 `native_bind` 链**：活实例的 core-js → 跨 5 个 bundle 的 `native_bind`/`bound_argument_0` 链 → 已销毁实例的 `__webpack_require__` 与模块表。**下一步要定位的是这条链上第一次跨实例赋值的确切位置。**（18.6.4 的 `DocumentState` 路径已于 2026-09-13 核实为活应用的正常结构，不再是候选。）
5. **当前没有任何新增证据表明每轮约 266 MB 的增长已被解决。** 本节新增的全部内容都是**定位与机制**层面的：18.6.6 量化了副本累积（`live=17 / dead=29`），18.6.7 找到了跨实例保留入口，18.6.8 的最小复现只证明「还原无法撤销捕获」这一条 JS 语义。**没有一项改动被施加到运行代码上，也没有任何一轮基线显示出增长下降。**

   > 已知的数字（供对照，非修复效果）：`E:\heap-baseline2` 实测每轮 **+265.8 MB**（`round-1→2` +275.9、`round-2→3` +255.7），与旧基线的 +264 ~ +291 MB 同量级。**在机制被坐实、并有针对性改动之前，不应期待这个数字变化。**

### 18.8 尚未解释的两处

1. `CustomWindow` **73 个** vs `CreateApp` **57 个**（存活 17 + 已销毁 40），多 16 个；指标显示每轮 `customWindow` +14 而 `createApp` +10，差的 4 个/轮。
2. `Context @6017183` 属于哪个函数未定位（`@6017221` 已确认属于 `getEventTarget`）。

### 18.9 复现命令

所有命令都需要 `--max-old-space-size=16384`（真实快照 1–3 GB，默认堆上限不够）。

#### 18.9.1 `heap_root_cut.js` 参数总表

| 参数 | 作用 |
|---|---|
| `--retainers=<o,…>` | **穷举入边**（反向 CSR 索引），列出这些节点的**全部**持有者。**不是**最短路径。 |
| `--retainerDepth=<n>` | 向上展开层数，默认 3。逐层聚合后再截断显示。 |
| `--traceToWindow=<o,…>` | **定向走查**：沿 `internal:context → internal:previous` 上爬，找到第一个指向实例 window 的槽，据此判定节点属于哪个实例。详见 18.9.4。 |
| `--traceDepth=<n>` | 走查最大跳数，默认 80。 |
| `--describe=<o,…>` | 打印节点出边，含 `detachedness`（`attached`/`detached`）与脚本 URL。 |
| `--targets=<o,…>` | BFS 目标，用于可达性判定与路径回溯。 |
| `--blockEdge=<substr>` | 可重复。屏蔽边名含该子串的边；同时匹配裸边名与 `type:边名` 两种写法。 |
| `--blockNode=<o>` | 可重复。屏蔽节点（不遍历其出边）。 |
| `--dumpFull` | 输出完整路径（默认只给前 6 跳）。 |

#### 18.9.2 三个基本动作

```bash
# 1) 穷举持有者
node --max-old-space-size=16384 scripts/heap_root_cut.js <snapshot> --retainers=6089105 --retainerDepth=3

# 2) 定向走查：这个闭包 / 作用域属于哪个应用实例？
node --max-old-space-size=16384 scripts/heap_root_cut.js <snapshot> --traceToWindow=2529578,2631654

# 3) 切割实验（可叠加多层）
node --max-old-space-size=16384 scripts/heap_root_cut.js <snapshot> --targets=6089105 \
     --blockEdge="DevTools console" --blockEdge="internal:1272" --blockEdge="bound_argument_0"
```

判定走查结果时，把得到的 `CustomWindow` ordinal 与「存活应用数」和「孤儿名单」对照（孤儿 = 无 `WithSandBox` 持有者的 CustomWindow，见 18.6.1）。

#### 18.9.3 逐层剥离：枚举并行入口的标准动作

单点切割在这个图上无效（见 18.7 第 1 条），正确做法是**逐层剥离**：切一层 → 看下一层入口 → 再切。**切割后的路径会自动出现在输出的 `after` 里**，无需额外跑一次：

```bash
# 第 1 层
node ... --targets=6089105 --dumpFull --blockEdge="DevTools console"
# 第 2 层：把上一层的边累加进来
node ... --targets=6089105 --dumpFull --blockEdge="DevTools console" --blockEdge="internal:1272"
# 第 3 层：继续累加
node ... --targets=6089105 --dumpFull --blockEdge="DevTools console" --blockEdge="internal:1272" \
     --blockEdge="__core-js_shared__"
```

**注意**：每一层的"释放 0"**不等于该路径无效**——切割测的是**独占可达性变化**，零独占只说明还有并行入口。要量化真实收益必须同时切断全部并行入口。

#### 18.9.4 定向走查的设计约束（重要）

走查**只匹配作用域上的 `context:` 槽，不匹配对象的 `property:` 边**。原因是 `CustomWindow` 自己也有 `window`/`self` 属性指向它的代理——若一并匹配，就会顺着 `CustomWindow.window` 自指回它自己，产生假阳性。

由此有两条使用限制：

- 起点应是**闭包**（经 `internal:context` 进入其作用域）或**作用域**（沿 `internal:previous` 外爬）；
- **`native_bind` 这类没有 `internal:context` 边的对象走查不到**，其归属需由持有它的作用域推出——但必须先对该作用域单独走查验证。

**自校验方法**：对一批已知归属的节点跑走查。已验证的一次：对全部 `47` 个 `__webpack_require__` 副本走查，`live` 数 = `17`，恰好等于存活应用数（18.6.6）。若走查有假阳性，不会正好相等。

#### 18.9.5 其它脚本

```bash
# 从 (GC roots) 出发的最短保留路径（注意：不等于唯一路径，见 18.1 / 18.2）
node --max-old-space-size=16384 scripts/heap_path_to_root.js <snapshot> 6089105

# 按精确名字列节点（只扫 nodes 段，比 heap_find_large_nodes.js 快）
node --max-old-space-size=16384 scripts/heap_find_nodes.js <snapshot> --name=CustomWindow
node --max-old-space-size=16384 scripts/heap_find_nodes.js <snapshot> --name=getEventTarget --limit=200
```

#### 18.9.6 边界与踩过的坑

**`scriptUrlOf` 只认 `source_url`。** 原有一个回退分支「在 Script 节点名字里匹配第一个像 URL 的子串」，它会把不同脚本归属到同一 URL，使**所有按 URL 分组的统计失去可信度**。现在拿不到就返回 `null`，并由 `scriptInfoOf` 返回 `via` 便于核实口径。（micro-app 的 `code2Function` 注入了 `//# sourceURL=`，所以连 `new Function` 产生的 Script 也带正确 URL。）

**按名字找节点时不要用子串匹配**：string 节点的 "name" 就是它的内容，子应用 23 MB 的包裹源码里必然出现 `CustomWindow` / `StyleRule` 字样，会把巨型字符串一起匹配出来（`heap_metrics.js` 早期版本的 `parsedCSS` 因此从 27 MB 虚高到 98 MB）。

**工具自身修过的三个坑（留作前车之鉴）**：

- BFS 的节点计数曾写在循环外，恒定返回 1，制造出「切割只释放 1 个节点」的假象；实际应取队列尾 `tail`。
- 持有者列表曾**先截断到 80 行再做分类**，导致 884 条入口里只看得到前 80 条（全是 `sliced string`），真实分布完全不可见。现在**先聚合再截断**。
- `cdp_heap_snapshot.js` 的分片写入曾忽略写回压，造成「报告写入 1915 MB、落盘只有 880 MB」，而**截断的快照会被下游当成有效数据**（表现为 `Marker not found: "strings":[`）。现在尊重背压、等 V8 的 `finished` 事件、并在落盘后自检 `strings` 段与结尾 `}`。

### 18.10 验证方案

#### 第一步：合并切割两个**指定的**原生锚 —— 已跑，但它不是全部原生入口的上界

单个切割释放量太小不说明问题，所以把**当时已知的这两个**原生锚同时切掉。

> **不得据此推断的结论**：这只给出「这两个句柄合计能回收多少」，**既不能排除其它原生入口，也不能作为"全部原生保留量的上界"**。18.6.2 的逐层剥离已经证明：切掉一层就出现新的原生入口（`(Eternal handles)`、`C++ Persistent roots`），它们**未被本步覆盖**。「切两个指定入口」与「穷尽原生入口」是两件事。

```bash
node --max-old-space-size=16384 scripts/heap_root_cut.js <snapshot> \
     --targets=6089105,3147771,2632053,1929970 \
     --blockEdge="DevTools console" --blockEdge="internal:1394"
```

round-5 实测：

```
blocked = [DevTools console, internal:1394]
可达   25,417,540 → 25,413,861      释放 3,679 节点 / 0.1 MB
四个目标全部仍可达（43→116、243→316、138→211、218→291 跳）
```

**1,754.9 MB 里有 1,754.8 MB 与这两个原生锚无关。** 这一步排除了"锚在原生句柄"。

> **2026-09-13 修正**：本步当时据此推向「剩下唯一候选是活着的子应用 realm」。**该推论已被修正**——「不是原生句柄」与「框架无从下手」是两回事。18.6.7 已找到一条**框架可控范围内**的入口（共享内建原型被跨实例捕获）。**"排除所有原生入口"不等于"排除所有入口"**，本步只能作为原生锚的上界测量，不能作为方向性结论。

> 反证判据：若释放量跃升到数百 MB，则锚是原生句柄，18.7 的结论作废，方向应改为"不让 Error 进入全局句柄"。

#### 第二步：先测噪声地板（不需要改任何代码）

在动子应用之前，先知道"什么都没发生"时数字会怎么动：

1. **零操作对照**：抓一份快照后不做任何操作，再抓一份。两次之差就是采集噪声地板。
2. **半量操作**：同一序列但每轮只开关 1 个 tab。若每轮 Δ 按比例降到约 1/4（≈68 MB），说明泄漏与操作量线性、无固定开销；若仍约 270 MB，说明存在与 tab 数无关的固定泄漏源。

两步都用十六节的 `heap_baseline_round.js`，只改操作，不改代码。

#### 第三步：决定性实验（需要子应用侧一次最小改动）

一次只改一处，各跑 5 轮同序列，比对 Δ 的均值：

| 实验 | 改动 | 预测 |
|---|---|---|
| 3a | 让"抛出后被长期持有"的那个 Error 不再存活（去掉捕获后长期保存，或改成 string） | Δ 从 ~270 MB 降到接近噪声地板 |
| 3b | 移除对业务大对象的 `console.log` | Δ 轻微下降（0.1 MB 量级），**不足以解释 270 MB** |

判据：

| 结果 | 含义 | 下一步 |
|---|---|---|
| 3a 显著下降 | 环的锚是子应用 Error，18.6 / 18.7 证实 | micro-app 侧只保留十七节改动，不加额外工作 |
| 3a 无变化、3b 有变化 | 锚是控制台，与 18.2 的切割数据矛盾 | 重查 18.2，可能存在第三条原生路径 |
| 两者都无变化 | 锚是子应用模块表本身（被存活应用引用） | 转向："为什么已销毁应用的模块表仍被活着的应用引用"——即 17 个存活应用的 `__core-js_shared__` / webpack 模块表共享问题 |

#### 记录方式与判据

沿用十六节的固定变量与 `baseline.jsonl`，**看 Δ 列而不是绝对值**。每档采 5 轮，报 Δ 的均值与极差；单轮波动超过 Δ 均值的 20% 时加采两轮。

#### 明确不要做的两件事

- **不要再对单个节点做切割实验并据此宣称"找到根"。** 18.2 已经证明：在这个图上，单节点/单边的切割释放量都在 0.1 MB 量级，它是**无效判据**。要么合并切割整个入口集（如第一步），要么看 Δ 趋势。
- **不要在没跑够 5 轮的情况下用单份快照的绝对值下结论。** 16.8 已把这条列为偏差源；18.1 也说明单份快照里几乎所有对象都可达，绝对值没有区分度。

### 18.9 共享 Axios 工厂的实例级生命周期接入（2026-09-13）

待完成 XHR 路径中的请求不一定通过子应用的 XMLHttpRequest 创建。BPM 的
`window.globalPlugin.useAxios()` 在底座 realm 创建 VAxios，因此仅补子应用 XHR
abort 不足以覆盖此路径。本轮不修改业务路由，不清 webpack 模块表。

- `resource_factory.ts`：仅适配显式标记的共享工厂，按沙箱实例记录返回资源。
  终态 dispose 时调用资源 dispose；普通 stop/保活切换不调用。无标记对象保持原身份。
- 底座 `globalPlugin.ts`：给已有 createAxios 工厂增加 opt-in 标记。
- 底座 `Axios.ts`：每个 VAxios 独立记录请求取消令牌，终态取消该实例请求；
  保留调用方取消传播，并在成功、失败、主动取消时释放记录。
  不使用全局 AxiosCanceler.removeAllPending，以免取消其它 Tab 的请求。
- 已验证：真实 Axios 0.26.1 自定义 pending adapter 下，实例隔离、重复销毁、
  销毁后拒绝新请求、调用方取消和登记释放通过；沙箱 stop 不清资源、destroy 清资源通过。
- micro-app 已重新构建；底座两个修改文件定向 lint 通过，未打包底座。

**结论边界**：这些测试验证生命周期行为，不证明每轮堆增长已经消失。
仍须在运行页面确认新工厂标记及新 micro-app 产物，再采固定序列 GC 基线。
当前文件系统找不到 E:\heap-baseline2；可读取的是 E:\heap-baseline，二者不可混称。

补充复核：仅屏蔽 native 类型且名为 XMLHttpRequest 的六个实例（2391623、
2391679、9642329、9642341、9642353、14206759），不屏蔽同名构造器或原型。
排除 console 后的可达堆由约 709.3 MB 进一步降到 501.4 MB，目标旧窗口
4043230 不再可达；3773793 和 3434407 仍通过 Global handles → Error 4005
的栈捕获可达。**这是静态切割，不是实际 abort 后的 GC 收益**。

底座 responseInterceptorsCatch 已增加 isCancel 提前返回：正常取消不打印 Error、
不记接口错误、不转换成失去取消标记的对象。直接提取产品该函数执行的回归测试通过，
底座 index.ts 定向 lint 通过。

运行验证限制：浏览器工具库存为空、getBrowser 返回 No browser is available。
现有 CDP 的 Browser.getVersion 正常返回，但 Performance.enable、Debugger.enable
均 30 秒无响应，不能由此认定页面暂停，也不能把只读命令超时当成进程已退出。
开发服务器返回的 globalPlugin.ts 已含新工厂标记；这只证明服务器文件更新，
不证明运行中的子应用已经重新挂载并使用新生命周期。

另补底座请求包装器的确定缺陷：移除没有 await 的 async Promise executor，
使缓存钩子同步抛错能拒绝外层 Promise；requestCatchHook 再次抛错时显式拒绝外层，
避免 Promise 永久 pending。销毁实例在 request 入口拒绝，不继续执行缓存钩子。
回归测试包含 200ms Promise.race 判据，两个抛错分支均得到原错误而非 still pending。
这证明异常路径结算行为修正，不单独证明旧快照全部保留对象已回收。
