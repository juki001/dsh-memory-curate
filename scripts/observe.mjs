#!/usr/bin/env node
/**
 * Read-only observation helper for a running memory-curate store.
 * Usage: node scripts/observe.mjs [storePath]
 * Defaults to <DSH_HOME or ~/.dsh>/data/memory-curate/memory-curate.ndjson.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const file = process.argv[2] ?? join(home, 'data', 'memory-curate', 'memory-curate.ndjson')
if (!existsSync(file)) {
  console.error(`no store at ${file}`)
  process.exit(1)
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})

const kind = (row) => (row.kind === 'audit' ? `audit:${row.op}` : row.kind)
const counts = new Map()
for (const row of rows) counts.set(kind(row), (counts.get(kind(row)) ?? 0) + 1)
const active = rows.filter((row) => row.kind === 'memory' && row.status === 'active')
const compactions = rows.filter((row) => row.op === 'compact')
const prunes = rows.filter((row) => row.op === 'prune')
const decisions = new Map()
for (const row of compactions) decisions.set(row.decision ?? '?', (decisions.get(row.decision ?? '?') ?? 0) + 1)

console.log(`store: ${file}`)
console.log(`rows: ${rows.length}  active memories: ${active.length}  prompt: ${rows.findLast?.((row) => row.kind === 'prompt' && row.status === 'active')?.version ?? 'none'}`)
console.log('kinds:', [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join('  '))
console.log('compact decisions:', [...decisions.entries()].map(([name, count]) => `${name}=${count}`).join('  ') || 'none')
console.log('prune rows:', prunes.length, ' protected skips:', prunes.filter((row) => row.skipped).length)
const recent = rows.filter((row) => row.op === 'compact' || row.op === 'prune').slice(-8)
if (recent.length > 0) {
  console.log('recent compaction activity:')
  for (const row of recent) {
    const where = row.region ? `${row.region.start}..${row.region.end}` : row.seq ?? ''
    console.log(`  ${row.ts} ${row.op} ${row.decision ?? ''} ${row.gate ?? ''} ${row.trigger ?? ''} seq=${where} protectedTrimmed=${row.protectedTrimmed ?? ''}`)
  }
} else {
  console.log('recent compaction activity: none yet (below pressure threshold)')
}
