import { appendFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { Chunk } from '../lib/corpus.ts'
import { findByPeriod, findByProject, findByTerms, fold, parseSearch, preview, replyPreview } from '../lib/find.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import type { Labelled } from '../run-retrieval.ts'
import { chooseAlsoRelevant } from './retrieval.ts'

/**
 * The hard set is the half of the eval a generator cannot produce: queries asked the way the
 * author would actually ask them months later, vague and lossy, instead of derived from the very
 * chunk that answers them.
 *
 * Two ordering rules make that true, and both are enforced by the flow rather than by intent:
 *
 * 1. The query is written and locked BEFORE the corpus is searched, and this file offers no way
 *    to edit it afterwards. A query revised once its target is on screen drifts into the target's
 *    vocabulary, which is exactly the easy, generated-looking query the hard set exists to avoid.
 * 2. Locating the target is an unranked filter (see lib/find.ts), never a retriever.
 *
 * What survives is a residual bias worth measuring rather than claiming away: a chunk found by
 * typing words is a chunk that contains those words. So how it was found is recorded on the row
 * and the runner reports search-located against browse-located separately.
 */

const OUT = 'evals/data/retrieval.labels.jsonl'
/**
 * A query whose answer is not in the corpus is a finding, not a mistake — it says the corpus is
 * missing something the author expects to be able to ask. Losing it would hide that.
 */
const UNMATCHED = 'evals/data/hard.unmatched.jsonl'
const PAGE = 12
const TARGET = 30

export function hitsFor(
  raw: string,
  corpus: Chunk[],
): { hits: Chunk[]; terms: string[]; via: 'search' | 'browse' } | null {
  const mode = parseSearch(raw)
  if (mode.kind === 'give-up') {
    return null
  }
  if (mode.kind === 'terms') {
    return { hits: findByTerms(corpus, mode.terms), terms: mode.terms, via: 'search' }
  }
  const hits = mode.kind === 'period' ? findByPeriod(corpus, mode.prefix) : findByProject(corpus, mode.name)
  return { hits, terms: [], via: 'browse' }
}

/** Folded, so the same question typed twice with different accents is caught as the duplicate it is. */
export function queryKey(query: string): string {
  return fold(query).replace(/\s+/g, ' ').trim()
}

type Located = { chunk: Chunk; via: 'search' | 'browse' }

async function locate(corpus: Chunk[], ask: (q: string) => Promise<string>): Promise<Located | null> {
  while (true) {
    const raw = await ask('  hledat (slova | /2026-07 | /projekt jmeno | /? = nápověda | . = nenašel jsem) > ')
    // Project names reach the corpus as opaque tokens, so browsing by project is unusable unless the
    // labeller can see what the tokens actually are.
    if (raw.trim() === '/?') {
      const counts = new Map<string, number>()
      for (const c of corpus) {
        counts.set(c.project, (counts.get(c.project) ?? 0) + 1)
      }
      for (const [p, n] of [...counts].sort((a, b) => b[1] - a[1])) {
        console.log(`  /projekt ${p} — ${n}`)
      }
      const dates = corpus
        .map((c) => c.ts.slice(0, 10))
        .filter(Boolean)
        .sort()
      console.log(`  /obdobi: ${dates[0]} … ${dates.at(-1)} (prefix, např. /2026-07 nebo /2026-07-30)`)
      continue
    }
    const found = hitsFor(raw, corpus)
    if (!found) {
      return null
    }
    const { hits, terms, via } = found
    if (hits.length === 0) {
      console.log('  nic nenalezeno, zkus jiná slova')
      continue
    }
    // Paged rather than capped: browsing a busy day returns thirty hits, and with a date there is
    // no way to "narrow the search" — the rest would simply be unreachable.
    let page = 0
    let answer = ''
    while (true) {
      const shown = hits.slice(page * PAGE, page * PAGE + PAGE)
      shown.forEach((c, i) => {
        console.log(`  ${String(page * PAGE + i + 1).padStart(2)}. [${c.ts.slice(0, 10)}] ${c.project}`)
        console.log(`      ${terms.length ? preview(c.text, terms) : replyPreview(c.text)}`)
      })
      const more = hits.length - (page * PAGE + shown.length)
      if (more > 0) {
        console.log(`  … a dalších ${more} — [+] další stránka`)
      }
      answer = (await ask('  číslo (enter = hledat znovu, . = nenašel jsem) > ')).trim()
      if (answer === '+' && more > 0) {
        page++
        continue
      }
      break
    }
    const shown = hits
    const pick = Number.parseInt(answer, 10)
    if (Number.isInteger(pick) && pick >= 1 && pick <= shown.length) {
      // Full text, never the preview: the verdict a chunk reaches sits at the end of the reply,
      // which is exactly what a windowed preview cuts off. Judging relevance from the window
      // rejects chunks that do answer the query — it happened three times during the bulk pass.
      const chunk = shown[pick - 1]
      console.log(`\n${'─'.repeat(70)}\n${chunk.text}\n${'─'.repeat(70)}`)
      if (
        (await ask('  odpovídá to na dotaz? [a]no / cokoliv jiného = zpět na hledání > ')).trim().toLowerCase() === 'a'
      ) {
        return { chunk, via }
      }
      continue
    }
    if (answer === '.') {
      return null
    }
  }
}

async function main(): Promise<void> {
  const corpus = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const existing = readJsonLines<Labelled>(OUT)
  const seen = new Set(existing.map((l) => queryKey(l.query)))
  let hard = existing.filter((l) => l.kind === 'hard').length

  console.log('Hard set: dotazy z hlavy, tvými slovy, jako bys je za půl roku poslal agentovi.')
  console.log('Dotaz napiš DŘÍV, než začneš hledat — po nalezení cíle už ho tenhle skript nepustí měnit,')
  console.log('protože přepsaný dotaz sklouzne do slov cílového chunku a přestane být těžký.')
  console.log(`Cíl je ~${TARGET}. Prázdný dotaz = konec, můžeš pokračovat kdykoliv později.`)

  const rl = createInterface({ input: stdin, output: stdout })
  let added = 0
  let unmatched = 0

  while (true) {
    console.log(`\n──── hard hotovo ${hard}/${TARGET} ────`)
    const query = (await rl.question('dotaz z hlavy (enter = konec) > ')).trim()
    if (!query) {
      break
    }
    if (seen.has(queryKey(query))) {
      console.log('  tenhle dotaz už v sadě je, přeskakuju')
      continue
    }
    // Marked seen before the outcome is known: a query abandoned as unmatched should not be
    // offered back as new on the next run either.
    seen.add(queryKey(query))

    const found = await locate(corpus, (q) => rl.question(q))
    if (!found) {
      appendFileSync(UNMATCHED, `${JSON.stringify({ query })}\n`)
      console.log(`  uloženo do ${UNMATCHED} — v korpusu na to zřejmě odpověď není`)
      unmatched++
      continue
    }
    const also = await chooseAlsoRelevant(found.chunk, corpus, (q) => rl.question(q))
    const row: Labelled = { query, relevant: [found.chunk.id, ...also], kind: 'hard', via: found.via }
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
    hard++
    added++
  }

  rl.close()
  console.log(`\ntahle session: ${added} hard dotazů, ${unmatched} bez cíle v korpusu`)
  console.log(`celkem hard: ${hard}/${TARGET}`)
}

if (/[\\/]label[\\/]hard\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
