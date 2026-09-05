import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { Chunk, EmbeddingsIndex } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { unpackVectors } from '../lib/vectors.ts'
import { denseRetriever } from '../retrievers/dense.ts'
import { assertDenseInputsFresh, type Labelled } from '../run-retrieval.ts'

/**
 * Runs two models over the same questions and the same retrieved context, and records what each
 * one spent. The design is fixed in evals/results/thinkingcap-preregistration.md; this file only
 * collects data, and deliberately computes nothing — no ratios, no verdicts. Analysis happens
 * after judging, from the recorded rows.
 *
 * The hard set is the pre-registered sample because those queries are diagnostic rather than
 * lookup: a task with no reasoning in it cannot test a claim about reasoning tokens. The bulk set
 * runs as a separate, larger sample — its queries are lexically closer to their targets, so fewer
 * items should collapse into ties.
 */

/**
 * Which label set to run. The hard set was the pre-registered sample; the bulk set is the planned
 * extension, kept in its own file because the two are never averaged — bulk queries are generated
 * paraphrases and hard queries are written from memory, which are different tasks.
 */
const SET = process.env.EVAL_SET === 'bulk' ? 'bulk' : 'hard'
/**
 * Names the serving conditions, not just the sample. The first runs went through an aggregator that
 * routed across hosts of unknown quantisation; these go to two endpoints we control. Mixing the two
 * in one file would be undetectable afterwards, because nothing in a row says which.
 */
const RUN_TAG = process.env.EVAL_RUN_TAG ?? 'hfe'
const OUT = `evals/data/model-runs.${RUN_TAG}.${SET}.jsonl`
/**
 * The sampling the model's authors used for the numbers under replication. Greedy decoding was the
 * original design here; it measures the model outside its documented regime and risks the
 * repetition loops reasoning models fall into — which is what a ceiling-length completion in the
 * first runs looks like. See amendment 6.
 */
const TEMPERATURE = Number.parseFloat(process.env.MODEL_TEMPERATURE ?? '1.0')
const TOP_P = Number.parseFloat(process.env.MODEL_TOP_P ?? '0.95')
const SAMPLE_TOP_K = Number.parseInt(process.env.MODEL_TOP_K ?? '20', 10)
const MIN_P = Number.parseFloat(process.env.MODEL_MIN_P ?? '0')
/**
 * Sampling makes one run a draw rather than a measurement — the authors report high run-to-run
 * variability and used five seeds. Each seed is a full pass over the set and the spread across them
 * is what gets reported, so a single-seed number would be an anecdote with a confidence interval.
 */
const SEEDS = (process.env.MODEL_SEEDS ?? '1,2,3').split(',').map((x) => Number.parseInt(x.trim(), 10))
/**
 * Restricts a run to one endpoint. Alternating between them per question needs both machines up
 * for the whole run, and the slower model then bills the faster one's idle time — on dedicated
 * hardware that doubles the cost of the same calls. The prompts do not depend on which endpoint
 * ran, so splitting the passes changes the bill and nothing else.
 */
const ONLY = process.env.EVAL_ONLY
/**
 * Fixed at bge-m3 top-5 even after the retriever improves. Changing retrieval between the two
 * halves would confound a better context with a larger sample; retrieval quality is measured by
 * the retrieval eval, not by this one.
 */
const TOP_K = 5
/**
 * Deliberately generous. A low ceiling truncates whichever model thinks longer — which is the base
 * model by hypothesis — so the saving under test would partly be this setting rather than the
 * fine-tune. Raised to the larger of the two budgets the authors used, because a truncated item is
 * dropped and the dropped ones are the hardest questions, not a random sample of them.
 */
const MAX_TOKENS = Number.parseInt(process.env.MODEL_MAX_TOKENS ?? '24576', 10)

export type Run = {
  query: string
  model: string
  /**
   * Which pass this row came from. Sampling makes one run a draw, so the same question is asked
   * once per seed and the spread across them is the measurement.
   */
  seed: number
  answer: string
  reasoningTokens: number | null
  /**
   * Length of the reasoning trace in characters. Recorded because the token count cannot be
   * trusted across these two providers: Sference returns the trace in `reasoning_content` while
   * reporting `reasoning_tokens: 0`. Characters need no tokenizer and both traces are Czech.
   */
  reasoningChars: number
  completionTokens: number | null
  promptTokens: number | null
  /** Recorded for completeness, not reported: it measures the provider's serving stack. */
  latencyMs: number
  finishReason: string | null
  /**
   * Who actually served the call. An aggregator routes freely across hosts differing in
   * quantisation and hardware; the first runs recorded neither field, so that is now unknowable.
   */
  provider: string | null
  generationId: string | null
  contextIds: string[]
}

