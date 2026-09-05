import { appendFileSync } from 'node:fs'
import type { Chunk } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { buildIdf, leakageScore } from '../lib/leakage.ts'

const LEAKAGE_MAX = 0.25
const TARGET = 150
const ATTEMPTS = 3
const OUT = 'evals/data/retrieval.candidates.jsonl'

const PROMPT = [
  'Níže je úryvek konverzace. Napiš JEDINOU otázku v češtině, kterou by o tomhle tématu',
  'položil člověk po několika měsících — pamatuje si jen téma, ne detaily.',
  'NESMÍŠ použít odborné termíny, názvy nástrojů ani identifikátory z textu.',
  'Odpověz pouze tou otázkou, bez uvozovek a bez vysvětlení.',
].join(' ')

export type Candidate = { chunkId: string; query: string; leakage: number }

/** Stratified across projects and time: a uniform sample over-represents the largest project. */
function sample(chunks: Chunk[], n: number): Chunk[] {
  const byProject = new Map<string, Chunk[]>()
  for (const c of chunks) {
    const list = byProject.get(c.project) ?? []
    list.push(c)
    byProject.set(c.project, list)
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts))
  }

  const out: Chunk[] = []
  const keys = [...byProject.keys()]
  let i = 0
  while (out.length < n && keys.length > 0) {
    const key = keys[i % keys.length]
    const list = byProject.get(key)!
    if (list.length === 0) {
      keys.splice(i % keys.length, 1)
      continue
    }
    out.push(list.splice(Math.floor(list.length / 2), 1)[0])
    i++
  }
  return out
}

/** Chunk ids already written to the candidates file, so a re-run after a crash doesn't re-pay for them. */
export function loadDoneChunkIds(path: string): Set<string> {
  return new Set(readJsonLines<Candidate>(path).map((c) => c.chunkId))
}

export function selectTodo(chunks: Chunk[], done: Set<string>): Chunk[] {
  return chunks.filter((c) => !done.has(c.id))
}

async function generate(chunk: Chunk, key: string, model: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: chunk.text.slice(0, 1500) },
      ],
      temperature: 0.7,
      // Reasoning models spend this budget before emitting any content: at 100 the whole
      // allowance went to the reasoning trace and every response came back with content null.
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[]
  }
  const choice = data.choices?.[0]
  const text = (choice?.message?.content ?? '').trim().replace(/^["']|["']$/g, '')
  // A truncated response yields no usable question; treating it as an answer is how 81 blank
  // candidates passed the leakage guard, which scores an empty string as a perfect 0.
  if (!text) {
    throw new Error(`empty completion (finish_reason: ${choice?.finish_reason ?? 'unknown'})`)
  }
  return text
}

export type ChunkOutcome =
  | { status: 'written'; candidate: Candidate }
  | { status: 'exhausted' } // every attempt leaked
  | { status: 'error' } // an API call failed; the chunk is not retried further this run

/**
 * One chunk's worth of generate-and-check, isolated from I/O so it can be unit tested with a
 * fake generateFn. A failed call ends this chunk's attempts rather than throwing, so one bad
 * call can't take the whole (paid, ~450-call) run down with it.
 */
export async function processChunk(
  chunk: Chunk,
  idf: Map<string, number>,
  generateFn: (chunk: Chunk) => Promise<string>,
  attempts: number = ATTEMPTS,
  leakageMax: number = LEAKAGE_MAX,
): Promise<{ outcome: ChunkOutcome; leakageRejections: number }> {
  let leakageRejections = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    let query: string
    try {
      query = await generateFn(chunk)
    } catch {
      return { outcome: { status: 'error' }, leakageRejections }
    }
    // Defence in depth: leakageScore rates a blank query a perfect 0, so without this a truncated
    // completion looks like the best candidate the guard has ever seen.
    if (!query.trim()) {
      leakageRejections++
      continue
    }
    const leakage = leakageScore(query, chunk.text, idf)
    if (leakage <= leakageMax) {
      return { outcome: { status: 'written', candidate: { chunkId: chunk.id, query, leakage } }, leakageRejections }
    }
    leakageRejections++
  }
  return { outcome: { status: 'exhausted' }, leakageRejections }
}

async function main(): Promise<void> {
  const key = process.env.LLM_API_KEY
  if (!key) {
    throw new Error('LLM_API_KEY not set')
  }
  const model = process.env.EVAL_GEN_MODEL ?? 'deepseek/deepseek-v4-flash'

  const chunks = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const idf = buildIdf(chunks)
  const picked = sample(chunks, TARGET)

  const done = loadDoneChunkIds(OUT)
  const todo = selectTodo(picked, done)
  if (done.size > 0) {
    console.log(`resuming: ${done.size} candidates already in ${OUT}, ${todo.length} chunks left`)
  }

  let written = 0
  let leakageRejections = 0
  let exhausted = 0
  let apiErrors = 0

  for (const [i, chunk] of todo.entries()) {
    const result = await processChunk(chunk, idf, (c) => generate(c, key, model))
    leakageRejections += result.leakageRejections
    if (result.outcome.status === 'written') {
      // append per candidate, not once at the end: a crash mid-run must not lose what's already earned
      appendFileSync(OUT, `${JSON.stringify(result.outcome.candidate)}\n`)
      written++
    } else if (result.outcome.status === 'exhausted') {
      exhausted++
    } else {
      apiErrors++
    }
    if ((i + 1) % 20 === 0) {
      console.log(
        `${i + 1}/${todo.length} (written ${written}, leakage-rejected attempts ${leakageRejections}, ` +
          `exhausted ${exhausted}, errors ${apiErrors})`,
      )
    }
  }

  console.log(
    `candidates written this run: ${written} | leakage-rejected attempts: ${leakageRejections} | ` +
      `chunks skipped after exhausting attempts: ${exhausted} | chunks lost to API errors: ${apiErrors}`,
  )
}

if (process.argv[1]?.endsWith('queries.ts')) {
  await main()
}
