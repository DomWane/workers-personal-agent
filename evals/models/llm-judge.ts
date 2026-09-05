import { appendFileSync } from 'node:fs'
import { readJsonLines } from '../lib/jsonl.ts'
import type { Run } from './compare.ts'
import { buildPairs, type Pair } from './judge.ts'

/**
 * An automated stand-in for the human judge, run over the same pairs so the two can be compared.
 *
 * Its output is not a result on its own. Amendment 6 fixes the order: agreement with the blind
 * human pass is measured first, and only a judge that reproduces human verdicts is allowed to
 * extend the comparison to the larger set. A judge scored against nothing measures agreement with
 * a model of unknown quality, which is what the original design refused to do.
 */

const RUN_TAG = process.env.EVAL_RUN_TAG ?? 'hfe'
const SET = process.env.EVAL_SET === 'bulk' ? 'bulk' : 'hard'
const RUNS = `evals/data/model-runs.${RUN_TAG}.${SET}.jsonl`
const OUT = `evals/data/model-preferences.${RUN_TAG}.${SET}.llm.jsonl`

/**
 * Deliberately not from the family under test. Both candidates are Qwen3.6-27B derivatives, and a
 * judge shares the preferences of its own lineage — a Qwen judge would be scoring its relatives.
 */
const MODEL = process.env.JUDGE_MODEL
const API_BASE = process.env.JUDGE_API_BASE
const API_KEY = process.env.JUDGE_API_KEY

const SYSTEM = [
  'Porovnáváš dvě odpovědi na stejnou otázku, obě psané jen z přiložených úryvků.',
  'Rozhoduj se podle věcné správnosti vůči úryvkům, ne podle délky, tónu ani jistoty.',
  'Odpověď, která si vymýšlí nebo tvrdí víc, než v úryvcích je, je horší než ta, která přizná, že to tam není.',
  'Odpověz jediným slovem: A, B, nebo tie.',
].join(' ')

export type LlmVerdict = {
  query: string
  /** Which model was shown first in this presentation, so a flipped repeat is identifiable. */
  firstShown: string
  /** A model id, or the literal `'tie'` — see the note on `Preference`. */
  winner: string
  raw: string
}

export function buildPrompt(pair: Pair, flipped: boolean): string {
  const [a, b] = flipped ? [pair.right, pair.left] : [pair.left, pair.right]
  return [`OTÁZKA: ${pair.query}`, '', `ODPOVĚĎ A:\n${a.answer}`, '', `ODPOVĚĎ B:\n${b.answer}`].join('\n')
}

/**
 * Reads the verdict off the last line the model wrote, since a model asked for one word sometimes
 * writes a sentence first. Anything that is not a clear A, B or tie counts as a tie rather than
 * being guessed at, and the raw text is stored so a run of unparseable replies is visible as such
 * instead of passing for a judge that found everything equal.
 */
export function parseVerdict(raw: string, first: Run, second: Run): string {
  const last =
    raw
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .pop() ?? ''
  const v = last.toLowerCase().replace(/[^a-z]/g, '')
  if (v === 'a') {
    return first.model
  }
  if (v === 'b') {
    return second.model
  }
  return 'tie'
}

async function ask(prompt: string): Promise<string> {
  const res = await fetch(`${API_BASE!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // Reasoning models spend this budget thinking before they answer. At the one-word ceiling the
      // task seems to want, every reply comes back empty and the whole run reads as a judge that
      // found every pair equal — a configuration error wearing the shape of a result.
      max_tokens: Number.parseInt(process.env.JUDGE_MAX_TOKENS ?? '2000', 10),
      reasoning: { effort: 'low' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

async function main(): Promise<void> {
  if (!MODEL || !API_BASE || !API_KEY) {
    throw new Error('set JUDGE_MODEL, JUDGE_API_BASE and JUDGE_API_KEY')
  }
  const runs = readJsonLines<Run>(RUNS, { required: true })
  const pairs = buildPairs(runs)
  const done = new Set(readJsonLines<LlmVerdict>(OUT).map((v) => `${v.query}\u0000${v.firstShown}`))

  let flips = 0
  let judged = 0
  let unparsed = 0
  for (const pair of pairs) {
    // Every pair is judged in both presentations. Position bias in LLM judges is large, and a
    // disagreement between the two orders is the only direct measurement of it available here.
    for (const flipped of [false, true]) {
      const [first, second] = flipped ? [pair.right, pair.left] : [pair.left, pair.right]
      if (done.has(`${pair.query}\u0000${first.model}`)) {
        continue
      }
      const raw = await ask(buildPrompt(pair, flipped))
      const winner = parseVerdict(raw, first, second)
      if (winner === 'tie' && !/^\s*tie\s*$/i.test(raw.trim().split('\n').pop() ?? '')) {
        unparsed++
      }
      const row: LlmVerdict = { query: pair.query, firstShown: first.model, winner, raw }
      appendFileSync(OUT, `${JSON.stringify(row)}\n`)
      judged++
    }
  }

  const verdicts = readJsonLines<LlmVerdict>(OUT)
  const byQuery = new Map<string, LlmVerdict[]>()
  for (const v of verdicts) {
    if (!byQuery.has(v.query)) {
      byQuery.set(v.query, [])
    }
    byQuery.get(v.query)!.push(v)
  }
  for (const vs of byQuery.values()) {
    if (vs.length === 2 && vs[0].winner !== vs[1].winner) {
      flips++
    }
  }
  console.log(`${judged} nových posudků zapsáno do ${OUT}`)
  console.log(`nekonzistentních při otočení stran: ${flips}/${byQuery.size}`)
  if (unparsed > 0) {
    console.log(`POZOR: ${unparsed} odpovědí nešlo přečíst jako verdikt a spadlo na remízu — zkontroluj pole raw.`)
  }
  console.log('Pozor: tohle není výsledek. Nejdřív změř shodu se slepým lidským průchodem.')
}

if (/[\\/]models[\\/]llm-judge\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
