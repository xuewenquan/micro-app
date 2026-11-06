'use strict'

/**
 * 微应用实例清单 + 持有者分类。单次遍历建图（含反向边），输出 JSON。
 *
 * 目的：把「活的」与「孤儿」的判定从猜测变成可核对的事实。
 *   - WithSandBox 在构造时执行 `microAppWindow = new CustomWindow()`，
 *     所以「某个 CustomWindow 被 WithSandBox 持有」是它仍属于活沙箱的直接证据。
 *   - 反过来，没有任何 WithSandBox 持有者的 CustomWindow 就是孤儿。
 *
 * 每个实例都带自己的**入边**（全部强引用持有者），因此"谁还拿着它"不需要再猜。
 *
 * 用法：
 *   node --max-old-space-size=12288 scripts/heap_app_audit.js <snapshot> [--out=<json>]
 *        [--names=CreateApp,CustomWindow,WithSandBox,MicroDocument]
 *
 * 输出 JSON：
 *   { snapshot, nodeCount, instances: { <name>: [ {ordinal,type,selfSize,props,holders} ] },
 *     summary: { <name>: count } }
 */

const fs = require('fs')

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']
const STRING_TYPE_IDS = new Set([2, 10, 11])

const args = process.argv.slice(2)
const snapshotPath = args.find((a) => !a.startsWith('--'))
const outArg = args.find((a) => a.startsWith('--out='))
const namesArg = args.find((a) => a.startsWith('--names='))
const WANTED = (namesArg ? namesArg.slice(8) : 'CreateApp,CustomWindow,WithSandBox,MicroDocument,BaseSandBox').split(',').map((s) => s.trim()).filter(Boolean)
if (!snapshotPath) throw new Error('用法: node scripts/heap_app_audit.js <snapshot> [--out=<json>] [--names=A,B]')

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

async function readGraph () {
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

  const edgeType = new Uint8Array(edgeTotal)
  const edgeTarget = new Int32Array(edgeTotal)
  const edgeName = new Uint32Array(edgeTotal)
  field = 0; value = 0; hasValue = false
  let edgeOrdinal = 0
  const et = new Array(3)
  const consumeEdge = () => {
    if (!hasValue) return
    et[field++] = value; value = 0; hasValue = false
    if (field !== 3) return
    field = 0
    edgeType[edgeOrdinal] = et[0]
    edgeName[edgeOrdinal] = et[1]
    edgeTarget[edgeOrdinal] = et[2] / 6
    edgeOrdinal++
  }
  await afterMarker(Buffer.from('"edges":['), (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk[i]
      if (code >= 48 && code <= 57) { value = value * 10 + code - 48; hasValue = true }
      else if (code === 44) consumeEdge()
      else if (code === 93) { consumeEdge(); return false }
    }
    return true
  })
  return { nodeCount: ordinal, types, names, sizes, edgeStart, edgeType, edgeTarget, edgeName, edgeTotal }
}

function buildReverse (g) {
  const n = g.nodeCount
  const indeg = new Int32Array(n)
  for (let e = 0; e < g.edgeTotal; e++) {
    if (g.edgeType[e] === 6) continue
    const t = g.edgeTarget[e]
    if (t < 0 || t >= n) continue
    indeg[t]++
  }
  const revStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) revStart[i + 1] = revStart[i] + indeg[i]
  const total = revStart[n]
  const revNode = new Int32Array(total)
  const revEdge = new Int32Array(total)
  const fill = new Int32Array(n)
  // 按源节点遍历，直接在第二遍里同时填「持有者」和「进来用的那条边」，
  // 不再额外建 edgeSource 数组（那会多占约 363 MB）。
  for (let node = 0; node < n; node++) {
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
      if (g.edgeType[e] === 6) continue
      const t = g.edgeTarget[e]
      if (t < 0 || t >= n) continue
      const at = revStart[t] + fill[t]++
      revNode[at] = node
      revEdge[at] = e
    }
  }
  return { revStart, revNode, revEdge }
}

