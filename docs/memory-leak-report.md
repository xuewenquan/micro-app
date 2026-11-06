# micro-app with 沙箱内存问题：结论报告

数据：`E:\heap-baseline`，round-1 … round-10 共 10 份 CDP 堆快照（`--gc` 后采集）+ `baseline.jsonl`。
分析方法：全图建索引后做正向可达性、反向入边、支配树、可达性切割实验。
辅助脚本：`scripts/heap_metrics.js`、`heap_app_audit.js`、`heap_scripts_by_url.js`、`heap_exclusive_size.js`、`heap_root_cut.js`、`diff_heap_snapshots.js`。

> 本文档已隐去业务域名与应用名，统一用 `app-ws` / `app-cpu` / `app-bpm` / `app-flow` / `app-ses` / `<业务域名>` 表示。

---

## 一、先纠正此前的两个判断

### 1.1 增长不是"每轮固定 X MB"

`baseline.jsonl` 的 `heapSelfMB`：

| 轮次 | heapMB | Δ | 活沙箱 | 孤儿 CustomWindow |
|---|---|---|---|---|
| round-1 | 77.7 | — | 0 | 0 |
| round-2 | 241.8 | +164.1 | 3 | 0 |
| round-3 | 594.2 | +352.4 | 3 | 14 |
| round-4 | 892.8 | +298.6 | 3 | 28 |
| round-5 | 953.8 | +61.0 | 3 | 30 |
| round-6 | **878.2** | **−75.6** | 3 | 28 |
| round-7 | **864.6** | **−13.6** | 3 | 28 |
| round-8 | 1001.6 | +137.0 | 3 | 33 |
| round-9 | 1217.7 | +216.1 | 3 | 44 |
| round-10 | **1211.9** | **−5.8** | 3 | 42 |

**每一轮的活沙箱都恰好是 3 个**（`WithSandBox` 实例数 = `CreateApp` 中 `destroyed=false` 的数量 = 3）。
堆大小**不是单调增长**，r5→r7、r9→r10 都在降。

因此此前"每轮约 266 MB"的说法不成立：**增长量跟着这一轮销毁了多少应用走，而不是跟着轮次走。**

把堆大小对孤儿数回归（活沙箱恒为 3）：

- (893 − 594) / (28 − 14) ≈ **21 MB / 孤儿**
- (1218 − 878) / (44 − 28) ≈ **21 MB / 孤儿**

这个线性关系很干净，但**下一节会说明它只是相关，不是因果**。

### 1.2 孤儿对象不是必要入口（但仍是有效指标）

在 round-10 上把 **42 个孤儿 CustomWindow + 21 个已销毁 CreateApp 的全部出边一起切断**：

```
baseline : 1211.9 MB / 17,374,555 节点
afterCut : 1211.9 MB / 17,373,322 节点
释放     : 0.0 MB / 233 节点
```

释放的 233 个节点全是这些对象自己的属性存储数组、Set、Map 等空壳。

**它们不是必要入口** —— 去掉它们，内存照样可达。

更严格地说：这只能证明"删掉这些空壳不会释放内存"，**不能**反推出"泄漏与它们无关"。它们仍然是"这个应用被销毁了"的可靠**指标**；"21 MB/孤儿"的线性关系说明**孤儿数是一个好的代理变量**，只是代理的对象不是它自己这 108 字节。

---

## 二、同活沙箱数量下的堆增量构成

> **口径限制（必须连同结论一起引用）**：活沙箱数相同**只说明子应用沙箱的存活集相同**，不代表业务侧缓存、接口请求状态、DevTools 保留对象、基座自身增长也相同。所以下面这些数字是**该区间内堆增量的构成**，不是"已销毁应用的净遗留物"。要得到净遗留物，必须做"同一会话内逐步释放 + 每步量堆"的对照（见 §6）。

round-2 与 round-10 的**活沙箱数相同（都是 3 个）**，因此两者之差可以近似视为这一段工作产生的堆增量：

**+970.1 MB**（241.8 → 1211.9），下面称**「同活沙箱数量下的堆增量」**。按节点类型拆：

| 类型 | 增量 | 占比 | 节点数 |
|---|---|---|---|
| `string` | **348.5 MB** | **35.9%** | **仅 30 个**（重复保留的 bundle 源码） |
| `code` | 126.7 MB | 13.1% | +2,347,357 |
| `array` | 113.1 MB | 11.7% | +1,156,508 |
| `object` | 98.4 MB | 10.1% | +3,667,992 |
| `native` | 93.4 MB | 9.6% | +904,472 |
| `closure` | 21.6 MB | 2.2% | +761,446 |
| `concatenated string` | 8.5 MB | 0.9% | +447,671 |
| `object shape` | 6.6 MB | 0.7% | +173,559 |

增长最大的单个条目：

| 增量 | 条目 |
|---|---|
| +89.63 MB | `(function anonymous(…)` 字符串 ×4 |
| +69.20 MB | `(function anonymous(…)` 字符串 ×4 |
| +67.72 MB | `(function anonymous(…)` 字符串 ×4 |
| +62.44 MB | `array (object properties)` ×305,633 |
| +50.75 MB | `(function anonymous(…)` 字符串 ×3 |
| +49.71 MB | `Object` ×1,725,889 |
| +43.12 MB | `system / ExternalStringData` ×2,069 |
| +42.66 MB | `(function anonymous(…)` 字符串 ×2 |
| +36.48 MB | `array (object elements)` ×729,221 |
| +33.73 MB | `system / InstructionStream` ×43,864 |

### 2.1 bundle 源码被整份重复保留

`(function anonymous(\n) {\n;(function(proxyWindow){with(proxyWindow.__MICRO_APP_WINDOW__)…` 正是 micro-app `bindScope` 的包裹形式。

round-10 里按 `Script.source_url` 归组，**12 个 bundle URL，每个都有多份 Script**：

| bundle | Script 副本数 | 源码占用 | 指向它的 SFI/闭包数 |
|---|---|---|---|
| app-ws/chunk-vendors | **5** | 112.04 MB | 201,165 |
| app-bpm/chunk-vendors | 4 | 69.20 MB | 114,895 |
| app-cpu/chunk-vendors | 4 | 67.72 MB | 107,996 |
| app-ses/chunk-vendors | 3 | 50.75 MB | 77,407 |
| app-flow/chunk-vendors | 2 | 42.66 MB | 76,750 |
| app-ws/app | 5 | 12.30 MB | 10,171 |
| app-cpu/app | 4 | 7.57 MB | 3,877 |
| app-flow/app | 2 | 5.48 MB | 3,536 |
| app-ses/app | 3 | 5.70 MB | 2,209 |
| app-bpm/app | 4 | 3.09 MB | 3,775 |
| **当前存活的那个应用**（chunk-vendors） | **1** | 12.03 MB | 15,993 |
| 同上（app 包） | 1 | 0.08 MB | 102 |

**总共 388.6 MB 的包裹源码留在堆里，占整堆 1211.9 MB 的 32.1%。** 每个 URL 只有 1 份是活的（存活的那个应用两份都恰好只有 1 份副本，可以直接对照），其余 2–4 份全是残留，**残留源码约 271.7 MB**（按"每 URL 保留 1 份、其余全部为残留"估算，假设各副本大小相近）。

> 口径说明：`concatenated string` 与 `sliced string` 的 `self_size` 只算节点本身，内容在子节点/父节点里。第一版统计没补这一层，把 app-ses/app 量成了 1.90 MB、把存活应用的 chunk-vendors 量成了 0.00 MB，总量低估。上表是补齐一层子节点后的口径。

已验证：这 5 份 app-ws/chunk-vendors 的 Script **各自持有 5 个互不相同的 source 字符串节点**（252570 / 330046 / 2587583 / 1797243 / 2791014）—— V8 既没有复用 Script，也没有复用源码字符串。

---

## 三、四个"切断后收益接近零"的负结果

这是本轮最重要的方法论结论。**任何单点切割几乎都释放不了东西。**

| 切什么 | 释放 | 释放节点数 |
|---|---|---|
| 42 个孤儿 CustomWindow + 21 个已销毁 CreateApp | **0.0 MB** | 233 |
| 25 个已销毁应用的**执行期 Context**（持有它们的那批作用域） | **0.0 MB** | 1,270 |
| 全部 `__webpack_require__`（118 个节点） | **10.7 MB** | 1,489 |
| 全部 508 个 `system / Script` | **73.0 MB** | 7,761 |

两条要读清楚：

1. 第二行说明：**销毁应用的模块图并不"独占地"挂在那 25 个执行期作用域上**。即使作用域里确实有 `internal:37 -> __webpack_require__` 这样的槽，把它们全切断仍只释放 1,270 个节点（全是 CreateApp、几个内部闭包和它们自己的属性存储）。模块图另有入口。
2. 第四行说明：源码总量是 388.6 MB，但切断全部 Script 只释放 73 MB。**大源码串还有 Script 之外的持有者** —— 追下去是答案（见 §4.1 的 1,323 个 `sliced string`）。

**这些实验能证明什么、不能证明什么（务必分清）：**

- **能证明**：这四类节点都**不是必要入口**（not a necessary entry）—— 去掉它们，内存仍然可达，所以它们只是"顺路被留下的结果"。据此可以排除"继续大范围清理空壳对象字段"这类修法。
- **不能证明**"不存在可定位的共同保留源"。收益低只说明**入口不止一个**，不等于没有一个上游节点同时支配它们。支配树 / 直接支配者分析才是回答这个问题的工具（§4 就是在做这件事）。
- **更不能证明**"bundle 靠自引用存活"。**GC 能回收引用环** —— 一个只被自身内部引用、外部不可达的子图会被整体回收。所以"模块图自己引用自己"本身不构成保活解释；必须有**环外**的活对象指向它。

也就是说：本轮四刀砍掉的是"结果"，还没找到"原因"。原因必须是一个**环外的、仍存活的持有者**。

---

## 四、机制链（逐层可核对）

### 4.1 重复源码的持有者

对 5 个 source 字符串做反向入边：

```
depth 1 : 1,323 个 sliced string  --internal:parent-->  源码串
          + 5 个 system / Script  --internal:source-->  源码串
depth 2 : 202,493 个 SharedFunctionInfo --internal:script--> Script
          （11,222 个不同的持有者分组）
```

**1,323 个 `sliced string`**：V8 的切片字符串只是"视图"（`self_size` 很小），但它会把**整个父串钉住**。这就是"切 Script 只释放 73 MB"的原因。

继续追这些切片的持有者：

```
slice --held by--> system / Context / scope  --context:e-->   （作用域变量）
        depth 2: closure (anon) --internal:context-->
        depth 3: closure "" --property:toString-->  ...
                 system / PropertyArray  --hidden:<dummy>-->
```

即：**切片挂在闭包作用域的变量上，沿作用域链最终被某个"带自有 `toString` 属性的函数"持有。**

### 4.2 已销毁 CreateApp 的持有者

21 个已销毁 CreateApp，每一个都只被**一个**持有者拿着：

```
CreateApp @9791453 (destroyed=true, sandBox=null)
  ← internal:146 ←  Context @9791440              （V8 闭包作用域，147+ 槽）
      ← property:<symbol> ← Error @9791408        （匿名 Symbol() 键）
          ← property:prototype ← closure @5003211
              ← property:CycleException ← closure @5003210
```

`Context @9791440` 里装的是**这个应用执行期的完整环境**：

```
internal:0   -> BytecodeWrapper        internal:37  -> __webpack_require__
internal:2   -> closure "PM"           internal:71  -> Window / http://localhost:3000
internal:32  -> closure "11069"        internal:82  -> runParsedFunction   ← micro-app 自己的
internal:42  -> closure "65483"        internal:87  -> runScript           ← micro-app 自己的
internal:66  -> system / JSProxy       internal:97  -> injectFiberTask     ← micro-app 自己的
internal:106 -> Array                  internal:146 -> CreateApp (已销毁)
```

`CycleException` / `topsort` 是 graphlib 的写法：`topsort.CycleException = CycleException; CycleException.prototype = new Error();`

可信的部分：**"某个 `Error` 对象经由匿名 `Symbol()` 属性持有一个执行期作用域"是一条真实的保留路径**，而 Error 的栈捕获确实会把作用域链带上。

**但不完整**：这只说明"存在这样一条路径"，没有说明它是**必要的**（§3 已验证：把 25 个执行期作用域全切断，收益 0.0 MB）。**真正缺的一环是：谁在长期保存这个 `Error`？** 这一步本轮没做完。

### 4.3 孤儿 CustomWindow 的持有者

42 个孤儿的持有者结构完全一致（每个 5 个持有者，2 个是 7 个）：

```
42 × native "system / JSProxy"     --hidden:-->               ← proxyWindow 仍指向它作 target
42 × Context / scope @2862397      --context:microAppWindow--> ← 框架闭包作用域（变量槽）
42 × Context / scope @3417695      --context:microAppWindow--> ← 框架闭包作用域（变量槽）
 6+ × Context / scope @…           --internal:extension-->     ← 子应用 bundle 里的 with(CustomWindow) 作用域
```

**关键点：`WithSandBox.destroy()` 已经做得很彻底** —— 它把 `microAppWindow` 的所有自有键删光、并把自己持有的引用置空（`this.microAppWindow = null` / `this.proxyWindow = null`）。孤儿之所以还在，是因为**框架自己的两个闭包作用域**（有 `microAppWindow` 变量槽）和**子应用 bundle 里的 `with` 作用域**仍指向它们。

- 名字里的 `@N` 是 **scope-id 不是节点 ordinal**，会重复，不要当成节点号用（我在分析中踩过这个坑）。
- 42 × JSProxy 说明：代理对象本身也还被别人持有，而代理会把 target 钉住。

### 4.4 为什么每次执行都会新建 Script

`src/source/scripts.ts:84`：

```ts
function code2Function (app: AppInterface, code: string): Function {
  const targetWindow = getEffectWindow(app)
  return new targetWindow.Function(code)
}
```

`parsedCode` 按 `(address, appName)` 缓存在 `sourceCenter` 的 `appSpace` 里，`releaseApp(appName)` 在销毁时会 `delete appSpace[appName]`，并在此后 `appSpace` 为空时把整条 address 记录逐出（`source_center.ts:95-109`）。

**这一步是有效的** —— 指标里 `parsedCode` 的边数从 round-2 起恒为 **12**，不再增长。

但问题的关键是：

> `new Function(parsedCode)` 产生的 **Script 自己也持有同一个 source 字符串**。框架删掉 `appSpace` 只是放开了自己那一份引用；只要这次执行产生的**任何一个 SFI / 闭包还活着**，Script 就活着，22 MB 的源码就跟着活着。

而这次执行产生的闭包，正是被 §4.1–4.3 那些**并行入口**钉住的。

---

## 五、可以下的结论

1. **存在真实泄漏**：活沙箱数不变（恒 3）的前提下，round-2 → round-10 的堆增量为 **970.1 MB**。这是"同活沙箱数量下的堆增量"，不是"已销毁应用的净遗留物"（区别见 §2 的口径限制）。
2. **最大单项是重复保留的 bundle 源码**：**388.6 MB（占整堆 32.1%）**，12 个 URL 各有 2–5 份 Script，其中残留约 271.7 MB。
3. **孤儿 CustomWindow / 已销毁 CreateApp 不是必要入口**：整批切断释放 **0.0 MB / 233 节点**。它们只应当作为"这里发生过销毁"的指标使用。
4. **四类最明显的一刀切都不是必要入口**：孤儿对象、执行期 Context、`__webpack_require__`、全部 Script 分别只释放 **0.0 / 0.0 / 10.7 / 73.0 MB**。据此可以排除"再加一条清理语句"式的修法。
   **但这不等于没有共同保留源**：入口多 ≠ 上游没有支配者。下一步应当用**直接支配者（idom）**而不是切割实验去找它 —— 切割回答"是不是必要"，idom 回答"谁在上游"。
5. **重复编译不是根因，是放大器**：`code2Function` 每次 `new Function` 都会让残留成本**翻倍**（多一份 22 MB 源码 + 一整套 SFI/字节码）。但**真正要修的是"让旧函数继续可达的那个环外引用"**，不是编译本身 —— 停止重复编译只是把泄漏速度降下来，不解决可达性。
6. **已证实两条从真实根出发的保留链**（§7.2）：基座 `Window.regeneratorRuntime` → CPU 子应用闭包组；`window.trustedTypes` 上的策略 → `V8CreateHTMLCallback` → WS 子应用的 `createHTML` 闭包。两条都指向**已销毁**的子应用。
7. **框架已做的清理是有效的，但不够**：`WithSandBox.destroy()` 对 CustomWindow 的全量清理、`releaseApp()` 对 `appSpace` 的逐出都确实生效（`parsedCode` 恒为 12 就是证据）；漏的是**执行期作用域与子应用侧库的引用**这些不在框架名下、却由框架的行为（同 realm 执行）产生的引用。

## 六、没有证实的部分（不要当成结论用）

- **没有证明"释放 X 就能回收 Y"**。四类切割实验（孤儿对象 / 执行期 Context / `__webpack_require__` / 全部 Script）收益分别是 0.0 / 0.0 / 10.7 / 73.0 MB，说明这些入口是并行的，没有找到任何"独占所有权"的锚点。970 MB 是按**构成**刻画出来的，不是按**独占所有权**。
- **支配树的自顶向下归因已补齐，但不能用来回答"属于谁"**。round-10 的两个合成根展开结果（`--children` × `--depth`）：

  | 根 | 直接支配的子节点 |
  |---|---|
  | `(Global handles)` 621.0 MB | 一个 128.3 MB 的 `Context / scope @2922879` 簇；**133.4 MB 的包裹源码串**（22.4 / 21.3 / 21.3 / 17.3 / 17.3 / 16.9 / 16.9 MB） |
  | `C++ Persistent roots` → `Pending activities` 206.1 MB → `blink::HeapVectorBacking<…>`（396,979 个子节点） | **73.5 MB 的包裹源码串**（22.4 / 17.3 / 16.9 / 16.9 MB）+ 三个各 9.3 MB 的 `closure "se"` → `Context / scope` 簇 |

  **判读时必须带 §7.4 的纠正**：`idom[X] = 某个根类别` 的含义是 **"X 没有单一 JS 支配者"**，不是"X 由原生持有"。所以这两行能支持的结论只有一条：
  **相当大一部分被保留的 bundle 源码没有唯一的 JS 所有者** —— 它经由多条互相独立的路径存活，其中若干条终止于 Blink/cppgc 侧。
  这也和 §3 的切割结果一致（切任何单一入口都释放不了多少）。

  另外 `Pending activities` 是 Blink cppgc 的"待终结"状态，属于**可能自行推进的中间态**，不能当稳态读。
- **`property:toString` 那一层已收口**。基座 `Function.prototype`（native context `http://localhost:3000`）上的 `toString` 是**内建** `FunctionPrototypeToString (builtin)`，即**没有活着的补丁**。在 `Heap-20260913T171026` 上复查：名为 `toString` 的属性边共 **2,450 条**，唯一来源 **246 个**，其中绝大多数是 V8 内部结构（`code (constant pool)`、`code system / ScopeInfo`）和库自身的方法对象（如 `closure "lodash"`）—— 即**属性名的表示**，不是"装着被改写 `toString` 的应用对象"。此前的疑虑可以关闭。
- **工具可信度**：`heap_root_cut.js` 的反向索引原先**未排除 weak 边**（已修），会把弱表算成持有者；`heap_path_to_root.js` 在 `Heap-20260913T171026` 上**节点名与类型不可靠**。凡引用过这两类输出的结论都需重核 —— 本文档 §7.2 的结论已改为只用 `--describe` / `--retainers`（强边）的直接验证结果。
- **"指向"与"保活"已按 §7.4 分开**：92 个强持有者之间**没有共同支配者**（22 个无单一支配者、70 个被应用侧作用域链支配），所以"持有者"这一层问不出保留源。**已闭合，结论是"这一层没有答案"。**
- **没有在真实浏览器里复现"不销毁就回收"**。要变成可验收的结论，需要一次"逐步释放 + 每步量堆"的对照实验。
- **新旧基线尚未在同一条件下对比**。round-1…10 早于最近修复，只能证明**历史残留确实存在**，不能用来判断当前修复有效或无效；`E:/Heap-20260913T171026.heapsnapshot`（222.3 MB）是单点快照，**也不能单独证明问题已解决**。要判定修复效果，需要在修复后的代码上按 round-1…10 相同的方式重跑一遍多轮基线。

---

## 七、修复后的基线（`E:/Heap-20260913T171026.heapsnapshot`）

这份快照采集于 17:10，**晚于 round-1…10（14:21–14:54）的那批修复**，且是"全部退出后"的状态：

| 指标 | 值 | 说明 |
|---|---|---|
| heapSelfMB | **222.3 MB** | |
| `WithSandBox` 实例 | **0** | 没有任何活沙箱 |
| `CreateApp` 实例 | **0** | 连已销毁的也没有 |
| `CustomWindow` 实例 | **3** | **全部是孤儿** |
| Script 总数 | 35（5 个有 URL） | |
| bundle 源码合计 | **53.9 MB** | 对比 round-10 的 388.6 MB |
| 每个 bundle 的 Script 副本 | **1** | 对比 round-10 的 2–5 |
| micro-app 装在共享对象上的访问器 | **0** | |

### 7.1 重复编译的现状（不能据此判定修复有效）

round-10 里同一 URL 有 2–5 份 Script、源码共 388.6 MB；这份快照里每个 URL 只有 **1 份**，源码共 **53.9 MB**。对照：round-1（只有基座、无子应用）是 77.7 MB。

> **但这两者不可直接比，结论要压住。** "1 份/URL"完全可以由"这次会话里每个应用只挂载过一次"解释，而不需要任何修复 —— 副本数取决于**挂载次数**，不取决于修复效果。要判定"重复编译的累积是否已被修好"，唯一办法是**在修复后的代码上重跑 round-1…10 那样的多轮装载序列**（§9.3）。
> 同理，"53.9 MB < 388.6 MB"只说明这次残留少，不说明修复有效。
>
> 本文档对这份快照能下的结论只有一条：**它是一份"全部应用退出后"的干净样本，可以用来定位退出后仍残留的对象**（§7.2 就是这么用的）。

### 7.2 已核实的真实保留链（只列直接验证过的）

**核查方法必须纠正**：`--name=` 只能搜到**节点名**，搜不到**属性引用**。下面第一条就是这么漏掉的。
先用 `heap_find_edges.js <snap> <属性名>` 找边，再对目标做 `--retainers`。

#### (1) 基座 `Window.regeneratorRuntime` → CPU 子应用闭包

```
Window [JSGlobalObject] / http://localhost:3000
   --property:regeneratorRuntime-->  Object @1511887
       property:wrap             -> closure "u"           ← cpu.dev/.../chunk-vendors
       property:mark             -> closure               ← cpu.dev/.../chunk-vendors
       property:awrap            -> closure               ← cpu.dev/.../chunk-vendors
       property:AsyncIterator    -> closure "x"           ← cpu.dev/.../chunk-vendors
       property:values           -> closure "E"           ← cpu.dev/.../chunk-vendors
```

**基座 window 的一个属性，直接挂着一个已销毁子应用 bundle 的闭包组。** 这是**真实根**（window 本身是根）。

#### (2) `window.trustedTypes` → WS 子应用 `createHTML` 闭包

```
Window (element:#25) → blink::HeapHashTableBacking → TrustedTypePolicyFactory     （= window.trustedTypes）
  → TrustedTypePolicy @…           --element:#3--> blink::TrustedTypePolicyOptions
  → blink::TrustedTypePolicyOptions --element:#1--> V8CreateHTMLCallback
  → V8CreateHTMLCallback            --element:#1--> closure "createHTML"   ← ws.dev/.../chunk-vendors
  → closure createHTML  --internal:context--> Context @294975   （121 个槽，含 \s*!important$、transition）
```

链上的每一跳都用强引用边直接验证过。**策略对象是浏览器内建，但 `V8CreateHTMLCallback` 抓着的是 WS 子应用的闭包**，而 `createHTML` 的作用域就是 WS bundle 的模块作用域。
Trusted Type 策略一旦注册就在 document 生命周期内存在，**JS 侧删不掉**。

#### (3) 三个孤儿 CustomWindow 的持有者

```
CustomWindow ← native "system / JSProxy"  --hidden:-->            （3/3）
             ← Context / scope @…  --context:microAppWindow-->     （框架闭包作用域）
             ← Context / scope @…  --internal:extension-->         （子应用 with(CustomWindow) 作用域）
```

反向入边（**已排除 weak 边**）共 **129 个强持有者 / 67 组**，其中：

| 持有者 | 数量 | 边 |
|---|---|---|
| 闭包作用域（含 `globalThis` / `self` / `window` / `proxyWindow` 槽） | ~40 | 作用域槽 |
| `Object`（含 `property:exports` / `property:global` / `property:Z`） | 13 | `property:…` |
| `closure native_bind` | 10 | `internal:bound_this` |
| `system / PropertyArray` | 3 | `hidden:(Debugger)` / `hidden:(Compilation cache)` |

> ⚠️ **这一条只能说到"谁指向它"，不能说"它被谁保活"。** 持有者自身是否被活对象保留，本轮**没有证明** —— 它们可能仍在待回收的内部图里。要坐实，需要对这 129 个持有者各自做一次到根的验证，本轮没做。§7.2(1)(2) 那两条之所以能下结论，是因为它们的持有者是 `Window` 这类**明确的根**。

#### 工具缺陷（已修，影响面需注意）

`heap_root_cut.js` 的反向索引**原先没有排除 weak 边**（正向 BFS 排了，反向漏了），会把 `WeakFixedArray` / `WeakArrayList` 这类**弱表**算成持有者，整体夸大"持有者数量"。

- 已修复：反向索引改为跳过 `edgeType === 6`。
- 对 §7.2(3) 的 129 这个数字**复核后无变化**（这些恰好都是强边）。
- 但**这份快照之外**的多次 `--retainers` 输出里出现过 `system / WeakFixedArray | weak:…` 分组，那些是弱引用，**不应被当作保留证据**。凡引用过这类分组的结论都要重核。
- `heap_path_to_root.js` 在快照 `Heap-20260913T171026` 上给出的节点名与类型**不可靠**（把 `int` 标成 `system / Context / scope`、把 `SharedFunctionInfo` 标成 Context），**本轮结论一律不引用它的路径输出**。

### 7.3 对四个"已确认入口"的核对结果

| 入口 | 实测 |
|---|---|
| `regeneratorRuntime` | **存在，而且是从基座 window 直达已销毁子应用闭包的一类真实入口**（见 7.2(1)）。此前写"0 个匹配"是**方法错误**：只按节点名搜，漏了属性引用 |
| Trusted Types 回调 | **成立**。`createHTML` 来自 WS 子应用，由 `V8CreateHTMLCallback` 保留（见 7.2(2)）。此前只说"策略是内建"就排除，是**只查了构造函数没查回调** |
| `dom7Listeners` | 真实 `<body>` 上确实挂着它，数组里是 `app-issues` bundle 的 `listener` / `proxyListener`。**不能说成"活应用的合法状态"** —— 这份快照里 `CreateApp` / `WithSandBox` 都是 0、且是退出登录后的状态，**不存在"活应用"**；回调仍可达恰恰说明该应用**被保留了** |
| 共享访问器 | 这份快照里没有任何 micro-app 安装在共享对象上的 `get/set`；12.8 万个访问器全部来自应用自身代码。**同意：目前没有证据证明是 micro-app 自己的访问器残留** |

### 7.4 92 个持有者的"到根"验证（本轮结论）

对 §7.2(3) 的持有者做了支配树验证。方法：取 3 个代理的全部强持有者（合并去重后 **92 个**），
在快照 `Heap-20260913T171026` 上跑支配树，求每条的 idom 链。

#### 结果一：持有者这一层没有"共同的保留源"

**全部 92 条 idom 链的交集只有 `(GC roots)` 和节点 0** —— 即**不存在任何一个 JS 对象同时支配这 92 个持有者**。分布：

| 情况 | 数量 | 说明 |
|---|---|---|
| `idom` 直接是 `(GC roots)` | 22 | **没有任何单一支配者**，从根出发有多条独立路径 |
| 被应用侧作用域链支配 | 70 | 首跳多是 webpack 模块作用域 / 模块导出对象（`__webpack_module_cache__`、`property:get Z` 等） |

