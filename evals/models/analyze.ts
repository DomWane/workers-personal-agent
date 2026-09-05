import { readJsonLines } from '../lib/jsonl.ts'
import type { Labelled } from '../run-retrieval.ts'
import { runKey, type Run } from './compare.ts'
import type { Preference } from './judge.ts'

/**
 * Computes the ThinkingCap comparison strictly to evals/results/thinkingcap-preregistration.md and
 * its five amendments. Written after the data was collected and judged, which is only safe because
 * the design was fixed before: every metric and cut below is named in that document, and nothing
 * here was chosen by looking at the numbers first.
 */

/** The two sets are reported separately and never averaged; see the note in compare.ts. */
const SET = process.env.EVAL_SET === 'bulk' ? 'bulk' : 'hard'
/** Must name the same serving conditions the runs were collected under; see compare.ts. */
const RUN_TAG = process.env.EVAL_RUN_TAG ?? 'hfe'
const RUNS = `evals/data/model-runs.${RUN_TAG}.${SET}.jsonl`
/** Which judging pass to score against; the blind one is the primary. See amendment 6. */
const PASS = process.env.EVAL_JUDGE_PASS ?? 'blind'
const PREFS = `evals/data/model-preferences.${RUN_TAG}.${SET}.${PASS}.jsonl`

/** Seed 1 is the pass that was judged, so answers come from it; see amendment 6a. */
export function firstPerPair(runs: Run[]): Run[] {
  const seen = new Set<string>()
  return runs.filter((r) => {
    const k = runKey(r.model, r.query)
    if (seen.has(k)) {
      return false
    }
    seen.add(k)
    return true
  })
}

function bySeedGroup(runs: Run[]): Map<string, Run[]> {
  const byPair = new Map<string, Run[]>()
  for (const r of runs) {
    const k = runKey(r.model, r.query)
    if (!byPair.has(k)) {
      byPair.set(k, [])
    }
    byPair.get(k)!.push(r)
  }
  return byPair
}

/**
 * How far the same model's trace length moves on the same question across seeds. Sampling is what
 * produces this now rather than a resume bug, but it plays the same role: a saving smaller than
 * this floor is a draw dressed as a result.
 */
export function repeatSpreads(runs: Run[]): number[] {
  const out: number[] = []
  for (const rs of bySeedGroup(runs).values()) {
    if (rs.length < 2) {
      continue
    }
    const lens = rs.map((r) => r.reasoningChars)
    const max = Math.max(...lens)
    if (max > 0) {
      out.push((max - Math.min(...lens)) / max)
    }
  }
  return out
}

/**
 * One row per model and question, holding the median across that pair's seeds. The median rather
 * than the mean because a single run that reaches the ceiling would otherwise carry the question
 * with it — see amendment 6a, fixed before the data was read.
 */
export function medianAcrossSeeds(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const rs of bySeedGroup(runs).values()) {
    out.push({
      ...rs[0],
      reasoningChars: median(rs.map((r) => r.reasoningChars)),
      completionTokens: median(rs.map((r) => r.completionTokens ?? Number.NaN)),
    })
  }
  return out
}

export function median(xs: number[]): number {
  if (xs.length === 0) {
    return Number.NaN
  }
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

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
 * Paired bootstrap over the per-question values: questions are resampled, not the two models
 * independently, because the pairing is what removes question difficulty from the comparison.
 */
export function bootstrapMedian(values: number[], seed = 7, rounds = 10000): [number, number] {
  if (values.length === 0) {
    return [Number.NaN, Number.NaN]
  }
  const rand = mulberry32(seed)
  const medians: number[] = []
  for (let i = 0; i < rounds; i++) {
    const sample: number[] = []
    for (let j = 0; j < values.length; j++) {
      sample.push(values[Math.floor(rand() * values.length)])
    }
    medians.push(median(sample))
  }
  medians.sort((a, b) => a - b)
  return [medians[Math.floor(rounds * 0.025)], medians[Math.floor(rounds * 0.975)]]
}

/**
 * Wilson interval rather than the normal approximation: with ~20 non-tied pairs the normal one
 * runs off the end of [0,1] and would report an interval that cannot contain the true value.
 */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) {
    return [Number.NaN, Number.NaN]
  }
  const p = successes / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(centre - spread) / d, (centre + spread) / d]
}

