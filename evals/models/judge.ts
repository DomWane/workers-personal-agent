import { appendFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { readJsonLines } from '../lib/jsonl.ts'
import type { Run } from './compare.ts'

/**
 * Blind pairwise preference over the two models' answers. Token savings mean nothing without
 * holding capability fixed, and this is the half that holds it.
 *
 * Deliberately not an LLM judge. An unvalidated judge measures agreement with a model of unknown
 * calibration, which is the failure mode this project's own write-up argues against — and
 * validating one would need hand-graded answers anyway, which is exactly what this produces.
 */

const SET = process.env.EVAL_SET === 'bulk' ? 'bulk' : 'hard'
/** Must name the same serving conditions the runs were collected under; see compare.ts. */
const RUN_TAG = process.env.EVAL_RUN_TAG ?? 'hfe'
const RUNS = `evals/data/model-runs.${RUN_TAG}.${SET}.jsonl`
/**
 * Pass one is judged blind with no assistance of any kind; pass two allows checking claims against
 * the context and is recorded separately, so the untouched verdicts stay available for validating
 * an automated judge against. See amendment 6.
 */
const PASS = process.env.EVAL_JUDGE_PASS ?? 'blind'
const OUT = `evals/data/model-preferences.${RUN_TAG}.${SET}.${PASS}.jsonl`

export type Pair = { query: string; left: Run; right: Run; leftIsFirstModel: boolean }
/** `winner` is a model id, or the literal `'tie'`. Writing that as `string | 'tie'` only looks
 *  like a type — the union collapses back to `string` and documents nothing. */
export type Preference = { query: string; winner: string }

/** Deterministic, so an interrupted session resumes with the same sides as before. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Sides are randomised per question. Presenting one model consistently on the left would let a
 * position preference — and everyone has one — read as a preference for that model.
 */
export function buildPairs(runs: Run[], seed = 1): Pair[] {
  const rand = mulberry32(seed)
  // A broken resume check answered some questions twice. The repeats are kept in the data as a
  // measure of run-to-run variance; here only the first per model is judged, so a duplicated
  // question is not silently dropped for having three runs instead of two.
  const byQuery = new Map<string, Run[]>()
  for (const r of runs) {
    if (!byQuery.has(r.query)) {
      byQuery.set(r.query, [])
    }
    const seen = byQuery.get(r.query)!
    if (!seen.some((s) => s.model === r.model)) {
      seen.push(r)
    }
  }
  const out: Pair[] = []
  for (const [query, pair] of byQuery) {
    // A question answered by only one model is not a comparison and is skipped rather than
    // scored against nothing. Same for a pair where one side spent its whole budget thinking and
    // returned nothing: judging that would score the ceiling, not the model.
    if (pair.length !== 2) {
      continue
    }
    if (!pair[0].answer.trim() || !pair[1].answer.trim()) {
      continue
    }
    const flip = rand() < 0.5
    out.push({
      query,
      left: flip ? pair[1] : pair[0],
      right: flip ? pair[0] : pair[1],
      leftIsFirstModel: !flip,
    })
  }
  return out
}

async function main(): Promise<void> {
  const runs = readJsonLines<Run>(RUNS, { required: true })
  const judged = new Set(readJsonLines<Preference>(OUT).map((p) => p.query))
  const pairs = buildPairs(runs).filter((p) => !judged.has(p.query))

  console.log(`${pairs.length} dvojic k posouzení. Nevíš, který model je vlevo — je to schválně.`)
  console.log('Ptej se: která odpověď je věcně lepší? Ne která je delší nebo hezčí.\n')

  const rl = createInterface({ input: stdin, output: stdout })
  let done = 0

  for (const p of pairs) {
    console.log(`\n──── ${done + 1}/${pairs.length} ────`)
    console.log(`OTÁZKA: ${p.query}`)
    console.log(`\n${'═'.repeat(70)}\nA:\n${p.left.answer}`)
    console.log(`\n${'═'.repeat(70)}\nB:\n${p.right.answer}\n${'═'.repeat(70)}`)
    const ans = (await rl.question('lepší? [a] / [b] / [t]ie / [q]uit > ')).trim().toLowerCase()
    if (ans === 'q') {
      break
    }
    const winner = ans === 'a' ? p.left.model : ans === 'b' ? p.right.model : 'tie'
    appendFileSync(OUT, `${JSON.stringify({ query: p.query, winner } satisfies Preference)}\n`)
    done++
  }

  rl.close()
  console.log(`\nposouzeno ${done}/${pairs.length}, zapsáno do ${OUT}`)
  console.log('analýzu spusť až po dokončení — viz thinkingcap-preregistration.md')
}

if (/[\\/]models[\\/]judge\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
