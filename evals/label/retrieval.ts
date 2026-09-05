import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Chunk } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { neighboursOf, pickNeighbours } from '../lib/similar.ts'

type Candidate = { chunkId: string; query: string; leakage: number }
const OUT = 'evals/data/retrieval.labels.jsonl'
// Separate from OUT: a drop is a decision too, and must survive a restart same as a keep.
const DROPPED = 'evals/data/retrieval.dropped.jsonl'

export function loadKeptIds(outPath: string): Set<string> {
  return new Set(readJsonLines<{ relevant: string[] }>(outPath).map((l) => l.relevant[0]))
}

/**
 * A topic revisited over months lives in several chunks, and dropping every such query would
 * leave a set biased towards one-off subjects — the least realistic ones. `relevant` was always
 * a list and the metrics divide by its length; this is what finally writes more than one into it.
 */
export async function chooseAlsoRelevant(
  chunk: Chunk,
  chunks: Chunk[],
  ask: (q: string) => Promise<string>,
): Promise<string[]> {
  const neighbours = neighboursOf(chunk, chunks)
  if (neighbours.length === 0) {
    return []
  }
  console.log('\npodobné chunky (chunk↔chunk, dotaz do toho nevstupuje):')
  neighbours.forEach((n, i) => {
    console.log(`  ${i + 1}. (${n.score.toFixed(2)}) ${n.chunk.text.slice(0, 150).replace(/\n/g, ' ')}`)
  })
  const answer = await ask('které z nich taky odpovídají? čísla oddělená čárkou (enter = žádné) > ')
  return pickNeighbours(answer, neighbours)
}

export function loadDroppedIds(droppedPath: string): Set<string> {
  return new Set(readJsonLines<{ chunkId: string }>(droppedPath).map((l) => l.chunkId))
}

export function selectTodo(candidates: Candidate[], excluded: Set<string>): Candidate[] {
  return candidates.filter((c) => !excluded.has(c.chunkId))
}

async function main(): Promise<void> {
  const corpus = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const chunks = new Map(corpus.map((c) => [c.id, c]))
  const candidates = readJsonLines<Candidate>('evals/data/retrieval.candidates.jsonl', { required: true })

  const excluded = new Set([...loadKeptIds(OUT), ...loadDroppedIds(DROPPED)])
  const todo = selectTodo(candidates, excluded)
  // Absolute position, not the index in the remaining queue: after a resume the latter restarts
  // at 1 and reads as if nothing had been saved.
  const done = candidates.length - todo.length
  const rl = createInterface({ input: stdin, output: stdout })
  let kept = 0
  let dropped = 0

  for (const [i, c] of todo.entries()) {
    const chunk = chunks.get(c.chunkId)
    if (!chunk) {
      continue
    }
    console.log(
      `\n──── ${done + i + 1}/${candidates.length} ─── zbývá ${todo.length - i} ` +
        `─── minule hotovo ${done} ─── leakage ${c.leakage.toFixed(2)} ────`,
    )
    console.log(`DOTAZ:  ${c.query}`)
    console.log(`CHUNK:  ${chunk.text.slice(0, 400).replace(/\n/g, ' ')}`)
    const ans = (await rl.question('[k]eep / [d]rop / [e]dit / [m]ulti / [q]uit > ')).trim().toLowerCase()

    if (ans === 'q') {
      break
    }
    if (ans === 'd') {
      appendFileSync(DROPPED, `${JSON.stringify({ chunkId: c.chunkId })}\n`)
      dropped++
      continue
    }
    let query = c.query
    if (ans === 'e') {
      query = (await rl.question('nový dotaz > ')).trim() || query
    }
    const also = ans === 'm' ? await chooseAlsoRelevant(chunk, corpus, (q) => rl.question(q)) : []
    // An edit is written with the chunk on screen and is never re-scored for leakage, so the
    // flag is what lets a later run check whether hand-edited queries scored differently.
    const edited = ans === 'e' && query !== c.query
    const relevant = [c.chunkId, ...also]
    appendFileSync(OUT, `${JSON.stringify({ query, relevant, kind: 'bulk', ...(edited ? { edited: true } : {}) })}\n`)
    kept++
  }

  rl.close()
  console.log(`\ntahle session: ${kept} keep, ${dropped} drop`)
  console.log(`celkem hotovo ${done + kept + dropped}/${candidates.length}, zbývá ${todo.length - kept - dropped}`)
}

// Directory-qualified: a bare 'retrieval.ts' also matches run-retrieval.ts, so importing this
// module from the runner would launch the interactive labelling CLI mid-eval.
if (/[\\/]label[\\/]retrieval\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
