'use strict'

/**
 * 受控诊断驱动器：把 `intrinsic_probe_payload.js` 注入页面，监听
 * `Function.prototype.toString` 的「安装 / 还原」事件，跑完一轮后取回记录。
 *
 * ⚠️ **这不是无侵入手段，必须当作受控诊断使用：**
 *   - 注入体会替换 `Object.defineProperty` / `Reflect.defineProperty`，
 *     可能影响第三方库的特性检测，也可能改变描述符处理路径；
 *   - 覆盖不全：直接赋值靠 250ms 轮询兜底（有延迟）；注入**之前**已被缓存的
 *     API 引用会绕开包装。**"没记录到"不能当作"没发生"**；
 *   - 因此：**只跑一次性会话**，跑完本脚本会自动 `stop()` 并校验两个 API 已还原。
 *
 * 与 `cdp_heap_snapshot.js` 的关系：那个脚本刻意不启用 `Runtime` 以保住内存读数，
 * **两者不要同时跑**。
 *
 * 用法：
 *   # 注入并等一轮操作（默认 600 秒）
 *   node scripts/cdp_intrinsic_probe.js --seconds=600
 *
 *   # 只停止并取回（先前的注入还在跑）
 *   node scripts/cdp_intrinsic_probe.js --stop
 *
 *   # 只查看当前状态，不改动任何东西
 *   node scripts/cdp_intrinsic_probe.js --status
 *
 *   # 打开堆侧身份标记（见下），标记名自定
 *   node scripts/cdp_intrinsic_probe.js --mark=mfprobe --seconds=600
 *
 * 参数：--port=9222  --url-match=<s>  --seconds=<n>  --out=<json 文件>  --mark=<名字>
 *
 * `--mark` 说明：运行期的数字 id 进不了堆，无法直接与 `bound_argument_0` 的节点号对上。
 * 打开标记后，安装时会给该函数挂一个**唯一字符串属性**（不可枚举），之后即可在堆里检索：
 *
 *   node scripts/heap_find_nodes.js <snapshot> --name=<标记名>-<id>      # 找到那个字符串
 *   node scripts/heap_root_cut.js <snapshot> --retainers=<字符串节点>     # 找到持有它的函数
 *
 * 再把该函数的节点号与 `bound_argument_0` 比对，身份对账即闭合。
 * **代价：会给函数增加一个自有属性，属于对运行对象形状的修改**——所以它默认关闭。
 */

const fs = require('fs')
const path = require('path')

const PAYLOAD = path.join(__dirname, 'intrinsic_probe_payload.js')
const NS = '__MF_INTRINSIC_PROBE__'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseArgs (argv) {
  const out = { port: 9222, seconds: 600, urlMatch: null, stop: false, status: false, out: null, mark: null }
  for (const arg of argv) {
    if (arg === '--stop') out.stop = true
    else if (arg === '--status') out.status = true
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--seconds=')) out.seconds = Number(arg.slice(10))
    else if (arg.startsWith('--out=')) out.out = arg.slice(6)
    else if (arg.startsWith('--mark=')) out.mark = arg.slice(7)
  }
  return out
}

/** 与 cdp_heap_snapshot.js 相同的 WebSocket 兼容层。 */
function connect (url) {
  let WS = null
  try { WS = require('ws') } catch (_) { /* 退回内置实现 */ }
  if (!WS) {
    if (typeof WebSocket === 'undefined') throw new Error('需要 Node ≥ 22（内置 WebSocket）或在仓库内安装 ws 包')
    WS = WebSocket
  }
  const socket = new WS(url)
  const handlers = { message: [], open: [], error: [], close: [] }
  const emit = (name, payload) => handlers[name].slice().forEach((fn) => fn(payload))
  const isNodeWs = typeof socket.on === 'function' && typeof socket.addEventListener !== 'function'
  if (isNodeWs) {
    socket.on('message', (data) => emit('message', String(data)))
    socket.on('open', () => emit('open'))
    socket.on('error', (error) => emit('error', error))
    socket.on('close', () => emit('close'))
  } else {
    socket.addEventListener('message', (event) => emit('message', typeof event.data === 'string' ? event.data : String(event.data)))
    socket.addEventListener('open', () => emit('open'))
    socket.addEventListener('error', (error) => emit('error', error))
    socket.addEventListener('close', () => emit('close'))
  }
  return { on: (name, fn) => handlers[name].push(fn), send: (d) => socket.send(d), close: () => socket.close() }
}