async function main () {
  process.stderr.write('reading strings…\n')
  const strings = await readStrings()
  process.stderr.write(`strings=${strings.length}\nreading graph…\n`)
  const g = await readGraph()
  process.stderr.write(`nodes=${g.nodeCount} edges=${g.edgeTotal}\nbuilding reverse…\n`)
  const rev = buildReverse(g)
  process.stderr.write('reverse built\n')

  const nameOf = (o) => (o < 0 || o >= g.nodeCount) ? '<oob>' : (strings[g.names[o]] || '')
  const edgeLabel = (e) => {
    const t = g.edgeType[e], raw = g.edgeName[e]
    if (t === 1) return `element:#${raw}`
    if (t === 4 && raw === 0) return 'hidden:<dummy>'
    return `${edgeTypes[t]}:${strings[raw] || ''}`
  }

  // 1) 按名字收集目标实例（只取 object / closure，避开 string 内容误匹配）
  const wantedSet = new Set(WANTED)
  const found = new Map()
  for (const w of WANTED) found.set(w, [])
  for (let i = 1; i < g.nodeCount; i++) {
    const t = g.types[i]
    if (STRING_TYPE_IDS.has(t)) continue
    const nm = strings[g.names[i]] || ''
    if (wantedSet.has(nm)) found.get(nm).push(i)
  }

  // 2) 实例属性 + 入边
  const propsOf = (node, keys) => {
    const out = {}
    for (let e = g.edgeStart[node]; e < g.edgeStart[node + 1]; e++) {
      const t = g.edgeType[e]
      if (t === 6) continue
      const label = edgeLabel(e)
      const bare = label.startsWith('property:') ? label.slice(9) : (label.startsWith('internal:') ? label.slice(9) : label)
      if (keys && !keys.includes(bare)) continue
      const to = g.edgeTarget[e]
      const v = nameOf(to)
      out[bare] = { to, value: v.length > 60 ? `${v.slice(0, 60)}…[${v.length}]` : v, type: nodeTypes[g.types[to]] }
    }
    return out
  }

  const holdersOf = (node) => {
    const out = []
    for (let i = rev.revStart[node]; i < rev.revStart[node + 1]; i++) {
      const e = rev.revEdge[i]
      const from = rev.revNode[i]
      if (from < 0) continue
      out.push({
        from,
        fromName: nameOf(from),
        fromType: nodeTypes[g.types[from]],
        edge: edgeLabel(e),
        fromSize: g.sizes[from],
      })
    }
    return out
  }

  const result = { snapshot: snapshotPath, nodeCount: g.nodeCount, instances: {}, summary: {} }
  const KEYPROPS = {
    CreateApp: ['name', 'appName', 'destroyed', 'sandBox', 'status', 'container', 'appWrapper'],
    WithSandBox: ['microAppWindow', 'proxyWindow', 'appName', 'name', 'destroyed', 'active', 'url'],
    CustomWindow: ['__MICRO_APP_NAME__', '__MICRO_APP_URL__', 'window', 'self', 'globalThis'],
    MicroDocument: ['__MICRO_APP_NAME__', '__MICRO_APP_URL__'],
    BaseSandBox: ['appName', 'name', 'destroyed', 'active', 'url'],
  }

  for (const w of WANTED) {
    const list = found.get(w)
    result.summary[w] = list.length
    result.instances[w] = list.map((ordinal) => ({
      ordinal,
      type: nodeTypes[g.types[ordinal]],
      selfSize: g.sizes[ordinal],
      props: propsOf(ordinal, KEYPROPS[w] || null),
      holders: holdersOf(ordinal),
    }))
  }

  const line = JSON.stringify(result)
  if (outArg) {
    fs.writeFileSync(outArg.slice(6), JSON.stringify(result, null, 2), 'utf8')
    process.stderr.write(`written ${outArg.slice(6)}\n`)
  }
  console.log(line)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
