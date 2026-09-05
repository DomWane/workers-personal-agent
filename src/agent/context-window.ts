import type { TurnLog } from './log'
import type { HistoryMessage, ToolCall } from '../types'

/** Headroom for the reply and a round's tool output. Was 0.70, which compacted a turn earlier than
 *  it had to. */
const COMPACT_AT_FRACTION = 0.8
/** Higher than the comparable harnesses on purpose: they prune oversized tool results at
 *  compaction, where this prunes them per round, so what reaches here is already stubbed. */
const COMPACT_KEEP_FRACTION = 0.25
/** The smallest window measured here, so an unknown model compacts early rather than overflowing. */
export const DEFAULT_CONTEXT_TOKENS = 24_000

/** An overestimate on purpose, and only the fallback: a provider's own `prompt_tokens` wins. The
 *  3.11 measured for `MAX_EMBED_CHARS` is bge-m3's tokenizer and does not transfer. */
export const CHARS_PER_TOKEN = 3

/**
 * The most of the model's window one tool result may occupy, in estimated characters.
 *
 * `COMPACT_KEEP_FRACTION` keeps a quarter of the window as verbatim tail; a single result taking
 * more than a large slice of that *becomes* the tail after the next compaction, which is the defect
 * `evals/results/inline-page-size-preregistration.md` derives from constants rather than measures.
 * At 24k this is 7,200 characters and binds; at 1.31M it is 393,000 and `MAX_PAGE_CHARS` binds
 * first. That crossover is the point — one number cannot serve a picker spanning fifty-fold.
 */
export const RESULT_SHARE_OF_WINDOW = 0.1

/** The cap a result is actually cut to: its tool's own, and never more than the window allows.
 *  `context` absent means unknown, not small — see `ToolContext.contextTokens`. */
export function resultCap(toolCap: number, context: number | undefined): number {
  return context === undefined
    ? toolCap
    : Math.min(toolCap, Math.floor(RESULT_SHARE_OF_WINDOW * context * CHARS_PER_TOKEN))
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** `tool_calls` is on the spoken arm only, and four readers below ask this of a message they have
 *  no reason to narrow first. */
function callsOf(m: HistoryMessage | undefined): ToolCall[] {
  return m && m.role !== 'tool' ? (m.tool_calls ?? []) : []
}

/**
 * The conversation, without the tool traffic that shares the array with it.
 *
 * Every reader that treats history as something a person said needs this, and there are three:
 * `transcript` renders anything that is not a user as "Assistant", so a fetched page would reach
 * both the compaction summarizer and the nightly reflection as assistant speech — the second of
 * those being the prompt that gates destructive memory writes.
 *
 * Never applied to what the *archive* keeps, and never inside `transcript` itself: `citationLabels`
 * numbers by position over the same array, so filtering one and not the other points every citation
 * at the wrong turn.
 */
export function spoken(messages: HistoryMessage[]): HistoryMessage[] {
  return messages.filter((m) => m.role !== 'tool' && !m.tool_calls?.length)
}

/**
 * The conversation as this question must see it, when the question is not the newest thing in
 * state. Queued messages sit *after* it and answers are appended at the end, so the stored order
 * interleaves once two are in flight: everything before, the answers that have landed since, then
 * this question last. Anything else waiting is a turn of its own and this one must not answer as if
 * it had seen it.
 *
 * The later turns contribute their answers and nothing else. Keeping an assistant's `tool_calls`
 * without the `tool` replies underneath it is an unanswered call, which the API refuses with the
 * same 400 as an unmatched one — and the traffic belongs to an answer this turn never saw anyway.
 */
export function historyForTurn(messages: HistoryMessage[], at: number, question: HistoryMessage): HistoryMessage[] {
  const answeredSince = spoken(messages.slice(at + 1)).filter((m) => m.role === 'assistant')
  return [...messages.slice(0, at), ...answeredSince, question]
}

/**
 * Drops any tool traffic whose other half is missing, over the copy that goes to the model — the
 * persisted history keeps whatever it holds.
 *
 * Three shapes, and the provider refuses all three with a 400 on a request it would otherwise have
 * answered. Two are reachable without a bug: a turn that dies between a round and its results
 * leaves calls unanswered, and compaction moving its boundary is a guard, not a proof.
 *
 * **A permissive endpoint hides this**, so the fault lies dormant until a provider changes — which
 * here is a button in the composer. That is why the copy is sanitized rather than the writer
 * trusted, and why the trim is loud: it is the one this repo could not otherwise see.
 */
export function pairedOnly(history: HistoryMessage[], log?: TurnLog): HistoryMessage[] {
  const answered = new Set(history.flatMap((m) => (m.role === 'tool' && m.tool_call_id ? [m.tool_call_id] : [])))
  const fullyAnswered = (m: HistoryMessage) => callsOf(m).every((c) => answered.has(c.id))
  // Against the assistants that *survived*, not the original array: otherwise a partly-answered
  // round loses its assistant and leaves the one result that did arrive behind, as a fresh orphan.
  const live = new Set(history.filter(fullyAnswered).flatMap((m) => callsOf(m).map((c) => c.id)))
  const kept = history.filter((m) => (m.role === 'tool' ? live.has(m.tool_call_id) : fullyAnswered(m)))
  if (kept.length !== history.length) {
    log?.error({ at: 'history', stage: 'unpaired-tool-traffic', dropped: history.length - kept.length })
  }
  return kept
}

/** An assistant that only called tools carries `''`, so counting `content` alone would price a
 *  round of tool calls at zero and let the surface drift past the threshold unnoticed. */
function messageTokens(m: HistoryMessage): number {
  const calls = callsOf(m).reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0)
  return estimateTokens(m.content) + Math.ceil(calls / CHARS_PER_TOKEN)
}