const SYSTEM = [
  'Odpovídej česky a pouze na základě přiložených úryvků.',
  'Když v nich odpověď není, napiš to — nedomýšlej si.',
].join(' ')

export function buildPrompt(query: string, context: Chunk[]): string {
  const blocks = context.map((c, i) => `--- úryvek ${i + 1} (${c.ts.slice(0, 10)}) ---\n${c.text}`)
  return `${blocks.join('\n\n')}\n\nOTÁZKA: ${query}`
}

/**
 * A run is identified by the pair, so an interrupted session resumes without paying twice. Both
 * sides of the resume check must build the key the same way — they did not, and the mismatch cost
 * a duplicate call per already-answered question without anything failing.
 *
 * The separator is NUL because a model name or a query may contain a space, and it is written as an
 * escape because a literal one makes git treat this whole file as binary.
 */
export function runKey(model: string, query: string, seed = 0): string {
  return [seed, model, query].join('\u0000')
}

export function doneKeys(path: string): Set<string> {
  return new Set(readJsonLines<Run>(path).map((r) => runKey(r.model, r.query, r.seed ?? 0)))
}

type Usage = {
  completion_tokens?: number
  prompt_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  // Some providers report reasoning separately at the top level instead.
  reasoning_tokens?: number
}

/**
 * Reasoning tokens are the whole point and the field is not standardised, so both known shapes are
 * read and a miss returns null rather than zero. Zero would silently become "no reasoning at all"
 * in the median and make the saving look total.
 */
export function reasoningTokensOf(usage: Usage | undefined): number | null {
  const v = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens
  return typeof v === 'number' ? v : null
}

/**
 * The trace itself, under either name the two providers use. OpenRouter puts it in `reasoning`,
 * Requesty in `reasoning_content` — and the latter pairs it with `reasoning_tokens: 0`, so a run
 * trusting the count alone would record a model that thought for 143 tokens as having not thought
 * at all, and report a 100% saving.
 */
export function reasoningTextOf(message: { reasoning?: string; reasoning_content?: string } | undefined): string {
  return message?.reasoning ?? message?.reasoning_content ?? ''
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/**
 * Pulls the trace out of the content itself. A plain vLLM server started without a reasoning
 * parser returns the whole `<think>…</think>` block inline, so a run that only read the provider
 * fields would score the trace as part of the answer and measure a saving of zero.
 *
 * Doing the split here rather than asking the server to do it also removes the dependency that
 * already cost this experiment: the same code now derives the trace for every endpoint, instead of
 * trusting fields that two providers filled in differently and one filled in wrongly.
 */
export function splitThinking(content: string): { answer: string; thinking: string } {
  const thinking: string[] = []
  let answer = ''
  // This model's chat template puts the opening tag in the generation prompt, so the completion
  // begins inside the block and carries only the closing one. Supplying the missing tag rather
  // than special-casing it keeps one code path for both shapes.
  const firstClose = content.indexOf(THINK_CLOSE)
  const firstOpen = content.indexOf(THINK_OPEN)
  let rest = firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen) ? THINK_OPEN + content : content
  while (true) {
    const open = rest.indexOf(THINK_OPEN)
    if (open === -1) {
      answer += rest
      break
    }
    answer += rest.slice(0, open)
    const after = rest.slice(open + THINK_OPEN.length)
    const close = after.indexOf(THINK_CLOSE)
    // No closing tag means the ceiling cut the model off mid-thought. The fragment is reasoning,
    // not an answer, and letting it through would enter a stream of thought into the data as one.
    if (close === -1) {
      thinking.push(after.trim())
      break
    }
    thinking.push(after.slice(0, close).trim())
    rest = after.slice(close + THINK_CLOSE.length)
  }
  return { answer: answer.trim(), thinking: thinking.join('\n') }
}

/**
 * Decides what the model answered and what it merely thought, across every shape these endpoints
 * produce. Kept separate from the HTTP call so it can be tested: every measurement error this
 * experiment has suffered so far lived in exactly this step and failed silently.
 */
