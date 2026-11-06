'use strict'

// 临时诊断脚本：检查 heapsnapshot 是否完整、几个关键 marker 的绝对偏移。
// 用完即删。
const fs = require('fs')

const file = process.argv[2]
const markers = ['"nodes":[', '"edges":[', '"strings":[', '"trace_function_infos":[', '"locations":[']

const stat = fs.statSync(file)
console.log('file    :', file)
console.log('size    :', stat.size)

const fd = fs.openSync(file, 'r')
const head = Buffer.alloc(200)
fs.readSync(fd, head, 0, 200, 0)
console.log('head    :', JSON.stringify(head.toString('utf8')))
const tailLen = Math.min(300, stat.size)
const tail = Buffer.alloc(tailLen)
fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen)
console.log('tail    :', JSON.stringify(tail.toString('utf8')))
fs.closeSync(fd)

// 流式找每个 marker 的首次出现偏移
const found = Object.fromEntries(markers.map((m) => [m, -1]))
const bufs = markers.map((m) => Buffer.from(m))
const overlap = 64
let pos = 0
let carry = Buffer.alloc(0)
const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 * 1024 })
stream.on('data', (chunk) => {
  const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
  for (let i = 0; i < markers.length; i++) {
    if (found[markers[i]] >= 0) continue
    const off = data.indexOf(bufs[i])
    if (off >= 0) found[markers[i]] = pos - carry.length + off
  }
  pos += chunk.length
  carry = data.subarray(Math.max(0, data.length - overlap))
})
stream.on('end', () => {
  for (const m of markers) console.log('marker  :', m, '->', found[m])
})
stream.on('error', (e) => {
  console.error('stream error:', e.message)
})
