import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { Chunk, EmbeddingsIndex } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { tokenizeStemmed } from '../lib/stem.ts'
import { buildPool, key, shuffleWithinQuery } from '../lib/pool.ts'
import { unpackVectors } from '../lib/vectors.ts'
import { bm25Retriever } from '../retrievers/bm25.ts'
import { denseRetriever } from '../retrievers/dense.ts'
import { fasttextRetriever } from '../retrievers/fasttext.ts'
import { keywordRetriever } from '../retrievers/keyword.ts'
import { rerankRetriever } from '../retrievers/rerank.ts'
import { rrfRetriever } from '../retrievers/rrf.ts'
import type { RerankRow } from '../embed/rerank-precompute.ts'
import { assertDenseInputsFresh, type Labelled } from '../run-retrieval.ts'

/**
 * Fills in the relevant chunks the labelling pass never saw. One label per query understates every
 * retriever, because a corpus this redundant answers a question in several places — and it
 * understates them unequally, punishing whichever retriever finds a different-but-correct chunk.
 */

const LABELS = 'evals/data/retrieval.labels.jsonl'
/** Rejections have to persist too, or every resume re-offers the pairs already turned down. */
const JUDGED = 'evals/data/retrieval.pool-judged.jsonl'

/** Rewritten in place after each accept: a session killed halfway must not lose its judgments. */
function saveLabels(labels: Labelled[]): void {
  const tmp = `${LABELS}.tmp`
  writeFileSync(tmp, `${labels.map((l) => JSON.stringify(l)).join('\n')}\n`)
  renameSync(tmp, LABELS)
}

async function main(): Promise<void> {
  const kind = (process.argv[2] as 'bulk' | 'hard') ?? 'hard'
  const depth = Number.parseInt(process.argv[3] ?? '3', 10)
  const chunks = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const labels = readJsonLines<Labelled>(LABELS, { required: true })

  // Refuse rather than pool from whatever is loaded: a pool missing a system credits the others
  // with its finds, and the resulting ground truth would favour them permanently.
  if (!existsSync('evals/data/embeddings.bin') || !existsSync('evals/data/query-vectors.json')) {
    throw new Error('pooling needs every retriever, and the dense one has no vectors — run pnpm eval:embed first')
  }
  const meta = JSON.parse(readFileSync('evals/data/embeddings.index.json', 'utf8')) as EmbeddingsIndex
  const vectors = unpackVectors(readFileSync('evals/data/embeddings.bin'), meta.dim, meta.ids.length)
  const qv = JSON.parse(readFileSync('evals/data/query-vectors.json', 'utf8')) as Record<string, number[]>
  assertDenseInputsFresh(
    chunks,
    meta,
    labels.map((l) => l.query),
    qv,
  )

  const retrievers = [
    keywordRetriever(chunks),
    bm25Retriever(chunks),
    // Every retriever the runner scores has to be in the pool. A system left out gets no chance
    // to contribute a relevant chunk, and is then measured against ground truth the others built.
    bm25Retriever(chunks, { name: 'bm25-stem', tokenizer: tokenizeStemmed }),
    denseRetriever(meta.ids, vectors, (q) => new Float32Array(qv[q])),
  ]
  // The two-stage systems are scored like any other, so their candidates have to be judged like
  // any other. Both fuse or reorder the lists above, but each can promote a chunk none of them
  // ranked in its own top-3, and that chunk would otherwise count as non-relevant by default.
  const denseFor = denseRetriever(meta.ids, vectors, (q) => new Float32Array(qv[q]))
  const lexicalFor = bm25Retriever(chunks, { name: 'bm25-stem', tokenizer: tokenizeStemmed })
  for (const weight of [1, 2, 4]) {
    retrievers.push(
      rrfRetriever(
        [
          { retriever: denseFor, weight },
          { retriever: lexicalFor, weight: 1 },
        ],
        {
          depth: 20,
          name: `rrf-${weight}:1`,
        },
      ),
    )
  }
  if (existsSync('evals/data/rerank.jsonl')) {
    retrievers.push(rerankRetriever(readJsonLines<RerankRow>('evals/data/rerank.jsonl')))
  }
  if (existsSync('evals/data/fasttext-vectors.json')) {
    const ft = JSON.parse(readFileSync('evals/data/fasttext-vectors.json', 'utf8')) as {
      dim: number
      vectors: Record<string, number[]>
    }
    retrievers.push(fasttextRetriever(chunks, ft.vectors, ft.dim))
  }
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const judged = new Set(readJsonLines<{ query: string; chunkId: string }>(JUDGED).map((j) => key(j.query, j.chunkId)))
  const targets = labels.filter((l) => l.kind === kind)
  const pool = shuffleWithinQuery(buildPool(targets, retrievers, depth, judged))

  console.log(`pooling ${kind} do hloubky ${depth}: ${pool.length} dvojic k posouzení`)
  console.log('Nevíš, který retriever chunk vrátil — a je to schválně. Posuzuješ odpověď, ne systém.')
  console.log('Ptej se jen: odpovídá tenhle chunk na ten dotaz? Ne jestli je to nejlepší odpověď.\n')

  const rl = createInterface({ input: stdin, output: stdout })
  let accepted = 0
  let done = 0

  for (const item of pool) {
    const chunk = byId.get(item.chunkId)
    if (!chunk) {
      continue
    }
    console.log(`\n──── ${done + 1}/${pool.length} ────`)
    console.log(`DOTAZ: ${item.query}`)
    console.log(`${'─'.repeat(70)}\n${chunk.text}\n${'─'.repeat(70)}`)
    const ans = (await rl.question('odpovídá to na dotaz? [a]no / [n]e / [q]uit > ')).trim().toLowerCase()
    if (ans === 'q') {
      break
    }
    const relevant = ans === 'a'
    appendFileSync(JUDGED, `${JSON.stringify({ query: item.query, chunkId: item.chunkId, relevant })}\n`)
    if (relevant) {
      const label = labels.find((l) => l.query === item.query)
      if (label && !label.relevant.includes(item.chunkId)) {
        label.relevant.push(item.chunkId)
        saveLabels(labels)
      }
      accepted++
    }
    done++
  }

  rl.close()
  const perQuery = (accepted / Math.max(1, targets.length)).toFixed(2)
  console.log(`\nposouzeno ${done}/${pool.length}, doplněno ${accepted} relevantních (${perQuery} na dotaz)`)
  console.log('spusť pnpm eval:retrieval — čísla by měla vyrůst všem třem retrieverům')
}

if (/[\\/]label[\\/]pool\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
