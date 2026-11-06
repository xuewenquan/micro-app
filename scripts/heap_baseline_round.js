'use strict'

/**
 * 内存基线的一轮采集：一条命令完成
 *   1) 通过 CDP 抓快照（不打开 DevTools 面板）
 *   2) 算指标并追加到 <out-dir>/baseline.jsonl
 *   3) 打印到目前为止的轮次表 + 与上一轮的差值
 *
 * 用法：
 *   node scripts/heap_baseline_round.js --out-dir=E:/heap-baseline
 *   node scripts/heap_baseline_round.js --out-dir=E:/heap-baseline --label=init
 *   node scripts/heap_baseline_round.js --out-dir=E:/heap-baseline --dominators
 *
 * 参数：
 *   --out-dir=<dir>     必填。快照与 baseline.jsonl 都放这里
 *   --label=<name>      指定这一轮的标签。不给则自动递增（round-1、round-2…）
 *                       「初始化」那份建议显式给 --label=init
 *   --dominators        同时算最大 retained size 节点（很慢，大文件约 20 分钟，建议只在关键轮次用）
 *   --port=<n>          CDP 调试端口，默认 9222
 *   --url-match=<str>   多标签时选择页面的子串
 *   --settle=<ms>       GC 后的等待时间，默认 800
 *   --no-gc             抓之前不强制 GC（默认会强制）
 *   --force             允许覆盖已存在的同名快照
 *
 * 前置条件：Chrome 必须以调试端口启动（见 docs/memory-leak-findings.md 16.3）
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-heap-profile" --js-flags="--expose-gc" http://localhost:3000
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function parseArgs (argv) {
  const out = { port: 9222, gc: true, force: false, dominators: false, settle: 800, urlMatch: null, label: null, outDir: null }
  for (const arg of argv) {
    if (arg === '--dominators') out.dominators = true
    else if (arg === '--no-gc') out.gc = false
    else if (arg === '--force') out.force = true
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice(10)
    else if (arg.startsWith('--label=')) out.label = arg.slice(8)
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice(7))
    else if (arg.startsWith('--url-match=')) out.urlMatch = arg.slice(12)
    else if (arg.startsWith('--settle=')) out.settle = Number(arg.slice(9))
  }
  return out
}

function readRounds (jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return []
  return fs.readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line) } catch (_) { return null } })
    .filter(Boolean)
}

function nextRoundLabel (rows) {
  let max = 0
  for (const row of rows) {
    const m = /^round-(\d+)$/.exec(row.label || '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `round-${max + 1}`
}

function fmt (value, digits = 1) {
  return value === undefined || value === null ? '-' : Number(value).toFixed(digits)
}

function delta (now, prev) {
  if (prev === undefined || prev === null || now === undefined || now === null) return ''
  const d = now - prev
  const sign = d > 0 ? '+' : ''
  return `${sign}${d.toFixed(1)}`
}

function printTable (rows) {
  const header = ['label', 'heapMB', 'Δheap', 'nodes', 'Δnodes', 'detached', 'Δdet', 'cWin', 'mdoc', 'createApp', 'destroyed', 'apps', 'cssMB']
  const body = rows.map((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null
    return [
      String(row.label),
      fmt(row.heapSelfMB),
      prev ? delta(row.heapSelfMB, prev.heapSelfMB) : '',
      String(row.nodeCount ?? '-'),
      prev ? (row.nodeCount - prev.nodeCount >= 0 ? '+' : '') + (row.nodeCount - prev.nodeCount) : '',
      String(row.detachedDOM ?? '-'),
      prev ? (row.detachedDOM - prev.detachedDOM >= 0 ? '+' : '') + (row.detachedDOM - prev.detachedDOM) : '',
      String(row.customWindow ?? '-'),
      String(row.microDocument ?? '-'),
      String(row.createApp ?? '-'),
      String(row.createAppDestroyed ?? '-'),
      String(row.apps ?? '-'),
      fmt(row.parsedCSS && row.parsedCSS.mb, 1),
    ]
  })
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log('')
  console.log(line(header))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  body.forEach((r) => console.log(line(r)))
  console.log('')
}

function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.outDir) {
    throw new Error('必须指定 --out-dir=<dir>。用法见文件头部注释。')
  }

  const outDir = path.resolve(opts.outDir)
  fs.mkdirSync(outDir, { recursive: true })
  const jsonlPath = path.join(outDir, 'baseline.jsonl')
  const rows = readRounds(jsonlPath)
  const label = opts.label || nextRoundLabel(rows)

  const snapshotPath = path.join(outDir, `${label}.heapsnapshot`)
  if (fs.existsSync(snapshotPath) && !opts.force) {
    throw new Error(`快照已存在：${snapshotPath}\n（要覆盖请加 --force；要另存请用 --label=<新名字>）`)
  }

  // ---- 1) 抓快照 ----
  // node 开关必须排在脚本路径之前。默认堆上限对 2 GB 级快照偏紧：分片在落盘前
  // 会先经过 Node 堆，堆不够时收尾阶段容易出问题。
  const cdpArgs = ['--max-old-space-size=16384', path.join(__dirname, 'cdp_heap_snapshot.js'), `--out=${snapshotPath}`, `--port=${opts.port}`, `--settle=${opts.settle}`]
  if (opts.gc) cdpArgs.push('--gc')
  if (opts.urlMatch) cdpArgs.push(`--url-match=${opts.urlMatch}`)

  console.log(`[${label}] 通过 CDP 抓快照…`)
  const snap = spawnSync(process.execPath, cdpArgs, { stdio: 'inherit' })
  if (snap.status !== 0) {
    throw new Error('抓快照失败。请确认：Chrome 已用 --remote-debugging-port 启动，且页面已打开。')
  }

  // ---- 2) 算指标 ----
  const metricsArgs = ['--max-old-space-size=16384', path.join(__dirname, 'heap_metrics.js'), snapshotPath, `--label=${label}`]
  if (opts.dominators) metricsArgs.push('--dominators')

  console.log(`[${label}] 计算指标…`)
  const metrics = spawnSync(process.execPath, metricsArgs, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (metrics.status !== 0 || !metrics.stdout) {
    if (metrics.stderr) process.stderr.write(metrics.stderr)
    throw new Error('指标计算失败。')
  }
  const row = JSON.parse(metrics.stdout.trim().split('\n').pop())

  // ---- 3) 追加并打印 ----
  fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n', 'utf8')
  printTable([...rows, row])

  // 用全部轮次推算，而不是用当前标签推算 —— 否则跑了 --label=init 之后
  // 会错误地提示 round-1（实际自动递增取的是「已存在的最大 round-N + 1」）。
  const nextLabel = nextRoundLabel([...rows, row])
  console.log(`已追加到 ${jsonlPath}`)
  console.log(`快照：${snapshotPath}`)
  if (row.topAnchor) {
    console.log(`最大锚点：${row.topAnchor.type} ${row.topAnchor.ordinal} retained=${row.topAnchor.retainedMB} MB  ${row.topAnchor.name.slice(0, 60)}`)
  }
  console.log(`下一轮标签：${nextLabel}（不指定 --label 时会自动用它）`)
}

try {
  main()
} catch (error) {
  console.error(String(error && error.message ? error.message : error))
  process.exitCode = 1
}
