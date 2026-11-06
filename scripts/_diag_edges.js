'use strict'

// 临时诊断脚本：从 `"edges":[` 开始扫描，数出完整的三元组个数，
// 用来判断文件是在 edges 中间被截断，还是刚好停在 edges 结束处。用完即删。
const fs = require('fs')

const file = process.argv[2]

function readHeaderCounts (p) {
  const fd = fs.openSync(p, 'r')
  const buf = Buffer.alloc(2048)
  const n = fs.readSync(fd, buf, 0, 2048, 0)
  fs.closeSync(fd)
  const t = buf.toString('utf8', 0, n)
  return {
    nodeCount: Number(/"node_count":(\d+)/.exec(t)[1]),
    edgeCount: Number(/"edge_count":(\d+)/.exec(t)[1]),
  }
}

const header = readHeaderCounts(file)
console.log('file        :', file)
console.log('node_count  :', header.nodeCount)
console.log('edge_count  :', header.edgeCount, '(=> numbers in edges =', header.edgeCount * 3, ')')

const marker = Buffer.from('"edges":[')
let pos = 0
let carry = Buffer.alloc(0)
let started = false
let numbers = 0
let charsInNumbers = 0
let lastChunkBytes = 0
let sawClose = false

const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 * 1024 })
stream.on('data', (chunk) => {
  let data = carry.length ? Buffer.concat([carry, chunk]) : chunk
  let from = 0
  if (!started) {
    const off = data.indexOf(marker)
    if (off < 0) {
      carry = data.subarray(Math.max(0, data.length - marker.length + 1))
      pos += chunk.length
      return
    }
    started = true
    from = off + marker.length
  }
  for (let i = from; i < data.length; i++) {
    const c = data[i]
    if (c >= 48 && c <= 57) charsInNumbers++
    else if (c === 44) numbers++
    else if (c === 93) { numbers++; sawClose = true; break }
  }
  carry = Buffer.alloc(0)
  pos += chunk.length
  lastChunkBytes = chunk.length
})
stream.on('end', () => {
  console.log('complete tuples (numbers/3) :', Math.floor(numbers / 3), 'numbers =', numbers)
  console.log('ratio vs edge_count        :', (numbers / 3 / header.edgeCount * 100).toFixed(2) + '%')
  console.log('avg bytes per number       :', (charsInNumbers / numbers).toFixed(3))
  console.log('saw edges-closing "]"      :', sawClose)
  console.log('estimated full edges bytes :', Math.round(charsInNumbers / numbers * header.edgeCount * 3))
})