export function separateTrace(
  message: { content?: string; reasoning?: string; reasoning_content?: string } | undefined,
  finishReason: string | null,
): { answer: string; reasoningText: string } {
  const content = message?.content ?? ''
  const fromField = reasoningTextOf(message)
  // A completion the ceiling cut off mid-thought never reaches its closing tag, and because the
  // opening one lives in the prompt it arrives with no tags at all — shaped exactly like a plain
  // answer. Recorded as one it would report a long answer and no reasoning: the saving inverted.
  if (finishReason === 'length' && !fromField && !content.includes(THINK_CLOSE)) {
    return { answer: '', reasoningText: content.trim() }
  }
  const split = splitThinking(content)
  return { answer: split.answer, reasoningText: fromField || split.thinking }
}

type Reply = {
  answer: string
  reasoningText: string
  usage: Usage | undefined
  finishReason: string | null
  latencyMs: number
  provider: string | null
  generationId: string | null
}

/**
 * Each model carries its own endpoint. The base model and the fine-tune are not served by the same
 * provider, which is a confound the pre-registration records rather than hides: quantisation and
 * sampling implementation differ per host, so a quality difference is not purely the model's.
 * Token counts survive this better than quality does — the tokenizer is shared.
 */
export type Endpoint = { label: 'base' | 'tuned'; base: string; key: string; model: string }

export function endpointsFromEnv(env: NodeJS.ProcessEnv): Endpoint[] {
  const read = (p: string, label: 'base' | 'tuned'): Endpoint => {
    const base = env[`${p}_API_BASE`]
    // Both endpoints are now our own, authenticated by the one account token, so the per-endpoint
    // key is optional rather than a third copy of the same secret in the same file.
    const key = env[`${p}_API_KEY`] ?? env.HF_TOKEN
    const model = env[`${p}_MODEL`]
    if (!base || !key || !model) {
      throw new Error(`set ${p}_API_BASE, ${p}_API_KEY and ${p}_MODEL`)
    }
    return { label, base, key, model }
  }
  return [read('BASE', 'base'), read('TUNED', 'tuned')].filter((e) => !ONLY || e.label === ONLY)
}

