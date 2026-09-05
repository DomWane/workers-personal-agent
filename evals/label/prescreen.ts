import { writeFileSync } from 'node:fs'
import type { Chunk } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { similarity } from '../lib/similar.ts'
import { tokenize } from '../lib/tokenize.ts'

/**
 * Flags candidates a human would probably drop, so the reviewer reads reasons instead of
 * hunting for them. It never removes anything: dropping is the judgment being outsourced to,
 * and a set filtered by this file's opinions would carry those opinions into the ground truth.
 *
 * Every signal is computed WITHOUT scoring a query against a chunk. Flagging "the target is
 * hard to retrieve" would let the reviewer delete exactly the items a retriever fails, which
 * inflates whichever retriever did the flagging — the one bias that would invalidate the eval.
 */

/** Reply is still planning: no verdict was reached, so there is nothing durable to retrieve. */
const SCAFFOLD =
  /\b(I['’]ll (look|investigate|check|start|wait|verify|run|dispatch)|Let me (first|look|check|start|wait|run)|dispatched an agent|waiting for|before (proposing|diagnosing|saying)|I['’]m in Phase \d|Podívám se|Ověřím|Zkontroluju|Počkám)/i
/**
 * Kept deliberately wide. A chunk that plans and *then* answers is exactly what this corpus is
 * full of, so a thin list here turns the scaffolding flag into a false positive on the best
 * items — "The pattern is clear now: secrets live on…" was one, and the reviewer caught it.
 */
const CONCLUSION =
  /\b(root cause|the (problem|issue|bug|answer|pattern|rule|fix) (is|was)|is clear|turns out|in short|so the|therefore|conclusion|fixed|opraveno|hotovo|because|protože|důvod|takže|závěr|řešení|výsledek|ukázalo se|zjistil jsem)\b/i

/** Reply only reports that something happened. A completion notice is not knowledge. */
const STATUS = /^\s*(hotovo|done|ok|opraveno|nasazeno|deployed|committed|pushed|pr opened|merged|tests? pass|✅)/i

/** This project's own transcripts about building the eval: real noise, but the user decides. */
const META = /────\s*\d+\/\d+\s*────|\[k\]eep \/ \[d\]rop|leakage \d|labelov|eval:gen|eval:label/i

/**
 * A chunk that cites its sources is asserting something about the outside world, which is the
 * one thing in this corpus that can be plain wrong — everything else is the author's own code
 * and decisions. Worth verifying whichever date it carries.
 */
const CLAIMS_SOURCES = /^\s*(Zdroje|Checked|Sources)\s*:/im

/**
 * Until this commit web_search returned nothing and said so as an instruction, and the model
 * filled the gap by inventing the sources it then listed. A sourced claim from before it is a
 * documented fabrication, not merely unverified.
 */
const SEARCH_FIXED_AT = '2026-07-29T10:50:57Z'

const THIN_CHARS = 300
/**
 * The 99th percentile of chunk-to-chunk Jaccard in the real corpus (median 0.04, p99 0.146),
 * so this fires on the top ~1% of pairs. It catches near-verbatim repeats and nothing more:
 * two chunks revisiting one topic in different words score around the median and stay unflagged,
 * which is why topical ambiguity is still the reviewer's call and not this file's.
 */
const TWIN_SIMILARITY = 0.15
export type Flag = 'scaffolding' | 'status' | 'thin' | 'meta' | 'sourced' | 'fabricated-era'

export function replyOf(text: string): string {
  return text.split('\n\n').slice(1).join('\n\n')
}

export function flagsFor(chunk: Chunk): Flag[] {
  const flags: Flag[] = []
  const reply = replyOf(chunk.text)
  if (SCAFFOLD.test(reply) && !CONCLUSION.test(reply)) {
    flags.push('scaffolding')
  }
  if (STATUS.test(reply.trim()) && reply.trim().length < 200) {
    flags.push('status')
  }
  if (chunk.text.length < THIN_CHARS) {
    flags.push('thin')
  }
  if (META.test(chunk.text)) {
    flags.push('meta')
  }
  if (CLAIMS_SOURCES.test(chunk.text)) {
    flags.push(chunk.ts && chunk.ts < SEARCH_FIXED_AT ? 'fabricated-era' : 'sourced')
  }
  return flags
}

const REASON: Record<Flag, string> = {
  scaffolding: 'chunk jen plánuje, nedojde k závěru',
  status: 'chunk je hlášení o dokončení, ne znalost',
  thin: 'chunk je příliš krátký na smysluplný cíl',
  meta: 'chunk je z ladění evalu, ne trvalá znalost',
  sourced: 'chunk se odvolává na zdroje — tvrdí něco o vnějším světě, ověř to',
  'fabricated-era': 'chunk cituje zdroje a je z doby před opravou searche — doložená fabrikace',
}

type Candidate = { chunkId: string; query: string; leakage: number }

function main(): void {
  const chunks = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const candidates = readJsonLines<Candidate>('evals/data/retrieval.candidates.jsonl', { required: true })
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const tokens = new Map(chunks.map((c) => [c.id, new Set(tokenize(c.text))]))

  const lines: string[] = [
    '# Předfiltr kandidátů',
    '',
    'Flagy jsou návrh, ne rozhodnutí — projdi je a rozhodni sám.',
    '',
  ]
  const twinCounts: Array<{ i: number; query: string; twins: number }> = []
  let flagged = 0

  candidates.forEach((cand, i) => {
    const chunk = byId.get(cand.chunkId)
    if (!chunk) {
      return
    }
    const mine = tokens.get(chunk.id)!
    let twins = 0
    for (const other of chunks) {
      if (other.id === chunk.id) {
        continue
      }
      if (similarity(mine, tokens.get(other.id)!) >= TWIN_SIMILARITY) {
        twins++
      }
    }
    twinCounts.push({ i: i + 1, query: cand.query, twins })
    const flags = flagsFor(chunk)
    if (flags.length === 0) {
      return
    }
    flagged++
    lines.push(`## ${i + 1}/${candidates.length} — ${flags.join(', ')}`)
    lines.push(`DOTAZ: ${cand.query}`)
    for (const f of flags) {
      lines.push(`- ${REASON[f]}`)
    }
    lines.push('')
  })

  // Reported as a number, not a flag: lexical overlap finds near-verbatim repeats, and the
  // ambiguity that actually matters — one topic revisited in different words — sits at the
  // median. Turning this into a verdict flagged 46% of the set, which is noise, not a signal.
  const top = twinCounts
    .filter((t) => t.twins > 0)
    .sort((a, b) => b.twins - a.twins)
    .slice(0, 15)
  if (top.length) {
    lines.push('## Nejvíc lexikálně podobných sousedů (jen informace, ne flag)', '')
    lines.push('Vysoké číslo = chunk se v korpusu doslova opakuje. Nízké NEznamená jednoznačný cíl:')
    lines.push('téma řešené víckrát jinými slovy se sem nedostane a musíš ho poznat sám.', '')
    for (const t of top) {
      lines.push(`- ${t.i}/${candidates.length} — ${t.twins} podobných — ${t.query}`)
    }
    lines.push('')
  }

  writeFileSync('evals/data/prescreen.md', lines.join('\n'))
  console.log(`kandidátů: ${candidates.length} | označených: ${flagged} | čistých: ${candidates.length - flagged}`)
  console.log('report: evals/data/prescreen.md — flagy jsou návrh, rozhoduješ ty')
}

if (/[\\/]label[\\/]prescreen\.ts$/.test(process.argv[1] ?? '')) {
  main()
}