> ⚠️ **术语纠正**：`idom[X] = (GC roots)` **不等于**"X 由原生根持有"。它的准确含义是"X 没有单一支配者"。
> 另外 `heap_dominators.js` 的 **`idomEdge` 字段不可靠**：它输出了 `(GC roots) --internal:previous--> scope`，
> 而 `(GC roots)`（节点 1）只有 30 条 `element:#N` 指向各根类别。**引用 idom 链时只取节点、不要取边。**

结论：**"谁指向代理"这一层问不出答案** —— 持有者彼此之间没有共同上游。要继续追，得换一个层级。

#### 结果二：真正的保留是集中的，而且全在同一个已销毁应用的 bundle 里

同一份快照的 `topByRetained`：

| retained | 节点 |
|---|---|
| 25.2 MB | `system / Context / scope @624433`（**2352 个槽，全部是 `ws/chunk-vendors` 的闭包**） |
| 24.9 MB | `closure t`（graphlib `topsort`，来自 `ws/chunk-vendors`） |
| 24.9 MB | `closure n`（graphlib `CycleException`，来自 `ws/chunk-vendors`） |
| **24.9 MB** | **`object Error` @1327260** |

`Error` 的持有者**只有一条链**：

```
ws/chunk-vendors  bundle
  → closure "t" (topsort)  --property:CycleException-->  closure "n" (CycleException)
      --property:prototype-->  object "Error" @1327260
                                 --property:<symbol>(匿名 Symbol)--> 执行期作用域
```

`closure t` 的 2542 个持有者是 dagre 的布局函数（`layout` / `execute` / `beforeDraw` / `getDefaultOptions` / `destroy` / `e`），
它们又共同指向 `Context / scope @624433`（那 25.2 MB）。

#### 综合结论

1. **92 个持有者之间没有可定位的共同保留源** —— 这一层是"散的"。
2. **但残留本身不是散的**：本快照最大的几块各约 25 MB，**全部属于同一个已销毁的应用（`app-ws`）**，
   且通过 graphlib/dagre 的模块级对象（`topsort` / `CycleException` / `Error.prototype` / 布局闭包）串在一起。
3. 这与 §7.2(2) 验出的真实根是**同一个应用**：`window.trustedTypes` 上的策略保留了 `app-ws` 的 `createHTML` 闭包。
4. 因此**下一步不该继续在"谁持有孤儿的代理"上挖**，而应该问：**`app-ws` 这个 bundle 的模块图，为什么在应用销毁后整体存活？**
   目前已有的两个线索是：`window.trustedTypes` 的策略回调（已证实是真实根）、以及 graphlib 的 `CycleException.prototype = new Error()`（把执行期作用域挂在一个 Error 上，已证实是 `Error` 唯一的持有链）。

### 7.5 结论：app-ws 模块图整体存活的原因（已闭合）

用 `heap_grow_boundary.js` 把簇的边界一层层往外推，直到接上活代码。种子取 §7.4 里两个独占锚点
（`Error @1327260` + `scope @624433`），跑 16 轮：

| 轮 | cluster 节点 | cluster MB | 边界集 | 入边/来源 | GC 根直达 | 框架闭包 |
|---|---|---|---|---|---|---|
| 1 | 9,759 | 25.21 | 2 | 18 / 18 | 无 | 0 |
| 6 | 32,780 | 25.99 | 511 | 466 / 287 | 无 | 0 |
| 11 | 748,284 | 51.32 | 1,821 | 10 / 6 | 无 | 0 |
| **16** | **760,868** | **74.54** | **1,887** | **23 / 17** | **无** | **0** |

**74.54 MB —— 整堆 222.3 MB 的 33.5% —— 被这一个簇独占。**

推到第 16 轮后，进入这个 74.5 MB 簇的边**只剩 23 条 / 17 个来源**，全部清单：

| 条数 | 来源 | 节点 | 性质 |
|---|---|---|---|
| 7 | `array (anon)` [无 url] | #864213 | 待定 |
| **5** | **`closure "setup"` ← `issues.dev/…/app.ca861a93.js`** | #645557 | **子应用 issues 的闭包** |
| **2** | **`object Object`** | **#774526** | **就是 `<body>.dom7Listeners` 指的那个对象** |
| 1 | `closure "Tn"` ← issues 子应用 | #645552 | 子应用闭包 |
| 1 | `closure "default"` ← issues 子应用 | #1890214 | 子应用闭包 |
| **1** | **`native TrustedTypePolicyFactory`** | #1545008 | **= `window.trustedTypes`** |
| 7 | `Context / scope @441455 / @961645 / @1407903 / @1055685` 等 | — | 作用域 |
| 1+1 | `(object elements)` / `FeedbackCell` | — | 待定 |

**关键判读：**

1. **`syntheticIngress = []`** —— 没有任何一条 GC 根边**直接**进入这个簇。
2. **`microAppIngress = []`** —— 入口里**没有一条来自 micro-app 框架自己**。
3. 入口是三个具体的东西：
   - **真实 `<body>` 上的 `dom7Listeners`**（`<body>` 是根）→ 它持有 `app-issues` 的监听闭包 → 进而进入 ws 簇；
   - **子应用 `issues` 的 bundle 闭包**（`setup` ×5、`Tn`、`default`）—— 一个子应用在引用另一个已销毁子应用的模块图；
   - **`window.trustedTypes`（TrustedTypePolicyFactory）直达**。

#### 回答上一轮留的问题："为什么 app-ws 的模块图在销毁后整体存活"

**不是因为它自己引用自己**（GC 能回收环），而是因为**环外有三个具体入口**：

```
<body>.dom7Listeners  ──┐
app-issues 的闭包       ├──→ [ app-ws 的模块图 74.54 MB ]
window.trustedTypes    ──┘
```

三者都在 §7.3 你点名的那份清单里 —— **`dom7Listeners` 和 Trusted Types 回调都被证实是真入口**，
落在我上一轮"核对结果"里对它们的判断是对的（dom7 是残留不是合法状态、Trusted Type 回调抓着子应用闭包）。

#### 一处必须自我纠正

§7.2(2) 我写了"`window.trustedTypes` → `createHTML` 是已证实的保留链"。**单独切断 `createHTML` 释放 0.00 MB**，
所以它不是**唯一**的保留源；但 §7.5 显示 `TrustedTypePolicyFactory` **本身**是这个 74.5 MB 簇的入口之一。
两者不矛盾：**trustedTypes 是入口之一，而不是全部** —— 这正是 §3 反复出现的"并行入口"结构，只不过这次我们把它穷举完了。

## 八、复现命令

```bash
# 1) 采集（Chrome 需以 --remote-debugging-port=9222 启动）
node scripts/heap_baseline_round.js --out-dir=E:/heap-baseline

# 2) 每轮的活沙箱 / 孤儿判定（WithSandBox 实例数 = 活的；CustomWindow − 活 = 孤儿）
node scripts/heap_app_audit.js <snapshot> --out=<json>

# 3) bundle 副本数与源码占用
node scripts/heap_scripts_by_url.js <snapshot> --top=20 --out=<json>

# 4) 切割实验（注意：节点号是空格分隔的独立参数，不是逗号分隔）
node scripts/heap_exclusive_size.js <snapshot> <ord1> <ord2> ...
node scripts/heap_exclusive_size.js <snapshot> "name:system / Script"

# 5) 反向入边 / 逐层持有者
node scripts/heap_root_cut.js <snapshot> --retainers=<ord> --retainerDepth=3 --describe=<ord>

# 6) 同一活沙箱数下的跨轮对比
node scripts/diff_heap_snapshots.js <早> <晚> 40 25
```

本轮产物在 `E:/heap-baseline/`：`baseline.jsonl`、`audit-r10.json`、`scripts-r10b.json`、
`cut-dead.json`、`cut-ctx.json`、`cut-scripts.json`、`cut-webpackreq.json`、
`chain-r10.json`、`slice-ret.json`、`src-ret.json`、`diff-2-10.json`、`dom-r10.json`。

## 九、下一步建议

**核心判断**：重复编译放大了残留成本，但**真正要修的是"让旧函数继续可达的引用"，不是编译本身**。

> 上一版这里写着"§7.1 已证明重复编译已修好"，**这是错的，已删除**。§7.1 已经写明：单份快照不能区分"修复生效"和"这次会话本来就少装卸了几次"。**在重跑多轮基线之前，谁都不能说重复编译已被修好。**

1. **证据现状**：

   | 项 | 状态 |
   |---|---|
   | `Window.regeneratorRuntime → CPU 闭包` | **已证实**（真实根，§7.2(1)） |
   | `window.trustedTypes → WS createHTML 闭包` | **已证实**（真实根，§7.2(2)） |
   | 92 个代理持有者的到根验证 | **已完成**（§7.4）：这一层**没有共同保留源**，不必再挖 |
   | 残留的实际形态 | **集中在少数 ~25 MB 的簇里，且全部属于 `app-ws`**（§7.4 结果二） |

   下一步的问题已经变了：不再是"谁持有孤儿代理"，而是 **"`app-ws` 的模块图为什么在销毁后整体存活"**。

2. **两条已着手实施（见 §10，18:03–18:05 落盘，单测 13 项通过）**：
   - **`Window.regeneratorRuntime`**：已加入 `trackedRawWindowKeys`，终态释放时按"描述符仍与登记写入一致"恢复。
   - **`window.trustedTypes` 策略回调**：已新增 `src/sandbox/trusted_types.ts`，包装函数只捕获可释放的 callback cell，终态 `dispose` 置 null。
   - **但两者都还没有"修复后快照"** —— §7.5 的 74.54 MB 是 17:10 的状态，早于这两处实施。**下一个动作应该是重新采集并复测 §7.5 的 17 个入口，看 `dom7Listeners` / `issues` 闭包 / `trustedTypes` 三条是否减少。**

3. **不要直接去掉 `with`。** 上一版建议"改成显式传参即可让 `with` 作用域整类消失"，**这不是等价改动**：`with(proxyWindow.__MICRO_APP_WINDOW__)` 承担的是**动态全局名解析**（子应用代码里任意未声明的标识符都要落到沙箱 window 上），换成显式参数传递会改变解析语义、破坏沙箱隔离，不能据此直接替换。要做也只能先做一次独立评估。

4. **区分"能修的"和"修不了的"**：`hidden:(Debugger)` / `hidden:(Compilation cache)` 这类 V8/DevTools 根类别不由 micro-app 控制。采集基线时必须关掉 DevTools 面板。

5. **建立"修复后"的多轮基线**：与 round-1…10 同条件（同样的开关应用序列、同样的 GC 与等待参数、不开 DevTools），才能回答"修复是否有效"。单点快照不足以判定。

6. **剩余的未处理入口**：§7.5 的 17 个入口里，`<body>.dom7Listeners`（2 条）与**子应用 `issues` 的闭包**（7 条）**不在 §10 的处理范围内**，仍然开着。dom7 的处理需要归属判断（`<body>` 是共享的，只能删属于本次实例的监听项）。
7. **不要**再去调 `CreateApp` / `AppTask` 的销毁顺序 —— 本轮数据表明那不是瓶颈。

## 十、Trusted Types 回调隔离实施（2026-09-13）

### 10.3 销毁后窗口代理晚到读取保护

审查发现 `createProxyWindow` 的 `!sandbox` 分支直接返回基座对象，旧应用回调销毁后重新读取 globalPlugin 时会绕过 resourceFactories 的实例销毁保护。该分支现在仍调用原实例的 resourceFactories.wrap，禁止旧实例经标记工厂重新创建资源，而同名新实例使用新的 scope 不受影响。新增晚到读取与同名新实例测试；四套相关单元测试共 24 项通过，源文件 lint 与类型检查通过。真实产品的多轮 GC 仍未验收。

> **归属说明**：本节记录的不是本报告作者的分析，而是**另一处实施**（`src/sandbox/trusted_types.ts`、
> `global_env.ts` 的 `trackedRawWindowKeys`、以及两个测试文件，落盘时间 18:03–18:05）。
> 已复核：文件存在；`npx jest trusted_types_cleanup global_snapshot_cleanup` **实跑 2 套 13 项全部通过**。
> 其余描述（构建状态、真实页面验证）**未由本报告复核**。

### 时间线（决定这些结论各自对应哪一版代码）

| 时间 | 事件 | 对应基线 |
|---|---|---|
| 14:21–14:54 | round-1…10 采集 | **所有近期修复之前** |
| **17:10** | `Heap-20260913T171026` 采集（222.3 MB） | **§10 修复之前** |
| 18:03–18:05 | §10 的 Trusted Types / regeneratorRuntime 修复落盘 | **尚无对应快照** |

**因此本文 §7.4 / §7.5 描述的"74.54 MB 簇 + 三个入口"，是修复前那一版的状态。**
`window.trustedTypes` 与 `Window.regeneratorRuntime` 两条入口正是 §10 要处理的对象；
**它们是否真的被切断，必须用 18:05 之后的代码重新采集才能判定**，不能拿 17:10 的快照下结论。


### 10.2 dom7 登记终态清理

`event_target.ts` 对已经记账的 DOM 监听器，在普通 release/remove 时保留与目标自身 `dom7Listeners[event]` 中 listener/proxyListener 身份一致的清理候选；只有 terminal dispose 才移除这些条目。通过数据描述符读取登记，不调用库 getter；保留无关基座条目以及其他应用仍持有的匹配条目。共享的同一原生监听器也保留到最后一个记账应用释放。未归属的监听器不能据此自动推断为子应用，因此不扩大为全局登记清空。

新增测试覆盖普通 stop 保留登记、rebuild 后可用、terminal 删除自有记录但保留基座监听、跨应用共享条目及原生监听保护。event_target_effect / trusted_types_cleanup / global_snapshot_cleanup / resource_factory 四套共 23 项通过，源文件 lint 与类型检查通过，micro-app 已重新构建，wonder-core-web 未打包。真实浏览器验收尚未完成：本次电脑工具库存再次返回 apps=[]、browsers=[]，无法执行真实产品多轮 Tab/登出操作。以上是实现与单元测试证据，不是实际 GC 收敛证据。

### 10.1 已验证的原始 Window 属性逃逸清理

`beginRawGlobalObjectTracking` / `finishRawGlobalObjectTracking` 现在额外跟踪原始 Window 的 `regeneratorRuntime` 描述符，只跟踪这个已在快照确认的属性，不对整个 Window 做回滚。继续复用 CreateApp 实例作为 owner，终态释放时仅在当前描述符仍与已登记写入一致的情况下恢复原描述符；基座后续替换不被覆盖。新增测试验证恢复以及保留基座后续写入，global_snapshot_cleanup 与 trusted_types_cleanup 两套共 13 项通过，源文件 lint 通过。此机制覆盖同步脚本执行中的直接属性替换，不覆盖绕过代理的后续异步写入或既有 runtime 对象的内部字段变更；尚需真实多轮基线验证。

新增 `src/sandbox/trusted_types.ts`，由每个 with 沙箱单独创建 scope。原生策略注册时只保存模块级包装函数，包装函数仅捕获可释放 callback cell，不捕获注册调用的 options、factory 或子应用 window。终态 dispose 将 cell.callback 置 null；策略继续存在，但旧回调不再被策略保留，后续调用抛 TypeError，不能绕过安全校验。普通 UMD stop 不 dispose，保活不受影响。注册失败也清空已建立的 cell。

`trusted_types_cleanup.test.ts` 与 `resource_factory.test.ts` 共 6 项通过，覆盖回调参数与返回值、失败关闭、实例隔离、注册失败、UMD stop 与 terminal destroy。源文件 lint 通过，micro-app 已构建；wonder-core-web 未打包。测试使用模拟原生策略工厂，尚未以真实 Trusted Types/CSP 页面及多轮 GC 证明整体泄漏消除。dom7 登记与共享全局污染仍待修复验证。

---

## 十一、残留是可回收的：整份 bundle 会"一次性整体释放"

> Review correction（2026-09-13 实施核对）：§9(6) 的 dom7“尚未处理”描述已经落后于代码；§10.2 已实现通用 EventTarget 登记清理，本轮进一步接通 with/iframe 的 window/document 独立 listener_effect。另一个子应用的 setup/Tn/default 闭包是簇外入边，不代表闭包自身是活根，不能直接删除这些第三方模块函数。

十轮里有三轮总量是**下降**的（r5→r6 −75.6、r6→r7 −13.6、r9→r10 −5.8 MB）。
把下降那一轮做**双向** diff（`diff_heap_snapshots.js` 原本只输出增长，已补 `bySelfShrink`）：

**round-5 → round-6：总量 −75.6 MB = 增长 +13.5 MB ＋ 回收 −86.5 MB**

| 回收 | 节点数 | 条目 |
|---|---|---|
| **−22.41 MB** | **−1** | 包裹源码串（11,748,062 字符） |
| **−17.30 MB** | **−1** | 包裹源码串（9,069,964 字符） |
| −2.46 MB | −1 | 包裹源码串 |
| −5.06 MB | −8,641 | `array (object properties)` |
| −4.79 MB | −6,437 | `system / InstructionStream` |
| −3.57 MB | −34,230 | `array (object properties)` / `array` |
| −2.90 MB | −102,291 | `object Object` |
| −1.58 / −1.47 / −1.24 / −0.97 MB | −8.2万 ~ −9.9万 | `code` 各类（SFI / BytecodeArray / FeedbackCell） |
| −1.42 / −1.29 MB | −15,971 / −16,406 | `blink::StyleRule` / `ImmutableCSSPropertyValueSet` |
| −1.25 MB | −44,061 | `closure` |

### 结论（这条把前面所有零散结果串起来了）

1. **残留不是"永久不可回收"的。** 一旦某个 bundle 变成不可达，它是**整体消失**的：源码串（−1 个节点、−22.41 MB）、它的整套 SFI/字节码/FeedbackCell、它的 `(object properties)`、它的 CSS（StyleRule / CSSPropertyValueSet）、它的闭包 —— 一次性全部释放。
2. **一个已销毁应用的整份残留约 25–40 MB**，释放是**原子性**的。
3. **这解释了 §3 为什么"切任何单一入口都释放不了东西"**：释放的条件是**该簇的所有入口同时消失**，不是某一个。
   §7.5 测出 ws 簇有 **17 个入口** —— 只切掉 `createHTML` 那一条，剩下的 16 条照样钉着它（实测 0.00 MB）。
4. **也印证了核心判断**："真正要修的是让旧函数继续可达的引用"。修的方向不是"加大清理力度"，而是**把这 17 个入口逐个消掉**；每消掉一个簇的全部入口，就能一次性收回 25–40 MB。
5. 轮与轮之间的涨跌，反映的是**哪些应用在这一轮恰好变成完全不可达**，而不是"每轮固定泄漏 X MB"（§1.1 的结论在这里得到机制层面的解释）。

## 十二、实施核对与剩余缺口（2026-09-13）

- 已实现：Trusted Types 可释放回调 cell；同步脚本中的原始 Window.regeneratorRuntime 描述符归属恢复；dom7 匹配登记终态清理；旧窗口代理晚到读取的资源工厂保护。
- 本轮补齐：window/document 的 listener_effect 使用原生方法，绕过通用 EventTarget 补丁；新增 beforeRemove 桥接，将已确认的 dom7 匹配记录交给实例终态清理。with 与 iframe 均接入，普通 release 只收集候选，不删除登记，终态 dispose 才执行。新增 document 普通 stop/terminal destroy 回归测试，五套相关测试共 32 项通过，源文件 lint 与类型检查通过。
- 尚未完成：未归属异步监听器的实例级归属；绕过窗口代理的后续异步全局写入，以及既有 runtime 对象内部字段污染；报告 Issues 闭包本身到活根的路径验证；真实 Trusted Types/CSP 与修复后的多轮 GC 产品验收。
- 不采用：去掉 with、更改第三方 webpack 模块表、清空基座监听器或 DOM、仅按当前活沙箱数量猜归属。这些不是已被证实的等价、安全修复。

32 项测试属于相关路径回归，不是整体产品内存收敛证明，不能据此将完整泄漏目标标记完成。

### 12.1 产品页签复核（2026-09-14）

- 补充 raw window 显式 removeEventListener 后的 dom7 清理测试：原生监听已移除，库登记保留至 terminal destroy，仅删除匹配子应用项。测试环境只初始化一次原生 descriptor，避免重复初始化把 DOM 补丁捕获为原始 setter。五套相关测试共 33 项通过。
- 真实页面：督办 → 已办 → 督办，督办动态组件名称仍为 `WS-Component-TypeRenderMenu-1789349170707`，本次切换未重建。
- 关闭后台已办：targets 2，框架日志 before 11 → after 9；关闭当前督办：targets 3，before 9 → after 6，自动选中个人工作区 `/wd/ws`。
- 上述只证明本次页签实例保留/销毁流程，不证明 GC 回收。当前浏览器扩展不提供 GC/堆快照能力，本机 CDP 采集端口检查失败（沙箱外复核仍失败）；修复后多轮堆基线尚未完成。
- 关闭后重新打开督办：动态组件变为 `WS-Component-TypeRenderMenu-1789349261315`（关闭前为 `1789349170707`），页面主容器 ID 也改变，本次重开未复用关闭前实例。此证据仍不等价于旧实例已被 GC。

---

## 十三、真实浏览器多轮 GC 验收（2026-09-14）

> ⚠️ **本章的阅读顺序**：§13.11~§13.26 的 **~110 MB/销毁轮** 是**非产品路径**下的数字，
> 已在 **§13.32** 用对照实验判定（需要 `router.push` 直接驱动 **且** 强制 `destroy` 属性）。
> **产品路径上的真实数字是 §13.30 / §13.32 的 0.13 MB/轮。**
> 先读 §13.30 → §13.32，再回头看前面的小节。

**背景**：`lib/index.esm.js` 已于 13 日 18:20 重新构建，产物里含 `createPolicy` ×6、
`regeneratorRuntime` ×1、`trackedRawWindowKeys` ×3 —— 即 §10 的修复确实在被加载的代码里。
本次验收用的是**当时正在跑的代码**（vite 从 `lib/index.esm.js` 提供服务）。

### 13.1 方法

人工"开 tab 再关掉"不可复现，所以把动作自动化：

- Chrome 以 `--remote-debugging-port=9222 --js-flags=--expose-gc` 独立 profile 启动；
- 每轮用页面内 `router.push` **切走再切回**（等价于原始基线的开关 tab），**不自己注入 DOM**
  （注入 DOM 会踩两个坑：基座是 Vue 应用会重复渲染；`disconnectedCallback` 默认 `destroy=false`，
  移除元素只走 stop 不走 destroy）；
- 每轮后 `HeapProfiler.collectGarbage` 强制 GC，再抓堆快照 + 指标；
- 驱动脚本 `scripts/mf_acceptance.js`，产物在 `E:/heap-accept3`（实验 A）、`E:/heap-accept4`（实验 B）。

**已知边界**：`lib/index.esm.js` 是 18:20 的构建，而 §10.2 的 dom7 改动晚于此；本次验收**未覆盖**那一处。

### 13.2 实验 A：stop / 重挂路径（不加 `destroy`）—— **不泄漏**

6 轮，每轮 `6 → 2 → 6` 个应用（ws-web + SES2×3 被卸载后重挂）：

| label | heapMB | Δheap | nodes | Δnodes | detached | cWin | cApp |
|---|---|---|---|---|---|---|---|
| init | 358.2 | | 4,709,239 | | 220 | 6 | 6 |
| acc-1 | 358.7 | +0.5 | 4,714,686 | +5,447 | 220 | 6 | 6 |
| acc-2 | 359.1 | +0.4 | 4,719,528 | +4,842 | 220 | 6 | 6 |
| acc-3 | **358.6** | **−0.5** | 4,710,805 | **−8,723** | 209 | 6 | 6 |
| acc-4 | 358.9 | +0.3 | 4,715,089 | +4,284 | 209 | 6 | 6 |
| acc-5 | 359.2 | +0.3 | 4,718,949 | +3,860 | 209 | 6 | 6 |
| acc-6 | 359.4 | +0.2 | 4,722,944 | +3,995 | 209 | 6 | 6 |

**净增 1.2 MB / 6 轮（0.20 MB/轮）**，`customWindow` / `createApp` **恒为 6**，
`detachedDOM` 由 220 降到 209，acc-3 一轮净减 0.5 MB / 8,723 节点（说明 GC 确实在回收）。
对照旧基线 r2→r3 的 **+352 MB**，这条路径**已不再泄漏**。

### 13.3 实验 B：终态 destroy 路径（元素带 `destroy` 属性）（**数字已被 §13.32 降级为非产品路径**）

> ⚠️ 本节以「元素带 `destroy` 属性」为前提，且由 `router.push` 驱动 —— **§13.32 证明这两个条件缺一个就不成立**。
> 产品路径上的真实速率见 §13.30（0.13 MB/轮）。本节保留作为**同一非产品协议下的相对比较基线**。

4 轮，同样的路由动作，只在会被卸载的元素上多设一个 `destroy` 属性，
让 `disconnectedCallback` 走 `unmount(destroy=true)` → `actionsForCompletelyDestroy()`：

| label | heapMB | Δheap | nodes | Δnodes | detached | cWin | cApp | 已销毁 |
|---|---|---|---|---|---|---|---|---|
| init | 359.4 | | 4,722,944 | | 209 | 6 | 6 | 0 |
| acc-1 | 462.4 | **+103.0** | 6,290,981 | **+1,568,037** | 5,872 | 10 | 6 | 0 |
| acc-2 | 577.2 | **+114.8** | 8,060,666 | **+1,769,685** | 7,378 | 14 | 7 | **1** |
| acc-3 | 685.5 | **+108.3** | 9,716,972 | **+1,656,306** | 8,884 | 18 | 8 | **2** |
| acc-4 | 793.9 | **+108.4** | 11,384,958 | **+1,667,986** | 10,390 | 22 | 9 | **3** |

**净增 434.5 MB / 4 轮，平均 108.6 MB/轮，四轮全为正、无回落。**
（⚠️ **非产品路径**，见本节标题注与 §13.32。）

`customWindow` **每轮恰好 +4**（= 每轮销毁 4 个应用），`detachedDOM` 每轮 +1,506。

### 13.4 增量构成：与旧基线完全同型

`init → acc-4` 的 434.5 MB 增量（按类型）：

| 类型 | 增量 | 占比 | 节点数 |
|---|---|---|---|
| **`string`** | **+174.7 MB** | **40.2%** | **仅 +16** |
| `array` | +73.1 MB | 16.8% | +920,520 |
| `object` | +51.3 MB | 11.8% | +2,111,508 |
| `code` | +41.2 MB | 9.5% | +823,445 |
| `closure` | +13.2 MB | 3.0% | +450,115 |

前 4 个条目就是 **4 个 bundle 的包裹源码串，每个恰好 ×4**：
`+89.63 MB`（11,748,062 字符）、`+67.66 MB`、`+9.84 MB`、`+7.59 MB`。
**每轮销毁 4 个应用 → 每轮多留 4 份源码。**

**Script 副本数直接对上了**（`acc-4` 快照）：

| bundle | Script 副本 | 源码 | 指向它的 SFI 数 |
|---|---|---|---|
| app-ws/chunk-vendors | **5** | 112.04 MB | 204,404 |
| app-ses2/chunk-vendors | **5** | 84.58 MB | 130,002 |
| app-ws/app | **5** | 12.30 MB | 12,416 |
| app-ses2/app | **5** | 9.49 MB | 3,700 |
| **app-issues/`*`（从未被销毁）** | **1** | 12.03 / 0.08 MB | 15,912 / 79 |

**5 份 = 1 份当前挂载 + 4 轮销毁，一一对应。**整堆 793.9 MB 里有 **230.5 MB 是重复保留的 bundle 源码（29%）**。

### 13.5 验收结论（**已按 §13.30 / §13.32 重述，不要引用本节旧版**）

> ⚠️ **本节的原始判定「未通过」是在非产品协议下得出的**（`router.push` 直接驱动 + 强制 `destroy` 属性）。
> 引入真实操作协议与冷启动对照后，**判定必须重述**。

#### 产品路径上的事实（§13.30）

| 项 | 数字 |
|---|---|
| 真实菜单 + Tab ×，连续 **10 轮** | **+1.05 MB / 9 轮 ≈ 0.13 MB/轮**，且增量在收敛（0.41→0.05） |
| **登出（单次）** | 残留 **≈64–69 MB**，**与轮数无关**（1 轮 63.94 / 10 轮 69.06） |
| 冷启动 vs 同进程 | 干净登录页基线在同进程内 **24.46 → 93 → 245 MB** 递增；**冷启动回到 24.46** |

