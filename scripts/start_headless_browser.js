'use strict'

/**
 * 启动一个**可远程调试的无头 Chromium**，供 scripts/gc_once.js、cdp_*.js、
 * cdp_heap_snapshot.js 等脚本连接（默认端口 9222，与既有脚本一致）。
 *
 * 为什么不用 `playwright.launch()`：那会把浏览器交给 Playwright 托管，
 * 已有的 CDP 脚本反而连不上。这里只负责"把浏览器拉起来"，保持 9222 上的
 * 标准 DevTools 协议入口，两套工具可以共用同一个浏览器。
 *
 * ⚠️ 重要：本脚本必须在**普通（非受限沙箱）终端**里运行。
 *    在 DSH 的 workspace-write 沙箱内，Chrome/Chromium 会因为无法创建
 *    Mojo 命名管道而 FATAL 退出（日志里是
 *    `FATAL:mojo\public\cpp\platform\platform_channel.cc: Access denied`），
 *    这不是参数问题。检测到该情况时脚本会直接提示，不再重试。
 *
 * 用法：
 *   node scripts/start_headless_browser.js                     # 无头，http://localhost:3000
 *   node scripts/start_headless_browser.js --url=http://localhost:3000/wd/dashboard
 *   node scripts/start_headless_browser.js --headless=false    # 带界面（排查视觉问题时用）
 *   node scripts/start_headless_browser.js --port=9333 --expose-gc
 *   node scripts/start_headless_browser.js --kill              # 关掉本脚本启动过的实例
 *
 * 参数：
 *   --url=<url>           启动后打开的地址，默认 http://localhost:3000
 *   --port=<n>            调试端口，默认 9222
 *   --headless=<bool>     默认 true；false 时用有头模式（与 Playwright 有头一致）
 *   --profile=<dir>       用户数据目录，默认 <repo>/.browser-profile-heap
 *   --exe=<path>          指定浏览器可执行文件（默认自动探测）
 *   --expose-gc           给页面暴露 window.gc（配合 --js-flags）
 *   --persist             复用已有 profile（保留登录态）；默认每次全新
 *   --keep-open           启动后不退出（前台等待 Ctrl+C）
 *   --kill                结束占用该调试端口的浏览器进程后退出
 */

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

function parseArgs (argv) {
  const out = {
    url: 'http://localhost:3000',
    port: 9222,
    headless: true,
    profile: path.join(ROOT, '.browser-profile-heap'),
    exe: null,
    exposeGc: false,
    persist: false,
    keepOpen: false,
    kill: false,
  }
  for (const arg of argv) {
    if (arg === '--expose-gc') out.exposeGc = true
    else if (arg === '--persist') out.persist = true
    else if (arg === '--keep-open') out.keepOpen = true
    else if (arg === '--kill') out.kill = true
    else if (arg.startsWith('--url=')) out.url = arg.slice(6)
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--profile=')) out.profile = arg.slice(10)
    else if (arg.startsWith('--exe=')) out.exe = arg.slice(6)
    else if (arg.startsWith('--headless=')) out.headless = arg.slice(11) !== 'false'
  }
  return out
}

/** 依次找：显式 --exe、Playwright 缓存里的 chromium、Playwright headless_shell、系统 Chrome。 */
function findExecutable (explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (fs.existsSync(pwCache)) {
    for (const dir of fs.readdirSync(pwCache)) {
      if (/^chromium-\d+$/.test(dir)) {
        candidates.push(path.join(pwCache, dir, 'chrome-win', 'chrome.exe'))
      }
      if (/^chromium_headless_shell-\d+$/.test(dir)) {
        candidates.push(path.join(pwCache, dir, 'chrome-win', 'headless_shell.exe'))
      }
    }
  }
  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  )
  const found = candidates.filter((p) => p && fs.existsSync(p))
  if (!found.length) throw new Error('没有找到可用的浏览器可执行文件，请用 --exe=<path> 指定')
  // 优先 chromium（不是 headless_shell）：headless_shell 缺一些 DevTools 面板能力
  found.sort((a, b) => {
    const score = (p) => (/chromium-\d+[\\/]/.test(p) ? 0 : /headless_shell/.test(p) ? 1 : 2)
    return score(a) - score(b)
  })
  return found[0]
}