async function pickTarget ({ port, urlMatch }) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`无法访问调试端口 ${port}，请确认 Chrome 以 --remote-debugging-port=${port} 启动`)
  const targets = await res.json()
  const pages = targets.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''))
  if (!pages.length) throw new Error('没有找到 http(s) 页面标签')
  if (urlMatch) {
    const hit = pages.find((t) => (t.url || '').includes(urlMatch))
    if (!hit) throw new Error(`没有匹配 --url-match=${urlMatch} 的标签，现有：${pages.map((p) => p.url).join(', ')}`)
    return hit
  }
  return pages[0]
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const target = await pickTarget(opts)
  process.stderr.write(`目标页面: ${target.url}\n`)

  const ws = connect(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  ws.on('message', (data) => {
    const msg = JSON.parse(data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result)
    }
  })

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (error) => reject(new Error(`CDP WebSocket 连接失败: ${error && error.message ? error.message : error}`)))
  })

  await send('Runtime.enable')

  /** 求值并返回 JSON 解析后的值（一律走字符串，不传对象）。 */
  const evalJson = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`页面内求值异常: ${r.exceptionDetails.text || ''} ${(r.exceptionDetails.exception || {}).description || ''}`)
    return r.result && typeof r.result.value === 'string' ? JSON.parse(r.result.value) : null
  }

  const installed = await evalJson(`String(!!(window.${NS} && window.${NS}.installed))`)

  if (opts.status) {
    if (!installed) { process.stderr.write('未注入（或已停止）。\n'); ws.close(); return }
    const st = await evalJson(`JSON.stringify(window.${NS}.status())`)
    console.log(JSON.stringify(st, null, 2))
    ws.close()
    return
  }

  if (!opts.stop) {
    if (installed) {
      process.stderr.write('⚠️ 检测到已注入，跳过注入（避免重复包装）。\n')
    } else {
      if (opts.mark) {
        if (!/^[A-Za-z_$][\w$-]*$/.test(opts.mark)) throw new Error('--mark 只允许字母/数字/下划线/连字符，且不能以数字开头')
        await send('Runtime.evaluate', {
          expression: `window.__MF_PROBE_MARK__ = ${JSON.stringify(opts.mark)}`,
          returnByValue: true,
        })
        process.stderr.write(`已启用堆侧身份标记，属性名: ${opts.mark}\n`)
        process.stderr.write('⚠️ 标记会给被安装的函数**增加一个自有属性**，属于对运行对象形状的修改。\n')
      }
      const payload = fs.readFileSync(PAYLOAD, 'utf8')
      await send('Runtime.evaluate', { expression: payload, returnByValue: true })
      process.stderr.write('已注入观察器。\n')
      process.stderr.write('⚠️ 注意：这会替换 Object/Reflect.defineProperty，属于受控诊断，跑完会自动还原。\n')
    }
    process.stderr.write(`\n请在页面里完成一轮操作（开几个 tab 再关掉）。监听 ${opts.seconds} 秒…\n\n`)
    const deadline = Date.now() + opts.seconds * 1000
    while (Date.now() < deadline) {
      await sleep(3000)
      try {
        const st = await evalJson(`JSON.stringify(window.${NS}.status())`)
        process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] 记录 ${st.records} 条（isOriginal=${st.isOriginal}）\n`)
      } catch (_) { /* 页面可能正在跳转 */ }
    }
  }

  // 取回并停止
  const records = installed || !opts.stop ? await evalJson(`JSON.stringify(window.${NS}.dump())`) : []
  const stopped = await evalJson(`JSON.stringify(window.${NS}.stop())`)

  if (opts.out && records) fs.writeFileSync(opts.out, JSON.stringify(records, null, 2), 'utf8')
  if (opts.out) process.stderr.write(`原始记录已写入 ${opts.out}\n`)

  process.stderr.write(`\n已停止观察器：${JSON.stringify(stopped)}\n\n`)

  // 汇总
  const list = records || []
  const installs = list.filter((r) => r.kind === 'install')
  const restores = list.filter((r) => r.kind === 'restore')
  console.log(`记录 ${list.length} 条：install ${installs.length} / restore ${restores.length}`)
  if (installs.length) {
    console.log('\ninstall 事件（bundle 由调用栈字符串判定）：')
    for (const r of installs) console.log(`  id=${r.id}  how=${r.how}  bundle=${r.bundle || '(栈里没有可用 URL)'}`)
  }
  if (restores.length) {
    console.log('\nrestore 事件：')
    for (const r of restores) console.log(`  id=${r.id}  how=${r.how}`)
  }
  const marks = installs.filter((r) => r.mark && r.mark !== 'mark-failed')
  if (marks.length) {
    console.log('\n堆侧身份对账（按序执行）：')
    for (const r of marks) {
      console.log(`  标记值 ${r.mark}:`)
      console.log(`    node --max-old-space-size=16384 scripts/heap_find_nodes.js <snapshot> --name=${r.mark}`)
      console.log(`    node --max-old-space-size=16384 scripts/heap_root_cut.js <snapshot> --retainers=<上一步的节点号> --retainerDepth=1`)
      console.log('    → 得到持有该标记的函数节点号，与 bound_argument_0 的节点号比对')
    }
  } else if (installs.length) {
    console.log('\n提示：未启用 --mark，运行期 id 无法进入堆，身份对账只能靠「bundle URL + 函数名 + 时序」间接推断。')
    console.log('      需要确定性结论请加 --mark=<名字> 重跑。')
  }

  console.log('\n判读提示：')
  console.log('  - 身份对账还需要**堆侧**配合：把这里 install 事件的 id/bundle，与 18.6.7 里')
  console.log('    app-ws 绑定函数的 bound_argument_0（其脚本 URL）对齐，才能确认「捕获的就是被还原的那个」。')
  console.log('  - 覆盖局限：直接赋值靠 250ms 轮询兜底；注入前已缓存的 API 引用会绕开包装。')
  console.log('    **没记录到 ≠ 没发生。**')

  ws.close()
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
})
