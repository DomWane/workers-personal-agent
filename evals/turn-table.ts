import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readJsonLines } from './lib/jsonl.ts'
import { fromExportedEvent, groupTurns } from './lib/records.ts'
import { projectTurn, toCsv } from './lib/turn-table.ts'

/**
 * Raw traces in, one publishable row per turn out. The projection is an allowlist, so this is
 * the boundary where private data stops: `evals/data/` is gitignored, `evals/results/` is not.
 *
 * Records from before the envelope existed (2026-08-06) carry no `turnId` and are dropped rather
 * than reconstructed — mixing two schemas into one table is how a denominator goes wrong quietly.
 */
const IN = 'evals/data/traces.jsonl'
const OUT = 'evals/results/turns.csv'

const raw = readJsonLines<unknown>(IN, { required: true })
const usable = raw.map(fromExportedEvent).filter((r) => r !== null)
const turns = groupTurns(usable)
const rows = turns.map(projectTurn)

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${toCsv(rows)}\n`)

const bySource = new Map<string, number>()
for (const row of rows) {
  bySource.set(String(row.source), (bySource.get(String(row.source)) ?? 0) + 1)
}

console.log(
  `${raw.length} records in, ${usable.length} with an envelope (${raw.length - usable.length} pre-schema, dropped)`,
)
console.log(`${turns.length} turns → ${OUT}`)
for (const [source, n] of [...bySource].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${String(n).padStart(4)}  ${source}`)
}
const unfinished = rows.filter((r) => r.outcome === 'unfinished').length
if (unfinished) {
  console.log(`  ${String(unfinished).padStart(4)}  unfinished (no turn record)`)
}
