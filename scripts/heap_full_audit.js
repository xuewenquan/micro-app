'use strict'

/**
 * One-command heap audit for the micro-app investigation.
 *
 * It prints a single JSON document containing lifecycle/DOM/bundle metrics and,
 * by default, the exact dominator chain of the largest detached application.
 * The heavy parsers stay in their focused scripts; this wrapper keeps the
 * operator workflow and model output to one command/result.
 *
 * Usage:
 *   node --max-old-space-size=16384 scripts/heap_full_audit.js <snapshot>
 *   node --max-old-space-size=16384 scripts/heap_full_audit.js <snapshot> --app=wonder-ws-web
 *   node --max-old-space-size=16384 scripts/heap_full_audit.js <snapshot> --no-dominators
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const snapshot = args.find((arg) => !arg.startsWith('--'))
const appArg = args.find((arg) => arg.startsWith('--app='))
const requestedApp = appArg ? appArg.slice('--app='.length) : null
const withDominators = !args.includes('--no-dominators')

if (!snapshot || !fs.existsSync(snapshot)) {
  throw new Error('Usage: node scripts/heap_full_audit.js <snapshot> [--app=name] [--no-dominators]')
}

function runJson (scriptName, scriptArgs) {
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=16384',
    path.join(__dirname, scriptName),
    ...scriptArgs,
  ], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`${scriptName} failed:\n${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

const metrics = runJson('heap_metrics.js', [snapshot, `--label=${path.basename(snapshot)}`])
const detached = requestedApp
  ? metrics.detachedApps.find((item) => item.name === requestedApp)
  : metrics.detachedApps[0]

let detachedDominator = null
if (withDominators && detached?.sampleOrdinal !== undefined) {
  const dominators = runJson('heap_dominators.js', [
    snapshot,
    '20',
    `--path=${detached.sampleOrdinal}`,
  ])
  const pathResult = dominators.paths?.[0] || null
  detachedDominator = {
    app: detached.name,
    count: detached.count,
    sampleOrdinal: detached.sampleOrdinal,
    rounds: dominators.dominatorRounds,
    sampleRetainedBytes: pathResult?.retainedSize || 0,
    chain: pathResult?.chain || [],
    topAnchors: (dominators.topByRetained || []).filter((item) => item.type !== 'synthetic').slice(0, 12),
  }
}

console.log(JSON.stringify({ metrics, detachedDominator }, null, 2))