/**
 * Transport-level retry, and only that. A run is ninety calls of up to two minutes each, so a
 * dropped connection is a matter of when rather than whether — one ECONNRESET already threw away
 * an hour of a paid run at call twenty-five. Retried on network failures and on the statuses that
 * mean "ask again"; a 4xx is a request that will fail identically next time and stops the run.
 *
 * Deliberately does not cover an empty completion. That is a reply the server meant to send, and
 * retrying it would quietly resample until the model said something — which is a different
 * experiment from the one being run.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  const waits = [2000, 8000, 30000]
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.status !== 429 && res.status < 500) {
        return res
      }
      if (attempt >= waits.length) {
        return res
      }
      console.log(`  ${label}: HTTP ${res.status}, zkouším znovu za ${waits[attempt] / 1000}s`)
    } catch (err) {
      if (attempt >= waits.length) {
        throw err
      }
      console.log(`  ${label}: ${(err as Error).message}, zkouším znovu za ${waits[attempt] / 1000}s`)
    }
    await new Promise((r) => setTimeout(r, waits[attempt]))
  }
}

async function ask(prompt: string, ep: Endpoint, seed: number): Promise<Reply> {
  const t0 = performance.now()
  const res = await fetchWithRetry(
    `${ep.base.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${ep.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ep.model,
        // Asks the provider to report the reasoning trace and its token count. Affects what comes
        // back, not what is generated, so both sides can carry it without becoming different runs.
        include_reasoning: true,
        temperature: TEMPERATURE,
        top_p: TOP_P,
        top_k: SAMPLE_TOP_K,
        min_p: MIN_P,
        seed,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    },
    ep.model,
  )
  if (!res.ok) {
    throw new Error(`${ep.model} ${res.status}: ${(await res.text()).slice(0, 400)}`)
  }
  const data = (await res.json()) as {
    id?: string
    provider?: string
    choices?: Array<{
      message?: { content?: string; reasoning?: string; reasoning_content?: string }
      finish_reason?: string
    }>
    usage?: Usage
  }
  const choice = data.choices?.[0]
  const finishReason = choice?.finish_reason ?? null
  const { answer, reasoningText } = separateTrace(choice?.message, finishReason)
  // Hitting the ceiling is a foreseen outcome the pre-registration handles by excluding the item,
  // so it is recorded and the run continues. An empty completion for any other reason is a broken
  // reply and stops the run rather than entering the data as a valid short answer.
  if (!answer.trim() && finishReason !== 'length') {
    throw new Error(`${ep.model} returned no content (finish_reason ${finishReason})`)
  }
  return {
    answer,
    reasoningText,
    usage: data.usage,
    finishReason,
    latencyMs: performance.now() - t0,
    provider: data.provider ?? null,
    generationId: data.id ?? null,
  }
}

async function main(): Promise<void> {
  const endpoints = endpointsFromEnv(process.env)

  const chunks = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const labels = readJsonLines<Labelled>('evals/data/retrieval.labels.jsonl', { required: true })
  const selected = labels.filter((l) => l.kind === SET)

  const meta = JSON.parse(readFileSync('evals/data/embeddings.index.json', 'utf8')) as EmbeddingsIndex
  const vectors = unpackVectors(readFileSync('evals/data/embeddings.bin'), meta.dim, meta.ids.length)
  const qv = JSON.parse(readFileSync('evals/data/query-vectors.json', 'utf8')) as Record<string, number[]>
  assertDenseInputsFresh(
    chunks,
    meta,
    labels.map((l) => l.query),
    qv,
  )
  const dense = denseRetriever(meta.ids, vectors, (q) => new Float32Array(qv[q]))
  const byId = new Map(chunks.map((c) => [c.id, c]))

  const done = existsSync(OUT) ? doneKeys(OUT) : new Set<string>()
  let ran = 0
  let missingReasoning = 0
  let truncated = 0

  // Seed outermost, so an interrupted run leaves whole comparable passes behind rather than a set
  // covered unevenly across seeds.
  const passes = SEEDS.flatMap((seed) => selected.map((label) => ({ seed, label })))
  for (const { seed, label } of passes) {
    const contextIds = dense.search(label.query, TOP_K)
    const prompt = buildPrompt(
      label.query,
      contextIds.map((id) => byId.get(id)!),
    )
    for (const ep of endpoints) {
      if (done.has(runKey(ep.model, label.query, seed))) {
        continue
      }
      const { answer, reasoningText, usage, finishReason, latencyMs, provider, generationId } = await ask(
        prompt,
        ep,
        seed,
      )
      const reasoningTokens = reasoningTokensOf(usage)
      // Zero tokens alongside a non-empty trace is the provider under-reporting, not a model that
      // skipped thinking — counted separately so it cannot pass as a saving.
      if (reasoningTokens === null || (reasoningTokens === 0 && reasoningText.length > 0)) {
        missingReasoning++
      }
      if (finishReason === 'length') {
        truncated++
      }
      const row: Run = {
        query: label.query,
        model: ep.model,
        seed,
        answer,
        reasoningTokens,
        reasoningChars: reasoningText.length,
        completionTokens: usage?.completion_tokens ?? null,
        promptTokens: usage?.prompt_tokens ?? null,
        latencyMs,
        finishReason,
        provider,
        generationId,
        contextIds,
      }
      appendFileSync(OUT, `${JSON.stringify(row)}\n`)
      ran++
      console.log(
        `${ran} [seed ${seed}] ${ep.model} | reasoning ${reasoningTokens ?? '—'} tok / ${reasoningText.length} zn` +
          ` | completion ${row.completionTokens ?? '—'}${finishReason === 'length' ? ' | USEKNUTO' : ''}`,
      )
    }
  }

  console.log(`\nhotovo: ${SET} set, seedy ${SEEDS.join(',')}, ${ran} běhů zapsáno do ${OUT}`)
  if (missingReasoning > 0) {
    console.log(`POZOR: ${missingReasoning} odpovědí s nedůvěryhodným reasoning_tokens.`)
    console.log('Použij reasoningChars; viz thinkingcap-preregistration.md, dodatek 3.')
  }
  if (truncated > 0) {
    console.log(`POZOR: ${truncated} odpovědí useknuto stropem ${MAX_TOKENS} tokenů.`)
    console.log('Ty otázky se ze srovnání vyřazují — viz dodatek 2, ne že by šetřily tokeny.')
  }
}

if (/[\\/]models[\\/]compare\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
