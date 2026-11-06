# heap01 初始化与退出登录对比（2026-09-14）

## 实测指标

| 指标 | 初始化 14:21:10 | 登录后退出 14:23:25 |
|---|---:|---:|
| JS 堆 self size | 66.9 MB | 324.8 MB |
| 节点数 | 658,231 | 4,070,804 |
| 游离 DOM | 0 | 5,568 |
| CustomWindow | 0 | 4 |
| MicroDocument | 0 | 4 |
| CreateApp | 0 | 0 |
| 解析后 CSS | 3.07 MB | 4.08 MB |

退出后游离节点按应用标签：WS 5,519，SES2 proofreadApproveModal 19，SysMLLinkEditor 15，LoadData 15。
初始化与退出后不一定应完全相等，登录可能加载基座懒模块、业务缓存。
但本样本存在四个旧窗口和大量子应用 DOM，不能把 257.9 MB 差值全部解释为正常基座缓存。

## 导出图中的必要入口候选（尚非 V8 实际保活证明）

使用本快照自己的节点号，工具跳过 weak 边，并对 V8 标识的 WeakMap ephemeron
按 table 与 key 均可达处理。静态图实验不等于浏览器实际执行清理后的收益。

**Review correction：该工具未建模共享 DescriptorArray 的定制标记语义。**
V8 的 Map 可以只拥有共享描述符表的一个前缀，不能从「表可达且包含 `$state`」直接推出
「该 Map 会保活 `$state` getter」。V8 明确按 `NumberOfOwnDescriptors()` 访问有效前缀以避免泄漏。
因此下面的 222.8 MB 是导出图屏蔽结果，不能证明 Pinia AllocationSite 是实际 GC 中的必要入口，
更不能据此把普通 Pinia 对象创建当成已证实根因。本样本 Map 的实际有效前缀尚未独立核验。
参考：[V8 描述符共享说明](https://github.com/v8/v8/blob/main/docs/objects/descriptor-and-transition-arrays.md)、
[V8 GC 描述符访问实现](https://chromium.googlesource.com/v8/v8/+/1a66a16e3a6c2f9a2760d78bbb03c5660ceedda3/src/heap/marking-visitor-inl.h)。

旧 CustomWindow：952617 / 996978 / 1623920 / 2276734。
四条路径共有：

```text
基座 Window 1559681
→ globalPlugin 1728773
→ useMultipleTabStore/useStore 206610
→ Pinia createSetupStore 216103
→ FeedbackCell 216023 → FeedbackVector 216024
→ AllocationSite 1804441
→ literal boilerplate 2190826
→ Map 333475 → DescriptorArray 333470
→ $state AccessorPair 2479121 → get 2479122（旧 WS vendor）
→ WS 作用域 → WS 旧窗口，及三个 SES2 引用
```

核对事实：

- createSetupStore 的 SharedFunctionInfo 1804433 通过 script 215982 对应
  `http://localhost:3000/node_modules/.vite/deps/pinia...`，确实是基座 Pinia。
- boilerplate 2190826 的七个字段 `_p/$id/$onAction/$patch/$reset/$subscribe/$dispose`
  值均为 V8 Hole，它不是一个可经业务 API 直接操作的 store 实例。
- DescriptorArray 包含 theme/setTheme/getTheme/$state，$state getter 来源为
  `ws.dev.wonder10.com/js/chunk-vendors.a695a4d2.js`，options.state 来源为旧 WS app。
- 仅屏蔽 DevTools console：减少 213 节点，四舍五入 0 MB，四个旧窗口仍可达。
- 同时屏蔽 console 与 AllocationSite 1804441：减少 **2,743,545 节点 / 222.8 MB**，
  四个旧窗口全部不可达，剩余 102.0 MB。比历史多入口样本更明确，但不可推广到其它会话。

复核命令：

```powershell
node --max-old-space-size=16384 scripts/heap_root_cut.js E:\heap01\Heap-20260914T142325.heapsnapshot --targets=952617,996978,1623920,2276734 --compact --dumpFull --blockEdge="DevTools console" --blockNode=1804441 --maxHops=120
```

## 修复边界与验证

AllocationSite/boilerplate/DescriptorArray 是 V8 内部结构，没有 ECMAScript API 可以直接清除。
不能把静态屏蔽节点变成 delete globalPlugin.useMultipleTabStore，也不能据此清基座 Pinia/业务状态。
应复现 Pinia literal 对象的跨实例隐藏类描述表保留，再验证非 literal 的对象创建能否切断该路径。
如果需要修改依赖构建，应作为有版本约束的 Pinia 修补而非 micro-app 全局 Object 行为劫持。

已添加 `scripts/test_pinia_literal_retention.js`（仅诊断，不修改库或产品）：
共享 literal 分配与 Object.create(Object.prototype) 分配分别安装捕获子 realm 的 $state getter，
跨 turn 多次 GC 检查 WeakRef。Node v20.19.6 / V8 11.3 两者 getter **均被回收**。
所以最小 Node 实验没有复现产品 Chrome 的路径，不能宣称 Object.create 改法有效或直接上线。
本次尚未修改运行时代码，也未重新构建；需 Chrome + 实际 Pinia 创建流程复现验证。

## Chrome 与真实 Pinia 库的受控探针

用户授权登录后，通过浏览器 UI 登录 wd，打开 WS，再点击真实 Tab 的 remove 按钮：
close-current-tab targets=4，before=7，after=3，页面返回首页。这证明该次实际关闭流程处理了
WS 和三个 SES2 目标，不证明它们的堆内存均已回收。

经批准启动独立临时 Chrome 调试配置，没有修改已有用户配置或保存密码。
`scripts/cdp_literal_retention_probe.js` 在隔离 world 做内存实验，无登录/导航/DOM 写入操作，
只用 WeakRef 与 HeapProfiler.collectGarbage，返回值为基本数据；结束时清 console 并关闭 Runtime。
Chrome 153.0.8010.37 / V8 15.3.76.10：

- 字面量分配与非 literal 分配：旧 getter 两者都被回收；
- `--pinia` 加载真实 Pinia 2.0.12 production CJS，使用本地 Vite Vue 依赖，创建和释放测试 store；
  原版与将 reactive(assign 的目标改成 Object.create(Object.prototype) 的实验版，测试 state
  两者都被回收。实验修改只在内存中的源字符串，没有改依赖或运行产品代码。

所以探针仍未复现实际产品中的跨 bundle AllocationSite/DescriptorArray 保留，不能上线该候选改法。
普通 Pinia 初始化/释放并非已证实根因，产品集成或共享 realm 的具体触发步骤仍需验证。
当前可操作产品页面属于浏览器扩展用户配置；独立调试配置尚未连接 UI 自动化扩展，
因此不能把两种配置的 UI 操作与堆快照当作同一会话的验收数据。

## 再次连接后的实际关闭验证

已在恢复连接的 Chrome「用户1」页面中打开 WS，等待工作区表格与属性面板完成加载，再点击页签的 remove 按钮。
界面返回 `/wd/dashboard`，WS 页签消失；日志包含 `close-click /wd/ws`、`close-current-tab targets Array(4)`、
`before Array(7)`、`after Array(3)`。本次操作验证了关闭入口及四个目标的销毁调用，不代表相关 realm 已 GC。

该浏览器的自动化连接已恢复，但本机 `127.0.0.1:9222` 的内存采集连接再次失败（默认权限与提权重试均为 fetch failed）。
因此没有将先前独立配置的 47.2 MB 登录页基线与「用户1」的本次操作混为一组数据，也没有据此上线未复现的 Pinia 分配补丁。

## 补全保留条件后的 Chrome 探针

已恢复原独立 Chrome 的 9222 调试连接，继续在隔离 world 执行内存实验，不操作产品 UI。
`scripts/cdp_literal_retention_probe.js` 补充以下条件：

- `--shared-shape`：可变字段值、持续存活的基座实例、不可配置的 `$state` getter/setter 对；原版和非 literal 创建的旧 getter 均被回收。
- `--pinia`：纠正观察对象，从 state payload 改为 `$state` getter；持续保留基座 Store。原 Pinia 2.0.12 production CJS 与候选创建方式的旧 getter 均被回收。
- `--pinia-vite`：使用服务器实际返回的 Vite Pinia 模块及其带版本查询的依赖 URL；原版与非 literal partialStore 候选的旧 getter 均被回收。

Chrome 153.0.8010.37 / V8 15.3.76.10；以上结果仍不等同于真实微应用反复挂载验收，
但进一步否定了「现有最小实验已证明对象创建修补有效」的说法。
原有 payload 回收结论仅说明 payload 被回收，不证明 getter 或整个模块图消失，历史文字保留并在此纠正。

`heap_root_cut.js` 的 cut 输出增加模型与局限字段，避免将未建模 DescriptorArray GC 的模拟差值当成真实释放量。
本轮只修正诊断脚本与证据口径，未修改产品运行时代码，未重新构建。