#### 被降级 / 撤回的

1. ~~终态 destroy 路径 **108.6 MB/轮**~~ → §13.32：该速率需要「`router.push` + 强制 `destroy`」两个前提，
   **不是产品路径**。**仍然成立的是它的构成**：每销毁一个应用多留一份完整 bundle 源码 + 整套编译产物
   （SFI / 字节码 / 闭包 / `(object properties)` / CSS）。
2. ~~round-2 / round-4 的 240 MB 尖峰~~ → **冷启动下不复现**，是**脏进程造成的假象**（§13.30）。
3. ~~§10 的两处修复"没能止住泄漏"~~ → 那是在非产品协议下判的；在真实协议下**每轮本来就只有 0.13 MB**，
   该比较不成立。§10 的两条（`regeneratorRuntime`、Trusted Types 回调）**是否有效，本轮没有可用的对照**。

#### 仍然存在的两个问题（都在产品路径上）

1. **登出残留 ≈45–50 MB 的 WS 模块图**（§13.31）。而登出后**框架簿记是全空的**
   （`createApp=0` / `parsedCode=0` / `__MICRO_APP_URL__=0`）—— **所以不是靠"加一条清理"能解决的**（§13.29）。
2. **每轮 0.13 MB**（10 轮 1.05 MB）。比旧读数小约 800 倍，但**没有归零**。

#### 判定（重述）

**产品路径上「逐轮累积泄漏」的结论不成立。**
验收从**「未通过」**改为：**不构成逐轮累积泄漏，但存在（a）一次性登出残留、（b）每轮 0.13 MB 的缓慢增长。**

**判别标准同步更新**：真实菜单 + Tab × 协议、4 轮以上、**必须冷启动**（否则同进程累积会污染基线）——
每轮增量降至 0.01 MB 量级、且登出残留显著下降，才算改善。

### 13.6 复现

```bash
# 独立 profile 启动 Chrome（不要去杀用户自己的 Chrome）
chrome.exe --remote-debugging-port=9222   --user-data-dir="%TEMP%\chrome-heap-profile" --js-flags="--expose-gc"   --no-first-run http://localhost:3000/wd/ws

# 实验 A（stop 路径）
node scripts/heap_baseline_round.js --out-dir=E:/heap-accept3 --label=init --url-match=wd/
node scripts/mf_acceptance.js --out-dir=E:/heap-accept3 --rounds=6 --url-match=wd/      --away-wait=14000 --back-wait=9000

# 实验 B（终态 destroy 路径）
node scripts/heap_baseline_round.js --out-dir=E:/heap-accept4 --label=init --url-match=wd/
node scripts/mf_acceptance.js --out-dir=E:/heap-accept4 --rounds=4 --url-match=wd/      --away-wait=15000 --back-wait=10000 --destroy-prefix=wonder-ws-web,SES2-
```

产物：`E:/heap-accept3/`（7 份快照）、`E:/heap-accept4/`（5 份快照），各含 `baseline.jsonl`。

### 13.7 Review correction 与独立复核（2026-09-14）

保留上述原报告，但收紧以下结论：

1. **18:20 构建已包含 dom7 清理**：本地 `event_target.ts` / `listener_effect.ts` 时间为 18:19:41/42，产物为 18:20:36；`lib/index.esm.js` 内存在 `retiredDom7`、`retainSandboxDom7Cleanup` 及四处 window/document 桥接调用。因此“dom7 晚于构建、实验未覆盖”的说法不符合当前文件证据。运行时是否确实加载这一完整版本仍需核对，不能只计数 createPolicy 等字符串。
2. **路由切换不等价于 Tab 关闭**：脚本调用的是 `/work_flow/wd/bpm/*`，不是本次真实菜单的 `/wd/bpm/*`；awayNames 只有两个全局应用，没有审批应用。此实验可以验证销毁/重挂压力，但没有触发 `multipleTab.closeTab`，不能作为真实 Tab 关闭行为的证明。
3. 六轮 stop 路径净增 1.2 MB 是本序列内的稳定结果，不证明所有工作负载无泄漏；终态路径四轮持续增长是未通过验收的证据，但旧快照的 17 条入口不能直接当作本次全部原因。
4. 复现命令的 `--away-wait` / `--back-wait` 未被脚本 parseArgs 识别；实际应使用 `--mount-wait` / `--unmount-wait`。

独立读取实验 B 的 `acc-1.heapsnapshot`：6 个有效窗口之外，四个空壳 CustomWindow 为 3008703 / 3047078 / 3816366 / 4831800。屏蔽 `DevTools console` 强边仅减少 2.6 MB，四个目标均仍可达，不能把本次增长归因于 console。

本次另见强保留路径：基座 HTMLDocument → DocumentTimeline → CSSAnimation → 已游离 WS DOM → Vue `_vei` invoker → WS/SES2 旧代理。屏蔽 console 和所有 native CSSAnimation 后仅减少 2.7 MB，仍出现 `globalPlugin.useMultipleTabStore → Pinia createSetupStore → FeedbackVector/AllocationSite → DescriptorArray/AccessorPair → WS getter` 的替代路径。因此动画是已观察到的入口，不是唯一原因；V8 内部路径也不能直接当作可通过 JS 删除的业务字段。

新增终态防御性清理：`clearInstanceDOM` 对逐个自有 Element 调用 `getAnimations()` 并 cancel；不使用 document 全局查询、不遍历嵌套 micro-app 内部、不放入普通 stop/keep-alive。新增测试覆盖自有动画取消、基座/嵌套保护、普通卸载保护、取消异常后继续清理；terminal_dom_cleanup 15 项通过，类型检查通过。此实现尚未通过新的实验 B 证明总体内存收敛。

### 13.8 动画清理的 A/B 对照（2026-09-14，同一协议、同一脚本）

针对 13.7 记录的"DocumentTimeline 保留游离动画目标"这条入口，
`create_app.ts` 的 `clearInstanceDOM` 补了终态自有动画取消。用**完全相同**的实验 B 协议
（`--destroy-prefix=wonder-ws-web,SES2-`、`--away-wait=15000 --back-wait=10000`、
每轮强制 GC、同一驱动脚本）在新旧两版产物上各跑 4 轮：

| label | 旧构建 heapMB | Δheap | 新构建 heapMB | Δheap |
|---|---|---|---|---|
| init | 359.4 | | 358.7 | |
| acc-1 | 462.4 | +103.0 | 463.5 | **+104.8** |
| acc-2 | 577.2 | +114.8 | 572.8 | **+109.3** |
| acc-3 | 685.5 | +108.3 | 680.5 | **+107.7** |
| acc-4 | 793.9 | +108.4 | 788.8 | **+108.3** |
| **合计** | | **+434.5 / 4 轮（108.6/轮）** | | **+430.1 / 4 轮（107.5/轮）** |

`customWindow` 两版都是每轮 **恰好 +4**；`detachedDOM` 每轮增量也同量级
（旧 +2,545/轮，新 +2,393/轮）。

**结论：动画清理把总量降低了约 1%（1.1 MB/轮），在噪声范围内 —— 它没有改变泄漏的走势。**

这与 13.7 自己的判断一致："动画是已观察到的入口，不是唯一原因"。
一个合理的解释是：动画路径在旧构建里被屏蔽时本来也只减少 2.7 MB（13.7 实测），
而每轮增量是 ~108 MB —— **动画这条链占的比重本来就很小**。

因此：

1. **不能把本次动画修复当作泄漏已解决。** 终态 destroy 路径的累积速率与修复前实质相同。
2. 13.7 已记录的替代路径（`globalPlugin.useMultipleTabStore → Pinia createSetupStore →
   FeedbackVector/AllocationSite → DescriptorArray/AccessorPair → WS getter`）**仍未被消除**，
   应作为下一步的主攻方向。
3. 判别标准已经固化：**同一协议下 4 轮，平均增量应从 ~107 MB/轮 降到接近 0**，才算通过。

产物：`E:/heap-accept4`（旧构建）、`E:/heap-accept5`（新构建），均为 5 份快照 + `baseline.jsonl`。

### 13.9 死沙箱代理的持有者（2026-09-14 续查，**部分结论**）

沿 13.7 指的 Pinia/插件方向，在 `E:/heap-accept5/acc-4.heapsnapshot` 上查到一个新的结构：

**`window.globalPlugin`（基座插件对象，含 `microAppsConfig` / `microApp` / `router` 及约 70 个闭包）
有 47 个持有者，其中 22 个是 `system / JSProxy`，另有 22 条来自同一个 `Context / scope @3040879`。**

22 这个数字与实验设计**完全吻合**：6 个活沙箱 + 4 轮 × 4 个已销毁应用 = 22。
也就是说：**存在 22 个 `JSProxy`，它们都指向基座的 `globalPlugin`。**

> ⚠️ **"每个都已销毁"这个归属，本节的依据只是计数**（22 = 6 个活沙箱 + 4 轮 × 4 个已销毁，与实验设计吻合）。
> **计数吻合不是归属证明** —— 与 §13.28 指出的问题同类。本节能支持的是"存在 22 个代理指向 globalPlugin"，
> **不能支持"它们全部来自已销毁实例"**。

对其中 5 个采样做反向入边（已排除 weak 边），得到它们的持有者只有两类：

| 持有者 | 说明 |
|---|---|
| `(Global handles) --internal:<n> / DevTools console-->` | **DevTools console 句柄**（5 个里有 4 个） |
| `WeakMap` 的 ephemeron 条目 `{key → JSProxy}` | 5 条（深度 2 上显示 5 个 WeakMap `--internal:table-->`） |

两点必须说清：

1. **DevTools console 句柄是测量环境引入的保留。** 本节采样的 4/5 个代理被它直接持有。
   13.7 已实测"屏蔽 console 强边仅减少 2.6 MB"，所以**它解释不了每轮 ~108 MB 的增量**，
   但它**污染了"谁持有死代理"这个问题的答案** —— 想要干净的答案，采集时不能开 DevTools UI，
   且要在同一会话内避免用 `Runtime.evaluate` 打印过目标对象。
2. **标签里的 `@N` 不是节点号。** `pair in WeakMap (table @15730621)` 中的 15730621 超过了快照
   节点总数（约 1,130 万），无法直接解析。**不要拿它当 ordinal 用**（这一点和 §7.4 的 `@N`
   是同一类坑：那些 `@N` 是 V8 的内部 id）。

同时盘了一遍框架自己建的 WeakMap（`grep -n "new WeakMap" src/`），共 8 处：

| 位置 | 结构 | 是否可疑 |
|---|---|---|
| `bind_function.ts:9/10` | `WeakMap<Function, boolean>` | 否，弱键 |
| `bind_function.ts:11` | `WeakMap<fn, WeakMap<proxyWindow, Map<string, boundFn>>>` | 内层以 proxyWindow 为**弱键**，不单独保活 |
| `sandbox/iframe/document.ts:352` | `WeakMap<CallableFunction, MicroEventListener>` | 否（iframe 路径） |
| `sandbox/resource_factory.ts:14/15` | `WeakMap<object,object>` / `WeakMap<Function,Function>`，**键是长期存活的基座对象/函数，值是 per-scope 包装** | **结构可疑**，但两个 Map 建在 `createResourceFactoryScope()` 内部，**随 scope 一起释放**，所以本身不是根 |
| `trusted_types.ts:21` | `WeakMap<object, object>` | 否，随 scope |
| `source/patch.ts:60` | `WeakMap<Node, Element\|Comment>` | 否，弱键 |

**尚未证实的部分（不要当结论用）：**

- 22 个死代理与每轮 108 MB 增量之间的**因果**没有被证明。已经证明的只是：
  它们存在、它们指向 globalPlugin、它们的持有者里有一半是 console 句柄。
- **没有验证"屏蔽 console 句柄后增量是否下降"**。这是下一步最该做的一次实验：
  在 `mf_acceptance.js` 的抓取流程里避免一切 `Runtime.evaluate` 打印，并在指标里加一列
  "console 句柄数"，才能把测量污染与真实泄漏分开。
- 每轮 +108 MB 的**构成**是可信的（§13.4：4 个 bundle 源码串各 +1 份 + 整套编译产物），
  这一条不依赖上面两个未决问题。

### 13.10 用 `consoleHandles` 一列排除测量污染（2026-09-14，结论）

13.9 留下一个未决问题：**每轮 ~108 MB 的增量里，有多少是 DevTools console 句柄造成的测量污染？**
为此给 `heap_metrics.js` 加了一列 `consoleHandles` —— 统计边名含 `DevTools console` 的
`(Global handles)` 句柄数，并在 `mf_acceptance.js` 的输出表里单列。

同一协议（destroy 路径、4 轮、每轮强制 GC）重跑，结果：

| label | heapMB | Δheap | **Δconsole句柄** | cWin | cApp | 已销毁 |
|---|---|---|---|---|---|---|
| init | 346.7 | | （基线 41,156） | 6 | 6 | 0 |
| acc-1 | 464.2 | +117.5 | **+574** | 10 | 6 | 0 |
| acc-2 | 579.4 | +115.2 | **+544** | 14 | 7 | 1 |
| acc-3 | 678.2 | +98.8 | **−10,577** | 18 | 8 | 2 |
| acc-4 | 787.5 | +109.3 | **−16,439** | 22 | 9 | 3 |

**heap 净增 440.8 MB / 4 轮（110.2 MB/轮，单调）；console 句柄 41,156 → 15,258，净变化 −25,898。**

**结论：console 句柄与堆增长方向相反 —— 它解释不了这次泄漏，13.9 的疑虑可以排除。**

三点补充说明：

1. **`init` 快照里就有 41,156 个 console 句柄**，而它是页面刚重载后的状态。这说明这些句柄
   **主要由测量工具自己引入**（`_diag_eval.js` / `mf_acceptance.js` 的 `evalOnce` 都调用了
   `Runtime.enable`，会让 V8 保留 console 相关的句柄），不是页面代码产生的。
   采集流程要干净的话，**抓快照之前不应再开 `Runtime` 域** —— `cdp_heap_snapshot.js` 已经
   只开 `HeapProfiler`，这一点是对的；问题出在同一会话里先跑过 `Runtime.enable`。
2. 尽管如此，**这个量级（3–4 万）确实会污染"谁持有 X"的答案** —— 13.9 里 5 个采样代理有 4 个
   被 console 句柄直接持有，就是它造成的。所以那一节只保留了"存在 WeakMap 持有者"这条，
   没有下因果结论。
3. **泄漏的签名没有变化**：`customWindow` 每轮 +4、`createApp` 每轮 +1、每轮多留一份完整的
   bundle 源码 + 整套编译产物（§13.4）。**验收仍未通过。**

**下一步应该做的是**：抓快照前不启用 `Runtime`（把轮次驱动与快照分成两个进程、两次连接，
且驱动进程退出后再抓），再重跑一次；如果 `consoleHandles` 归零而增量仍是 ~110 MB/轮，
就彻底排除了测量因素，可以把全部精力放在真正的保留链上。  

### 13.11 清除测量污染后重跑（2026-09-14，**数字已被 §13.32 降级**）

> ⚠️ **本节数字已被 §13.32 判定为「非产品路径」——引用前必读。**
>
> 本节测到的 **~110.5 MB/销毁轮** 需要**两个条件同时成立**才有：
> **① 用 `router.push` 直接驱动路由**（绕过基座的 tab 系统）**且 ② 强制元素的 `destroy` 属性**。
> 对照实验（同应用、同轮数、只改一个变量）：
>
> | 配置 | MB/轮 |
> |---|---|
> | 真实菜单 + Tab ×（**产品路径**） | **0.13** |
> | 真实菜单 + Tab × **+ `destroy` 属性** | ≈0.24（`usedSize` 口径） |
> | `router.push`，不加 `destroy` | 5.5 |
> | **`router.push` + `destroy`（= 本节配置）** | **110.5** |
>
> 机制：`destroyed` 实例堆积（本节快照里 `createAppDestroyed` 逐轮 +1；真实路径全程为 0）。
> **因此本节的增量不是产品路径上的行为，不能作为「产品泄漏速率」引用。**
> 产品路径上的真实数字是 **0.13 MB/轮**（§13.30）。

---

按 13.10 的建议做了两件事：

1. **驱动与快照彻底分开**：每轮由独立连接跑 `Runtime.enable` + 导航，**关连接前显式
   `Runtime.discardConsoleEntries` + `Runtime.disable`**；快照由另一个进程、只开 `HeapProfiler` 抓。
2. `_diag_eval.js`（重载与轮询用的工具）也加了同样的清理，保证 `init` 之前也是干净的。

同协议（destroy 路径、4 轮、每轮强制 GC）重跑：

| label | heapMB | Δheap | nodes | Δnodes | detached | **console句柄** | cWin | cApp | 已销毁 |
|---|---|---|---|---|---|---|---|---|---|
| init | 346.6 | | 4,452,430 | | 164 | **417** | 6 | 6 | 0 |
| acc-1 | 463.2 | +116.6 | 6,269,670 | +1,817,240 | 1,670 | **28** | 10 | 6 | 0 |
| acc-2 | 569.9 | +106.7 | 7,916,759 | +1,647,089 | 3,176 | **28** | 14 | 7 | 1 |
| acc-3 | 678.1 | +108.2 | 9,585,634 | +1,668,875 | 4,682 | **74** | 18 | 8 | 2 |
| acc-4 | 788.7 | +110.6 | 11,303,823 | +1,718,189 | 6,188 | **74** | 22 | 9 | 3 |

**四次同协议运行的横向对照：**

| 运行 | 构建 | console 污染 | 净增 / 4 轮 | 平均 |
|---|---|---|---|---|
| acc-4 | 旧（18:20） | 有（209 → 10,390） | +434.5 MB | 108.6/轮 |
| acc-5 | 新（10:04） | 有 | +430.1 MB | 107.5/轮 |
| acc-6 | 新 | 单列统计（41,156 → 15,258） | +440.8 MB | 110.2/轮 |
| **acc-7** | **新** | **已清除（417 → 74）** | **+442.1 MB** | **110.5/轮** |

**`consoleHandles` 从 4 万量级压到 74，增量仍然是 110.5 MB/轮，一分没有减少。**

### 验收定论

1. **测量污染已被彻底排除。** 13.9 提出的"增量是不是 DevTools console 造成的"这个问题，
   到此有确定答案：**不是**。console 句柄压掉约 100 倍后，增长曲线完全相同。
2. **终态 destroy 路径存在真实、可复现、单调的泄漏：110.5 MB/轮**（四次测量落在
   107.5–110.5 区间）。签名与 round-1…10 一致：每轮多留一份完整 bundle 源码 + 整套编译产物，
   `customWindow` 每轮 +4，`detachedDOM` 每轮 +1,506。
3. **已排除的原因**：DevTools console 句柄（本节）、动画时间线（13.8，A/B 无差异）、
   孤儿空壳对象（§3，切割释放 0.0 MB）。
4. **仍然解释不了它的**：13.9 的 WeakMap 持有者（键不可解析）、13.7 的 Pinia 路径
   （`globalPlugin.useMultipleTabStore → createSetupStore → …`）。**这两条是下一步唯一的方向。**
5. **采集方法已修正**：抓快照前必须 `Runtime.discardConsoleEntries` + `Runtime.disable`，
   否则 4 万量级的 console 句柄会污染"谁持有 X"的一切结论。**这条对后续所有分析都适用。**

产物：`E:/heap-accept7/`（5 份快照 + `baseline.jsonl`），驱动脚本 `scripts/mf_acceptance.js` 已固化，
含清理逻辑，重跑同一条命令即可复现。

### 13.12 死代理的根找到了：`resource_factory` 的 `objects` WeakMap（真 bug，但**不是**主因）

用干净快照（`E:/heap-accept7/acc-4`，console 句柄只有 74）重查 13.9 留下的问题，
死代理的持有者这次很清楚：

```
JSProxy  ← WeakMap 条目 {key Object @2211031 → value JSProxy}   （每个代理一个 WeakMap）
JSProxy  ← Context / scope @2546537  --context:object-->
         ← Context / scope @2548903  --internal:previous-->
         ← closure "get" --internal:context-->
         ← Context / scope @2211015  --context:objects-->        ← 变量名就是 objects
```

对照 `src/sandbox/resource_factory.ts:12-15`：

```ts
export function createResourceFactoryScope (): ResourceFactoryScope {
  const resources = new Set<{ dispose:() => void }>()
  const objects = new WeakMap<object, object>()      // ← 就是它
  const functions = new WeakMap<Function, Function>()
  ...
      proxy = new Proxy(object, { get (target, key, receiver) {...} })
      objects.set(object, proxy)                     // 键 = 基座对象，值 = per-scope 代理
```

**`dispose()` 只做了 `resources.clear()`，没有清 `objects`。** 而 `objects` 的**键是长期存活的基座对象**——
只要键活着，值（该沙箱的 Proxy）就活着。于是：

**每个 `createResourceFactoryScope()` 的 scope 都为同一个基座对象留一个 Proxy。**

> ⚠️ **按 §13.16 第 3 条 / §13.28 收紧**：原文写的是"沙箱销毁后这个 Proxy **永久存活**"，
> **这个推断不成立** —— WeakMap 的 ephemeron 要生效，需要 **WeakMap 自身和 key 都可达**；
> `objects` 是 scope 的局部变量，**随 scope 释放**。本轮**没有验证 scope 自身的可达性**。
> 本节只能支持："存在 `{基座对象 → per-sandbox 代理}` 的 WeakMap 条目，且实测有 22 个这样的代理节点"。
实测 22 个（6 个活沙箱 + 4 轮 × 4 个已销毁应用），而它们**全部指向 `window.globalPlugin`** ——
说明 `globalPlugin` 正是那个被 `wrap()` 的基座对象（它的 ~70 个属性里有带 `__MICRO_APP_RESOURCE_FACTORY__` 标记的工厂）。

**这是一个真实的、可独立修复的缺陷**：`dispose()` 应该同时切断 `objects` / `functions` 的可达性
（例如把 scope 内的 WeakMap 换成普通 Map 并在 dispose 时 clear，或把 Proxy 的 handler 在 dispose 时置空）。

**但是 —— 它不是主因。** 从其中一个死代理做 4 层 BFS：

```
可达节点 1,464 个（d1:4  d2:86  d3:313  d4:1,061）
其中带 ws/ses2 特征的只有 2 个，且都只是 URL 字符串
```

**代理够不到子应用的模块图。** 它的 handler 只闭包了 `disposed` / `resources` / `functions` 这些
scope 自身的状态。22 个代理合计最多几万节点，与每轮 **+170 万节点 / +110 MB** 差两个数量级。

**结论：修掉它是应该的，但不要指望它改变验收结果。** 主因仍在别处 —— 仍在 13.7 那条 Pinia 路径
（`globalPlugin.useMultipleTabStore → createSetupStore → FeedbackVector/AllocationSite →
DescriptorArray/AccessorPair → WS getter`）上。

### 13.13 Pinia 链的量化：是路径，不是载体（2026-09-14）

13.7 记录了一条替代路径：
`globalPlugin.useMultipleTabStore → Pinia createSetupStore → FeedbackVector/AllocationSite →
DescriptorArray/AccessorPair → WS getter`。本轮把它量化，结论**推翻了它的侧重**。

**（1）前向追不到子应用。** 从 `useMultipleTabStore`（ordinal 4093621）做 6 层 BFS：

```
可达节点 65,092（d1:9 d2:65 d3:530 d4:7,950 d5:16,293 d6:40,245）
带 ws / ses2 / issues 特征的可达节点：0
```

即：**这个闭包向前够不到任何子应用的闭包、Script 或模块作用域。**

**（2）切割收益为零。** 在同一份快照上量它们的独占保留：

