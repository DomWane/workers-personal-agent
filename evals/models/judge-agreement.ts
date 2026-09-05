import { readJsonLines } from '../lib/jsonl.ts'
import type { Preference } from './judge.ts'
import type { LlmVerdict } from './llm-judge.ts'

/**
 * How well an automated judge reproduces the blind human verdicts. This is the gate amendment 6
 * puts in front of using an LLM judge on the larger set: without it, an automated preference is
 * agreement with a model of unknown quality reported as a result.
 *
 * Read against the blind pass only. The fact-checked pass had model assistance in it, so scoring a
 * judge against it would be scoring a model partly against itself.
 */

const RUN_TAG = process.env.EVAL_RUN_TAG ?? 'hfe'
const SET = process.env.EVAL_SET === 'bulk' ? 'bulk' : 'hard'
const HUMAN = `evals/data/model-preferences.${RUN_TAG}.${SET}.blind.jsonl`
const LLM = `evals/data/model-preferences.${RUN_TAG}.${SET}.llm.jsonl`

/**
 * Cohen's kappa over the three verdicts. Raw agreement alone would flatter any judge on a set
 * where one verdict dominates — with many ties, always answering "tie" scores well and knows
 * nothing. Kappa subtracts what chance alone would have produced.
 */
export function cohenKappa(a: string[], b: string[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return Number.NaN
  }
  const labels = [...new Set([...a, ...b])]
  const observed = a.filter((x, i) => x === b[i]).length / a.length
  let expected = 0
  for (const l of labels) {
    expected += (a.filter((x) => x === l).length / a.length) * (b.filter((x) => x === l).length / b.length)
  }
  return expected === 1 ? Number.NaN : (observed - expected) / (1 - expected)
}

/**
 * One verdict per question from a judge that saw both presentations. A pair that disagrees with
 * itself when the sides are swapped has expressed a position preference, not a preference between
 * the answers, and is counted as a tie rather than resolved by picking one of the two.
 */
export function collapseOrders(verdicts: LlmVerdict[]): Map<string, string> {
  const byQuery = new Map<string, LlmVerdict[]>()
  for (const v of verdicts) {
    if (!byQuery.has(v.query)) {
      byQuery.set(v.query, [])
    }
    byQuery.get(v.query)!.push(v)
  }
  const out = new Map<string, string>()
  for (const [query, vs] of byQuery) {
    const winners = new Set(vs.map((v) => v.winner))
    out.set(query, winners.size === 1 ? vs[0].winner : 'tie')
  }
  return out
}

function main(): void {
  const human = readJsonLines<Preference>(HUMAN, { required: true })
  const llm = collapseOrders(readJsonLines<LlmVerdict>(LLM, { required: true }))

  const shared = human.filter((h) => llm.has(h.query))
  const hv = shared.map((h) => h.winner)
  const lv = shared.map((h) => llm.get(h.query)!)

  const agreed = hv.filter((x, i) => x === lv[i]).length
  console.log(`${SET} set — ${shared.length} otázek posouzených oběma`)
  console.log(`hrubá shoda   ${((agreed / shared.length) * 100).toFixed(1)}%  (${agreed}/${shared.length})`)
  console.log(`Cohenovo κ    ${cohenKappa(hv, lv).toFixed(3)}`)

  const raw = readJsonLines<LlmVerdict>(LLM)
  const byQuery = new Map<string, string[]>()
  for (const v of raw) {
    byQuery.set(v.query, [...(byQuery.get(v.query) ?? []), v.winner])
  }
  const flipped = [...byQuery.values()].filter((ws) => ws.length === 2 && ws[0] !== ws[1]).length
  console.log(`otočení stran změnilo verdikt u ${flipped}/${byQuery.size} otázek`)

  console.log('\n## Kde se rozcházejí')
  for (const [i, h] of shared.entries()) {
    if (hv[i] !== lv[i]) {
      console.log(`  člověk ${h.winner.padEnd(12)} judge ${lv[i].padEnd(12)} ${h.query.slice(0, 60)}`)
    }
  }
}

if (/[\\/]models[\\/]judge-agreement\.ts$/.test(process.argv[1] ?? '')) {
  main()
}