export function historyTokens(messages: HistoryMessage[], summary?: string): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0) + estimateTokens(summary ?? '')
}

export const compactAt = (context: number) => Math.floor(context * COMPACT_AT_FRACTION)
export const compactKeep = (context: number) => Math.floor(context * COMPACT_KEEP_FRACTION)

/**
 * A boundary inside an assistant's tool-call group is moved back onto that assistant, even where
 * that overshoots the budget. A `tool` message whose request was evicted is an unmatched
 * `tool_call_id`, which the next request answers with a 400 — and since it stays in state, the
 * thread is then dead rather than degraded. The budget is already breakable for correctness
 * elsewhere: `planCompaction` keeps the last exchange over any size.
 */
function ownedGroupStart(messages: HistoryMessage[], first: number): number {
  let i = first
  while (i > 0 && messages[i].role === 'tool') {
    i--
  }
  return callsOf(messages[i]).length ? i : first
}

/** Both callers below are this walk with a different floor. */
function tailFrom(messages: HistoryMessage[], budgetTokens: number, minKept: number): number {
  let spent = 0
  let first = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messageTokens(messages[i])
    if (spent + cost > budgetTokens && messages.length - i > minKept) {
      break
    }
    spent += cost
    first = i
  }
  return ownedGroupStart(messages, first)
}

/** Keeps the last exchange even when it alone exceeds the budget: one message larger than the
 *  window is a different failure, and one the provider's own refusal handles. */
export function planCompaction(messages: HistoryMessage[], keepTokens: number): HistoryMessage[] {
  return messages.slice(0, tailFrom(messages, keepTokens, 2))
}

/**
 * How much of the evicted head one summarizing call can read; chaining passes until it all fits
 * would compress a summary of a summary, invisibly. The *newest* evicted turns are the ones read,
 * so the gap this leaves is the one furthest from the live conversation.
 */
export function fitHead(
  evicted: HistoryMessage[],
  budgetTokens: number,
): { summarize: HistoryMessage[]; unsummarized: HistoryMessage[] } {
  const first = tailFrom(evicted, budgetTokens, 1)
  return { summarize: evicted.slice(first), unsummarized: evicted.slice(0, first) }
}

/** Matched on the message: the OpenAI-compatible vendors agree on the wording far more than on
 *  the error code. */
export function isContextOverflow(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return /context (length|window)|maximum context|too many tokens|reduce the length|prompt is too long/i.test(text)
}
