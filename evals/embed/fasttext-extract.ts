import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import type { Chunk } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { tokenize } from '../lib/tokenize.ts'

/**
 * Pulls the corpus vocabulary out of a fastText .vec file and drops the rest. The Czech Common
 * Crawl vectors hold two million words at 300 dimensions; this corpus uses about thirteen
 * thousand of them, so keeping the file whole would mean carrying 1.2 GB to answer 78 queries.
 *
 * Streamed through gunzip line by line for the same reason — the decompressed file does not fit
 * comfortably in memory, and nothing here needs more than one line at a time.
 */

const SOURCE = process.env.FASTTEXT_VEC ?? `${process.env.HOME}/Downloads/cc.cs.300.vec.gz`
const OUT = 'evals/data/fasttext-vectors.json'

export type VectorFile = { dim: number; vectors: Record<string, number[]> }

/**
 * The corpus tokenizer decides what counts as a word, so the same folding that BM25 sees is what
 * gets looked up here. A vector file keyed on raw text would miss on diacritics alone.
 */
export function corpusVocabulary(chunks: Chunk[], queries: string[]): Set<string> {
  const vocab = new Set<string>()
  for (const c of chunks) {
    for (const t of tokenize(c.text)) {
      vocab.add(t)
    }
  }
  for (const q of queries) {
    for (const t of tokenize(q)) {
      vocab.add(t)
    }
  }
  return vocab
}

async function main(): Promise<void> {
  const chunks = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const labels = readJsonLines<{ query: string }>('evals/data/retrieval.labels.jsonl', { required: true })
  const vocab = corpusVocabulary(
    chunks,
    labels.map((l) => l.query),
  )
  console.log(`hledám ${vocab.size} slov korpusu v ${SOURCE}`)

  const rl = createInterface({ input: createReadStream(SOURCE).pipe(createGunzip()), crlfDelay: Infinity })
  const vectors: Record<string, number[]> = {}
  let dim = 0
  let seen = 0

  for await (const line of rl) {
    seen++
    // First line is a "<count> <dim>" header rather than a vector.
    if (seen === 1) {
      dim = Number.parseInt(line.trim().split(/\s+/)[1] ?? '0', 10)
      continue
    }
    const cut = line.indexOf(' ')
    if (cut < 1) {
      continue
    }
    // Folded to match the tokenizer: the file holds cased and accented forms, the corpus does not.
    const word = line
      .slice(0, cut)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
    if (!vocab.has(word) || vectors[word]) {
      continue
    }
    vectors[word] = line
      .slice(cut + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    if (seen % 200_000 === 0) {
      console.log(`  ${seen} řádků, nalezeno ${Object.keys(vectors).length}/${vocab.size}`)
    }
  }

  const found = Object.keys(vectors).length
  writeFileSync(OUT, `${JSON.stringify({ dim, vectors } satisfies VectorFile)}\n`)
  console.log(`\nřádků ve zdroji: ${seen} | dim: ${dim}`)
  console.log(`nalezeno ${found}/${vocab.size} slov — OOV ${(((vocab.size - found) / vocab.size) * 100).toFixed(1)}%`)
  console.log(`zapsáno ${OUT}`)
}

if (/[\\/]embed[\\/]fasttext-extract\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
