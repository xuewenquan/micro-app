'use strict'

/**
 * 游离 DOM 的**自身体量**统计。
 *
 * 为什么需要这个：`heap_metrics.js` 的 `domAll.detached` 给出的是**个数**（111,318 个），
 * 但个数不等于体量。Blink 的 DOM 原生节点每个只有 ~100 多字节，111k 个合起来也就十几 MB，
 * 真正的几百 MB 在**持有它们的 JS 图**（Vue 组件实例 / vnode / store / 闭包）里。
 * 不把这两个量分开，就会把"个数的指示作用"误读成"体量就在这里"。
 *
 * 用法：
 *   node --max-old-space-size=8192 scripts/heap_detached_size.js <snapshot>
 *
 * 输出：已挂载 / 游离 两类的节点数、自身字节合计、均值，以及游离子集中
 * 自身字节最大的若干节点（用来判断是否存在少数超大游离子树）。
 */

const fs = require('fs')

const snapshotPath = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!snapshotPath) throw new Error('用法: node scripts/heap_detached_size.js <snapshot>')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']

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

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()

  const acc = { attached: { n: 0, bytes: 0 }, detached: { n: 0, bytes: 0 }, unknown: { n: 0, bytes: 0 } }
  let nativeTotal = { n: 0, bytes: 0 }
  const bigDetached = []

  let field = 0, value = 0, hasValue = false, ordinal = 0
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    const [type, nameIdx, , selfSize, , detachedness] = tuple
    // 8 = native。只有 native 才有 Blink 提供的 detachedness。
    if (type === 8) {
      nativeTotal.n++
      nativeTotal.bytes += selfSize
      const bucket = detachedness === 1 ? acc.attached : detachedness === 2 ? acc.detached : acc.unknown
      bucket.n++
      bucket.bytes += selfSize
      if (detachedness === 2 && selfSize >= 1024) {
        bigDetached.push({ ordinal, selfSize, name: (strings[nameIdx] || '').slice(0, 90) })
      }
    }
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

  const MB = (b) => +(b / 1048576).toFixed(2)
  bigDetached.sort((a, b) => b.selfSize - a.selfSize)
  console.log(JSON.stringify({
    snapshot: snapshotPath,
    natives: {
      totalNodes: nativeTotal.n,
      totalMB: MB(nativeTotal.bytes),
      attached: { nodes: acc.attached.n, MB: MB(acc.attached.bytes), avgBytes: acc.attached.n ? Math.round(acc.attached.bytes / acc.attached.n) : 0 },
      detached: { nodes: acc.detached.n, MB: MB(acc.detached.bytes), avgBytes: acc.detached.n ? Math.round(acc.detached.bytes / acc.detached.n) : 0 },
      unknown: { nodes: acc.unknown.n, MB: MB(acc.unknown.bytes) },
    },
    biggestDetached: bigDetached.slice(0, 15).map((r) => ({ ...r, MB: MB(r.selfSize) })),
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