type Paired = {
  query: string
  base: Run
  tuned: Run
  /** Whether the context the two models shared held any chunk the labeller called relevant. */
  hasRelevantContext: boolean
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function main(): void {
  const baseModel = process.env.BASE_MODEL
  const tunedModel = process.env.TUNED_MODEL
  if (!baseModel || !tunedModel) {
    throw new Error('set BASE_MODEL and TUNED_MODEL')
  }

  const allRuns = readJsonLines<Run>(RUNS, { required: true })
  // Lengths are the seed medians; every other field on the row is seed 1's, which is the pass that
  // was judged, so the answers quoted below are the answers that were actually compared.
  const runs = medianAcrossSeeds(allRuns)
  const prefs = readJsonLines<Preference>(PREFS, { required: true })
  const labels = readJsonLines<Labelled>('evals/data/retrieval.labels.jsonl', { required: true })
  const relevantByQuery = new Map(labels.map((l) => [l.query, new Set(l.relevant)]))

  const pairs: Paired[] = []
  for (const query of new Set(runs.map((r) => r.query))) {
    const base = runs.find((r) => r.query === query && r.model === baseModel)
    const tuned = runs.find((r) => r.query === query && r.model === tunedModel)
    if (!base || !tuned) {
      continue
    }
    const rel = relevantByQuery.get(query) ?? new Set<string>()
    pairs.push({ query, base, tuned, hasRelevantContext: base.contextIds.some((id) => rel.has(id)) })
  }

  console.log(`${SET} set — n = ${pairs.length} otázek, oba modely, byte-identický vstup\n`)

  // Primary metric (amendment 3): trace length in characters. The token count is not comparable
  // across these two providers and is excluded, not quietly used.
  const charRed = pairs.map((p) => (p.base.reasoningChars - p.tuned.reasoningChars) / p.base.reasoningChars)
  const [cLo, cHi] = bootstrapMedian(charRed)
  console.log('## Primární metrika — délka uvažovací stopy (znaky)')
  console.log(`base medián    ${median(pairs.map((p) => p.base.reasoningChars)).toFixed(0)} zn`)
  console.log(`tuned medián   ${median(pairs.map((p) => p.tuned.reasoningChars)).toFixed(0)} zn`)
  console.log(`úspora mediánu ${pct(median(charRed))}  95% CI [${pct(cLo)}, ${pct(cHi)}]`)
  console.log(`kratší stopa u ${charRed.filter((x) => x > 0).length}/${pairs.length} otázek`)

  const spreads = repeatSpreads(allRuns)
  console.log(`\npodlaha šumu (rozptyl mezi seedy): medián ${pct(median(spreads))}, n = ${spreads.length}`)
  if (median(charRed) <= median(spreads)) {
    console.log('POZOR: úspora nepřesahuje podlahu šumu — viz dodatek 6a.')
  }

  // Secondary: completion tokens are trustworthy on both sides and are the practical cost measure.
  const tokRed = pairs
    .filter((p) => p.base.completionTokens && p.tuned.completionTokens)
    .map((p) => (p.base.completionTokens! - p.tuned.completionTokens!) / p.base.completionTokens!)
  const [tLo, tHi] = bootstrapMedian(tokRed, 11)
  console.log('\n## Sekundární — completion tokeny')
  console.log(`base medián    ${median(pairs.map((p) => p.base.completionTokens ?? Number.NaN)).toFixed(0)}`)
  console.log(`tuned medián   ${median(pairs.map((p) => p.tuned.completionTokens ?? Number.NaN)).toFixed(0)}`)
  console.log(`úspora mediánu ${pct(median(tokRed))}  95% CI [${pct(tLo)}, ${pct(tHi)}]`)

  const untrustworthy = pairs
    .flatMap((p) => [p.base, p.tuned])
    .filter((r) => r.reasoningTokens === null || (r.reasoningTokens === 0 && r.reasoningChars > 0)).length
  console.log(`\nreasoning_tokens nedůvěryhodné u ${untrustworthy}/${pairs.length * 2} běhů — vyloučeno (dodatek 3)`)

  // Quality: the saving means nothing unless capability held.
  console.log('\n## Kvalita — slepé párové posouzení')
  const verdicts = pairs.map((p) => ({ p, w: prefs.find((x) => x.query === p.query)?.winner }))
  const judged = verdicts.filter((v) => v.w !== undefined)
  const ties = judged.filter((v) => v.w === 'tie').length
  const baseWins = judged.filter((v) => v.w === baseModel).length
  const tunedWins = judged.filter((v) => v.w === tunedModel).length
  const decided = baseWins + tunedWins
  const [pLo, pHi] = wilson(baseWins, decided)
  console.log(`posouzeno ${judged.length}, remíz ${ties}, rozhodnutých ${decided}`)
  console.log(`base ${baseWins} : ${tunedWins} tuned`)
  console.log(`podíl pro base ${decided ? pct(baseWins / decided) : '—'}  95% CI [${pct(pLo)}, ${pct(pHi)}]`)
  const detectable = decided >= 20
  if (pLo <= 0.5 && pHi >= 0.5) {
    console.log(
      `→ interval obsahuje 0.5 — rozdíl neprokázán${detectable ? '' : `, ale ${decided} rozhodnutých dvojic ho neumí odhalit`}`,
    )
  } else {
    console.log('→ interval míjí 0.5 — rozdíl v kvalitě')
  }

  // Not in the original design, added because collection revealed it: on 12 of 30 questions the
  // shared context held no chunk the labeller called relevant, so those test refusal, not recall.
  console.log('\n## Rozpad podle toho, jestli kontext vůbec obsahoval odpověď')
  for (const withCtx of [true, false]) {
    const group = judged.filter((v) => v.p.hasRelevantContext === withCtx)
    const t = group.filter((v) => v.w === 'tie').length
    const b = group.filter((v) => v.w === baseModel).length
    const u = group.filter((v) => v.w === tunedModel).length
    console.log(
      `${withCtx ? 's relevantním kontextem ' : 'bez relevantního      '} n=${group.length}  base ${b} : ${u} tuned, remíz ${t}`,
    )
  }

  // The promised blindness check: if verdicts tracked answer length, the judging measured length.
  console.log('\n## Kontrola sleposti — šel verdikt za délkou odpovědi?')
  const decidedPairs = judged.filter((v) => v.w !== 'tie')
  const longerWon = decidedPairs.filter((v) => {
    const winner = v.w === baseModel ? v.p.base : v.p.tuned
    const loser = v.w === baseModel ? v.p.tuned : v.p.base
    return winner.answer.length > loser.answer.length
  }).length
  const [lLo, lHi] = wilson(longerWon, decidedPairs.length)
  console.log(`delší odpověď vyhrála ${longerWon}/${decidedPairs.length}  95% CI [${pct(lLo)}, ${pct(lHi)}]`)
  console.log(
    `→ ${lLo <= 0.5 && lHi >= 0.5 ? 'nerozlišitelné od náhody — délka verdikt neřídila' : 'délka s verdiktem koreluje — nahlásit jako limit'}`,
  )
}

if (/[\\/]models[\\/]analyze\.ts$/.test(process.argv[1] ?? '')) {
  main()
}
