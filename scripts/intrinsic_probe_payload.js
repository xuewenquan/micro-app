/**
 * 受控诊断载荷：记录 `Function.prototype.toString` 的「安装 / 还原」事件并做身份编号。
 *
 * ⚠️ 这不是无侵入工具。它会替换 `Object.defineProperty` 与 `Reflect.defineProperty`，
 *    因此**可能影响第三方库的特性检测**，也可能改变描述符的处理路径。
 *    只在一次性诊断会话里使用，用完必须 `stop()`。
 *
 * 设计约束（来自 18.6.8，必须遵守）：
 *   1. **日志只存字符串和数字**，绝不长期保存函数对象或 Error 对象——
 *      否则诊断本身会钉住目标，制造新的保留。
 *   2. 函数身份用 `WeakMap<Function, number>` 编号：键是弱引用，不阻止回收。
 *   3. 覆盖不全，必须如实记录：直接赋值（`FT.toString = x`）不经过 defineProperty，
 *      靠轮询兜底（有最多一个轮询间隔的延迟）；注入**之前**已被缓存的
 *      `Object.defineProperty` 引用会绕开包装，看不到。
 *
 * 判定 install / restore：以开始时捕获的原始函数的 id 为基准。
 *   - 新值的 id === 原始 id  → restore
 *   - 否则                    → install
 *
 * 用法（DevTools 控制台可直接粘贴整个文件）：
 *   __MF_INTRINSIC_PROBE__.status()   // 看是否在跑、记录条数
 *   __MF_INTRINSIC_PROBE__.dump()     // 取记录（JSON 字符串）
 *   __MF_INTRINSIC_PROBE__.stop()     // 停掉并还原被包装的两个 API
 */
(function () {
  var NS = '__MF_INTRINSIC_PROBE__'
  if (window[NS] && window[NS].installed) return

  var FT = Function.prototype
  var KEY = 'toString'
  var POLL_MS = 250
  var MAX_RECORDS = 500

  var rawDefine = Object.defineProperty
  var rawReflect = Reflect.defineProperty
  var original = FT[KEY]

  var ids = new WeakMap()   // 弱键：不保留函数
  var nextId = 1
  function idOf (v) {
    if (typeof v !== 'function') return 0
    var hit = ids.get(v)
    if (hit) return hit
    var id = nextId++
    ids.set(v, id)
    return id
  }
  var originalId = idOf(original)
  var currentId = originalId

  var records = []

  /** 取调用栈里的第一个「非基座」URL —— 用来判定补丁是哪个 bundle 装的。只返回字符串。 */
  function bundleFromStack () {
    try {
      var s = String(new Error().stack || '')
      var urls = s.match(/https?:\/\/[^\s)"']+/g)
      if (!urls) return ''
      for (var i = 0; i < urls.length; i++) {
        var u = urls[i]
        if (u.indexOf('/@fs/') === -1 && u.indexOf('/@vite/') === -1 && u.indexOf('/node_modules/') === -1) {
          return u.slice(0, 200)
        }
      }
      return urls[0].slice(0, 200)
    } catch (e) {
      return ''
    }
  }

  /**
   * 可选的堆侧身份标记。
   *
   * 为什么需要它：运行期的数字 id **进不了堆**，所以"被安装的函数"与"堆里某绑定函数
   * 持有的 bound_argument_0"无法直接对上。若在安装时给该函数挂一个**唯一字符串属性**，
   * 之后就能在堆里按这个字符串找到它：
   *
   *   node scripts/heap_find_nodes.js <snapshot> --name=<标记值>       → 找到那个字符串节点
   *   node scripts/heap_root_cut.js <snapshot> --retainers=<该节点>    → 持有它的函数
   *
   * 再与 bound_argument_0 的节点号比对，身份对账即闭合。
   *
   * 代价：会给函数**增加一个自有属性**（不可枚举），属于对运行对象形状的修改——
   * 这正是它默认关闭、需要显式指定标记名的原因。只在诊断会话里用。
   */
  var MARK = (typeof window.__MF_PROBE_MARK__ === 'string' && window.__MF_PROBE_MARK__) ? window.__MF_PROBE_MARK__ : ''

  function onValue (value, how) {
    var id = idOf(value)
    if (id === currentId) return
    var prev = currentId
    currentId = id
    var kind = id === originalId ? 'restore' : 'install'
    var marked = ''
    if (kind === 'install' && MARK) {
      marked = MARK + '-' + id
      try {
        // 用 rawDefine，避免走进自己的包装造成递归
        rawDefine(value, MARK, { value: marked, configurable: true, enumerable: false, writable: true })
      } catch (e) {
        marked = 'mark-failed'
      }
    }
    records.push({
      t: Date.now(),
      kind: kind,
      id: id,
      prevId: prev,
      how: how,
      mark: marked,
      // 只为 install 取栈，控制开销
      bundle: kind === 'restore' ? '' : bundleFromStack(),
    })
    if (records.length > MAX_RECORDS) records.shift()
  }

  function wrapDefine (raw) {
    return function (target, key, desc) {
      var result = raw.apply(this, arguments)
      if (target === FT && key === KEY && desc && 'value' in desc) onValue(desc.value, 'defineProperty')
      return result
    }
  }

  var pollTimer = setInterval(function () {
    // 兜底：直接赋值 `FT.toString = x` 不经过 defineProperty
    onValue(FT[KEY], 'poll')
  }, POLL_MS)

  Object.defineProperty = wrapDefine(rawDefine)
  Reflect.defineProperty = wrapDefine(rawReflect)

  window[NS] = {
    installed: true,
    originalId: originalId,
    status: function () {
      return { installed: true, records: records.length, currentId: currentId, isOriginal: FT[KEY] === original }
    },
    dump: function () { return records.slice() },
    clear: function () { records.length = 0 },
    stop: function () {
      clearInterval(pollTimer)
      Object.defineProperty = rawDefine
      Reflect.defineProperty = rawReflect
      this.installed = false
      return { stopped: true, records: records.length, restoredApis: Object.defineProperty === rawDefine && Reflect.defineProperty === rawReflect }
    },
  }
})()