| 切断 | 释放 | 释放节点数 |
|---|---|---|
| `useMultipleTabStore` 闭包 (#4093621) | **0.00 MB** | 3 |
| `globalPlugin` (#1104415) | **0.00 MB** | 82 |

**结论：Pinia 这条链是"存在一条这样的路径"，但它不独占保留任何内存 —— 和 §3、§7.5、§13.12 遇到的是同一个结构：入口是并行的，砍掉任何一个都释放不了东西。**

这一条必须写清楚，否则会误导修复方向：**不要为了切断 Pinia 路径去改 `globalPlugin` 或 tab store。**

### 到目前为止，已被测量排除的候选

| 候选 | 测得的独占释放 | 出处 |
|---|---|---|
| DevTools console 句柄 | 排除（压掉 100× 后增量不变） | §13.10 / §13.11 |
| 动画时间线 | A/B 无差异（108.6 → 107.5 MB/轮，**非产品协议**） | §13.8 |
| 孤儿 CustomWindow / 已销毁 CreateApp | 0.0 MB | §3 |
| 执行期 Context（25 个） | 0.0 MB | §3 |
| `__webpack_require__` 全部 | 10.7 MB | §3 |
| 全部 `system / Script` | 73.0 MB（源码总量 388.6 MB） | §3 |
| `resource_factory` 的死代理（22 个） | 最多 ~1,464 节点/个，够不到模块图 | §13.12 |
| `useMultipleTabStore` / `globalPlugin` | 0.00 MB | §13.13 |

**（本节所列的 ~110 MB/轮 均已按 §13.32 降级为非产品路径；产品路径数字见 §13.30。）**

### 方法上的建议（下一步）

到目前为止所有的"找一个入口再切掉"的做法都失败了，原因是同一个：**保留是分布式的**。
继续枚举入口的边际收益已经很低。更有希望的方向是换问法：

1. **差分定位**：把某个已销毁应用的 bundle 图与**当前仍挂载的同一应用**的图做差集，
   找出只在旧副本里存在的持有者类型 —— 差集里的**共同尾部**才是真正的入口。
2. **在 destroy 路径上打点**：`actionsForCompletelyDestroy()` 前后各抓一次，
   看哪些节点从"可达"变成"仍可达"，直接得到保活集合，而不是靠反复猜测入口。
   （注意：这需要改源码插桩，属于受控诊断，用完必须回滚。）

### 13.14 Review correction：WeakMap 条件与原生帧回调（2026-09-14）

保留 13.12/13.13 原文，但不要据此作以下过强推断：

- WeakMap ephemeron 保留 value 需要 **WeakMap 自身与 key 都可达**；仅证明 key 是基座对象不能证明 scope 永久扎根。`resource_factory.objects/functions` 是 scope-local WeakMap，必须继续验证 map/scope 的环外持有者。不能直接换成强引用 Map 当作根因修复。
- 4 层/6 层 BFS 无匹配只能说明所查深度内没有匹配；13.7 的 Pinia 路径长度本来就超过 6。静态切割释放 0 说明所切入口不是该实验的必要入口，不等于该路径不存在或与所有残留无关。
- console 清理后增长仍约 110 MB/轮，说明它不能解释主要增长；不代表 74 个剩余句柄和所有 debugger/compilation-cache 测量影响都被“彻底排除”。当前多轮测试足以保留“验收未通过”，无需靠这种绝对措辞加强结论。

独立复核干净 `E:/heap-accept7/acc-1.heapsnapshot`（6,269,670 节点）：四个销毁后空壳 CustomWindow 为 1100309 / 1378064 / 1587794 / 2361339。屏蔽所有 `DevTools console` 强边后仅减少 358 节点（四舍五入 0 MB），四个目标仍可达。

新的具体链条（WS 空壳 1100309）：基座 NativeContext → Window → HTMLDocument → **ScriptedAnimationController → V8FrameCallback → V8FrameRequestCallback → WS vendor 匿名闭包 2572556** → with/context → 旧窗口代理 519183 → 空壳 CustomWindow。其它三个 SES2 空壳仍存在 DocumentTimeline/CSSAnimation → WS DOM/Vue 回调 → SES2 引用的路径。由此不能称“Pinia/WeakMap 是唯一剩余方向”。

代码核对：此前 window effects 仅登记 timeout/interval，没有登记 RAF。新增 `sandbox/animation_frame.ts`：由 native wrapper 捕获可清空的 callback cell，执行/显式取消时摘除记录；普通 UMD/keep-alive release(false) 保留帧；释放资源时取消本实例待执行帧；terminal dispose 后缓存的 request 方法不再提交新帧。with 与 iframe 均接入，native/base 以及其它实例帧不被全局扫除。三套相关测试 17 项通过，类型检查通过；仍需新构建多轮实验验证总体累积，不能由这条入口或单元测试断言泄漏已经解决。

### 13.15 支配树与入边的测量结果（2026-09-14，**结论已被 §13.16 收紧**）

> ⚠️ 本节的原始措辞（"没有有界的入口集合""根是分布式的"）**已被 §13.16 判定为推过头**，
> 以下只保留测量数据，结论以 §13.16 为准。

对 11 份 Script 副本（5 份 app-ws/chunk-vendors + 5 份 app-ses2/chunk-vendors + 1 份
从未被销毁的 app-issues 作对照）跑完整支配树，取各自的 idom 链：

```
公共前缀长度 1（只有 (GC roots) 本身）
11 份副本的链长全部为 2，即 idom = (GC roots) 直接支配
11 份副本全部「无任何非 synthetic 祖先」
retained = 0.14 – 0.28 MB
```

**按 §7.4 的判读规则**：`idom[X] = (GC roots)` 的含义是 **"X 没有任何单一支配者"** ——
从根到 X 有 ≥2 条互相独立的路径。**活副本和死副本在这一项上完全一样。**

再做边界外推（`heap_grow_boundary`，种子 = 15 个 bundle Script 副本）：

```
round 1: cluster = 118 节点 / 11.1 MB
         ingress = 344,150 条边 / 344,150 个独立来源
         → 超出 fan-out 上限，停止
```

**一个 118 节点的簇有 34 万条独立入边。**

> ⚠️ **这不是"34 万个独立 GC 根"** —— 绝大多数是编译对象之间的内部引用，**可能仍汇聚到少数外部持有者**（§13.16 第 1 条）。

### 最终结论（本次验收的完整答案）

1. ~~**泄漏是真的，且已量化**：终态 destroy 路径 **+110.5 MB/轮**~~
   —— **已按 §13.32 降级为非产品路径**（需 `router.push` + 强制 `destroy` 两个前提）。
   产品路径上的真实数字是 **0.13 MB/轮**（§13.30）。
   所有测量污染（DevTools console 句柄，4 万量级）已被压掉 100 倍后重测，曲线不变（§13.11）。
2. **构成已知**：每销毁一个应用，多留**一份完整的包裹源码 + 它整套编译产物**
   （Script / SFI / 字节码 / 闭包 / `(object properties)` / CSS），§13.4。
3. **已测到的 9 个候选锚点都不是"必要入口"** —— 逐个切割全部 ≈0（汇总见 §13.13 的表），
   支配树上 11 份副本也**无一有单一支配者**（`retained` 仅 0.14–0.28 MB）。
   ⚠️ **但这只能说明"这些锚点不是必要入口"，不能推出"不存在根因"** —— 见 §13.16 的三条收紧。
4. **因此正确的修法不是"再补一条清理"**，而是**减少旧执行留下的引用数量本身**。按证据强度排序：
   - **减少重复编译**：副本数 = 挂载次数（§13.4 的 5 份 = 1 活 + 4 销毁一一对应）。
     ⚠️ 但**跨挂载复用 `parsedCode` / `parsedFunction` 只能减少"重复编译"这一项的增量，
     不能保证旧模块、闭包、DOM 零残留** —— 残留的可达性由引用决定，与是否复用编译产物是两件事。
     这条是"降低成本"，不是"消除泄漏"。
   - **让销毁以一个整体为单位释放**：既然保留是分布式的，逐条切断入口没有意义；
     应当把"这次执行产生的一切"（作用域、闭包、Context、Script）作为一组，
     在 destroy 时一起断开与根的联系。
5. **顺带发现并已定位的独立缺陷**（值得单独修，但都不是主因）：
   `resource_factory.ts` 的 `objects` WeakMap 以长期存活的基座对象为键、值为 per-sandbox 代理，
   `dispose()` 只清 `resources` 未清它 → ~~每个已销毁沙箱的代理永久存活~~
   **（此句已按 §13.16 第 3 条撤回：未验证 scope 自身可达性）**，实测只有 22 个这样的代理节点（§13.12）。

### 本次验收的判定

**未通过。** 判别标准（§13.8 已固化）：同一协议下 4 轮，平均增量应从 ~107 MB/轮 降到接近 0。

### 13.16 Review correction：三条被推过头的结论（2026-09-14）

13.15 里有三处推理不成立，逐一收紧。**这三条收紧对后续所有结论都适用，不要再用旧措辞。**

**（1）34 万条入边 ≠ 34 万个独立 GC 根。**
13.15 拿 `heap_grow_boundary` 的 "ingress = 344,150 条边 / 344,150 个来源" 去支持
"没有有界的入口集合"，这是不成立的：那些入边里绝大多数是**编译对象之间的内部引用**
（SFI → Script、闭包 → Context、作用域槽 → 闭包……），它们**可能仍然汇聚到少数几个外部持有者**。
入边条数衡量的是"这个区域的边界有多毛糙"，不是"有多少个根"。
**要判断根的个数，必须做的是把这些内部引用吸收掉之后再看剩下的入口** —— 也就是 grow_boundary
本该做的事，但它在第 1 轮就因为 fan-out 超限停了，**没有跑完**。所以这一项**未完成，不是结论**。

**（2）跨挂载缓存 `parsedFunction` 不能保证零残留。**
13.15 曾写"如果 parsedCode/parsedFunction 能跨挂载复用，每次销毁留下的就不是一份 22 MB 源码
+ 一整套编译产物，而是零"。这是错的：复用只消除了**重复编译**这一项的成本，
**旧模块、闭包、DOM 是否残留，取决于它们的可达性，与是否复用编译产物是两件独立的事**。
更实际的风险是反过来的：长期缓存会让每个曾经挂载过的应用都保留一份编译产物，
**如果引用没被正确释放，缓存反而把残留变成了永久**（§十二 已经记录过这个取舍）。

**（3）WeakMap 的保留条件是"Map 自身可达 **且** key 可达"，不能只看 key。**
§13.12 由"基座 key 长期存活"推出"每个已销毁沙箱的代理永久存活"，缺了一半条件：
**WeakMap 的条目要生效，WeakMap 自身也必须可达**。
`resource_factory.ts` 里的 `objects` 是 `createResourceFactoryScope()` 内部的局部变量，
**随 scope 一起释放**；只有当 scope 本身被某个活对象持有时，条目才会生效。
本轮**没有验证 scope 的可达性**，所以 §13.12 只能降级为：
**"存在一条 `{基座对象 → per-sandbox 代理}` 的 WeakMap 条目，且代理实测存在 22 个"**，
不能称为"永久泄漏"，更不能据此把 WeakMap 改成 Map。

**这三条共同说明一件事：本轮所有"排除"都只排除了"必要入口"这一种身份，
没有一个能排除"共同上游存在但不是必要入口"这种可能。**
下一步的正确方向是 §13.15 里那条已经写对、但没执行完的：
**把内部引用吸收掉，再看剩下什么** —— 而不是继续逐个枚举入口。

### 13.17 11:18 构建（RAF 修复）重跑（2026-09-14，**数字已被 §13.32 降级**）

> ⚠️ **本节数字已被 §13.32 判定为「非产品路径」——引用前必读。**
>
> 本节测到的 **~111.8 MB/销毁轮** 需要**两个条件同时成立**才有：
> **① 用 `router.push` 直接驱动路由**（绕过基座的 tab 系统）**且 ② 强制元素的 `destroy` 属性**。
> 对照实验（同应用、同轮数、只改一个变量）：
>
> | 配置 | MB/轮 |
> |---|---|
> | 真实菜单 + Tab ×（**产品路径**） | **0.13** |
> | 真实菜单 + Tab × **+ `destroy` 属性** | ≈0.24（`usedSize` 口径） |
> | `router.push`，不加 `destroy` | 5.5 |
> | **`router.push` + `destroy`（= 本节配置）** | **111.8** |
>
> 机制：`destroyed` 实例堆积（本节快照里 `createAppDestroyed` 逐轮 +1；真实路径全程为 0）。
> **因此本节的增量不是产品路径上的行为，不能作为「产品泄漏速率」引用。**
> 产品路径上的真实数字是 **0.13 MB/轮**（§13.30）。

> 本节与 §13.8/§13.20 的**纵向比较仍然有意义** —— 三次测量用的是同一套非产品协议，
> 所以「RAF 修复没有降低每销毁一轮的代价」这个**相对结论不受影响**；被降级的只是**绝对速率**。

---

按 13.16 的要求，用 **11:18 的构建**（`lib/index.esm.js` 507,626 字节，含新增的
`src/sandbox/animation_frame.ts` —— 按沙箱跟踪 `requestAnimationFrame` / `cancelAnimationFrame`，
终态取消；`animation_frame_cleanup.test.ts` 3 项通过，六套相关共 44 项通过）
重跑**同一四轮序列**（同协议、同 `--destroy-prefix`、同等待参数、清 console）。

| label | heapMB | Δheap | nodes | Δnodes | detached | console | cWin | cApp | 已销毁 |
|---|---|---|---|---|---|---|---|---|---|
| init | 357.2 | | 4,672,831 | | 219 | 164 | 6 | 6 | 0 |
| acc-1 | 470.9 | +113.7 | 6,427,712 | +1,754,881 | 5,887 | 43 | **10** | 6 | 0 |
| acc-2 | 463.5 | **−7.4** | 6,298,346 | **−129,366** | 5,876 | 48 | **10** | 6 | 0 |
| acc-3 | 576.4 | +112.9 | 8,057,329 | +1,758,983 | 7,382 | 19 | **14** | 7 | 1 |
| acc-4 | 685.2 | +108.8 | 9,741,043 | +1,683,714 | 8,888 | 19 | **18** | 8 | 2 |

### 必须先纠正一个读表陷阱

**`+328.0 MB / 4 轮 = 82.0/轮` 这个数是错的，不能用。** 因为 **acc-2 那一轮没有走成销毁循环**：

- `destroyTagged` 四轮都设上了同样 4 个应用（日志已核），导航也确实发生了（每轮都是 `6→2→6`）；
- 但 acc-2 的 `customWindow` **停在 10 没有 +4**、`createApp` 停在 6、`createAppDestroyed` 停在 0；
- 而且它是**唯一一轮堆下降的**（−7.4 MB / −129,366 节点）。

即：**acc-2 只有 stop，没有 destroy。** 拿它去做分母会把"每轮成本"人为拉低。
（这是本验收脚本的可靠性问题，不是代码的行为 —— 同样的输入在两轮里走出了不同路径，
原因未定，**不做解释，只做标记**。后续所有轮次都必须用 `cWin` 是否 +4 来判定这一轮是否为销毁轮。）

**按"真正发生销毁的轮次"重算：**

| 构建 | 各销毁轮 Δheap | 销毁轮数 | 平均 |
|---|---|---|---|
| 18:20（基线） | +103.0 / +114.8 / +108.3 / +108.4 | 4 | **108.6/轮** |
| 10:04（动画清理） | +116.6 / +106.7 / +108.2 / +110.6 | 4 | **110.5/轮** |
| **11:18（RAF 修复）** | **+113.7 / +112.9 / +108.8** | **3** | **111.8/轮** |

**结论：RAF 修复没有降低"每销毁一轮"的代价。** 111.8 落在前两次测量（108.6 / 110.5）的波动范围内。
签名也没有变化：`customWindow` 每销毁轮 +4、`detachedDOM` 每销毁轮 +1,500 量级。

**因此 11:18 构建的验收同样不通过。** 判别标准不变：同一协议下销毁轮的平均增量应从 ~110 MB 降到接近 0。

### 13.18 `grow_boundary` 跑完了：边界在第 5 轮闭合，入口是**有界的 1 万条**（2026-09-14）

13.16 指出 13.15 的"没有有界入口"不成立、且那一次 `grow_boundary` **根本没跑完**。
这次把 `--cap` 从 2 万提到 200 万、轮数提到 20，用 **acc-8（11:18 构建）自己的节点号**
（首次误用了 acc-7 的节点号，round 1 只有 0.0 MB，已作废重跑）跑完：

```
round 1: cluster=     130 节点 /  19.5 MB  ingress= 284,898 条 / 284,898 源
round 2: cluster= 1,141,228 节点 /  52.1 MB  ingress=1,142,283 条
round 3: cluster= 7,465,272 节点 / 452.1 MB  ingress= 102,881 条 / 41,972 源
round 4: cluster= 7,790,735 节点 / 467.5 MB  ingress=  92,773 条 / 57,620 源
round 5: cluster= 7,915,911 节点 / 472.9 MB  ingress=  10,297 条 / 10,133 源
round 5: ingress reaches synthetic GC-root nodes — boundary is complete
```

**边界集 1,494,040 个节点；簇 7,915,911 节点 / 472.9 MB（占该快照 685.2 MB 堆的 69%）。**

### 13.16 第（1）条被实测证实

round 1 的 284,898 条入边里，**绝大多数确实是编译对象之间的内部引用** ——
把边界吸收掉之后，入口一路收敛到 **10,297 条**，**是一个有界的集合**，而不是"和整图一样大"。
**"没有有界的入口集合"这个说法到此彻底作废。**

### 最终入口的完整分类（10,297 条）

**接到 GC 根的只有 22 条：**

| 条数 | 来源 |
|---|---|
| 11 | `(Global handles)` → **NativeContext #3705**（`blink::ScriptStateProtectingContext::context_` ×7、`V8PerContextData::context_`、`gin::ContextHolder::context_`、`extensions::ScriptContext::v8_context_`） |
| 1 | `(Global handles) --internal:1 / DevTools console-->` Array |
| 6 | **micro-app 自己的闭包**（`lib/index.esm.js`，均为 `internal:context`） |
| 4 | 基座闭包，其中 **6 条来自 `lib/index.esm.js`** |

**剩下 ~10,275 条按类别：**

| 条数 | 类别 | 性质 |
|---|---|---|
| 861 | `object shape system / Map` | V8 内部（隐藏类） |
| 840 | `object Generator` | V8 内部（生成器状态机） |
| 356 | `closure resolve` | V8 内部（Promise 解析器） |
| **177** | **`blink::RegisteredEventListener`** | **DOM 事件监听器** |
| 165 | `native Text` | 游离文本节点 |
| **144** | **`native KeyframeEffect`** | **CSS 动画对象** |
| 90 | `native Comment` | 游离注释节点 |
| **72** | **`blink::CSSAnimations::TransitionEventDelegate`** | **CSS 过渡** |
| 57 / 53 | `blink::LayoutBlockFlow` / `LayoutFlexibleBox` | 布局对象 |
| 50 | `blink::TreeOrderedMap::MapEntry` | DOM 树索引 |
| **40** | **`native CSSTransition`** | **CSS 过渡** |
| 49 / 33 / 31 / 29… | `closure toJSON` / `close` / `get length` / `keys` … | 集合/迭代器方法 |

### 这条结果的可操作含义

1. **入口是有界的，可以逐个处理** —— 10,297 条，不再是 34 万。
2. **最大的一块是 V8 内部结构**（Map 形状 861 + Generator 840 + resolve 356 ≈ 2,057 条），
   这部分**不由业务代码直接控制**，只能通过"减少存活的对象"间接影响。
3. **真正可操作的是 DOM/CSS 那一组**：`RegisteredEventListener` 177 + `KeyframeEffect` 144 +
   `Text` 165 + `Comment` 90 + `CSSAnimations::TransitionEventDelegate` 72 + `LayoutBlockFlow` 57 +
   `LayoutFlexibleBox` 53 + `TreeOrderedMap::MapEntry` 50 + `CSSTransition` 40 ≈ **848 条**。
   **注意：这是 CSS 过渡/动画（`KeyframeEffect` / `CSSTransition` / `CSSAnimations`），不是
   `requestAnimationFrame`** —— 11:18 的 RAF 修复覆盖不到它们；13.8 的 `getAnimations().cancel()`
   只作用于**调用时已存在**的动画，如果动画是**之后**才创建/继承的，或者挂在被 `innerHTML=''`
   摘掉的子树上，就漏掉了。
4. **`RegisteredEventListener` 177 条仍在** —— 说明监听器清理仍不完整（§13.3 的 dom7 只处理
   `<body>.dom7Listeners` 这一处登记）。

**下一步应针对第 3、4 条**：CSS 过渡/动画的取消时机，与 `RegisteredEventListener` 的归属清理。
这两组加起来约 1,000 条入口，是当前唯一被证明"有界且可操作"的部分。

### 13.19 独立定位与终态卸载前 DOM 快照（2026-09-14）

独立读取 `E:/heap-accept8/acc-1.heapsnapshot`，不是沿用 acc-7 节点号：
旧空壳 CustomWindow 为 1558949 / 3119018 / 3119186 / 3120743。
屏蔽 DevTools console 后四个目标仍可达（仅减少 559 节点，四舍五入 0 MB）。
具体路径：HTMLDocument 180204 → DocumentTimeline 6323378 → CSSTransition
6347733 → 已游离 input 4506295（明确带 `__MICRO_APP_NAME__=wonder-ws-web`）
→ Vue `_vei.onInput` 5363785 → WS 旧作用域及三个 SES2 旧窗口引用。
这证明存在该保留路径，不证明取消一个动画就能释放全部增量。

代码缺口：`unmount()` 先执行子应用 UMD hook，随后才遍历 container 清理。
hook/Vue transition 已移出的节点不再出现在这个遍历里。实现如下：

- 仅终态 unmount 在 hook 前记录本实例容器内元素，排除嵌套 micro-app 子树；
- 补入本应用 effect 日志中明确带应用标签的、已经游离的元素监听目标；
  读取 name-keyed 日志须通过实例所有者判断，不猜测未标记基座目标归属；
- 卸载完成后取消候选节点的动画，即使 container 已被 hook 清空；
  已连接且转移出本容器的节点不处理；立即置空快照，重复清理不保留节点；
- 普通卸载/keep-alive 切换不采集、不取消这批动画。未全局扫描动画或删除监听器。

新增回归覆盖 hook 移出节点、container=null、嵌套应用、普通卸载、重新挂入活容器，
及 effect 候选的应用标签/连接状态/销毁后释放。六套相关测试 42 项通过，类型与源码 lint 通过。
本次改动不是对所有第三方 DOM/动画的全面所有权跟踪；创建后未登记、且卸载前就移出容器的
节点仍可能无法覆盖。不得据此声称累计泄漏已解决，须用新构建重跑同协议 GC 验收。

工具纠正：`heap_grow_boundary` 在遇到任意 synthetic 入边时停止，并不意味着其余入口已闭合。
保留 `reachedRoots` 字段，新增 `boundaryComplete` 和 `unresolvedNonSyntheticSources`，
去掉“boundary is complete”的无条件输出。13.18 的类别计数不能直接证明监听器是旧应用残留，
不能批量移除那 177 个监听器；CustomWindow 增量也不是 destroy 执行次数的可靠判据。

### 13.20 13:33 构建（CSS 过渡/动画 + 事件监听器）重跑（2026-09-14，**数字已被 §13.32 降级**）

> ⚠️ **本节数字已被 §13.32 判定为「非产品路径」——引用前必读。**
>
> 本节测到的 **~112.2 MB/销毁轮** 需要**两个条件同时成立**才有：
> **① 用 `router.push` 直接驱动路由**（绕过基座的 tab 系统）**且 ② 强制元素的 `destroy` 属性**。
> 对照实验（同应用、同轮数、只改一个变量）：
>
> | 配置 | MB/轮 |
> |---|---|
> | 真实菜单 + Tab ×（**产品路径**） | **0.13** |
> | 真实菜单 + Tab × **+ `destroy` 属性** | ≈0.24（`usedSize` 口径） |
> | `router.push`，不加 `destroy` | 5.5 |
> | **`router.push` + `destroy`（= 本节配置）** | **112.2** |
>
> 机制：`destroyed` 实例堆积（本节快照里 `createAppDestroyed` 逐轮 +1；真实路径全程为 0）。
> **因此本节的增量不是产品路径上的行为，不能作为「产品泄漏速率」引用。**
> 产品路径上的真实数字是 **0.13 MB/轮**（§13.30）。

> 同样地：本节与 §13.8/§13.17 的**横向比较仍然有意义**（同一套非产品协议），
> 「13:33 的修复没有降低代价」这个**相对结论不受影响**。

---

新构建 `lib/index.esm.js` 时间 **13:33**（510,757 字节），改动集中在
`src/create_app.ts` 与 `src/sandbox/event_target.ts` —— 正是 §13.18 指出的两组
（`KeyframeEffect` / `CSSTransition` / `CSSAnimations` 与 `RegisteredEventListener`）。

同协议四轮（fresh 登录 → init → 4 轮 destroy，清 console）：

| label | heapMB | Δheap | nodes | Δnodes | detached | cWin | cApp | 已销毁 |
|---|---|---|---|---|---|---|---|---|
| init | 348.3 | | 4,486,411 | | 188 | 6 | 6 | 0 |
| acc-1 | 471.6 | +123.3 | 6,419,744 | +1,933,333 | 5,910 | 10 | 6 | 0 |
| acc-2 | 585.0 | +113.4 | 8,179,598 | +1,759,854 | 7,416 | 14 | 7 | 1 |
| acc-3 | 686.8 | +101.8 | 9,741,265 | +1,566,667 | 8,922 | 18 | 8 | 2 |
| acc-4 | 797.1 | +110.3 | 11,450,184 | +1,708,919 | 10,428 | 22 | 9 | 3 |

（每轮 `customWindow` 都 +4，四轮**全部**走成了销毁路径。）

**历次同协议对照（每销毁轮）：**

| 构建 | MB / 销毁轮 |
|---|---|
| 18:20 基线 | 108.6 |
| 10:04 动画清理 | 110.5 |
| 11:18 RAF 修复 | 111.8 |
| **13:33 CSS/监听器** | **112.2** |

**四次修复全部落在 108.6–112.2 的波动带内。验收仍未通过。**

### 入口级对比：**被销毁轮数混淆，不能下结论**

用 `grow_boundary` 把 13:33 构建的边界也推到闭合，逐项对比最终入口分类：

| 类别 | 11:18（3 个销毁轮） | 13:33（4 个销毁轮） |
|---|---|---|
| `object shape Map` | 861 | 860 |
| `Generator` | 840 | 840 |
| `closure resolve` | 356 | 356 |
| `KeyframeEffect` | 144 | 192 |
| `Text` | 165 | 189 |
| `blink::RegisteredEventListener` | 177 | 181 |
| `Comment` | 90 | 107 |
| `CSSAnimations::Transition…` | 72 | 96 |
| **`array (anon)`** | **0** | **13,663** |
| `system / JSProxy` | 0 | 790 |

**必须说清：两次的销毁轮数不同（3 vs 4），基数本来就不一样，绝对值不可直接比。**
DOM/CSS/监听器那几项的增长幅度大致与"多一个销毁轮"相当，**没有出现比例上的改善**，
但这**不足以判定"修复无效"** —— 要判定必须让两个构建跑**同样多的销毁轮**，
而 11:18 的代码已经无法重建。

**另一个必须标记、但不能解释的现象**：13:33 构建的入口里出现了一个 11:18 完全没有的类别
**`array (anon)` = 13,663 条**，它单独就解释了 ingress 边数从 10,297 涨到 25,067 的大部分。
**这可能是新代码引入的，也可能是销毁轮数差异造成的 —— 本轮不做解释，只做标记**，
它是下一个最该查的具体线索（比继续猜"哪条保留链"更具体）。

### 判定

**未通过。** 判别标准不变：同一协议下销毁轮的平均增量应从 ~110 MB 降到接近 0。

（本次为登录后重跑：会话已过期，用平台账号重新登录 `wd` 实体后采集；凭据不写入本报告。）

### 13.21 对 `heap-accept9` 的两项独立检查，以及 §13.18 的两处限定（2026-09-14）

### 检查一：CSS 过渡保留链 —— 样本**不是**游离 DOM，§13.18 的侧重需要收回

取 `CSSTransition #10935368`（54 个中的 1 个）追保留链：

```
CSSTransition #10935368
  element:#1 -> KeyframeEffect #10935365
  element:#2 -> HTMLDocument            ← DOM 固有：过渡必然属于某个 document
  element:#3 -> DocumentTimeline        ← DOM 固有
  element:#5 -> <button id="ws-checkout-btn" data-v-4a117f44>
                  detachedness = **attached**
                  __MICRO_APP_NAME__ = "wonder-ws-web"
```

**目标是 `attached` 的按钮（属于当前仍挂载的 app），不是游离节点。**
所以这个样本**不是游离 DOM 泄漏**，`element:#2/#3` 那两条也只是动画对象与 document/timeline 的固有关系。

**但游离 DOM 确实大量存在**（同一份快照，`heap_detached_dom.js`）：

| | 节点数 | selfSize |
|---|---|---|
| attached | 1,680 | 201,208 |
| **detached** | **10,428** | **1,202,840** |
| unknown | 260 | 8,324 |

| 应用 | 游离节点数 |
|---|---|
| **app-ws（wonder-ws-web）** | **10,221** |
| app-ses2 ×3 | 77 / 60 / 60 |
| app-ws-dataDetail-global | 8 |

**这 10,221 个游离节点的持有者不是动画，是 Vue 组件实例**（取游离 `Comment #143047` 追出）：

```
depth1: object "Object"  --property:el-->                    ← 组件实例 → DOM
depth2: object "Object"  --property:vnode-->                 ← Vue VNode
        object "Object"  --property:subTree-->               ← 渲染子树
depth3: object "Object"  --property:ctx--> / --property:_-->
        closure native_bind  --shortcut:bound_argument_0-->  （§4 那类绑定函数）
```

**结论：§13.18 把 `KeyframeEffect` / `CSSTransition` 当成"可操作的入口"是判错了方向 ——
动画不是游离 DOM 的保留机制，Vue 组件实例才是。**
（"为何漏过取消"这个问题因此不成立：这些过渡的目标本来就没游离。）

### 检查二：新增的 `array (anon)` —— 是业务数据，不是 DOM

取该类别样本 `#664827`（797 个 distinct 中的 1 个）：

```
array #664827  (129 条出边)
   internal:38 -> "owning_dept_dictText"
   internal:41 -> "type_name"
   internal:44 -> "intelligence_group_json"
   internal:47 -> "child_data_tenant_id"        ← 业务字段名
持有者: Map --internal:table-->
     ← 64 × object "B" --property:map-->
     ← 38 × object "P" --property:dep-->
```

**内容是业务表单/表格的字段名数组，通过 `Map` 被 `B` / `P` 这类压缩类名持有 —— 与卸载前 DOM 快照无关。**
**但这只是 797 个里的 1 个样本，不能推广**；要定性需要抽样统计（本轮未做）。

### 两处必须保留的限定（§13.18 / §13.20 的措辞据此收紧）

1. **`customWindow +4` 不能证明 destroy 执行了 4 次。**
   它只能说明"新增了 4 个 CustomWindow" —— 究竟走了 `unmount(destroy=true)` 还是
   走了 stop 后重挂、抑或是别的原因创建了新沙箱，**这个计数本身无法区分**。
   §13.20 用 `cWin +4` 判定"四轮全部走成了销毁路径"是**不成立的**，应降级为"四轮都出现了 +4 个新沙箱"。
2. **"遇到部分 GC 根"不等于"整个边界闭合"。**
   acc-9 那次的日志自己就写了
   `ingress reaches synthetic GC-root nodes; 11892 non-synthetic sources remain (not necessarily a complete boundary)` ——
   **这不是完整边界**。§13.18 里"边界在第 5 轮闭合"的措辞应降级为"入边里有 GC 根出现"。
   另外 acc-9 的簇已长到 **9,618,349 节点 / 583.6 MB（占该快照约 85%）**，
   **当一个簇覆盖了几乎整个堆时，它的入边分类已经不再专门描述这次泄漏**，不能拿来当泄漏证据。

**因此：不能用这两条（`cWin +4`、出现 GC 根）作为继续扩大清理范围的依据。**
本轮唯一站得住的新事实是：**游离 DOM 的持有者是 Vue 组件实例，不是动画。**

### 13.22 797 个 `array (anon)` 的持有者分布（抽样统计，2026-09-14）

§13.21 只看了 1 个样本（#664827），结论不能推广。这次把 797 个全部拿到再统计。

**方法**：给 `heap_grow_boundary.js` 加 `--dumpIngress=<file>`（导出最后一轮 ingress 来源的
节点号，而不是只留 sample），给 `heap_root_cut.js` 加 `--rowLimit=<n>`（原先行数硬编码 80，
会把分布截断）。重跑后拿到全部 797 个节点号，再做反向入边统计。

### 第一层：797 个 array 被谁持有（797 条边 / 3 组，完整）

| 条数 | 持有者 | distinctFrom |
|---|---|---|
| **791** | `object Map --internal:table-->` | **791** |
| 5 | `native system / SourceTextModule --hidden:(Compilation cache)` | 4 |
| 1 | `object WeakMap --internal:table-->` | 1 |

**99.2% 是 791 个不同 `Map` 的内部存储表。** 注意 `internal:table` 的含义：
这些 array **不是被 Map 当作值存着，它们本身就是 Map 的哈希表存储**
（所以 §13.21 的样本里那些业务字段名是 **Map 的 key**）。

### 第二层：那 791 个 Map 被谁持有（15,231 条边 / 6 组，完整）

| 条数 | 持有者 | distinctFrom |
|---|---|---|
| **13,638** | `object "B"` | **13,638** |
| 787 | `array (anon)` | 4 |
| 587 | `object "Array"` | 587 |
| 203 | `object "Object"` | 201 |
| 15 | `object "D"` | 15 |
| **1** | **`object "EventCenter"`** | 1 |

### 第三层：`B` 那一层被谁持有（6,084 条边 / 13 组，显示前 10）

| 条数 | 持有者 | distinctFrom |
|---|---|---|
| 2,823 | `array (anon)` | 171 |
| **2,813** | `object "P"` | 2,813 |
| **173** | **`native system / JSProxy`** | 173 |
| 126 | `object "Object"` | 45 |
| 44 / 44 | `array (object elements)` / `object Array` | 2 / 2 |
| 37 | `native system / PropertyArray` | 37 |
| 10 / 6 / 3 | `object "M"` / `object "$e"` / `object WeakMap` | |

### 这条分布说明什么、不说明什么

**说明：**

1. **这批数据是业务侧的**：`B` / `P` / `D` / `M` / `$e` 是应用 bundle 里压缩后的类名，
   持有链是 `Map(table) ← B ← P ← …`，**没有任何一类是 DOM、动画或框架对象占多数**。
   §13.18 把 `array (anon)` 当作"可能由新代码引入"的怀疑，**在这一层得不到支持** ——
   它的持有者压倒性是应用自己的类（13,638 个不同的 `B`）。
2. **框架侧的接触点只有两处，且都很小**：`object "EventCenter"` ×1（micro-app 自己的事件中心，
   `src/interact/event_center.ts`）、以及第三层的 `native system / JSProxy` ×173（沙箱代理）。
   **这两处值得单独看一眼，但不能凭条数认定它们是保留源。**

**不说明（限定）：**

- **持有 ≠ 保活。** 这一节是分布统计，不是切割实验。13,638 个 `B` 里每一个都可能是
  可达但正常的部分（应用自己长期持有的表单/表格元数据），**没有做任何"切断后是否释放"的验证**。
- 三层都是 `distinctFrom` 极大的"扁平"分布（13,638 / 2,813 / 791），
  **这种形状与"分布式保留"一致，与"少数几个共同上游"不一致 —— 但同样不能据此排除共同上游**
  （§13.16 第 1 条）。
- `heap-accept9` 是 13:33 构建、4 个销毁轮的快照；这批 Map 里有多少属于**当前仍挂载的应用**
  的正常状态、有多少属于**已销毁应用**的残留，**本节没有区分**（那需要按 `__MICRO_APP_NAME__`
  或按 bundle 来源归属，本轮未做）。

### 13.23 按实例活死归属这批 Map（2026-09-14）

### 先说一个方法限制：`__MICRO_APP_NAME__` 分不开活死实例

`__MICRO_APP_NAME__` **只设在 DOM 节点上**（Map 上没有这个属性）。
更关键的是：**本套测试里活实例与死实例的应用名完全相同** —— 每轮卸载重挂的都是
`wonder-ws-web` + `SES2-*`，名字一样。**所以按名字无法区分活死，只能按 `detachedness` 或按持有者身份。**

按 `__MICRO_APP_NAME__` + `detachedness` 的 DOM 归属（`heap-accept9/acc-4`）：

| 应用名 | attached（活实例） | detached（已销毁实例） |
|---|---|---|
| **wonder-ws-web** | **1,453** | **10,221** |
| SES2-proofreadApproveModal | 40 | 77 |
| SES2-LoadData | 37 | 60 |
| SES2-SysMLLinkEditor | 37 | 60 |
| wonder-ws-dataDetail-global | 79 | 8 |
| Issues-Component-CreateIssue | 34 | 2 |

**同一个名字在两边都出现**，这就直接证明了"按名字归属"行不通；`wonder-ws-web` 的 DOM
有 87.6% 处于 detached 状态。

### 用"持有者身份"归属这批 Map

791 个 Map 的持有链里，第二层出现了 **173 个 `native system / JSProxy`**（沙箱代理）。
代理能判归属：**活沙箱的代理被 `WithSandBox` 以 `proxyWindow` 持有；`destroy()` 会把
`this.proxyWindow = null`，所以已销毁沙箱的代理没有 `WithSandBox` 持有者。**

先核实分母 —— 该快照里确实有活沙箱：

| 节点 | 数量 |
|---|---|
| `WithSandBox`（实例） | **6** |
| `CustomWindow`（实例） | 22 |
| `CreateApp`（实例） | 9 |

对其中 109 个代理（truncated 样本）做反向入边：

| 判据 | 结果 |
|---|---|
| **被 `WithSandBox` 持有（= 活实例）** | **0 / 109** |
| 只被死实例结构持有 | 1 |
| 被业务数据结构持有 | 108 |

**持有者分布（327 条边）：**

| 条数 | 持有者 |
|---|---|
| 27 | `object "Object" --property:record-->`（表格行记录） |
| 27 | `native system / PropertyArray` |
| 7 | `object "$e" --property:_value-->`（Vue ref 内部值） |
| 6 | `object "Object" --property:data-->` |
| 3 | `object "Ze" --property:_value-->` |
| 3 | `object "Object" --property:dataForChild-->` |
| 3 | `object "Object" --property:selectedRowKeys-->` |
| 2 | `object "system / Context / scope @1044435" --context:w-->` |
| 若干 | `WeakMap` 条目 `{Object @1031649 → JSProxy}`（table @16281041） |

### 结论

**1. `__MICRO_APP_NAME__` 归属这条路走到头是"分不开活死"，因为名字相同。** 这不是本次数据的问题，
而是"同一应用反复卸载重挂"这种工作负载的固有性质。

**2. 换成持有者身份后，归属是清楚的**：那 109 个代理**没有一个属于活沙箱**（分母 6 个活沙箱确实存在），
**全部来自已销毁实例**；而持有它们的是**业务数据结构**（表格行 `record`、Vue `ref._value`、
`dataForChild`、`selectedRowKeys`）。

**3. 这是一条比 §13.22 更具体的链**：

```
业务数据结构（表格 record / Vue ref）
  → JSProxy（已销毁沙箱的 proxyWindow）
  → B（应用类）→ Map → array（797 个）
```

~~`WithSandBox.destroy()` 已经把 `proxyWindow` 置空了，**框架松了手，但业务数据把它捡走了**。~~

> ⚠️ **此句已按 §13.25 撤回**：那些 JSProxy **不是沙箱的 `proxyWindow`**（target 是 Vue 响应式源
> `object "ne"`，不是 `CustomWindow`）。"业务数据捡走沙箱 window"**无依据**。
所以"已销毁沙箱的代理为什么还活着"这个问题，答案指向**应用侧把 sandbox window 存进了长期存活的数据结构**
（表格行、ref、选中项这类）。

### 限定（不要越过）

- 这仍是**持有关系**，不是切割实验：**没有验证切断这 109（或 173）个代理后是否真的释放那批 Map。**
  按本轮反复出现的规律（§13.13 的表：9 个候选锚点全部 ≈0），**很可能仍有并行入口。**
- 109 是 173 的 truncated 样本；`record` / `_value` 这些业务字段名是**压缩后的 Vue/antd 内部名**，
  没有逐一定位到源码。
- **不能据此扩大清理范围**：要动的是"谁把 sandbox window 写进了业务数据"，
  这是应用侧的行为，不是 micro-app 单方面能清的；框架侧能做的是在 `destroy()` 时把
  `proxyWindow` 从它可能被写入的地方撤回 —— **但本轮没有证据支持某个具体做法。**

### 13.24 Review correction：JSProxy 类型不等于窗口代理（2026-09-14）

独立核对 `E:/heap-accept9/acc-4.heapsnapshot` 中 13.21 的样本：
array 664827 ← Map 664896；Map 的入边包含 Object 515183 的 WeakMap
ephemeron 关联，Object 515183 又是 JSProxy 670557 的 target。
JSProxy 670557 的三条出边为 map 141698、target Object 515183、handler ne 522939。
target 明确有 owning_dept_dictText=WD、type_name=ws_folder、table_name=wds_folder、
children 等业务字段，它不是 CustomWindow，而是业务数据对象。

因此 13.23 的判据无效：JSProxy 是所有 JavaScript Proxy 的统一堆类型，包含 Vue 响应式
代理、业务代理和沙箱窗口代理。没有 WithSandBox.proxyWindow 入边，只能排除它是该字段
直接引用的代理，不能据此认定来自已销毁实例，也不能推出业务 record/ref 保存了 sandbox window。
本次样本已经证伪该判据的普适性；其它 108/173 个仍需逐个检查 target/handler，不能沿用
“全部是已销毁窗口代理”的结论。detached DOM 也不等价于已销毁实例，存活组件可有游离节点。

目前没有支持清空这些业务 Map/ref/record 或撤回 Proxy 的安全实施依据，不据此扩大框架清理。
真正的窗口代理须验证 target=对应 CustomWindow（或其完整包装链），再核对活沙箱的精确实例身份。
业务代理则需通过持有者的脚本/组件实例及环外强保留路径继续归属。以上修正保留原报告和历史注释，
不表示累积泄漏已排除，也不表示动画样本一条 attached 目标能够排除其它 detached 动画路径。

### 13.25 **更正 §13.23**：那些 JSProxy 不是沙箱代理，是 Vue 的响应式代理（2026-09-14）

> 与 §13.24（另一处独立写入）结论一致，互相印证：**不能凭 `system / JSProxy` 这个类型判定它是窗口代理。**

### 错误在哪

§13.23 由"109 个代理里 0 个被 `WithSandBox` 持有"推出"**它们全部来自已销毁沙箱**"，
进而得出"业务数据把已销毁沙箱的 `proxyWindow` 捡走了"。

**这个推理的前提是错的**：那些 JSProxy **根本不是沙箱的 `proxyWindow`**。

### 判据：看代理的 target

沙箱 `proxyWindow` 的 target 一定是 `CustomWindow`（`WithSandBox.microAppWindow = new CustomWindow()`，
`proxyWindow` 是它的 `Proxy`）。对 §13.23 那 109 个代理逐个查 `hidden:`（JSProxy 的 target 边）：

| target | 个数 |
|---|---|
| `object "ne"` | **104** |
| `object "Object"` | 4 |
| `object "Array"` | 1 |
| **`CustomWindow`** | **0** |

**没有一个是 `CustomWindow`。** 再看共享的那个 target：

```
object "ne" #522939
   property:_isReadonly -> false      ← Vue 3 ReactiveFlags
   property:_isShallow  -> false
   property:__proto__   -> object "te"
   被 1,666 个 system / JSProxy 持有（同一 target）
```

`_isReadonly` / `_isShallow` 是 **Vue 3 响应式系统的标志位**。
**所以这些代理是 Vue 的响应式代理（`reactive()` / `readonly()` / `shallowReactive()` 产生的），
不是沙箱代理。**

### 因此 §13.23 的结论作废

| §13.23 的说法 | 更正 |
|---|---|
| "109 个代理没有一个属于活沙箱" | **数字没错，但样本选错了** —— 被检查的群体里本来就不含沙箱代理 |
| "全部来自已销毁实例" | **无依据** |
| "业务数据把 sandbox window 捡走了" | **无依据，撤回** |
| "链是 业务数据 → JSProxy（已销毁沙箱的 proxyWindow）→ B → Map" | **更正为**：链是 `业务数据 / Vue 响应式代理 → B（应用类）→ Map → array`，**与沙箱代理无关** |

§13.23 里唯一仍然成立的是那张 `__MICRO_APP_NAME__` + `detachedness` 的表
（`wonder-ws-web`：attached 1,453 / detached 10,221），以及"**同一应用名在活死两边都出现，
所以按名字分不开活死**"这条方法结论。

### 仍然成立的分布（§13.22）

三层持有链本身没有变，只是第二、三层里那个"JSProxy"要重新理解成 **Vue 响应式代理**：

| 层 | 持有者 | 条数 |
|---|---|---|
| array(797) | `Map --internal:table-->` | 791 |
| Map(791) | `object "B"` / `array(anon)` / `Array` / `Object` / `D` / **`EventCenter`** | 13,638 / 787 / 587 / 203 / 15 / **1** |
| B | `array(anon)` / `object "P"` / **Vue 响应式代理** / `Object` / `Array` / `PropertyArray` / `M` / `$e` / `WeakMap` | 2,823 / 2,813 / **173** / 126 / 44 / 44 / 37 / 10 / 6 / 3 |

**这条链从头到尾是应用侧 + Vue 的结构，框架侧的接触点只有 `EventCenter` ×1。**

### 方法教训（写下来避免重犯）

**堆快照里的 `system / JSProxy` 不必然是沙箱的 `proxyWindow`。** Vue 3 的 `reactive()` /
`readonly()` / `shallowReactive()` 返回的也是 `Proxy`，在堆里同样是 `system / JSProxy` 节点。
**任何用 "JSProxy" 当沙箱代理证据的结论，都必须先查它的 `hidden:` target 是不是 `CustomWindow`。**
本报告 §4.3、§7.2(3)、§13.9、§13.12 里的 JSProxy 都做过 target 检查（是 `CustomWindow`），
所以那些结论不受影响；**只有 §13.23 漏了这一步。**

### 结论：这条线索到头了

"业务数据从哪里写入代理"这个问题，**在本轮数据里不成立** —— 那些代理是 Vue 自己造的，
不是应用把沙箱 window 存进了数据。**追这条链的收益到此为止**，继续追只会追到 Vue 的响应式系统。

### 13.26 追 `EventCenter`：规模与活应用一致，但**不能据此排除它**（2026-09-14，**结论已被 §13.28 收紧**）

> ⚠️ **本节"不是保留源"这个结论已按 §13.28 收紧**：不能仅凭 `eventList` 只有 12 个键、
> table 只有 468 字节就排除事件中心 —— **小表可以通过 `data` 或 `callbacks` 保留大型旧模块图**。
> 本节**目前能支持的只有**："注册表**条目数量**没有按轮增长"，**尚未证明全部内容无旧实例引用**。

§13.22 的三层分布里，框架侧的接触点只有 `object "EventCenter"` ×1。追它。

### 它确实是那 791 个 Map 之一

```
EventCenter #1921105
   property:eventList -> Map #4864652   →  internal:table -> array #4868583
```

对照源码 `src/interact/event_center.ts:12`：`public eventList = new Map<string, IEventInfo | undefined>()`。
**`eventList` 的内部存储表就是 §13.22 里那 797 个 array 之一。**（所以"框架侧 1 条"是真的。）

### 但它的内容是 12 个条目，且与当前挂载的 6 个应用一一对应

`eventList` 的表里全部键：

```
"global"
"__wonder-ws-dataDetail-global_from_base_app__"   / "_from_micro_app__"
"__Issues-Component-CreateIssue_from_base_app__"  / "_from_micro_app__"
"__wonder-ws-web_from_base_app__"                 （只有 base 方向）
"__SES2-Component-LoadData_from_base_app__"       / "_from_micro_app__"
"__SES2-Component-proofreadApproveModal_…__"      / "…"
"__SES2-Component-SysMLLinkEditor_…__"            / "…"
```

**键名模式是 `<应用名>_from_base_app__` / `<应用名>_from_micro_app__`，条目正好对应快照里挂载的 6 个应用。**
表本身 468 字节。**它占 791 个 Map 的 0.13%，不是有量的持有者。**

### 它的 `data` 里确实有个 JSProxy —— 但不是沙箱 window

`IEventInfo #9596949`（`__wonder-ws-web_from_base_app__` 那条）：

```
property:data      -> 4530529 native "system / JSProxy"
property:callbacks -> Set #5733573
```

**按 §13.25 的教训先查 target**：

```
JSProxy #4530529
   hidden:        -> object "Object" #3140002      ← 目标是普通 Object，不是 CustomWindow
   hidden:<dummy> -> array ""
```

**`CustomWindow` 的实例在堆里名字就是 `CustomWindow`，这里是 `Object`** ——
**所以它同样不是沙箱的 `proxyWindow`。**

### 结论

**能确认的只有"条目数量没有按轮增长"：**

1. 它是 791 个 Map 里的 1 个，表 468 字节、12 个条目 —— **但小表不等于不保留，见下**；
2. 12 个条目与**当前挂载的 6 个应用**名字对应；**但同名应用复用键，无法证明值来自当前实例**；
3. 它 `data` 里那个 JSProxy **目标是普通 Object，不是 `CustomWindow`** —— 这条成立，
   但**不排除它的其它属性或响应式订阅连接旧实例**。

**§13.22 里"框架侧接触点 ×1"这句话要改口径**：那 1 条确实是 micro-app 自己的对象，
它是**设计上就长期存活的全局事件注册表**，规模与活应用数一致。**但按 §13.28：**
- **同名应用会复用键**，所以"12 个键对应 6 个应用"**不能证明每个值与每个回调都来自当前实例**；
- `data` 是业务 Proxy 而非 `CustomWindow`，**也不排除它的其它属性或响应式订阅连接旧实例**。

**§13.22 三层分布里的类别到此追完，但没有一类被"证明"或"排除"为入口** ——
每一处都只证明了"规模/形状与活状态一致"，而**规模一致 ≠ 内容无旧实例引用**（§13.28）。
链的绝大部分是应用侧 + Vue 的结构（`B` = Dep / `P` = Link / 响应式代理），框架侧那 1 条是全局注册表。

### 方法备注

本次每一步 JSProxy 都先查了 `hidden:` target（§13.25 的教训）。**§13.23 的错误只犯了一次。**

### 13.27 追 `B` 和 `P`：识别为 Vue 的 `Dep` 与 `Link`（2026-09-14，**结论已被 §13.28 撤回**）

> ⚠️ **本节的两条断言已按 §13.28 撤回**：
> 1. "整条链是**已销毁应用**的 Vue 响应式图" —— **撤回为待验证**。
>    代码来源是 ws bundle 只证明**来源应用**，**不能区分本次仍存活的 ws 与前四次已卸载的 ws**。
> 2. "销毁没有把这份响应式图拆掉" —— **撤回为待验证**。
>    `ReactiveEffect` 存在**不等于**它仍处于 active 状态；须核查 `flags` 与所属 `effectScope`。
>
> **仍然成立的部分**：字段识别（`B` = Vue `Dep`、`P` = Vue `Link`、`d` = Vue `ReactiveEffect`）、
> 原型的 `constructor`/`fn`/`scheduler`/`onStop` 的 scriptUrl 均来自 `ws.dev` bundle、
> 以及 `array(797) ← Map(791) ← Dep ← Link ← ReactiveEffect` 这条**结构**链。

### 识别方法

不看名字（`B`/`P` 是压缩后的类名），而是**看字段集合 + 原型的 `constructor` 属于哪个 Script**。

| 类 | 字段 | 原型 `constructor` 的 scriptUrl | 判定 |
|---|---|---|---|
| `B` | `computed` / `version` / `activeLink` / `subs` / `map` / `key` / `sc` | `ws.dev/…/chunk-vendors.a695a4d2.js` | **Vue 3 的 `Dep`** |
| `P` | `sub` / `dep` / `version` / `prevActiveLink` / `prevSub` / `nextSub` / `prevDep` / `nextDep` | 同上 | **Vue 3 的 `Link`** |

`B` 的原型上还挂着 **`track` / `trigger` / `notify`** 三个方法 —— 正是 `Dep.prototype` 的那三个，识别无疑。

### 完整链路（每一跳都有边或原型证据）

```
array (797)            = Map 的内部存储表
  ← Map (791)          ← Dep.map
  ← B = Vue Dep (13,638)
  ← P = Vue Link (2,813)
  ← d = Vue ReactiveEffect      { fn, deps, depsTail, flags, next, cleanup, scheduler, onStop }
        其中 fn / scheduler / onStop 全部来自 ws bundle
```

`Link.sub -> d`，而 `d` 被 **14,114 个不同的 `P`（Link）** 持有 —— 那是它自己的 `deps` 链。

### 这条链说明什么

**1. §13.22 里那两个"应用侧压缩类名"不是什么业务数据类，而是 Vue 自己的响应式内部结构。**
`B`/`P`/`d` 三者合起来就是 Vue 3 的 `Dep → Link → ReactiveEffect` 三元组。

**2. 这**整条链属于 `ws.dev` 子应用自己打包的那份 Vue**（不是基座的 Vue）——
所有 `constructor` / `fn` / `scheduler` / `onStop` 的 scriptUrl 都是 `ws.dev/…/chunk-vendors`。**
而 `ws`（`wonder-ws-web`）正是本轮被销毁 4 次的那个应用。

**3. ~~已销毁的 `ws` 应用的 Vue 响应式图是完整的~~ —— 此句已按 §13.28 撤回。**
能确认的只有：存在一条 `ReactiveEffect → Dep 订阅链` 的结构，其代码来源是 ws bundle。
**是否属于已销毁实例、该 effect 是否仍 active，本轮都没有验证。**

**4. 保留方向**（已按 §13.28 修正）：`targetMap` 是 `WeakMap<响应式目标, Map<key, Dep>>`，
**ephemeron 要生效需要 WeakMap 自身和 target 都可达，不是仅 key 存活。**
所以"内层 Map 活着是因为 key 活着"这句话本身不完整，**本轮也没有验证 targetMap 本身的可达性**。
正确的下一步是核对**精确实例**对应的 `ReactiveEffect` / `effectScope`、它的 `flags` 状态和强外部入边。

### 限定

- 这是**保留结构**的描述，不是切割实验。**没有验证"切断某个响应式目标后是否释放这条链"** ——
  按本轮反复出现的规律，很可能仍有并行入口。
- 791 个 Map 里有多少属于**已销毁实例**、多少属于**仍挂载的 ws 实例**，**本节仍未区分**。
  已确认的只是：这些结构的代码来源是 ws bundle，而 ws 在本次工作负载里被销毁 4 次、重挂 4 次。
- `d`（ReactiveEffect）**外部的**持有者（组件实例的 `effect` 字段、computed 的 `ComputedRefImpl`）
  本轮**没有追到**，只追到它被自己的 `deps` 链持有。**下一跳应该从响应式目标往回追。**

### 13.28 Review correction：识别 Vue 结构不等于识别已销毁实例（2026-09-14）

13.27 按字段识别 Dep/Link/ReactiveEffect 是合理的，但代码来源为 ws bundle 只证明来源应用，
不能区分本次仍存活的 ws 与前四次已经卸载的 ws。该节限定明确写了尚未区分 791 个 Map 的
活死归属，所以正文“整条链是已销毁应用”“销毁没有拆掉响应式图”仍需撤回为待验证。
ReactiveEffect 的存在本身也不能证明它仍处于 active 状态，须核查 flags/所属 effectScope。

13.26 不能仅凭 eventList 12 个键、table 468 字节排除事件中心：小表可通过 data 或 callbacks
保留大型旧模块图；同名应用会复用键，不能证明每个值与每个回调均来自当前实例。
data 是业务 Proxy 而非 CustomWindow，也不排除它的其它属性/响应式订阅连接旧实例。
目前只证明注册表条目数量没有按轮增长，尚未证明全部内容无旧实例引用。

WeakMap targetMap 的 ephemeron 生效仍需 WeakMap 自身和 target 都可达；不是仅 key 存活。
下一步应核对精确实例对应的 ReactiveEffect/effectScope、它的状态和强外部入边，或检查
事件中心每个 callback/data 的旧 S cript 关联，而不是强行清 Vue 的内部 Dep/Link/targetMap。
本次没有足以支持安全修改运行时代码的新增外部根链，保留现有保护与回归测试，不扩大清理。

### 13.29 收尾：本次没有足以支持安全修改的新增根链（2026-09-14）

把 §13.16 起的全部纠正合并，本次探索得到的**净结论**如下。

**一、站得住的事实**

| 事实 | 出处 |
|---|---|
| **产品路径（真实菜单 + Tab ×）每轮 0.13 MB**，10 轮累计 +1.05 MB，增量在收敛 | §13.30 |
| **登出残留 ≈64–69 MB / 次，与轮数无关**（1 轮 63.94 / 10 轮 69.06） | §13.30 |
| **登出后框架簿记全空**（`createApp=0` / `parsedCode=0` / `__MICRO_APP_URL__=0`），残留来自框架之外 | §13.31 |
| **同进程内"干净页基线"会累积**（24.46 → 93 → 245 MB），**评估必须以冷启动为基准** | §13.30 |
| ~~终态 destroy 路径真实泄漏，**~110 MB / 销毁轮**~~ → 已按 §13.32 降级为**非产品路径**（需 `router.push` + 强制 `destroy`） | §13.32 |
| 构成：每销毁一个应用多留**一份完整包裹源码 + 整套编译产物** | §13.4 |
| stop / 重挂路径**不泄漏**（+0.2 MB/轮） | §13.2 |
| 测量污染（DevTools console 句柄）已排除：压掉 100× 后增量不变 | §13.11 |
| 边界可收敛：入边从 28 万收敛到**约 1 万的有界集合** | §13.18 |
| **WS 残留的入口是「并行冗余」的**：全切 9,495 个源释放 **132.94 MB**（全堆 74.5%），单切任一类别 ≈0（最大的 2,234 个 `Object` 也只 7.63 MB） | §13.34 / §13.35 |
| 游离 DOM 的持有者是 **Vue 组件实例**（`el`/`vnode`/`subTree`），不是动画 | §13.21 |
| `array(anon)` 那批是 **Vue 的 `Dep`/`Link`/`ReactiveEffect` 结构**，代码来源 ws bundle | §13.27 |

**二、被撤回或收紧的断言（不要再引用旧措辞）**

| 旧说法 | 现状 |
|---|---|
| "34 万入边 = 没有有界入口" | 撤回：内部引用收敛后有界（§13.16 / §13.18） |
| "不存在单一根因可修" | 收紧：只证明"那些锚点不是**必要**入口"，不能推出无根因（§13.16） |
| "JSProxy 都不属于活沙箱 → 业务数据捡走了沙箱 window" | 撤回：那些 JSProxy 是 **Vue 响应式代理**，不是沙箱代理（§13.25） |
| "EventCenter 不是保留源" | 收紧：只证明"条目数没按轮增长"（§13.26 / §13.28） |
| "整条链是已销毁应用的 Vue 响应式图 / 销毁没拆掉它" | 撤回：来源是 ws bundle 只证明来源应用，**分不清活死实例**；effect 存在≠active（§13.27 / §13.28） |
| "WeakMap 只看 key 存活就能判定永久泄漏" | 撤回：ephemeron 需 WeakMap 自身与 target **都**可达（§13.16 / §13.28） |
| "22 个代理**全部来自已销毁实例**"（§13.9） | 收紧：依据只是**计数吻合**（22 = 6 + 4×4），**计数吻合不是归属证明**（§13.9 就地标注） |

**三、结论**

**产品路径上的净结论（按 §13.30 / §13.32 重述）**：

- **逐轮累积泄漏不成立**：真实操作 0.13 MB/轮且收敛；旧读数 ~110 MB/轮是非产品路径。
- **剩下的两个真实问题**：(a) 一次性登出残留 ≈45–50 MB 的 WS 模块图；
  (b) 每轮 0.13 MB 的缓慢增长。
- **(a) 在框架侧无解** —— 登出后框架簿记全空（§13.31）。
- **(b) 的成因未定** —— 冷启动对照证明它不是"进程污染"，但也没有定位到具体引用。

**在此之上，本次探索没有产出任何一条"足够支持安全修改运行时代码"的新增外部根链。**

- 所有追过的候选（孤儿空壳、执行期 Context、`__webpack_require__`、全部 Script、
  `resource_factory` 死代理、Pinia/tab store、`globalPlugin`、动画、事件监听器、
  797 个 array → 791 个 Map → Vue 的 `Dep`/`Link`）**要么切割收益 ≈0，要么只证明了形状而非归属**。
- 剩下的都是"分布式的、无法用一条清理语句解决的"结构（§13.15 的支配树结果：
  11 份 Script 副本 **无一有单一支配者**）。

**这个"分布式"现在有了准确的机制描述（§13.35）**：

| | |
|---|---|
| 全切 9,495 个入口源 | **释放 132.94 MB / 1,709,484 节点** |
| 单切任一类别（含最大的 `Object` 2,234 个） | ≈0（最大 7.63 MB） |
| 入口里 micro-app 框架代码 | **0 条**（§13.34 `microAppIngress = 0`） |

**→ 入口不是"分散得找不到"，而是"冗余"：每一个都单独够得到整个簇。
所以要释放这 74.5 MB，必须同时断开全部 9,495 个 —— 而它们不在框架名下。**

**这解释了为什么前面 9 个候选锚点（孤儿空壳、执行期 Context、`__webpack_require__`、全部 Script、
`resource_factory` 死代理、Pinia/tab store、`globalPlugin`、动画、事件监听器）逐个切割全部 ≈0：
每一个都只是这 9,495 个里的一个子集。**

**因此本轮的动作是：保留现有保护与回归测试，不扩大清理范围。**
具体地：

1. **不**恢复长期编译缓存（§13.16 第 2 条：复用只降低重复编译成本，不消除可达性；反向风险是把残留变永久）。
2. **不**把 `resource_factory` 的 WeakMap 改成 Map（§13.16 第 3 条）。
3. **不**清 Vue 内部的 `Dep`/`Link`/`targetMap`（§13.28：那是响应式系统的核心结构，强行清会破坏运行时）。
4. **保留**已实施的防护与回归测试：Trusted Types 回调隔离、`regeneratorRuntime` 逃逸清理、
   dom7 登记清理、终态动画取消、RAF 跟踪、`resource_factory` 的 scope 释放。
   现有相关测试 **6 套 44 项**（`animation_frame_cleanup` / `terminal_dom_cleanup` /
   `event_target_effect` / `trusted_types_cleanup` / `global_snapshot_cleanup` / `resource_factory`）。
5. **判别标准不变**：同一协议（destroy 路径、4 轮、每轮强制 GC、清 console 句柄）下，
   每销毁轮平均增量**应从 ~110 MB 降到接近 0** 才算通过。当前 **未通过**。

**四、如果将来还要继续，正确的问题是**

不再是"哪条保留链"（那已经被证明是分布式的），而是：
**"为什么一次执行会在堆里留下上万个对自身 Script 的引用，且没有一个支配者"** ——
这指向执行模型本身（每次 `new Function` 一份完整模块图、以及销毁时以什么粒度断开），
而不是某个可以补一条清理的对象。

### 13.30 真实 Tab 协议 + 冷启动对照：结论与前面几节完全不同（2026-09-14）

**协议换了。** 本节用的是 `scripts/real_tab_gc_acceptance.js`（另一处实现）：
**只做真实菜单点击与 Tab 上的 × 按钮**，不注入 `micro-app` 元素、不设 `destroy` 属性、
不调 router/unmount API；用 `globalPlugin.microApp.getActiveApps()/getAllApps()` 验证状态；
把启动时的 WS tab 关闭显式当作 **warm-up 而非第 1 轮**。这修掉了本报告 §13.20 承认的
"`router.push` 不等于点 Tab 关闭"那个问题。

### 真实 Tab × 协议：基本不涨

冷启动（全新 Chrome 进程、独立测试 profile）跑 10 轮：

| label | heapUsedMB |
|---|---|
| login-initial | 24.46 |
| dashboard-initial | 119.31 |
| round-1 | 172.62 |
| round-2 | 173.03 |
| round-5 | 173.42 |
| round-10 | **173.67** |
| logout-final | **93.52** |

**round-1 → round-10 = +1.05 MB / 9 轮 ≈ 0.12 MB/轮，且增量在收敛**
（+0.41 / +0.19 / +0.12 / +0.08 / +0.07 / +0.07 / +0.01 / +0.06 / +0.05）。

同时，§13.11 那一版协议里出现的 **round-2 / round-4 的 240 MB 尖峰在本协议下不复现**
（173.03 / 173.34）—— 那些尖峰是被污染的进程造成的假象，不是真实行为。

### 退出后的残留：**与轮数无关**，是 login/logout 生命周期留下的

| 运行 | 轮数 | login-initial | logout-final | 每循环净增 |
|---|---|---|---|---|
| 冷启动（首跑） | **10** | 24.46 | 93.52 | **+69.06 MB** |
| 同进程第二跑 | **1** | 111.60 | 175.54 | **+63.94 MB** |

**1 轮和 10 轮的净残留几乎相同（63.94 vs 69.06 MB）。**

**结论：**
1. **"退出后剩下的那 90 MB"不是前面重试造成的** —— 1 轮循环留下 63.94 MB，10 轮循环留下 69.06 MB，
   差值 5 MB 与 9 个额外轮次的量级一致（0.12 MB/轮）。
2. **它来自 `login → dashboard → logout` 这个生命周期本身**，每循环约 **64–69 MB**。
3. **而且它在进程内累积**：同一个浏览器进程里，第二次运行的登录页基线
   从 **24.46 MB 涨到 111.60 MB**（+87 MB），并跨导航存活。
   按 §13.11 的教训，这种"干净页基线也在涨"的现象**必须用冷启动对照才能识别**，
   否则会把进程级累积误算成"每轮泄漏"。

### 与本报告前面结论的关系（**必须一起引用**）

| 协议 | 测到的增量 | 说明 |
|---|---|---|
| 本报告 §13.11/§13.17/§13.20（**强制 `destroy` 属性 + `router.push`**） | **~110 MB/销毁轮** | 走的是 `unmount(destroy=true)` → `actionsForCompletelyDestroy()` |
| 本节（**真实菜单 + Tab ×**） | **~0.12 MB/轮** | 走的是 `disconnectedCallback` → `unmount(destroy=false)` → stop |

**两者不是同一个路径，不能互相覆盖，也不能互相否定：**
- **真实用户操作（点 Tab ×）不走 destroy**，那条路径**基本不涨**；
- **destroy 路径确实会累积 ~110 MB/轮**，但本次的新协议**没有触发它**；
- 因此 §13.11 的 110 MB/轮 **仍然成立，但它的前提是"强制 destroy"** ——
  而真实产品在什么条件下会走到 destroy（登出？切实体？超时？）**本轮没有测**。

### 已知的实现局限（如实记录）

- 该脚本的登录用 `Input.insertText`，**在冷启动首次加载时会超时失败**（实测两次）。
  热态下正常。本次冷启动对照是用外部脚本先手动登录、再让脚本从已登录状态继续完成的。
- `Runtime.getHeapUsage` 的 `usedSize` 与 `heap_metrics.js` 的 `heapSelfMB` **口径不同**，
  本节数字不能与 §13.4~§13.20 的表直接相减。

### 13.31 诊断：为什么登出后回不到初始水平（2026-09-14）

**问题**：冷启动干净的登录页是 **24.46 MB**，登出后是 **93.52 MB**。差的约 69 MB 是什么？

**方法**：用 codex 脚本在端点自动保存的两份快照做 diff ——
`E:/heap-real-tab-cold2/login-initial.heapsnapshot`（冷进程、全新登录页）对
`E:/heap-real-tab-cold3/logout-final.heapsnapshot`（同一冷进程、登录→dashboard→10 轮 Tab×→登出）。

### 差的 105.8 MB（按快照 self 口径）由三块组成

| 块 | 大小 | 性质 |
|---|---|---|
| **A. 基座 SPA 自己的功能模块** | xlsx 10.29 + jsoneditor 3.57 + sourcemap 1.40 + 基座模块若干 ≈ **20 MB** | **SPA 正常行为**：访问 dashboard 会懒加载这些，登出不会卸载它们 |
| **B. WS 子应用 bundle（两份）** | 包裹态 **22.41 MB**（堆内 string）+ 原始态 **22.41 MB**（Blink 外部串） + app 包 2.46×2 | **micro-app 相关，且未被释放** |
| **C. WS 的编译产物** | InstructionStream 3.36 + BytecodeArray 2.73 + Object 2.72 + `(object properties)` 3.40 + closure/ScopeInfo… ≈ **20 MB** | 同上 |

**A 是 SPA 的固有行为，不是 micro-app 的问题**（一个 SPA 登出不会卸载已加载的 JS 模块）。

### micro-app 相关的部分（B + C ≈ 45–50 MB）：**一次也没被释放**

登出后：

```
globalPlugin.microApp.getAllApps()  →  []            （框架认为应用已经没了）
heap_scripts_by_url 结果：
   Script 总数 32   不同 URL 2   源码合计 24.9 MB
   x 1  22.41 MB  引用=40,685   ws.dev/…/chunk-vendors.a695a4d2.js
   x 1   2.46 MB  引用= 1,509   ws.dev/…/app.ac339412.js
```

**整个 WS 子应用的模块图还在**：源码（包裹 + 原始两份）、**40,685 个 `SharedFunctionInfo`**、
63 个 `sliced string` 视图、InstructionStream、闭包（`value` / `default` / `setup` / `validator`）。

持有结构（对 22.41 MB 那份追反向入边）：

```
depth 1:  63 × sliced string   +   1 × system / Script
depth 2:  40,801 条 —— 8,584 个 SharedFunctionInfo + setup/value/Z/t/e/a/l…
depth 3:  (constant pool) / closure value / (anon) / default / validator / setup / FeedbackVector / InstructionStream
```

**与本报告 §4.1 记录的结构完全一致** —— 源码被 Script 与切片视图持有，Script 被整套 SFI 持有，
SFI 被模块图的闭包持有。**没有单一支配者**（§13.15 的支配树结果）。

### 一条对比线索：**SES2 被释放了，WS 没有**

本次登录期间 `getActiveApps()` 同时包含 `wonder-ws-web` 与 `SES2-Component-*` 三个。
**登出后堆里只剩 ws 的 2 个 URL，SES2 一个都没有。**

两者的差别是：**SES2 的三个元素带 `keep-alive` 属性，`wonder-ws-web` 不带。**
这条对比**只是观察，不是结论** —— 本次没有做"带/不带 keep-alive"的对照实验，
也没有排除"WS 更大 / 挂载次数更多 / 菜单路径不同"这些混淆因素。
但它是一个**具体的、可检验的**下一步方向。

### 结论

1. **登出后的残留不等于"泄漏累积"**：10 轮 Tab 开关只涨 1.05 MB（§13.30），
   而残留是**一份从未被释放的 WS 模块图**（约 45–50 MB）+ SPA 自己的懒加载模块（约 20 MB）。
2. **框架的簿记是干净的**（`getAllApps()` 为空），**但代码没被释放** ——
   这仍然是 §13.29 说的那个问题：可达性是分布式的，没有单点可清。
3. **本次没有产出可安全实施的修改点**（与 §13.29 一致）。
   唯一新增的可检验方向是上面那条 **keep-alive 对比**，但它需要一组对照实验，本轮未做。

### 13.32 销毁时机对照实验：**§13.11 的 110 MB/轮 不是产品路径**（2026-09-14）

**起因**：§13.30 发现真实 Tab 协议下每轮只有 ~0.12 MB，而 §13.11 用 `router.push` + 强制 `destroy`
属性测到 ~110 MB/轮。两者都声称走 destroy，差 1000 倍，必须隔离出变量。

**代码依据（先查实触发机制）**：

- 元素被移除 → `disconnectedCallback()` → `handleDisconnected()`（**destroy 默认 false**）
  → `MicroAppElement.unmount(false)` → `createApp.unmount({destroy: getDestroyCompatibleResult()})`；
  **`destroy` 只来自元素上的 `destroy` 属性**。
- **`appInstanceMap.delete` 全仓只有一处**（`create_app.ts:870`，在 `actionsForCompletelyDestroy` 内）
  → **`unmount(false)` 只是 stop，实例仍留在 `appInstanceMap`**。
- 因此**下一次同名挂载**时，`micro_app_element.ts:388` 发现 `oldApp` → **`oldApp.actionsForCompletelyDestroy()`**。
  **这条不看 `destroy` 属性。**

**所以"关 Tab 后重开"和"退出登录"最终都会 destroy，区别只是时机。**

### 实验设计（同一应用、同样 4 轮，只改一个变量）

给 `real_tab_gc_acceptance.js` 加了一个**显式 opt-in** 的 `--destroy-attr=on`：
在点 Tab × **之前**给 4 个目标元素加 `destroy` 属性，把销毁**提前到卸载时**。
其余全部不变（真实菜单点击、真实 Tab ×、同一页面、同一等待）。

### 结果

| 臂 | 驱动方式 | `destroy` 属性 | 每轮增量 | 销毁实例堆积 |
|---|---|---|---|---|
| **真实流程**（§13.30 cold3，`heapSelfMB`） | 真实菜单 + Tab × | 否 | **0.13 MB/轮** | `destroyed` 全程 **0** |
| 臂 B（`usedSize`） | 真实菜单 + Tab × | 否 | 0.26 MB/轮 | — |
| 臂 A（`usedSize`） | 真实菜单 + Tab × | **是**（每轮 4 个全打上） | **0.24 MB/轮** | — |
| 臂 C（`heapSelfMB`） | `router.push` | 否 | **5.5 MB/轮** | `destroyed` 全程 **0** |
| **§13.11**（`heapSelfMB`） | `router.push` | **是** | **110.5 MB/轮** | **`destroyed` 0→1→2→3 堆积** |

**臂 A vs 臂 B：销毁时机本身没有影响**（0.24 vs 0.26，噪声内），且干预确实生效
（日志里每轮都打印了打标的 4 个应用名）。

**但臂 C vs §13.11 差 20 倍**（5.5 vs 110.5），而它们的区别就是 `destroy` 属性。

### 结论：需要**两个条件同时成立**

**§13.11 的 ~110 MB/轮 只在"`router.push` 直接驱动路由 **且** 强制 `destroy` 属性"时出现。**

- 只在真实操作下 → **0.13–0.26 MB/轮**（加不加 `destroy` 都一样）
- 只用 `router.push` 不加 `destroy` → **5.5 MB/轮**
- 两者都有 → **110.5 MB/轮**

**机制**：`destroyed` 实例的堆积。
真实流程全程 `destroyed = 0`；§13.11 是 `0→1→2→3`。
**"绕过 tab 系统直接驱动路由"会让基座（Vue）的 tab 状态与 DOM 不同步，
此时再提前 destroy，就会产生"已销毁但仍被基座引用"的实例，并逐轮堆积。**

### 这对前面结论的影响（**必须一起引用**）

| 结论 | 现状 |
|---|---|
| §13.11 / §13.17 / §13.20 的 **~110 MB/轮** | **降级为"非产品路径"** —— 它需要 `router.push` 直接驱动这个前提，真实操作不满足 |
| §13.30 的 **0.13 MB/轮** | **这是产品路径上的真实数字** |
| §13.4「每销毁一个应用多留一份完整 bundle 源码 + 整套编译产物」 | **仍然成立**，但它是"已销毁且仍被引用"状态下的构成，不是产品路径的每轮行为 |
| 「真实 Tab × 不泄漏、强制 destroy 泄漏」 | **更正为**：真实 Tab × 不泄漏；**强制 destroy + 绕过 tab 系统**才泄漏 |
| §13.31 的登出残留（≈45–50 MB） | 不受影响 —— 那是**单次**残留，不是每轮累积 |

**度量口径提示**：臂 A/B 用 `Runtime.getHeapUsage().usedSize`，臂 C/§13.11/真实流程的
`heapSelfMB` 来自快照节点 self_size 之和，**两者绝对值不可比**；上表的比较只在同一口径内成立。

### 仍然成立的、最该关注的一条

**真实操作下**（0.13 MB/轮）与**真实登出**（一次性 ≈45–50 MB 的 WS 模块图残留，§13.31）
仍然存在，且 §13.31 已证明**框架簿记当时是全空的** ——
所以那部分**不是框架能靠加清理解决的**（§13.29 的结论不变）。

### 13.34 推到底：WS 残留 74.5 MB 的入口里**没有一条是 micro-app**（2026-09-14）

§13.33 把"谁钉住那 45–50 MB"收窄到"**子应用自己 Vue 运行时 + 模块图的闭环（11 条边 / 7 个持有者）**"。
本节用 `heap_grow_boundary` 从那两个存活的 Vue 应用对象出发，把边界推到收敛。

### 推进过程

```
round  1: cluster=    141             ingress=      7 / 7 源
round  2: cluster=  9,549             ingress=    128
round  3: cluster= 24,878             ingress=    332
round  4: cluster= 698,477 / 48.1 MB  ingress=      2      ← 内部引用被吸收
round  6: cluster= 698,548 / 70.8 MB  ingress=      1 / 1 源
round 13: cluster= 698,625 / 70.8 MB  ingress=      2
round 18: cluster= 705,502 / 71.3 MB  ingress=    406
round 19: cluster= 731,456 / 74.5 MB  ingress=  9,611 / 9,495 源
round 19: ingress reaches synthetic GC-root nodes
```

（round 6–13 的"1~2 条"是**逐级吸收的暂态前沿**，不是终点 —— 每轮吸收上一层后会露出新的，工具在第 19 轮才接到根。）

### 收敛后的入口构成

| 项 | 值 |
|---|---|
| cluster | **731,456 节点 / 74.5 MB**（boundary 1,294 节点） |
| ingress | **9,611 条边 / 9,495 个来源** |
| **`syntheticIngress`** | **16** —— 且全部是同一目标：Blink 全局句柄（`blink::ScriptStateProtectingContext::context_`）→ **基座 NativeContext #3690**（页面的根，非应用特定） |
| **`microAppIngress`** | **0** —— ⚠️ **micro-app 框架的闭包一条都不在入口里** |
| `baseClosures` | 20 组 |

按类别：

| 条数 | 类别 |
|---|---|
| **2,242** | `object Object` |
| **1,136** | **`closure (anon)` ← `BASE(localhost:3000)`** |
| 331 | `closure resolve` |
| 78 / 49 / 34 | `array (anon)` / `closure toJSON` / `object Set` |
| 33 / 32 / 31 / 29 / 29 / 28 | `close` / `Context scope` / `get length` / `keys` / `toString` / `entries` |

### 切割验证（§13.35，本节结论的必要补充）

本节只给出了"入口是这 9,495 个源"。**§13.35 做了切割验证**，结果改变了对它的解读：

```
全切 9,495 个源   →  释放 132.94 MB / 1,709,484 节点（baseline 170.7 MB → 37.8 MB）
单切任一类别      →  ≈0（最大的 `Object` 2,234 个也只释放 7.63 MB）
```

**→ 这 9,495 个入口是并行冗余的**：每一个都单独够得到整个簇，只有全部移除才断得开。
**所以"入口有 9,495 个"这句话的准确含义不是"分散"，而是"冗余"。** 详见 §13.35。

### 结论

**把这 74.5 MB 的 WS 残留推到根之后，入口是：**
1. **基座应用自己的活对象图**（2,242 个 `Object` + 1,136 个基座 `(anon)` 闭包 + 一批集合/迭代器方法）；
2. **页面的 NativeContext**（16 条 Blink 全局句柄，是所有 JS 的根，与应用无关）。

**而 `microAppIngress = 0`：入口里没有任何一条来自 micro-app 的框架代码。**

这与 §13.31 的簿记全空互相印证 —— **框架确实已经放手了**，但子应用的模块图仍然被**基座应用的对象图**接着。

**所以"能不能解决"的答案现在有了机制层面的依据：**

| 事实 | 出处 |
|---|---|
| 框架簿记全空（0 CreateApp / 0 parsedCode / 0 URL 标记） | §13.31 |
| 入口里 0 条 micro-app 代码 | §13.34 |
| 子应用自己的 Vue 应用对象还活着，4 跳够得到源码 | §13.33 |
| 入口是基座应用自己的 ~9,000 个对象 | §13.34 |

**要解决，必须动的是「子应用自己的运行时」或「沙箱隔离方式」，而不是 micro-app 里的某条清理语句** ——
micro-app 侧已经没有可清的对象了（§13.29 的结论不变，但现在有了机制证据）。

而 §13.35 进一步说明**为什么"清一条"永远不够**：入口是**冗余**的，要释放这 74.5 MB
必须**同时**断开全部 9,495 个，而它们**不在框架名下**。

### 限定（不要越过）

- 工具日志自己写了 `9494 non-synthetic sources remain (not necessarily a complete boundary)` ——
  **这是"接到了一些 GC 根"，不是"边界已完备"**（§13.28 的限定同样适用）。
- 9,495 个来源里，**没有区分哪些属于本次会话、哪些是页面本来就有的**；`BASE(localhost:3000)` 那 1,136 个
  也可能是基座应用的正常长期状态。
- 这是**可达性**分析，**没有做切割验证** —— 按本轮反复出现的规律，切断其中任一部分很可能仍是 ≈0。

### 13.35 切割验证：9,495 个入口是**并行冗余**的（2026-09-14，**本轮最关键的机制结论**）

§13.34 把 WS 残留推到根，得到 9,495 个入口源。本节做切割验证。

### 全切 → 释放 133 MB

```
baseline : 170.7 MB / 1,988,000 节点
afterCut :  37.8 MB /   278,516 节点
释放     : 132.94 MB / 1,709,484 节点        ← 占全堆 74.5%
```

**这是整场调查里第一次出现大额切割收益。** 被释放的头部正是那些 bundle：

| 数量 | 大小 | 内容 |
|---|---|---|
| 4,059 | **42.43 MB** | `system / ExternalStringData`（Blink 侧外部串） |
| **2** | **24.87 MB** | `(function anonymous…)` **WS 包裹源码**（22.41 + 2.46） |
| 13,707 | 6.01 MB | `array (object properties)` |
| 4,887 / 16,653 | 4.08 / 3.75 MB | `InstructionStream` / `BytecodeArray` |
| 94,832 | 3.22 MB | `object Object` |

### 单切每一类 → 全部 ≈0

| 类别 | 数量 | 释放 |
|---|---|---|
| 基座 `closure (anon)` | 1,144 | **0.01 MB** |
| `object Object` | 2,234 | **7.63 MB** |
| `closure resolve` | 331 | 0.06 MB |
| `array (anon)` | 52 | 0.00 MB |
| `closure toJSON` | 49 | 0.00 MB |
| `object Set` | 34 | 0.00 MB |

最大的单一类别（`Object`，2,234 个）也只释放 7.63 MB —— **离 133 MB 差 17 倍。**

### 补充验证：把"掉下来的尾巴"也切掉，看会不会露出新的

切 1,144 个基座闭包时，只掉下 **148 个节点**。这 148 个是「**只有通过这 1,144 个才可达**」的尾巴，
所以再切它们可以检验一件具体的事：**切掉一个入口之后，它独占的那点尾巴里会不会藏着下一个入口？**

（为此给 `heap_exclusive_size.js` 加了 `dumpLost:<file>`，把"因此不可达"的节点号导出。）

**这 148 个是什么**（合计 0.01 MB，纯结构性，无业务内容）：

| 数量 | 内容 |
|---|---|
| 15 | `closure setMenuSetting` |
| 3 | `closure clear` |
| ~100 | 闭包作用域（`Context / scope @326055 / @1314273 / @325867 / @325897 / @322391 / @424733 / @427019`…） |
| 2 | `system / WeakArrayList` |
| 4 / 5 / 3 | `DescriptorArray` / object shape `Map` / `PropertyArray` |

**切割结果：**

| 切什么 | 释放 |
|---|---|
| 1,144 个基座闭包（单独） | 0.01 MB / 148 节点 |
| 那 147 个尾巴（单独） | 0.005 MB / 48 节点 |
| **1,144 + 147 合并（1,292 个）** | **0.008 MB / 148 节点** |

**合并切与单独切 1,144 个完全等价** —— 因为那 147 个本来就只有通过这 1,144 个才可达，
补切它们**一点额外收益都没有**。

**这正面确认了「并行冗余」的机制：**

> 切掉一个入口，**只掉它独占的那点尾巴**（这里是 148 个节点 / 0.01 MB）；
> **主体（74.5 MB）仍被其余 8,351 个入口接着。**
> 所以逐层剥离是**结构性无效**的 —— 不会"越剥越少"，只会一层层掉下无关紧要的碎片。

对照：

| 切割 | 释放 |
|---|---|
| 1,144 个基座闭包 | 0.01 MB |
| + 它们的 147 个尾巴 | 0.008 MB（**无额外收益**） |
| **全部 9,495 个入口** | **132.94 MB** |

### 结论：入口是**并行冗余**的

**全切释放 133 MB，单切任一类 ≈0** —— 唯一自洽的解释是：

> **这 9,495 个源是"冗余入口"：每一个都单独够得到整个簇，所以移除任意一个（或任意一类）
> 都释放不了东西；只有把它们**全部**移除，簇才断开。**

这与 §13.15 的支配树结果（11 份 Script 副本**无一有单一支配者**）**完全一致**，而且现在有了机制解释：

**不是"找不到根"，而是"根有 9,495 个，且彼此冗余"。**

### 这对整场调查的意义

**之前所有"找一个入口再切断"的尝试全部 ≈0，不是方法错了，而是问题本身的性质就是这样** ——
前面 9 个候选锚点（孤儿空壳、执行期 Context、`__webpack_require__`、全部 Script、`resource_factory`
死代理、Pinia/tab store、`globalPlugin`、动画、事件监听器）**每一个都只是这 9,495 个里的一个子集**，
所以收益必然是 ≈0。

**而这也解释了为什么"加一条清理"永远不够**：要释放这 74.5 MB，
必须同时断开**全部 9,495 个**引用 —— 这在框架侧做不到，因为它们**不在框架名下**
（§13.34：`microAppIngress = 0`，入口里没有一条 micro-app 代码）。

### 限定

- `heap_exclusive_size` 的语义是"忽略这些节点的出边后，从根不可达的部分"。
  **133 MB 是"这些入口被移除后可释放的上界"**，不等于"线上能释放这么多"。
- 9,495 个源里**没有区分**哪些属于本次会话、哪些是页面本来就有的；
  其中 `BASE(localhost:3000)` 的那些（1,136 个 `(anon)` 闭包等）也可能是基座应用的正常长期状态。
- 工具日志写了 `9494 non-synthetic sources remain (not necessarily a complete boundary)` ——
  **"全切释放 133 MB"说明这一轮的入口集合是自洽的**，但不排除还有别的、这一轮没吸收到的入口。

### 13.36 残留是**可释放的** —— 且 §13.30 的"同进程累积"很可能是 BFCache（2026-09-14）

用 `scripts/_diag_usage.js`（导航 → 强制 GC ×2 → 报 `Runtime.getHeapUsage().usedSize`）
在同一进程内连续测量：

| 步骤 | usedMB |
|---|---|
| `/wd/ws`（6 个应用在挂载） | 266.47 |
| → **文档级导航**到 `/login` | **285.51** |
| → 再导航到 `/login` | **285.45** |
| → 导航到 `about:blank` | **0.4** |
| → 再导航到 `/login` | **24.58 / 24.56 / 24.57** |

（冷启动进程的登录页是 24.46 —— **与最后一行一致**。）

### 两条结论

**1. 残留是可释放的。** `about:blank` 之后整个 285 MB 归零，重新加载登录页只有 24.5 MB。
**所以 §13.31 / §13.34 那 45–50 MB 的 WS 模块图不是"永远收不回"的** ——
文档被销毁、且不重新加载 SPA 时，它会被完整回收。

**2. 但"从 `/wd/ws` 直接导航到 `/login`"没有释放它（285 MB）。**
最可能的解释是 **Chrome 的 BFCache**：同源整页导航会把上一个文档整体保留在
back/forward cache 里，**连同它的整个 JS 堆**。`about:blank` 那一步把 BFCache 条目挤掉，
之后测量就回到了干净值。

**这条解释如果成立，§13.30 的一个观察要重新解释**：

> 原文写的「同进程内"干净页基线"会累积（24.46 → 93 → 245 MB），**评估必须以冷启动为基准**」

那个递增**很可能不是 micro-app 的累积，而是每次运行结束时留了一个 BFCache 条目**。
`about:blank` 之后基线立刻回到 24.5，说明**没有进程级累积**。

**状态：BFCache 是当前最自洽的解释，但本轮没有直接验证**（需要关掉 BFCache 重测，
例如启动 Chrome 时加 `--disable-features=BackForwardCache`）。**不要当成已证事实引用。**

### 这对"怎么解决"的意义

| 层次 | 可行性 | 证据强度 |
|---|---|---|
| **登出时做文档级跳转，并让旧页面进不了 BFCache**（`location.replace()` + 应用页 `Cache-Control: no-store`） | 高 —— 基座侧改动 | **最强**：`about:blank` 后完全归零 |
| 子应用侧纪律（unmount 时销毁自己的运行时） | 中 | 未验证（§13.33 显示 `app.unmount()` 已执行、组件树已释放） |
| iframe 沙箱试点（减少同 realm 跨引用） | 中 | 未验证 |
| **框架侧加清理** | **无解** | §13.31 簿记全空、§13.34 入口 0 条框架代码 |

### 13.37 受控对照：demo（同代码、同模式）**完全干净** —— 排除 micro-app 与沙箱模式（2026-09-14）

用户提供了本地可控的 `E:/work/microapp-demo`（`localhost:5000`，`main-app` + `sub-app1/2/3`）。
它的 `package.json` 依赖指向**本仓库**（`d.ts` 里写明 `@micro-zoe/micro-app` → `E:/work/micro-app`），
所以这是同一份被测代码。关闭路径是**显式 destroy**：

```ts
// main-app/src/composables/useTabs.ts
if (remainingForApp.length === 0) {
  nextTick(() => { unmountApp(tab.appName, { destroy: true }).catch(() => {}) })
}
```

驱动脚本 `scripts/_diag_demo_rounds.js`：每轮 `router.push('/appN/')` → 等 `micro-app-body` 有子节点
→ 点 tab 的关闭按钮 → 等 tab 消失 → GC ×2 → 量 `getHeapUsage().usedSize`。

### 结果一：destroy 路径**没有残留**

| label | usedMB | Δ |
|---|---|---|
| init | 6.77 | |
| round-1 | 8.54 | +1.77（首次加载） |
| round-2 | 8.65 | +0.11 |
| round-3 | 8.82 | +0.17 |
| round-4 | 8.93 | +0.11 |
| round-5 | 9.03 | **+0.10** |

每轮结束时 `tabs=0`、`microApps=0`、`apps=[]`。**快照验证：**

```
Script 总数 2   不同 URL 0   源码合计 0.00 MB
```

**一个子应用 bundle 都没有留下。** 对照业务应用登出后的
「1 份完整 WS bundle（2 个副本）+ 40,685 个 SFI」。

### 结果二：`iframe` 与 `with-sandbox` **没有区别**

把 `main-app/src/micro-app.ts` 的 `iframe: true` 改成 `false`（with-sandbox，与业务应用同模式）
重跑同一套：

| | `iframe: true` | `iframe: false` |
|---|---|---|
| init | 6.77 | 15.41 |
| round-5 | 9.03 | 16.23 |
| **每轮增量** | **+0.11 / +0.17 / +0.11 / +0.10** | **+0.09 / +0.16 / +0.10 / +0.09** |

**每轮残留速率完全相同。**（实验后已把 `iframe` 改回 `true`。）

### 这两条排除了什么

| 候选 | 状态 |
|---|---|
| **micro-app 的清理逻辑有 bug** | **排除** —— 同一份代码、显式 destroy，demo 零残留 |
| **sandbox 模式（iframe vs with-sandbox）** | **排除** —— 两种模式每轮速率相同（~0.1 MB/轮） |
| **destroy 路径本身会留残留** | **排除** —— demo 走的就是 destroy，零残留 |

**剩下的差异只可能在基座应用**：

| | demo | 业务应用 |
|---|---|---|
| 子应用 bundle 残留 | **0** | 1 份完整 WS bundle（2 副本）+ 40,685 SFI |
| 关闭方式 | `unmountApp(name, {destroy:true})`（显式 API） | Tab × → `disconnectedCallback` → stop |
| 入口来源（§13.34） | 不适用（无残留） | **基座应用的 ~9,495 个对象**（`microAppIngress = 0`） |

**→ 与 §13.34 一致：残留是被基座应用自己的对象图接着的。demo 的基座不持有子应用对象，业务应用的基座持有。**

### 对"怎么解决"的修正

§13.36 里列的三个方向，现在要划掉一个：

| 方向 | 修正后 |
|---|---|
| ~~iframe 沙箱试点~~ | **排除**（本节 A/B：两种模式速率相同） |
| 登出做文档级跳转 + 避开 BFCache | 仍成立（§13.36 的 `about:blank` 证据） |
| 子应用侧纪律 | 仍待验证 |
| **基座应用不再持有子应用对象** | **新增，且证据最强** —— demo 与业务应用的唯一实质差异就在这里 |

### 13.38 demo 上加持有模式：**没能复现，且撤回一次过早的结论**（2026-09-14）

在 demo 上试了两种「基座持有子应用对象」的模式，想复现业务应用的残留。

**模式 A：基座持有子应用的 DOM 元素**（对应 §13.21 的 10,221 个游离子应用 DOM）。

在 `handleMicroAppMounted` 里把子应用 `micro-app-body` 的前 3 个子元素存进一个模块级数组、永不清理：

| label | usedMB | Δ |
|---|---|---|
| init | 20.96 | |
| round-1 | 25.28 | +4.32 |
| round-3 | 27.14 | +4.46 |
| round-4 | 31.76 | +4.62 |
| round-5 | 36.35 | **+4.59** |

**当时看起来复现了**（单调 +4.6 MB/轮，且每轮 `apps=[]` 与业务应用一致）。
快照显示增长全是 `system / ExternalStringData`（4.663 MB ×2、2.510 MB ×8…），
而 `Script 总数 2 / 不同 URL 0` —— **JS 侧无 Script 残留，增长全在 Blink 侧**，
与 §13.31 业务应用的 42 MB `ExternalStringData` 同类。

**但对照推翻了它：**

1. **在 `closeTab` 里清空那个数组 → 增长照旧**（`window.__heldChildNodes.length` 实测为 0，确认清理执行了）。
2. **把模式 A 完全移除、文件恢复到 HEAD → 增长照旧**：

| label | usedMB | Δ |
|---|---|---|
| init | 15.82 | |
| round-1 | 15.58 | |
| round-2 | 12.97 | |
| round-3 | 17.61 | +4.64 |
| round-4 | 18.73 | +1.12 |
| round-5 | 23.32 | +4.59 |

**所以 +4.6 MB/轮与模式 A 无关。** 而**最早那次干净跑（刚启动 Chrome）是 6.77 → 9.03、~0.1 MB/轮**。

**结论：增长取决于进程状态，不取决于那两段代码。**
最可能是我这套 demo 驱动的**测量时机**问题 —— `closeTab` 里 `unmountApp` 是异步的，
`--settle=1500ms` 在进程已经变重的后续轮次里可能不足以等到销毁完成，
于是把"还没销毁完"读成了"没释放"。

**因此：**

- **§13.37 的"demo 零残留"结论仍然成立**（那是刚启动的进程，5 轮 6.77 → 9.03、源码 0 MB）。
- **但本节不能声称"复现了业务应用的残留"** —— 撤回。
- **demo 这条路要能用，必须先修测量**：把 `--settle` 调到秒级并**等待 `getAllApps()` 为空**再测量，
  或者每轮之间做一次文档级导航把上一轮的状态清掉。
- **副作用已清理**：`TabContainer.vue` / `useTabs.ts` 已与 HEAD 完全一致
  （过程中我的还原脚本曾多插入一个孤立 `/**` 导致 demo 编译报错，已定位并删除）；
  `main-app/src/micro-app.ts` 里剩下的 `window.microApp = microApp` 是**用户原有的**调试钩子，未动。

### 13.39 demo 的 +4.6 MB/轮**不是 micro-app 的泄漏，是 Vite dev-server 的产物**（2026-09-14）

§13.38 撤回"复现"之后，先修测量再判因。

**第一步：修测量。** `_diag_demo_rounds.js` 不再靠固定 sleep 断言"已释放"，
改成**等 micro-app 自己的注册表里不再有该应用**（`!window.microApp.getAllApps().includes(name)`，
30 s 超时）再 GC 测量。

**第二步：修完之后基线**仍然**在涨**（`apps: []` 每次为空，即销毁确实完成了）：

| 运行 | init | round-5 | 趋势 |
|---|---|---|---|
| 第 1 次 | 15.90 | 31.28 | +3.1/轮 |
| 第 2 次 | 20.54 | 32.43 | +2.4/轮 |
| **强制新文档后**（`about:blank` → demo） | **5.33** | **18.21** | **+4.59/轮** |

**第三步：新文档后仍涨，就抓快照看构成。**

```
Script 总数 2   不同 URL 0   源码合计 0.00 MB     ← 没有任何子应用 bundle
```

按类型：`native` 19.95 MB（96397 个）；按名字：**`system / ExternalStringData` 16.26 MB / 355 个**。

**追它的持有者：**

```
depth 1: string  "import \"/node_modules/.vite/deps/@babel_runtime...\""
         string  "import { Comment, Fragment, NOOP, Teleport } ..."
depth 2: 150 × sliced string
         3 × Script  http://localhost:5000/node_modules/...
         3 × Script  http://localhost:5000/@fs/E:...
```

**涨的是基座应用（`localhost:5000`）自己的 Vite dev-server 模块源码**，
被 `Script` 持有。

**结论：这是 Vite 开发服务器的产物，不是 micro-app 的泄漏。**
Vite 每次会给模块 URL 追加新的 `?t=<时间戳>`，于是每轮都拉一份"新"模块、编译出一个新 Script
并留下它的源码。这也解释了为什么**最早那次刚启动 Chrome 的干净跑是平的（~0.1 MB/轮）**——
那时 dev server 还没有换代它的模块 URL。

**对 demo 这条路线的判定：**

| 项 | 状态 |
|---|---|
| §13.37「demo 干净」 | **仍成立**（刚启动进程、5 轮 6.77 → 9.03、子应用源码 0 MB） |
| 用 demo 做「每轮残留」的定量测量 | **不可用** —— 除非**关掉 HMR 或用生产构建**跑基座，否则 Vite 的模块换代会把噪声（+4.6 MB/轮）盖过真实信号（~0.1 MB/轮） |
| 上持有模式复现业务应用残留 | **本轮未能进行** —— 信号被噪声淹没，先要解决构建方式 |

**要把 demo 用起来，前置条件是其中之一：**
1. 基座用 `vite build` 的产物（生产构建，无 HMR）；
2. 或启动 dev server 时关掉 HMR（`server.hmr: false`）；
3. 或每轮之间做一次 `about:blank` 往返（能清掉文档级状态，但**清不掉 dev server 那侧**）。

### 13.40 关掉 HMR 后：噪声源不是时间戳，**是基座模块被重复执行**（2026-09-14）

按 §13.39 的建议，在 `main-app/vite.config.ts` 关掉 HMR（`server.hmr: false`），
整页换新文档后重跑基线：

| label | usedMB | Δ |
|---|---|---|
| init | 5.32 | |
| round-1 | 10.65 | +5.33 |
| round-2 | 8.03 | −2.62 |
| round-3 | 12.63 | +4.60 |
| round-4 | 13.78 | +1.15 |
| round-5 | 18.37 | **+4.59** |

**和关之前完全一样。** 所以 §13.39 把它归因于"Vite 给模块 URL 加 `?t=` 时间戳"是**不对的**。

**直接看 Script 节点名（名字里带 URL）：**

```
blink::ScriptResource                     ×10
JSModuleScript                            ×63
system / Script / http://localhost:5000/node_modules/.vite/deps/chunk-…   ×6
system / Script / http://localhost:5000/src/components/TabContainer.vue   ×6
含 ?t= 时间戳的条目：0            ← HMR 关掉后确实没有时间戳了
```

**`?t=` 确实消失了，但每个基座模块仍有 6 份 Script —— 正好是 init + 5 轮。**

**→ 真正的机制：每挂载一次子应用，基座应用自己的模块图就被重新执行一遍**，
产生一份新的 `system / Script` 并留下它的源码（`ExternalStringData`，每份 ~4.6 MB 里的大头）。

**这条与 micro-app 有关**（挂载子应用触发），但**不是"子应用没被释放"** ——
被重复创建的是**基座自己的模块**。

### 现状与限定

- **§13.37「demo 干净」的结论仍成立**（那次测的是子应用 bundle：0 MB）。
  **但"demo 能作为干净基线"这个前提不成立** —— 它每轮自己涨 4.6 MB。
- **本轮没有定位到"为什么基座模块会被重复执行"**。观察到的是"次数 = 挂载次数"，
  最可能是 iframe/沙箱创建时对模块图的某种重新求值，但**未验证**。
- `main-app/vite.config.ts` 的 `hmr: false` **暂时保留**（它是排除时间戳噪声的必要条件，
  且已确认不是噪声源）。要还原随时可回退。
- **在这一条查清之前，用 demo 上持有模式仍然是"把 4.6 MB 的基座噪声读成泄漏"** ——
  与 §13.38 撤回的那个错误是同一类。

### 13.41 更正 §13.40：副本数跟**页面加载次数**走，不跟轮数走（2026-09-14）

§13.40 由"每个基座模块有 6 份 Script = init + 5 轮"推出
"每挂载一次子应用，基座模块图就被重新执行一遍"。**这个推断不成立。**

把那一轮的 Script 名字**完整**列出来（不截断）：

```
×6  system / Script / http://localhost:5000/node_modules/.vite/deps/chunk-…
×6  system / Script / http://localhost:5000/src/components/TabContainer.vue
×3  system / Script / http://localhost:5000/src/main.ts
×3  …/src/App.vue            ×3  …/src/router/index.ts       ×3  …/src/micro-app.ts
×3  …/.vite/deps/vue.js      ×3  …/.vite/deps/element-plus   ×3  …/.vite/deps/vue-router
×3  …/.vite/deps/@babel…     ×3  …/@vite/client              ×3  …/image.png?import
×3  …/@fs/E:/work/micro-app/lib/index.esm.js      ×3  …/src/composables/useTabs.ts
×3  …/src/App.vue?vue&type=style&index=0 …
```

**除那两个 ×6 之外，其余全部 ×3** —— 而这次会话里 demo 页被**整页加载过 3 次**。

**→ 副本数跟"页面加载次数"走，不跟"轮数"走。**
（那两个 ×6 是同一模块在一次加载里被引用两次，与轮次无关。）

**因此 §13.40 的结论"每挂载一次子应用 → 基座模块图被重新执行"作废。**

### 现在的状态：demo 的 +4.6 MB/轮**仍未归因**

已经排除的：

| 候选 | 怎么排除的 |
|---|---|
| 子应用 bundle 残留 | 快照 `Script 总数 2 / 不同 URL 0`（§13.39） |
| Vite 的 `?t=` 时间戳 | 关掉 HMR 后 `?t=` 归零，基线不变（§13.40） |
| 基座模块被按轮重复执行 | 副本数跟加载次数走，不跟轮数走（本节） |
| 模式 A（基座持有子应用 DOM） | 移除后照旧涨（§13.38） |
| 测量时机（destroy 未完成） | 改成等 `getAllApps()` 再量，照旧涨（§13.39） |

**剩下未查的**：那 16.26 MB / 355 个 `system / ExternalStringData` 到底被谁持有
（§13.39 追到的持有者是 `Script`，但那些 Script 的副本数只跟加载次数走，解释不了每轮增长）。
**下一步应该直接从这 355 个 ExternalStringData 里取几个，追它们的完整入边。**

### 对整体进度的意义

**demo 这条路线到此还没能提供一个可用基线**，因此**持有模式的复现实验仍然没能开展**。
在 demo 的每轮增长归因清楚之前，用它测出来的任何"持有模式造成的增长"都无法与这 4.6 MB 区分。

### 13.42 找到了：**每挂载一次子应用，基座的每个 ES 模块就多一份 Script**（2026-09-14）

§13.41 用 `heap_scripts_by_url` 看 demo 时得到"子应用 Script 一个都没有"，
进而怀疑跨源 iframe 走了独立进程。**两个判断都不对 —— 是工具漏了一半。**

**工具 bug（已修）**：`heap_scripts_by_url.js` 早先要求节点名**恰好等于** `system / Script`，
但实际的 Script 名字有两种形态：

```
system / Script                  —— 无 source_url
system / Script / <url>          —— **URL 直接拼在名字里**（模块脚本走这条，没有 source_url 边）
```

只匹配前者 → **121 个 Script 里只认出 2 个**。修法两处：
1. 名字改成**前缀匹配** `system / Script`；
2. URL 增加**从节点名解析**的来源（`source_url` 边只覆盖 micro-app 包裹后的脚本）。

**修好之后，demo 的真实情况：**

| | |
|---|---|
| Script 总数 | **121** |
| 不同 URL | **22** |
| 每个基座模块的副本 | **×5** |

```
x 5  引用=14262  element-plus.js?v=973fd112
x 5  引用= 4333  chunk-LUSDXJEL.js?v=973fd112
x 5  引用= 1084  vue-router.js?v=973fd112
x 5  引用=   95  src/components/TabContainer.vue
x 5  引用=   54  src/micro-app.ts        … 22 个 URL 全是 ×5
```

**而这一次的序列是「1 次整页导航 + 5 轮子应用开关」 —— 每个模块恰好 5 份。**

**→ 每挂载一次子应用，基座应用的每个 ES 模块就多出一份 Script（连同它的源码与编译产物）。**

`?v=973fd112` 是 Vite 的依赖优化哈希、**稳定不变** —— 所以**不是时间戳导致的重复拉取，
是同一份模块被重复实例化**。

### 这条解释了什么

与前缀 before/after 快照的 diff 对得上：

| 增量 | 内容 |
|---|---|
| **+13.77 MB / +224** | `system / ExternalStringData`（模块源码的后备存储） |
| +2.22 MB / +2279 | `InstructionStream` |
| +1.48 MB / +4950 | `BytecodeArray` |
| +1.27 MB / +65 | `(script line ends)` ← 每个 Script 一份 |

**→ demo 的 +4.6 MB/轮 = 每轮重建一遍基座模块图**（22 个模块 × 源码 + 字节码 + 编译产物）。

### 与 micro-app 的关系

**这是 micro-app 触发的**：挂载/卸载子应用这个动作本身让基座的模块图被重新实例化。
但**它不是"子应用没被释放"** —— 被重建的是**基座自己的模块**。

**限定：**
- 这是 **demo（iframe 模式）** 上的观察。§13.37 测过 `iframe: false`（with-sandbox）每轮速率相同，
  所以**大概率两种模式都有**，但本轮没有在 with-sandbox 下重做这个 Script 计数。
- **机制未定位**：为什么创建/销毁一个子应用会让基座的 ES 模块重新实例化（最可能是 iframe
  的建立与销毁触发了模块解析路径），**未验证**。
- 这条**在业务应用上没有对应观察** —— 业务应用的真实 Tab 协议是 0.13 MB/轮，不是 4.6。

### 对 §13.41 的更正

§13.41 说"副本数跟页面加载次数走" —— **错**，那是**工具漏掉带 URL 的 Script** 造成的假象。
正确结论是 **§13.40 的原判断：副本数跟挂载次数走**。

### 13.43 一次追清：demo 的每轮增长 = **子应用的模块入口被解析到基座，导致基座模块图每挂载一次重建一遍**（2026-09-14）

#### 结论

**挂载一个 micro-app 子应用，会让基座应用的每一个 ES 模块多出一份 `Script`**（连同源码与编译产物）。
根因是**子应用的模块入口被按基座的 URL 解析**：

| 环节 | 事实 |
|---|---|
| 子应用 HTML | `sub-app1/index.html` 的入口是 **`<script type="module" src="/src/main.ts">`** |
| 基座 HTML | **同一个路径**（`/src/main.ts`） |
| 执行位置 | micro-app 把子应用的模块脚本放到**基座 realm** 里执行 |
| 结果 | `/src/main.ts` 按**基座的 URL** 解析 → `http://localhost:5000/src/main.ts` → **基座整份模块图被重新实例化** |

#### 证据链（每条都是实测）

**① 副本数跟挂载次数走**

demo 自带的 22 个基座模块，每个都出现 ×N：

```
x 5  引用=14262  element-plus.js?v=973fd112
x 5  引用= 1084  vue-router.js?v=973fd112
x 5  引用=   95  src/components/TabContainer.vue
x 5  引用=   54  src/micro-app.ts      … 22 个 URL 全是 ×5
```

序列是「1 次整页导航 + 5 轮子应用开关」→ 每个模块 **×5**。

**② 对照：只切 SPA 路由、不挂子应用 → 完全不涨**

6 次 `router.push('/_empty')` ↔ `router.push('/')`：

```
Script 总数 25 → 25      最大副本 x1 → x1
```

**→ 重复是"挂载子应用"造成的，不是路由、不是 SPA 本身。**

**③ 排除 `disableIframeRootDocument`**：设成 `true` 时 ×5/5 轮，设成 `false` 时仍从 ×1 涨到 ×2 再 ×4 —— **两种设置都重复，它不是原因**。

**④ 排除 Vite 时间戳**：这些 URL 带的是 `?v=973fd112`（Vite 依赖优化哈希，**稳定不变**），不是 `?t=`；而且关掉 HMR 后 `?t=` 归零、增长照旧。

**⑤ 最硬的一条：with-sandbox 模式下也没有子应用自己的 Script**

换成 `iframe: false`（无 iframe、必然同进程）跑 3 轮：

```
before: 25 个 Script，每个 ×1
after : 47 个 Script，22 个 URL 里多个变成 ×2
始终没有 http://localhost:3001/... 的 Script
```

**子应用在 3001，基座在 5000，而全部 22 个 URL 都是 5000。**
**→ 子应用自己的入口 `/src/main.ts` 从未在基座 realm 里被加载过 —— 被加载的是基座的同名入口。**

#### 与前缀 diff 的对应

| 增量（5 轮） | 内容 |
|---|---|
| **+13.77 MB / +224** | `system / ExternalStringData`（模块源码后备存储） |
| +2.22 MB / +2279 | `InstructionStream` |
| +1.48 MB / +4950 | `BytecodeArray` |
| +1.27 MB / +65 | `(script line ends)` ← 每个 Script 一份 |

**→ demo 的 +4.6 MB/轮 = 每轮重建一遍基座的模块图。**

#### 工具修复（这条曾导致两次错误结论）

`heap_scripts_by_url.js` 早先要求节点名**恰好等于** `system / Script`，但实际有两种形态：

```
system / Script                —— 无 source_url
system / Script / <url>        —— **URL 直接拼在名字里**（模块脚本走这条）
```

**121 个 Script 里只认出 2 个** → 由此产生了 §13.39「子应用源码 0 MB」和 §13.41「副本数跟页面加载走」两个结论，
**后者已被 §13.42 更正，前者需要重新审视**（demo 里子应用的 Script 确实没有，但那是"入口没被加载"，
不是"加载后被释放"）。

#### 限定（明确未做的事）

- **micro-app 里"把子应用的模块脚本放进基座 realm 执行"的具体代码路径没有逐行验证** ——
  证据是行为层面的（无 3001 的 Script、22 个 URL 全是 5000）。
- **业务应用上没有观察到同量级现象**（真实 Tab 协议 0.13 MB/轮，不是 4.6）——
  业务应用是 webpack + `new Function`，与 demo 的 Vite ESM 入口不同，**两者不能直接类比**。
- 这条**不是 micro-app 的泄漏**，而是**"子应用入口路径与基座同名"时的一个放大效应** ——
  但它的确由"挂载子应用"触发，且每次挂载都重建一遍基座模块图，**代价是真实的**。

#### demo 的最终状态

`main-app/vite.config.ts`、`src/components/TabContainer.vue`、`src/composables/useTabs.ts`
**均已与 git HEAD 完全一致**；`src/micro-app.ts` 里剩下的 `window.microApp = microApp`
是**用户原有的**调试钩子，未改动。

### 13.44 修复验证：iframe 模块脚本不再重建基座模块图（2026-09-15）

§13.43 的行为已经定位到 micro-app 的内部脚本创建路径：模块入口地址虽然已经由
`CompletionPath` 补全为 `http://localhost:3001/src/main.ts`，承载入口的 `<script>`
此前仍由基座 document 创建。iframe 节点补丁又只有在节点带
`__PURE_ELEMENT__` 时才会把框架内部脚本留在 iframe，因此模块执行 realm / 模块映射
仍可能落到基座。

本轮修复同时满足两个条件：

1. iframe 模式下，micro-app 自己插入的 script 必须使用该 iframe 保存的原生
   `Document.prototype.createElement` 创建；
2. 该 script 必须标记为 `__PURE_ELEMENT__`，避免被 iframe DOM 投射逻辑移到基座。

这不改变 `disableIframeRootDocument` 的业务语义。该选项仍决定子应用调用
`document.createElement` 时是否投射 DOM；它不应决定 micro-app 自己的模块加载器在哪个
realm 创建 script。

#### 真实浏览器结果

构建后通过 demo 的真实菜单打开 app1，`Debugger.scriptParsed` 观测到的入口及依赖全部来自
`localhost:3001`，包括 `/src/main.ts`、Vue、Vue Router、Element Plus、App.vue 和路由页面；
子应用内容也已真实渲染。没有再出现把子应用绝对导入解析到 `localhost:5000` 的情况。

随后重启独立测试 Chrome，在干净文档上执行 5 轮「挂载 app1 → Tab 关闭 → 等
`getAllApps()` 为空 → GC ×2」：

| 观测点 | used JS heap |
|---|---:|
| init | 6.77 MB |
| round-1 | 8.54 MB |
| round-2 | 8.64 MB |
| round-3 | 8.79 MB |
| round-4 | 8.93 MB |
| round-5 | 9.03 MB |

首轮加载后的 round-1 → round-5 增量为 0.49 MB；不再复现 §13.39～§13.43 的
约 4.6 MB/轮增长。

round-5 快照的 Script 结果：

- 基座 `localhost:5000`：21 个 URL，每个恰好 **1 份**；
- 已销毁子应用 `localhost:3001`：**0 个存活 Script**；
- 运行时 `getAllApps()`：空数组。

对应回归测试覆盖了 iframe document 创建、pure 节点标记和非 iframe 回退路径；iframe
销毁安全与原型恢复测试也同时通过。

#### 限定

本节证明的是 demo 中 Vite ESM 模块入口错用基座 realm 的问题已修复。它不能单独证明
业务项目 webpack/`new Function` 场景的全部内存问题已经解决；业务项目仍应继续采用
§13.30 的真实 Tab × 协议独立验收。

### 13.45 审批工作区多轮关闭后退出快照（2026-09-15 09:49）

快照：`E:\Heap-20260915T094940.heapsnapshot`。操作是反复切换、打开和关闭审批工作区的
待办、督办、已办三个菜单，随后退出登录。

#### 快照规模

- 快照文件 1.72 GB，堆 self size 约 1,580.3 MB；
- 15,820,260 个节点、83,561,937 条边；
- 23,885 个游离 DOM 节点；
- 56 个 `CreateApp`、56 个 `CustomWindow`、56 个 `MicroDocument`；
- 解析后 CSS 约 114.6 MB（1,657,427 个相关 native 节点）。

主 bundle 在本快照中每个 URL 只有一份 `Script`，因此这一次 1.58 GB 的主要问题不是
同 URL 的包裹源码重复副本，而是多代应用对象图、DOM 和 CSS 没有完成终态释放。

#### 已证实的增长机制

审批链路中下列实例均恰好保留 **5 代**：

- `wonder-bpm-webtodo`、`wonder-bpm-websupervise`、
  `wonder-bpm-webcompleteddetails`；
- `WS-Component-CreoNewTable`、`wonder-ws-dataDetail`、
  `CPU-Component-CompositionComparison-BPM`、`flow-app-a`。

这些实例均为 `state=unmount`、`container=null`，但 `sandBox=WithSandBox`，并继续保留
`source`。它们只完成了普通卸载，没有执行 `actionsForCompletelyDestroy()`；如果进入当前
终态销毁实现，`destroyed` 会置为 `true`，沙箱会被销毁并置空，源码空间和实例注册也会被释放。
因此本快照表现为每次操作留下一整代应用图，而不是 V8 在终态销毁后暂时没有 GC。

这些 56 个实例共享同一个 `CreateApp.prototype`，排除了“页面中加载了五份不同
micro-app 类库，各自维护注册表”作为本轮五代累积的解释。

#### 本快照运行的不是当前磁盘构建

当前 `lib/index.esm.js`（2026-09-15 09:31）明确包含
`disposeAppTasks`、`releaseAppRealm`、`createSandboxScriptElement`，以及
`unmountApp` 在宿主容器已被 Vue 移除时直接调用 `app.unmount({ destroy: true })` 的兜底。
但在 09:49 快照的完整字符串/源码中均检索不到上述三个当前构建标识；快照中的
`CreateApp` 形状也没有当前实现初始化的 `destroyed`、`terminalDOMNodes` 等字段。

这说明仅执行 `yarn build` 没有替换已经加载到现有页面 realm 中的 ESM 模块；本次快照的
页面仍在运行旧 micro-app 产物。旧 `unmountApp` 会在 Vue 已先删除宿主元素时继续访问
空容器，或者关闭映射没有给出目标，从而只留下 custom element 的普通卸载状态。

#### 结论边界与复测要求

快照已经证明“终态销毁未发生”，但快照本身不能在以下两个上游触发条件之间二选一：

1. 关闭日志中的 `targets` 为空，Tab → 微应用归属映射没有把本轮实例交给销毁器；
2. `targets` 非空，但旧版 `unmountApp` 在宿主元素已移除后失败，终态调用被中断。

必须完全关闭旧页面（最好新开浏览器进程）并重新启动/刷新基座，使其加载 09:31 之后的
`lib/index.esm.js`，再按相同流程复测。每次关闭应同时记录 `targets` 和销毁后的
`getAllApps()`；退出后两者应最终为空。只有在确认运行当前构建后仍出现多代实例，才可将
新快照归因为当前实现缺陷并继续修改核心销毁代码。

### 13.46 当前构建终态销毁后的快照（2026-09-15 10:18）

快照：`E:\Heap-20260915T101835.heapsnapshot`。运行时已确认 `getAllApps()` 与
`getActiveApps()` 均为空。

#### 与 09:49 旧运行时快照的变化

| 指标 | 09:49 | 10:18 |
|---|---:|---:|
| 堆 self size | 1,580.3 MB | 747.5 MB |
| 节点 | 15,820,260 | 9,754,757 |
| `CreateApp` | 56（未终态销毁） | 5（全部 `destroyed=true`） |
| `CustomWindow` | 56 | 15 |
| 游离 DOM | 23,885 | 21,819 |
| 解析后 CSS | 114.6 MB | 20.0 MB |

当前版本的终态销毁已实际生效。5 个残留 `CreateApp` 均为 `state=unmount`、
`destroyed=true`、`sandBox=null`、`container=null`、`terminalDOMNodes=null`；实例注册表、
沙箱字段、解析代码标记也均已清空。

#### 5 个 CreateApp 的残留路径

5 个实例均来自 WS 动态组件，并有完全相同的路径：

```text
ws/chunk-vendors 的 CycleException
  → Error.prototype
  → V8 ErrorStackData
  → 当时执行栈中的 CreateApp
```

这证明子应用加载期创建的 Error 栈快照仍能看见已经销毁的框架实例；但支配树中代表实例
只独占 336 字节，代表 `CustomWindow` 只独占 428 字节。它们是被保留图中的空壳/乘客，
不是数百 MB 的支配者，不能以此为依据继续增加字段清理。

#### 最大支配者是 DevTools InspectorDOMAgent

精确支配树经 353 轮收敛。`blink::InspectorDOMAgent` 独占保留 541,255,491 字节，约
516.2 MiB，占 747.5 MiB 堆的 69%。其子图中包含：

- 孤儿 `CustomWindow` 和子应用执行上下文；
- 大量游离 DOM；
- WS/BPM 的包裹源码和模块闭包；
- 一个 WS 闭包分支约 44.1 MiB。

代表 `CustomWindow` 甚至由 `InspectorDOMAgent` 直接通过 native hidden 边持有。这说明本次
使用已打开的浏览器开发者工具导出的快照，主要被 Elements/DOM 检查器的对象映射污染。
这是检查器保留，不是 micro-app 的注册表、任务表或沙箱字段保留；框架代码不能释放
`InspectorDOMAgent`。

#### 仍需单独验证的非检查器部分

当前仍有 WS vendor 7 份、BPM vendor 3 份 Script，合计包裹源码约 209 MiB；但其中多数
同样落在 `InspectorDOMAgent` 支配子树中。另外约 40.6 MiB 由 V8 object shape 的
`$state` AccessorPair 支配（形状符合 Pinia store），它不经过已清空的 micro-app 注册表。

因此这份快照可以证明终态销毁已经修复，却不能用来量化关闭 DevTools 后还剩多少真实增长。
下一份验收快照必须在不打开 DevTools 面板的独立 Chrome 中通过 CDP 直接抓取；至少对比
同一进程的登录页稳定基线与执行固定轮次、退出登录后的稳定基线。只有排除
`InspectorDOMAgent` 后仍按轮次增长的强引用，才进入下一轮代码修复。

### 13.47 无 DevTools 污染的登录前后对照（2026-09-15 10:37～10:40）

快照：

- `E:\heap-login\login.heapsnapshot`：初始登录页；
- `E:\heap-login\login2.heapsnapshot`：操作多个微应用并退出后重新回到登录页。

两份快照均无 console handle、无 `InspectorDOMAgent` 大支配子树，适合作为本轮干净对照。

#### 基础指标

| 指标 | 初始登录页 | 操作后退出 | 差值 |
|---|---:|---:|---:|
| 堆 self size | 64.0 MB | 315.1 MB | +251.1 MB |
| 节点数 | 623,366 | 4,137,066 | +3,513,700 |
| 游离 DOM | 0 | 5,857 | +5,857 |
| `CreateApp` | 0 | 2 | +2 |
| `CustomWindow` | 0 | 6 | +6 |
| 解析后 CSS | 2.38 MB | 3.21 MB | +0.83 MB |

退出后的两个 `CreateApp` 是 SES2 动态组件，均为 `destroyed=true`、`state=unmount`、
`sandBox=null`、`container=null`、`terminalDOMNodes=null`。代表实例只独占 336 字节，代表
`CustomWindow` 只独占 428 字节；它们仍然是空壳而不是大内存支配者。

#### 没有按开关次数重复编译

退出后仍存活的主要子应用 Script 每个 URL 均恰好一份：

- WS vendor 约 23.5 MB；
- BPM vendor 约 18.1 MB；
- SES2 vendor 约 17.7 MB；
- WS/SES2 app 及 flow bundle 各一份。

全部 URL 的 Script 源码合计约 64.8 MB。与 09:49/10:18 快照中的 ×3、×7 不同，
本次反复打开、关闭后副本数仍为 1；因此已经没有证据表明 bundle 按 Tab 操作次数持续累积。

#### 最大支配者：V8 的 Pinia createSetupStore 反馈缓存

精确支配树经 353 轮收敛。最大非根支配链为：

```text
(GC roots)
  → FeedbackCell / FeedbackVector（createSetupStore）
  → AllocationSite
  → Pinia store Object/隐藏类
  → $state AccessorPair
  → 子应用执行上下文
```

该 `FeedbackCell` 独占保留 189,655,071 字节，约 180.9 MiB，占退出后堆的 57%。其中
`$state` AccessorPair 后面的子应用上下文独占约 158.2 MiB。另有一条 V8 object-shape
链独占约 29.5 MiB。两者都是 V8 的编译反馈、分配点和隐藏类缓存，不经过
`appInstanceMap`、AppTask、sandbox 字段或 DOM 监听器表。

这解释了为什么“回到同一个登录页”不等于“回到首次登录前的 64 MB”：with 沙箱在基座
V8 realm 中编译和执行子应用；V8 会保留首次执行形成的代码、反馈向量、AllocationSite 和
对象隐藏类。JavaScript 框架没有受支持的接口强制逐出这些引擎缓存。真正需要观察的是
相同 URL 的 Script/反馈图是否每轮继续复制，而本次数据是每 URL 一份。

#### 剩余 DOM

5,857 个游离 DOM 中 5,677 个属于 `wonder-ws-web`，其 native self size 约 0.61 MiB；
其余来自 flow 和三个 SES2 动态组件。数量仍应继续观察，但本次 CSS 只比初始多 0.83 MB，
也没有出现上一轮多代容器/CSS 同步增长的形态。

#### 本轮结论

1. 当前终态销毁和注册表清理已生效；
2. DevTools 检查器造成的 516 MiB 干扰已经排除；
3. 退出后不会回到冷启动 64 MB，主要原因是 with 沙箱共享 realm 下 V8 的一次性代码、
   Pinia 反馈向量和隐藏类缓存；
4. 本次每个 bundle 只有一份，不能称为按轮次泄漏；
5. 是否真正收敛仍应使用同一 Chrome 进程连续记录 round-1～round-N 的退出后基线。若
   round-2 以后维持同一份 Script 且堆进入平台区间，就属于 warm-up 高水位；只有副本数和
   退出后基线继续近似线性增加，才是需要继续修复的累积泄漏。

### 13.48 真实产品上的三次连续采集：内存上升且部分 URL 重复（2026-09-15）

> 与 §13.44（另一处独立写入）是同期但不同主题：那一节验证的是 iframe 模块脚本的修复，
> 本节是真实产品上的累积曲线。

在**同一台真实产品页面**（`http://localhost:3000`，全新调试会话）上，按用户操作节奏连续采了三次。
三次都在 `/login`，页面上都没有 `<micro-app>` 元素（即"已退出"状态）。

| | 第 1 次（干净） | 第 2 次 | 第 3 次 |
|---|---|---|---|
| `usedMB`（GC 后） | **23.88** | **217.62** | **614.42** |
| `heapSelfMB` | 64.0 | 315.1 | **736.1** |
| 节点数 | 623,366 | 4,137,066 | **10,965,828** |
| 快照文件 | 77.1 MB | 441.3 MB | **1195.2 MB** |
| `customWindow` | 0 | 6 | **24** |
| `createApp` | 0 | 2 | **7** |
| **`createAppDestroyed`** | 0 | **2** | **7** |
| `apps`（DOM 上的应用名） | 0 | 5 | **17** |
| `detachedDOM` | 0 | 5,857 | **28,156** |
| `parsedCSS` | 2.38 MB | 3.21 MB | 11.62 MB |

**保留的子应用 bundle（源码合计）：**

| 次 | Script 总数 | 不同 URL | 源码合计 | 主要 bundle |
|---|---|---|---|---|
| 1 | — | — | **0** | 无 |
| 2 | 938 | 844 | **61.8 MB** | ws 22.41 / bpm 17.30 / ses2 16.92 / …（各 ×1） |
| 3 | 1,141 | 864 | **214.0 MB** | ws **×2** 44.82 / ses2 **×2** 33.83 / cat14 20.08 / bpm 17.35 / se 17.04 / cpu 16.93 / cle3 16.56 / proc 15.84 / prod 13.33 |

### 这三次采集说明什么

1. **同一浏览器会话的退出后高水位确实继续上升，且发生在真实产品上**（不是 demo、不是人造负载）。
   但三次之间的操作集合没有记录，不能把它作为固定工作负载下的线性“曲线”或计算每轮泄漏率。
2. **累积的是子应用的完整模块图**：bundle 源码 + 它的 SFI（`ws` 一份就有 43,210 个引用）+ 编译产物。
   第 3 次有约 10 个不同子应用的 bundle，其中相同哈希的 `ws`、`ses2` 以及 flow bundle
   已经各留 **2 份**。不同工作负载可以解释新增 URL，却不能解释同一 URL/哈希的第二份 Script；
   这是当前最直接的重复编译证据。
3. **第 2 次已有 `createAppDestroyed = 2`，第 3 次增加到 7**。
   它们均为 `sandBox=null`、`container=null` 的终态空壳，代表实例只独占数百字节；数量增长是
   旧执行图仍可达的伴随指标，不能把 7 个实例本身当成大内存载体。
4. **`customWindow` 24 个 vs `createApp` 7 个** → 17 个孤儿窗口。
5. **`detachedDOM` 0 → 5,857 → 28,156**，`parsedCSS` 2.38 → 3.21 → 11.62 MB —— 游离 DOM 与解析后的 CSS 同步累积。

### 与前面结论的关系

- 与 §13.31「登出后残留的是子应用完整模块图，而框架簿记全空」**完全一致** ——
  这三次的 `parsedCode` / `__MICRO_APP_URL__` / `__MICRO_APP_BOUND_` **始终都是 0**。
- 与 §13.30「登出残留 ≈64–69 MB / 次、与轮数无关」**方向一致**，但**绝对值更大** ——
  这次是多轮真实使用（约 10 个子应用被挂载过），不是单次轻量循环。
- §13.47 在只有前两份快照时只能确认“当时每 URL 一份”；第三份的新证据已经把这一结论推进为：
  **大多数新增 URL 来自更大的工作负载，但 WS/SES2/flow 确有同 URL 第二份 Script**。
- **不推翻 §13.30 的 0.13 MB/轮**：那个测的是受控的同一个应用反复开关，这里测的是未记录操作集合的真实使用。

### 限定

- **这三次之间用户具体操作了什么，我没有记录**（我只做采集），所以**不能把增量除以一个确定的轮数**。
- 前两列的 `CreateApp`/`createAppDestroyed` 已使用同一版 `heap_metrics.js` 重算；原表把初始的
  `CreateApp=0` 写成 2，并把第二份中两个 `destroyed=true` 实例写成 0，现已纠正。
- `cat14/chunk-vendors` 那份 20.08 MB 的 `引用=2` —— 只有 2 个 SFI 指着它，
  与其它 bundle（2–8 万引用）完全不同，**可能是预取而非挂载，本轮没有区分**。
- `usedMB` 与 `heapSelfMB` 是两种口径，不能互相换算。

### 13.49 同 realm 外链脚本弱复用实验（2026-09-15，已撤回）

针对 §13.48 已确认的“相同 URL/哈希产生第二份 Script”，曾在编译入口实验弱复用：

- 仅覆盖外链、非 inline/module、`with` 沙箱脚本；这类脚本由稳定的基座 `Window.Function`
  编译，执行时再读取当前安装的 `__MICRO_APP_PROXY_WINDOW__`。
- 缓存键先按脚本地址分组，再对最终转换后的完整代码做严格相等判断。插件、包装选项或代码不同，
  即使 URL 相同也不会复用。
- 缓存只保存 `WeakRef<Function>`；最终代码作为不可枚举 Symbol 属性保存在 Function 自身，
  Map 不强引用 Function 或大源码。因此缓存不会把本来可以被 GC 的子应用 bundle 重新变成常驻对象。
- `iframe`、关闭沙箱、inline 和 module 继续独立编译。旧浏览器不支持 `WeakRef` 时自动退回原行为。
- 地址表最多保留 1024 项，并会清除已经失效的弱引用；达到上限时只放弃最旧地址的复用机会，
  不影响函数生命周期或执行语义。

真实产品验证出现 Vue `shouldUpdateComponent` 读取空 `emitsOptions`，以及子应用路由数据
`microAppPath` 变为 `undefined`。这证明最终代码相同、编译 realm 相同仍不足以让可执行 Function
跨应用实例安全共享：Function 的反馈信息和内部闭包模板会参与每一代 Vue/webpack 运行时图。
因此该实验已完整撤回，恢复每个应用实例独立编译的隔离语义。后续不能通过共享 Function 处理
重复 Script，只能继续定位旧函数的环外强引用，或使用具备独立 realm 生命周期的隔离机制。

这次回归也说明原来的单元测试只覆盖了代理解析和代码返回值，没有覆盖完整 Vue 组件树、路由和
webpack 模块生命周期；不能用这些局部测试替代真实应用隔离验收。

### 13.50 六轮 +62 MB/轮 是真实残留，且残留物是游离 DOM（2026-09-16）

#### 现象（用户在同一标签上连做六次 `gc_once.js`）

```
[16:04:25] used 387.97 → 261.34   (释放 126.63)   total 268.44
[16:04:40] used 459.77 → 346.88   (释放 112.89)   total 354.77
[16:04:58] used 523.59 → 412.59   (释放 111.00)   total 420.77
[16:05:18] used 572.53 → 459.63   (释放 112.90)   total 471.69
[16:05:38] used 659.67 → 526.08   (释放 133.59)   total 538.44
[16:06:00] used 745.06 → 573.82   (释放 171.24)   total 586.83
```

GC 后的地板值：261.34 → 346.88 → 412.59 → 459.63 → 526.08 → 573.82，
五个间隔的增量是 +85.54 / +65.71 / +47.04 / +66.45 / +47.74，**合计 +312.48 MB，均值 +62.50 MB/轮**。
`totalSize`（V8 向系统提交的量）同步从 268.44 涨到 586.83 MB —— 不是"提交了但没用上"，
是活集确实变大。

#### 先排除测量通道：闲置 4.5 分钟，地板逐位不变

同一标签、不做任何操作，每 18 秒一次 GC×3，连做 12 次：

```
[16:24:41] used 569.72 → 569.72   (释放 0.00)   total 580.66
…（12 次全部相同，逐位一致）…
[16:29:03] used 569.72 → 569.72   (释放 0.00)   total 580.66
```

**12 次全部 `释放 0.00 MB`，地板稳定在 569.72 MB，逐位相同。**
所以：CDP 会话本身不制造增长，页面闲置时不产生垃圾，`Runtime.getHeapUsage` 这条读数通道是干净的。
上面 +62.50 MB/轮 是真实保留，不是观测引入的。

#### 决定性对照：同一个页面重新干净加载一次

在同一浏览器、同一登录态下新开一个标签，加载**同一个 URL**（`/wonder-plm/log?fresh=1`），
等它完整启动后 GC×3：

| | 用户那个标签（16:07 快照） | 新开的干净标签 |
|---|---|---|
| `used` / `total` | 569.72 / 580.66 MB | **178.18 / 182.67 MB** |
| `heapSelfMB` | 731.2 | 289.3 |
| `nodeCount` | 18,353,221 | **4,628,420** |
| **`domAll` 游离 DOM** | **111,318** | **110** |
| `domAll` 已挂载 DOM | 22,234 | 24,744 |
| 活着的子应用 | ws-dataDetail-global + Issues | **同样这两个** |
| `customWindow` / `createApp` | 2 / 2（均存活） | **2 / 2（均存活）** |
| 重复 bundle | 无 | **无** |
| `bundles` | 828 个 / 37 MB | 827 个 / 37 MB |
| `markers.parsedCode` | 8 | **8** |

**两个标签的子应用结构完全相同**（同样两个应用、同样两个沙箱、同样两个 CreateApp、同样的 bundle 集合、
同样没有重复副本），**已挂载 DOM 也基本一样**（干净标签甚至更多：24,744 对 22,234），
**但游离 DOM 相差 1000 倍：110 对 111,318**，节点总数相差 4 倍，堆相差 392 MB。

这条对照把归因直接钉死了：

- 该页面的固有开销是 **178 MB / 4.6 M 节点 / 110 个游离节点**。
- 用户那个标签多出来的 **+392 MB、+13.72 M 节点、+111,208 个游离节点**，
  **不是 micro-app 沙箱结构的函数** —— 同样的沙箱结构在干净标签里只对应 110 个游离节点。
- 它也不是"编译缓存没清"：两个标签的 `bundles` 完全一致（同样 37 MB 源码、同样无重复），
  `parsedCode` 都是 8。

注：干净标签的 `consoleHandles` 是 40,147（启动期日志被 inspector 保留），
也就是说 **289.3 MB 这个自身体量本身还是偏高的**，真实固有开销比它更低；
对照方向只会更强，不会更弱。

#### 同类证据：关闭标签页这一步，框架自己的账是清干净的

15:40 与 15:58 两次快照（`/wd/ws` 页，6 个子应用）到 16:07（`/wonder-plm/log`，2 个子应用）：

| | 15:40 | 15:58 | 16:07 |
|---|---|---|---|
| 活着的应用 | 6 | 6 | 2 |
| `customWindow`（其中无标记） | 10（8） | 10（8） | **2（0）** |
| `createAppDestroyed` | 2 | 2 | **0** |
| 重复 bundle | 4 份（86 MB） | 4 份（86 MB） | **0** |
| bundle 源码合计 | 99.5 MB | 99.5 MB | **37 MB** |
| `domAll` 游离 DOM | 48,698 | 48,701 | **111,318** |
| `nodeCount` | 13,138,396 | 13,142,844 | 18,353,221 |

15:40 → 15:58 十八分钟几乎冻结（+4,448 节点 / +0.4 MB），说明那段是稳定态。
而关掉工作区标签页之后：**孤立的 `CustomWindow` 8 → 0、已销毁 `CreateApp` 2 → 0、
重复 bundle 4 份 → 0、bundle 源码 99.5 → 37 MB** ——
**沙箱、编译产物、作用域 CSS 这三块，销毁路径是真正释放了的。**

同一时间窗里唯独 **游离 DOM 反向暴涨（48,698 → 111,318）**，节点总数也涨了 5.21 M。

（限定：15:58 与 16:07 是两个不同页面，不能当作同一页面的前后对照。
上一条同页面对照才是定论，本条只用来证明"框架账目确实清干净了"。）

#### 顺带核清：`markers.parsedCode` 不是隐藏类造成的假计数

`parsedCode` 计的是**名为 `parsedCode` 的边**，而 V8 也会从 `DescriptorArray` 发出同名边，
所以"三个快照都恰好是 8"一度像是隐藏类描述符而非活数据。直接查这 8 条边的两端：

```
from: object  Object (selfSize 16)
edge: property parsedCode
to:   string  "micro-app[name=Issues-Component-CreateIssue] .item-title{font-size:18px;…}"
to:   string  "@charset \"UTF-8\";micro-app[name=Issues-Component-CreateIssue] micro-app-body,html{…}"
```

8 条全是**真实对象属性**，指向 micro-app 生成的作用域 CSS 文本，且都属于**仍然活着**的应用。
即 `parsedCode` 是活状态，不是残留，也不是假计数。§13.31 用 `parsedCode=0` 判"退出后框架簿记为空"
的结论**成立**，无需更正。

#### 那 111k 游离 DOM 长什么样、被谁拿着（抽样）

从 16:07 快照取两个样本向上走持有者（`heap_retainers.js --levels=5`）：

- 样本节点：`<div class="el-tree-node is-focusable" role="treeitem" tabindex="-1" aria-expanded="false">`（Element-UI 树节点）与一个 `Text`。
- 第 1 层 12 个持有者：`property:el`（Vue vnode → 元素指针）3 个、原生树关系若干、1 个数组；
- 逐层放大：12 → 43 → 123 → 367 → 816，是**子树**的形状（沿父链/vnode 链向上）；
- **第 1–5 层里没有任何 micro-app 对象**。

#### 支配树：堆不是被某一个大对象占住的

16:07 快照的前 59 个支配者合计 341.4 MB / 731.2 MB（47%），其余散布在 1800 万个节点上（每个 <1.5 MB）：

| 保留量 | 对象 |
|---|---|
| 22.41 MB | `(function anonymous(){…with(proxyWindow.__MICRO_APP_WINDOW__)…}` —— ws bundle 的包裹源码 |
| 18.92 MB | `system / Context / scope @395305` |
| 12.15 MB | `Map`（+ 支撑数组） |
| 12.03 MB | `webpackChunkwonder_issues_web` —— issues bundle 的包裹源码 |
| 10.29 MB | 基座模块源码（xlsx） |
| 6.44 MB | `Map` |
| 5.67 MB | `system / Context / scope @325399` |
| 4.27 / 3.79 / 3.57 MB | micro-app 自身 `lib/index.esm.js` / jsoneditor.js / jsoneditor 源码 |
| 2.03 / 1.53 MB | `<style data-origin-href="…chunk-vendors.8d92a5f8.css">` 等作用域 CSS 表 |

子应用 bundle 包裹源码合计 ≈37 MB，与 `bundles.sourceMB: 37` 吻合，**每个 bundle 只有一份，无残留副本**。

#### 体量到底在哪：游离 DOM 自身只有 12.52 MB，其余约 359 MB 在 JS 图上

新增工具 `scripts/heap_detached_size.js`（统计原生节点的自身字节，按 detachedness 分组）。
两个标签对比如下：

| | 用户标签（16:07） | 干净标签 | 差 |
|---|---|---|---|
| 原生节点总数 | 4,170,546 / 203.69 MB | 923,031 / 120.92 MB | +3,247,515 / +82.77 MB |
| ├ 已挂载 DOM | 22,234 / 2.55 MB | 24,744 / 2.79 MB | **−2,510 / −0.24 MB** |
| ├ 游离 DOM | 111,318 / **12.52 MB** | 110 / 0.01 MB | +111,208 / +12.51 MB |
| └ detachedness=0 的原生对象 | 4,036,994 / 188.62 MB | 898,177 / 118.12 MB | +3,138,817 / +70.50 MB |
| 节点总数 | 18,353,221 | 4,628,420 | **+13,724,801** |
| `heapSelfMB` | 731.2 | 289.3 | **+441.9 MB** |

三条读数：

1. **游离 DOM 自身只有 12.52 MB**（均值 118 B/个），而且**没有任何 ≥1 KB 的游离子节点**
   （`biggestDetached` 为空）—— 不存在少数超大游离子树。
   所以 111k 个游离节点是**指示物，不是体量**；把"111k 个游离节点"读成"几百 MB 在 DOM 上"是错的。
2. 原生对象整体只贡献 **+82.77 MB**。**+441.9 MB 里约 +359 MB 在非原生（JS）对象上**，
   节点数上对应约 **+1,048 万个 JS 对象**（13.72 M − 3.25 M）。
3. 换算下来 **每个多出来的游离 DOM 节点背后约 94 个 JS 对象** ——
   这正是 Vue 组件树的形状（一个元素 → vnode + 组件实例 + props + effect + 闭包）。
   游离 DOM 之所以好用，是因为它**可数、且与 JS 图同步增长**，不是因为体量在它身上。

另外：**已挂载 DOM 反而是干净标签更多**（24,744 对 22,234），
说明两个标签渲染的是同一页面的同一量级视图，对照没有被"干净标签少渲染"污染。

支配路径（`heap_dominators.js --path=202945`）：

```
(GC roots) --element:#14--> <div class="el-tree-node is-focusable" role="treeitem" …>
                              retainedSize = 1,976 字节,  idom = (GC roots)
```

该样本节点的 `retainedSize` 只有 **1,976 字节**，且 `idom` 直接就是 `(GC roots)` ——
**没有单一非根持有者**。这与 §13.34/§13.35 那个 74.5 MB 簇是**同一种形状：并行冗余入口**。
所以"挑一个游离节点往上追"不是有效切入点，单个游离节点也不构成有效修复目标。

#### 结论与限定

1. **确认**：六轮的 +62.50 MB/轮 是真实保留；测量通道经 12 次零释放的闲置对照证明为干净。
2. **确认**：同页面干净加载的固有开销是 **178 MB / 4.63 M 节点 / 110 个游离节点**；
   用户标签是 **570 MB / 18.35 M 节点 / 111,318 个游离节点**。
   差值是 **+392 MB、+1372 万节点、+111,208 个游离节点**。这是一条可重复的验收口径。
3. **确认（修正）**：差值的主体是 **JS 对象图（约 +359 MB、约 +1048 万个对象）**，
   游离 DOM 自身只占 12.52 MB。游离 DOM 是**指示物**，不是体量所在。
4. **确认**：micro-app 的沙箱/编译/作用域 CSS 三块账目在两个标签里完全一致，
   且关标签页时确实被释放（孤立 CustomWindow 8→0、重复 bundle 4→0、源码 99.5→37 MB）。
   micro-app 自己的结构**不是**这 +392 MB 的所在。
5. **限定**：**不能**据此说"是 micro-app 造成了这 +392 MB"。
   目前能说的是"残留物的持有链上，抽样第 1–5 层没有 micro-app 对象，
   且 111,308/111,318 个游离节点不挂在 micro-app 根上（`detachedApps` 只有 10 个）"。
   归因到具体持有者仍未完成，且该簇呈并行冗余入口形状，单点切割按 §13.34 的经验收益会接近零。
6. **限定**：用户那六轮之间**具体做了什么操作我没有记录**，所以这是"约 6 轮共 +312 MB"，
   不是"某个确定的动作 ×6"。本轮也**没有**建立可复现的最小动作序列。
7. **限定**：干净标签的 `consoleHandles` 是 40,147（启动期日志被 inspector 保留），
   即它的 289.3 MB 自身也偏高，真实固有开销比这更低 —— 对照方向只会更强。

