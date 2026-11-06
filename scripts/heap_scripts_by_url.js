'use strict'

/**
 * 按 source_url 归组所有 `system / Script` 节点，回答两个问题：
 *   1. 每个 bundle 在堆里有**几份** Script（micro-app 用 new Function 执行子应用代码，
 *      每次执行都会产生一个新的 Script）；
 *   2. 每份 Script 各自的源码字符串有多大、被多少个 SharedFunctionInfo 引用。
 *
 * 用法：
 *   node --max-old-space-size=10240 scripts/heap_scripts_by_url.js <snapshot> [--top=60]
 *        [--filter=<url 子串>] [--out=<json>]
 *
 * 输出 JSON：{ totals, byUrl: [{ url, scripts, sourceBytes, sfiCount, ordinals }] }
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']

const args = process.argv.slice(2)
const snapshotPath = args.find((a) => !a.startsWith('--'))
const topArg = args.find((a) => a.startsWith('--top='))
const TOP = topArg ? Number(topArg.slice(6)) : 60
const filterArg = args.find((a) => a.startsWith('--filter='))
const FILTER = filterArg ? filterArg.slice(9) : null
const outArg = args.find((a) => a.startsWith('--out='))
if (!snapshotPath) throw new Error('用法: node scripts/heap_scripts_by_url.js <snapshot> [--top=N] [--filter=s] [--out=j]')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshotPath, { highWaterMark: 16 * 1024 * 1024 })
  let tail = Buffer.alloc(0)
  let found = false
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) {
        tail = data.subarray(Math.max(0, data.length - marker.length + 1))
        continue
      }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }
  if (!found) throw new Error(`Marker not found: ${marker}`)
}

function readNodeCount () {
  const fd = fs.openSync(snapshotPath, 'r')
  const buf = Buffer.alloc(4096)
  const read = fs.readSync(fd, buf, 0, 4096, 0)
  fs.closeSync(fd)
  const match = buf.toString('utf8', 0, read).match(/"node_count":(\d+)/)
  if (!match) throw new Error('node_count not found')
  return Number(match[1]) + 1
}

async function readStrings () {
  const strings = []
  let token = '', inString = false, escaped = false
  await afterMarker(Buffer.from('"strings":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const char = String.fromCharCode(chunk[i])
      if (!inString) {
        if (char === ']') return false
        if (char === '"') { inString = true; token = '"' }
      } else {
        token += char
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') { strings.push(JSON.parse(token)); token = ''; inString = false }
      }
    }
    return true
  })
  return strings
}

async function readNodes () {
  const N = readNodeCount()
  const types = new Uint8Array(N)
  const names = new Uint32Array(N)
  const sizes = new Uint32Array(N)
  const edgeStart = new Int32Array(N + 1)
  let field = 0, value = 0, hasValue = false, ordinal = 0, edgeTotal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    types[ordinal] = tuple[0]; names[ordinal] = tuple[1]; sizes[ordinal] = tuple[3]
    edgeStart[ordinal] = edgeTotal
    edgeTotal += tuple[4]
    ordinal++
  }
  await afterMarker(Buffer.from('"nodes":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })
  edgeStart[ordinal] = edgeTotal
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeTotal }
}

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  const g = await readNodes()
  process.stderr.write(`strings=${strings.length} nodes=${g.nodeCount} edges=${g.edgeTotal}\n`)

  // 1) 找出所有 Script 节点（名字就是 "system / Script"）
  const isScript = new Uint8Array(g.nodeCount)
  let scriptTotal = 0
  for (let i = 0; i < g.nodeCount; i++) {
    /**
     * 注意名字有两种形态：
     *   `system / Script`                —— 没有 source_url 的
     *   `system / Script / <url>`        —— **URL 直接拼在名字里**
     * 早先只精确匹配前者，会把所有带 URL 的 Script 全部漏掉，
     * 导致「某 bundle 有几份副本」这类统计系统性偏低（见报告 §13.41 的工具 bug）。
     */
    if ((strings[g.names[i]] || '').startsWith('system / Script')) { isScript[i] = 1; scriptTotal++ }
  }
  process.stderr.write(`scripts=${scriptTotal}\n`)

  // 2) 扫边：给每个 Script 取 source_url；统计指向它的 script 边（SFI/closure 引用数）
  const urlOf = new Map()      // scriptOrdinal -> url
  const srcBytes = new Map()   // scriptOrdinal -> source string selfSize
  const srcType = new Map()    // scriptOrdinal -> source 节点的 node type（10=cons 11=sliced）
  const srcTarget = new Map()  // scriptOrdinal -> source 节点 ordinal
  const refCount = new Int32Array(g.nodeCount)
  /**
   * cons string（type 10）与 sliced string（type 11）的 self_size 只算节点本身，
   * 真正的字符在子节点 / 父节点里。若不补回来，这些 Script 的源码会被量成 ~0.00 MB，
   * 总量就成了**低估**。这里把一层子节点的 self_size 累加回来。
   */
  const indirect = new Float64Array(g.nodeCount)
  const CONS = 10, SLICED = 11
  let field = 0, value = 0, hasValue = false
  let source = 0
  let remaining = g.edgeStart[1] - g.edgeStart[0]
  const tuple = new Array(3)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    const [type, nameOrIndex, toOffset] = tuple
    const target = toOffset / 6
    if (type !== 1 && type !== 4) {
      const nm = strings[nameOrIndex] || ''
      if (isScript[source] === 1 && nm === 'source_url' && target < g.nodeCount) {
        urlOf.set(source, strings[g.names[target]] || '(empty)')
      } else if (isScript[source] === 1 && nm === 'source') {
        // 注意：这里要量的是 **source 字符串本身**（包裹后的 bundle 源码），
        // 不是 source_url（那只是 URL，几十字节）。搞混会让结果全部显示成 0.00 MB。
        srcBytes.set(source, g.sizes[target])
        srcType.set(source, g.types[target])
        srcTarget.set(source, target)
      } else if ((g.types[source] === CONS || g.types[source] === SLICED) && target < g.nodeCount) {
        // cons 串的 first/second、sliced 串的 parent：把内容挂在来源节点上
        indirect[source] += g.sizes[target]
      } else if (nm === 'script' && isScript[target] === 1) {
        refCount[target]++
      }
    }
    if (--remaining <= 0) {
      do {
        source++
        remaining = source < g.nodeCount ? g.edgeStart[source + 1] - g.edgeStart[source] : 0
      } while (source < g.nodeCount && remaining === 0)
    }
  }
  await afterMarker(Buffer.from('"edges":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consume()
      else if (code === 93) { consume(); return false }
    }
    return true
  })

  /**
   * 3) 按 URL 归组
   *
   * URL 有两个来源，缺一不可：
   *   a) `source_url` 边 —— micro-app 包裹后的脚本（`//# sourceURL=`）走这条；
   *   b) **节点名 `system / Script / <url>`** —— Vite/模块脚本走这条，它们**没有 source_url 边**。
   * 早先只看 (a)，导致 demo 里 121 个 Script 全部被报成"有 URL 的 0 个"。
   */
  for (let i = 0; i < g.nodeCount; i++) {
    if (isScript[i] !== 1 || urlOf.has(i)) continue
    const nm = strings[g.names[i]] || ''
    const m = nm.match(/^system \/ Script \/ (.+)$/)
    if (m) urlOf.set(i, m[1])
    else if (nm === 'system / Script') urlOf.set(i, '(no url)')
  }

  const byUrl = new Map()
  for (const [ord, url] of urlOf) {
    if (FILTER && !url.includes(FILTER)) continue
    const key = url.length > 160 ? `${url.slice(0, 160)}…` : url
    let row = byUrl.get(key)
    if (!row) { row = { url: key, scripts: 0, sourceBytes: 0, sfiCount: 0, selfSize: 0, ordinals: [] }; byUrl.set(key, row) }
    row.scripts++
    // 用「直接 self_size + 间接子节点」的口径，否则 cons/sliced 源码会被量成 0
    const st = srcTarget.get(ord)
    row.sourceBytes += (srcBytes.get(ord) || 0) + (st !== undefined ? indirect[st] : 0)
    const ty = srcType.get(ord)
    if (ty === CONS) row.consScripts = (row.consScripts || 0) + 1
    else if (ty === SLICED) row.slicedScripts = (row.slicedScripts || 0) + 1
    row.sfiCount += refCount[ord]
    row.selfSize += g.sizes[ord]
    if (row.ordinals.length < 40) row.ordinals.push(ord)
  }
  const list = [...byUrl.values()].sort((a, b) => b.sourceBytes - a.sourceBytes)
  const totals = list.reduce((acc, r) => ({
    scripts: acc.scripts + r.scripts,
    sourceBytes: acc.sourceBytes + r.sourceBytes,
    sfiCount: acc.sfiCount + r.sfiCount,
    urls: acc.urls + 1,
  }), { scripts: 0, sourceBytes: 0, sfiCount: 0, urls: 0 })

  const result = {
    snapshot: snapshotPath,
    scriptTotal,
    scriptWithUrl: urlOf.size,
    totals,
    byUrl: list.slice(0, TOP),
    urlCount: list.length,
  }
  if (outArg) fs.writeFileSync(outArg.slice(6), JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify(result))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
