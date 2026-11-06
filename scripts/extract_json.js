'use strict'

/**
 * 从「被 powershell 2>&1 混入 stderr 前缀」的输出文件里抽出 JSON 并打印。
 * 用法: node scripts/extract_json.js <file>
 */
const fs = require('fs')
const file = process.argv[2]
if (!file) throw new Error('Usage: node scripts/extract_json.js <file>')
const text = fs.readFileSync(file, 'utf8')
const start = text.indexOf('{')
if (start < 0) throw new Error('no JSON object found')
const end = text.lastIndexOf('}')
const parsed = JSON.parse(text.slice(start, end + 1))
process.stdout.write(JSON.stringify(parsed, null, 2) + '\n')