function killByPort (port) {
  let killed = 0
  try {
    const ids = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`,
    ], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
    for (const id of ids) {
      try { process.kill(Number(id)); killed++ } catch (_) {}
    }
  } catch (_) {}
  return killed
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp (port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch (_) {}
    await sleep(400)
  }
  return null
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.kill) {
    const n = killByPort(opts.port)
    console.log(`已在端口 ${opts.port} 结束 ${n} 个进程`)
    return
  }

  const existing = await waitForCdp(opts.port, 1200)
  if (existing) {
    console.log(`端口 ${opts.port} 上已经有浏览器在跑：${existing.Browser}`)
    console.log('如果要用全新实例，先执行：node scripts/start_headless_browser.js --kill')
    return
  }

  const exe = findExecutable(opts.exe)
  if (!opts.persist) {
    // 全新 profile：避免上次会话的 localStorage / Service Worker 影响内存基线
    try { fs.rmSync(opts.profile, { recursive: true, force: true }) } catch (_) {}
  }
  fs.mkdirSync(opts.profile, { recursive: true })

  const args = [
    `--remote-debugging-port=${opts.port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${opts.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1600,1000',
  ]
  if (opts.headless) args.push('--headless=new', '--hide-scrollbars')
  if (opts.exposeGc) args.push('--js-flags=--expose-gc')
  args.push(opts.url)

  console.log(`浏览器: ${exe}`)
  console.log(`参数  : ${args.join(' ')}`)
  const logDir = path.join(ROOT, 'heap-analysis')
  fs.mkdirSync(logDir, { recursive: true })
  opts.logFile = path.join(logDir, 'chromium-launch.err.log')
  const errFd = fs.openSync(opts.logFile, 'w')
  const child = spawn(exe, args, { detached: true, stdio: ['ignore', 'ignore', errFd] })
  child.unref()
  try { fs.closeSync(errFd) } catch (_) {}

  const version = await waitForCdp(opts.port)
  if (!version) {
    // 把浏览器的 stderr 读回来，给出可行动的结论，而不是让人反复换参数
    let hint = ''
    try {
      const raw = fs.readFileSync(opts.logFile)
      // Chrome 的 stderr 可能是 UTF-16LE（带 BOM），这里统一成 UTF-8 文本再匹配
      let tail = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE
        ? raw.toString('utf16le').slice(-4000)
        : raw.toString('utf8').slice(-4000)
      tail = tail.replace(/^\uFEFF/, '')
      if (/platform_channel\.cc|crash server failed to launch|OpenProcess: (Access is denied|拒绝访问)|拒绝访问|Access is denied/i.test(tail)) {
        hint = '\n诊断：浏览器无法创建 Mojo 命名管道 / 无法访问同级进程（日志里的 ' +
          '"OpenProcess: 拒绝访问 (0x5)"），随即自终止。\n' +
          '      这是**受限沙箱环境**造成的，和启动参数无关。\n' +
          '      请在"自己的"终端里启动：在资源管理器里**双击** scripts\\start-headless-browser.cmd，\n' +
          '      或从开始菜单新开一个 PowerShell 窗口再执行本命令（不要用 DSH / Codex 的沙箱终端）。'
      } else if (!tail.trim()) {
        hint = '\n浏览器 stderr 是空的：说明进程还没来得及报错就被结束了，' +
          '典型原因是它运行在受限沙箱里（沙箱会在父进程退出时一并结束子进程）。\n' +
          '      请改用双击 scripts\\start-headless-browser.cmd 的方式启动。'
      }
    } catch (_) {}
    console.error(`启动后 ${opts.port} 端口仍无响应。${hint}`)
    console.error(`浏览器 stderr 日志：${opts.logFile}`)
    process.exitCode = 1
    return
  }

  const list = await (await fetch(`http://127.0.0.1:${opts.port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  console.log('')
  console.log(`已启动：${version.Browser}`)
  console.log(`调试端口：http://127.0.0.1:${opts.port}`)
  console.log(`当前页面：${page ? page.url : '(none)'}`)
  console.log('')
  console.log('接下来可以：')
  console.log(`  node scripts/gc_once.js --port=${opts.port} --url-match=localhost:3000 --clear-console`)
  console.log(`  node scripts/cdp_memory_probe.js --port=${opts.port} --url-match=localhost:3000`)
  console.log(`  node scripts/cdp_heap_snapshot.js --port=${opts.port}`)
  console.log(`  关闭：node scripts/start_headless_browser.js --port=${opts.port} --kill`)

  if (opts.keepOpen) {
    console.log('\n--keep-open：按 Ctrl+C 退出本脚本（浏览器不会被关闭）')
    await new Promise(() => {})
  }
}

main().catch((e) => { console.error(String(e && e.message ? e.message : e)); process.exitCode = 1 })
