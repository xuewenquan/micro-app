'use strict'

/**
 * 统计 Blink 侧 CSS 结构规模：样式表、规则、选择器、属性集、<style> 元素。
 * 用于判断「页面只有几千个 DOM 节点，却有 220 个样式表 / 2.5 万条规则」是否异常。
 *
 * 只读 nodes 段。
 *
 * 用法：
 *   node --max-old-space-size=8192 scripts/heap_css_audit.js <snapshot>
 */

const fs = require('fs')

const STRING_TYPE_IDS = new Set([2, 10, 11])
const snapshot = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!snapshot) throw new Error('Usage: node scripts/heap_css_audit.js <snapshot>')

async function afterMarker (marker, handler) {
  const stream = fs.createReadStream(snapshot, { highWaterMark: 16 * 1024 * 1024 })
  let tail = Buffer.alloc(0)
  let found = false
  for await (const chunk of stream) {
    if (!found) {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk
      const offset = data.indexOf(marker)
      if (offset < 0) { tail = data.subarray(Math.max(0, data.length - marker.length + 1)); continue }
      found = true
      if (handler(data.subarray(offset + marker.length)) === false) break
    } else if (handler(chunk) === false) break
  }
  if (!found) throw new Error('Marker not found')
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

const RULES = [
  [/^blink::StyleSheetContents/, 'StyleSheetContents（样式表内容）'],
  [/^blink::StyleRule/, 'StyleRule（规则）'],
  [/CSSSelector/, 'CSSSelector（选择器）'],
  [/ImmutableCSSPropertyValueSet|MutableCSSPropertyValueSet/, 'CSSPropertyValueSet（属性集）'],
  [/^blink::CSSStyleSheet$/, 'CSSStyleSheet（样式表对象）'],
  [/HeapVectorBacking/, 'HeapVectorBacking（数组后备存储）'],
  [/RuleSet|CSSRuleList/, 'RuleSet / CSSRuleList'],
  [/^<style/, '<style> 元素'],
  [/^<link/, '<link> 元素'],
  [/CSSVariableData|CSSUnparsed|CSSValueList|CSSFunction|CSSNumeric/, 'CSS 变量/函数等'],
  [/StyleSheet/, '其它 StyleSheet*'],
]

async function main () {
  const strings = await readStrings()
  const groups = new Map()
  const styleElementSamples = []
  const linkElementSamples = []
  let cssBytes = 0, ordinal = 0

  let field = 0, value = 0, hasValue = false
  const tuple = new Array(6)
  const consume = () => {
    if (!hasValue) return
    tuple[field++] = value; value = 0; hasValue = false
    if (field !== 6) return
    field = 0
    const typeId = tuple[0]
    const name = strings[tuple[1]] || ''
    const selfSize = tuple[3]
    if (!STRING_TYPE_IDS.has(typeId)) {
      for (const [re, label] of RULES) {
        if (re.test(name)) {
          const row = groups.get(label) || { count: 0, bytes: 0 }
          row.count++; row.bytes += selfSize
          groups.set(label, row)
          cssBytes += selfSize
          if (label === '<style> 元素' && styleElementSamples.length < 8) styleElementSamples.push(name.slice(0, 150))
          if (label === '<link> 元素' && linkElementSamples.length < 8) linkElementSamples.push(name.slice(0, 150))
          break
        }
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

  const mb = (b) => +(b / 1048576).toFixed(2)
  console.log(JSON.stringify({
    file: snapshot,
    cssTotalMB: mb(cssBytes),
    groups: [...groups.entries()].map(([name, row]) => ({ name, count: row.count, mb: mb(row.bytes) })).sort((a, b) => b.mb - a.mb),
    styleElementSamples,
    linkElementSamples,
  }, null, 2))
}

main().catch((e) => { console.error(String(e && e.stack ? e.stack : e)); process.exitCode = 1 })
