import type OpenAI from 'openai'
import { z } from 'zod'
import { chatCompletionWithTools } from '../connectors/llm.connector'
import type { CompletionResult } from '../connectors/llm.connector'
import { errorFields, ORPHAN_LOG } from './log'
import type { TurnLog } from './log'
import { pairedOnly, resultCap } from './context-window'
import { retryOnce } from './retry'
import { BudgetExhausted, type SubrequestBudget } from './subrequest-budget'
import type { ChatMessage, HistoryMessage } from '../types'
import {
  DEFAULT_RESULT_CHARS,
  recoverableAt,
  REF_MARKER,
  toolSpec,
  truncate,
  type ToolContext,
  type ToolDef,
} from './tools/registry'

/** An empty assistant message renders as a blank bubble, which reads as a bug rather than as a
 *  model that produced nothing. */
const EMPTY_REPLY_FALLBACK = '(no answer produced — try rephrasing)'

/** Kept unspent for the final answer call: crossing the platform's subrequest cap kills the reply
 * *and* the error message, leaving silence. */
export const FINAL_ANSWER_RESERVE = 6

/** What a tool returns when it hit the reserve. A distinct string rather than an `error:` message
 *  because the loop reads it as a stop reason, and the model as a fact about the turn. */
const OUT_OF_BUDGET_RESULT = 'error: skipped, request budget exhausted'

const OUT_OF_BUDGET_REPLY =
  '(stopped early — this turn ran out of its request budget before I could answer. Try again, ideally in smaller steps.)'

/** Models sometimes emit a tool call as prose instead of structured tool_calls. */
// The fullwidth pipe (U+FF5C) is not the ASCII one: deepseek-v4-flash emits `<｜DSML｜tool_calls>`
// and an ASCII-only guard let 362 characters of it through as an answer on 2026-08-08.
const TEXT_TOOL_CALL = /<tool_call>|<arg_key>|<function=|<[|｜]tool▁call|<｜|DSML｜/

/**
 * A forced tool_choice:'none' call makes some providers emit the tool call as prose;
 * that text must never reach the user verbatim.
 */
function safeText(content: string): string {
  const trimmed = content.trim()
  if (!trimmed || TEXT_TOOL_CALL.test(trimmed)) {
    return EMPTY_REPLY_FALLBACK
  }
  return trimmed
}

/**
 * Diagnostics for failures that could not be reproduced offline (empty replies, truncated
 * answers, tool calls leaked as text). Logged, never used for control flow.
 */
function logCompletion(
  log: TurnLog,
  stage: string,
  round: number,
  model: string,
  r: CompletionResult,
  durationMs: number,
): void {
  const leaked = r.toolCalls.length === 0 && TEXT_TOOL_CALL.test(r.content)
  log.event(
    {
      at: 'tool-loop',
      stage,
      round,
      model,
      provider: r.provider,
      finishReason: r.finishReason,
      // Per round, not per turn: a turn total cannot say which round was the expensive one.
      durationMs,
      ...(r.usage ? { usage: r.usage } : {}),
      contentLen: r.content.length,
      toolCalls: r.toolCalls.map((c) => c.function.name),
      empty: r.content.trim() === '' && r.toolCalls.length === 0,
      leakedToolCallText: leaked,
    },
    leaked || r.finishReason === 'length' ? { sample: r.content.slice(0, 400) } : undefined,
  )
}

/**
 * Why the loop stopped. One value, not three independent booleans: those could be true at once
 * and still not say which fired first, so `roundsUsed === 6` never distinguished a turn that ran
 * out of rounds from one that happened to need six.
 */
export type StopReason = 'complete' | 'max-rounds' | 'time-budget' | 'subrequest-budget' | 'no-progress'

export interface ToolLoopInput {
  /** Correlates every record this loop emits with the turn that started it. */
  log?: TurnLog
  client: OpenAI
  model: string
  systemPrompt: string
  history: ChatMessage[]
  tools: ToolDef[]
  ctx: ToolContext
  maxRounds?: number
  budgetMs?: number
  perToolTimeoutMs?: number
  /** Per-invocation subrequest budget; omitted in tests → unmetered. */
  subrequests?: SubrequestBudget
  /**
   * Whether to spend one more call forcing an answer when the loop runs out of rounds. False for
   * a caller that needs its own shape and will ask for it anyway: that caller would otherwise pay
   * for two final calls, and the forced one came back as leaked tool-call markup three times out
   * of three against deepseek-v4-flash.
   */
  forceFinalAnswer?: boolean
}

/** `messages` rides along so a caller that could not use the final answer can ask again from the
 *  same conversation instead of re-fetching everything it already paid for. */
export interface LoopResult {
  text: string
  toolsUsed: string[]
  stopReason: StopReason
  roundsUsed: number
  messages: ChatMessage[]
  /**
   * The provider's own `prompt_tokens` for the first round — the one call whose request is the
   * system prompt plus the history and nothing else, which is what the compaction threshold is
   * about. Later rounds carry tool results too. Absent when the upstream omits `usage`, and the
   * caller then falls back to estimating.
   */
  promptTokens?: number
  /** Input plus output across every round, as the provider reported them. 0 when it reported none,
   *  which the `unmetered` record distinguishes from a turn that genuinely spent nothing. */
  tokensSpent: number
}

/**
 * Filing buys a **ref**, not survival — compaction archives everything it evicts either way. So it
 * asks "worth re-reading a turn from now", which is why raising it to `DEFAULT_RESULT_CHARS` was
 * refused: 2,000–4,000 is the band that is never cut, and a ref is the only way back to it.
 *
 * **It must also stay under the smallest cap anything is cut at** — 4,000 today — or a result could
 * be cut and not filed, leaving the model a marker it cannot redeem.
 */
export const ARCHIVE_MIN_CHARS = 2000

/**
 * Borrowed rather than derived, and never settled either way —
 * `evals/results/inline-page-size-preregistration.md` holds what was tried and reverted.
 *
 * **The threshold must stay above head + tail**, or shortening makes the text longer and the marker
 * reports a negative count — it shipped once as `slice(-0)` returning the whole string.
 */
const PRUNE_HEAD_CHARS = 4096
const PRUNE_TAIL_CHARS = 1024
export const PRUNE_OVER_CHARS = 8192

/** Head, tail and the ref — or the input unchanged, where it is under the threshold or carries no
 *  ref to recover the rest from. */
function shorten(content: string): string {
  const ref = REF_MARKER.exec(content)
  if (content.length <= PRUNE_OVER_CHARS || !ref) {
    return content
  }
  const cut = content.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
  const gap = `\n…[${cut} characters dropped from this copy — read_tool_result(${ref[1]}) has the whole result]…\n`
  return content.slice(0, PRUNE_HEAD_CHARS) + gap + content.slice(-PRUNE_TAIL_CHARS)
}

/**
 * How many of the most recent tool results stay whole. Every published value is higher (3 to 10),
 * and raising it to 3 was tried and reverted: those numbers come from 250- and 500-turn agents,
 * where a turn here is capped at 12 rounds. Because the prune runs *after* a round completes, this
 * pushes the first cut to round `N + 3` — and 13 of 16 real turns ran fewer than 4 rounds, so at 3
 * it never fired at all. `N = 0` is arm C of
 * `evals/results/inline-page-size-preregistration.md`, which holds the rest of the reasoning.
 */
const PROTECT_RECENT_RESULTS = 1

/**
 * Shortens tool results the model has already answered, in place. A page read early in a turn is
 * otherwise re-sent whole in every remaining round — measured at ~15% of one production turn's
 * input tokens — and the archive holds the original, so the stub is recoverable rather than lost.
 *
 * `protectFrom` is where the fresh tail starts — `hermes-lcm`'s term for the stretch the model is
 * working on right now. Called each round with the length before this round's own traffic; the
 * last `PROTECT_RECENT_RESULTS` results before that are spared as well.
 */
function pruneToolResults(messages: ChatMessage[], protectFrom: number, round: number, log: TurnLog): void {
  // Counted from the end, so "the last N results" holds however many rounds ago they arrived and
  // however many other messages sit between them.
  const recent = new Set(
    messages
      .slice(0, protectFrom)
      .flatMap((m, i) => (m.role === 'tool' ? [i] : []))
      .slice(-PROTECT_RECENT_RESULTS),
  )
  let saved = 0
  for (let i = 0; i < protectFrom; i++) {
    const m = messages[i]
    if (m.role !== 'tool' || recent.has(i)) {
      continue
    }
    const shorter = shorten(m.content)
    saved += m.content.length - shorter.length
    m.content = shorter
  }
  // Loud, because this cuts what the model is shown. ARCHITECTURE.md keeps a list of the ceilings that
  // degrade silently, and the rule it states is that a new one joins the log before the list.
  if (saved > 0) {
    log.event({ at: 'tool-loop', stage: 'pruned', round, chars: saved })
  }
}

/**
 * This turn's tool traffic in persisted shape, so a later turn can still see which pages were read
 * and quote a ref at `read_tool_result`. Nothing full-size comes through: `state.messages` is
 * re-sent to the model every turn and broadcast to every client, so the stub is what may live there
 * — the archive holds the rest.
 *
 * Half a pair here gets its own record rather than `pairedOnly`'s: that one is housekeeping over
 * state that can hold anything, while this can only be a bug in the offset below — which the
 * sanitizer downstream would otherwise absorb while blaming the state it read.
 */
export function turnToolTraffic(
  messages: ChatMessage[],
  priorHistory: number,
  now: number,
  log?: TurnLog,
): HistoryMessage[] {
  const written = toHistory(messages.slice(1 + priorHistory), now)
  const paired = pairedOnly(written)
  if (paired.length !== written.length) {
    log?.error({ at: 'tool-loop', stage: 'unpaired-write', dropped: written.length - paired.length, priorHistory })
  }
  return paired
}

function toHistory(messages: ChatMessage[], now: number): HistoryMessage[] {
  return messages.map((m) => {
    const base = { id: crypto.randomUUID(), at: now }
    if (m.role === 'tool') {
      // `truncate` second, for the result `shorten` refuses because filing failed and there is no
      // ref. Its middle is already unrecoverable — `stage: 'archive-failed'` said so — so the
      // choice is only whether the loss is also broadcast to every client on every later turn.
      return {
        ...base,
        role: 'tool' as const,
        content: truncate(shorten(m.content), PRUNE_OVER_CHARS),
        tool_call_id: m.tool_call_id,
      }
    }
    // Only an assistant that called tools reaches here; the answering one is returned as `text`.
    // `''` rather than null — see `HistoryMessage`.
    return {
      ...base,
      role: 'assistant' as const,
      content: m.content ?? '',
      ...('tool_calls' in m && m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    }
  })
}

/** The ref is appended to *every* filed result, not only a truncated one: "what did that page say
 *  about X" comes a turn later, by which time the result is gone whether it was cut or not. */
async function fileAndTrim(
  raw: string,
  def: ToolDef | undefined,
  args: string,
  ctx: ToolContext,
  log: TurnLog,
): Promise<string> {
  // The tool's own cap, and never more than the window allows. Applied here rather than in any
  // handler: the archive is filed from `raw`, so a handler that cut for itself would cut the row.
  const toolCap = def?.maxResultChars ?? DEFAULT_RESULT_CHARS
  const cap = resultCap(toolCap, ctx.contextTokens)
  if (raw.length > cap && cap < toolCap) {
    log.event({ at: 'tool-loop', stage: 'window-capped', tool: def?.name, chars: raw.length, shown: cap })
  }
  const trimmed = truncate(raw, cap)
  const archive = ctx.toolArchive
  const filing = def && archive && !def.noArchive && raw.length >= ARCHIVE_MIN_CHARS && !raw.startsWith('error:')
  if (!filing) {
    return trimmed
  }
  let ref: number
  try {
    // Retried, because the failure this catches was described here as transient the day it was
    // written and then handled as permanent: a lost row costs the middle of a page for good, and
    // `retryOnce` is what this repo already reaches for on a write it must not lose.
    ref = await retryOnce(
      () => archive.save({ tool: def.name, args, content: raw }),
      (err) => log.error({ at: 'tool-loop', stage: 'archive-retried', tool: def.name, error: errorFields(err) }),
    )
  } catch (err) {
    // Both attempts. The answer is still the source of truth — a 2 MB row is refused outright and
    // no retry changes that — but the model is now told nothing was kept and cannot tell why.
    log.error({ at: 'tool-loop', stage: 'archive-failed', tool: def.name, chars: raw.length, error: errorFields(err) })
    return trimmed
  }
  // Says what was kept rather than promising "all of it": a result larger than one window comes
  // back in pieces, and a footer that oversells that is a footer the model will act on wrongly.
  const note =
    raw.length > trimmed.length
      ? `this copy skips the middle of ${raw.length} characters — read_tool_result(${ref}) reads it from the start`
      : `read_tool_result(${ref}) returns it again in a later turn, when this copy is gone`
  return `${trimmed}\n\n${recoverableAt(ref, note)}`
}

export async function runToolLoop(input: ToolLoopInput): Promise<LoopResult> {
  // `maxRounds` is a backstop, not the intended stop — `budgetMs` and the subrequest reserve are
  // the guards with a reason. It shipped at 6 on 2026-07-06 and fired first, so nothing could say
  // whether either of those would ever fire; 12 with `budgetMs` unchanged lets the logs answer.
  const { client, model, tools, ctx, maxRounds = 12, budgetMs = 90_000, perToolTimeoutMs = 10_000 } = input
  const log = input.log ?? ctx.log ?? ORPHAN_LOG
  const subrequests = input.subrequests ?? ctx.budget
  const started = Date.now()
  const byName = new Map(tools.map((t) => [t.name, t]))
  const specs = tools.map(toolSpec)
  const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt }, ...input.history]
  const toolsUsed: string[] = []
  // Held rather than checked before each call — see `SubrequestBudget.hold`.
  const releaseReserve = subrequests?.hold(FINAL_ANSWER_RESERVE) ?? (() => {})

  let roundsUsed = 0
  // Null until a guard fires. Exhausting the loop is the only reason with no guard of its own,
  // so it is the fallback rather than the initial value — otherwise the last guard to run would
  // look like the cause when an earlier one had already decided.
  let stopReason: StopReason | null = null
  let lastContent = ''
  let promptTokens: number | undefined
  // Only what a provider actually reported. A provider that omits `usage` leaves this at 0 and the
  // budget never fires, which `stage: 'unmetered'` says once rather than letting it pass for thrift.
  let tokensSpent = 0
  /** `name\0arguments\0result`. See the repeat check for why the arguments are in the key. */
  const seenResults = new Set<string>()
  let sawRepeat = false
  let outOfBudget = false
  // `finally`, because the `complete` return leaves from inside the loop: the reserve must not
  // stay held on a budget the caller goes on using.
  try {
    for (let round = 0; round < maxRounds; round++) {
      if (Date.now() - started > budgetMs) {
        stopReason = 'time-budget'
        break
      }
      // One, not the reserve: the reserve is held on the budget, so `canAfford` already excludes it
      // and asking for it again here would refuse a round that fits.
      if (subrequests && !subrequests.canAfford(1)) {
        stopReason = 'subrequest-budget'
        break
      }
      roundsUsed = round + 1
      const roundStarted = Date.now()
      const result = await chatCompletionWithTools(client, model, messages, specs)
      const { content, toolCalls } = result
      if (round === 0) {
        promptTokens = result.usage?.inputTokens
        if (!result.usage) {
          log.event({ at: 'tool-loop', stage: 'unmetered', model, provider: result.provider })
        }
      }
      tokensSpent += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)
      lastContent = content || lastContent
      logCompletion(log, 'round', round, model, result, Date.now() - roundStarted)
      if (toolCalls.length === 0) {
        log.event({
          at: 'tool-loop',
          stage: 'done',
          model,
          roundsUsed,
          stopReason: 'complete',
          elapsedMs: Date.now() - started,
          tokensSpent,
          toolsUsed,
        })
        return {
          text: safeText(content),
          toolsUsed,
          stopReason: 'complete',
          roundsUsed,
          messages,
          promptTokens,
          tokensSpent,
        }
      }

      // Before this round's own results are appended, so `messages.length` is exactly the fresh
      // tail's boundary: everything already here has been answered, everything after is in flight.
      pruneToolResults(messages, messages.length, round, log)
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
      // Concurrently: half of all rounds ask for more than one tool (measured over 137 rounds of
      // production traces) and three page reads in series is three times the wait. Safe because no
      // call depends on another's result, and the reserve holds without predicting what they cost.
      const executed = await Promise.all(
        toolCalls.map(async (call) => ({
          call,
          raw: await executeTool(byName, call.function.name, call.function.arguments, ctx, perToolTimeoutMs),
        })),
      )
      // Sequential over the original order, so the conversation and the records read the same way
      // whichever call happened to finish first.
      for (const { call, raw } of executed) {
        toolsUsed.push(call.function.name)
        // A tool that ran out says so through its own result. Plain assignment, not `??`: every other
        // guard breaks out of the round, so nothing can have set a reason by the time this is reached.
        if (raw === OUT_OF_BUDGET_RESULT) {
          stopReason = 'subrequest-budget'
          // Kept out of the repeat check below: several calls refused for the same reason are
          // identical strings, and that read as a model going in circles rather than a spent budget.
          outOfBudget = true
        }
        const result = await fileAndTrim(raw, byName.get(call.function.name), call.function.arguments, ctx, log)
        // A tool result that reads as an instruction ("try again") can drive the model to loop.
        log.event(
          {
            at: 'tool-loop',
            stage: 'tool-result',
            round,
            tool: call.function.name,
            resultLen: result.length,
            isError: result.startsWith('error:'),
          },
          { args: call.function.arguments.slice(0, 200), resultHead: result.slice(0, 160) },
        )
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })

        // The same call answered the same way twice. The arguments belong in the key: a rate limit
        // answers every URL with one string, which without them read as a model going in circles.
        if (!outOfBudget) {
          const key = `${call.function.name}\0${call.function.arguments}\0${result}`
          if (seenResults.has(key)) {
            sawRepeat = true
          }
          seenResults.add(key)
        }
      }

      if (sawRepeat) {
        stopReason = 'no-progress'
        log.event({ at: 'tool-loop', stage: 'no-progress', round })
        break
      }
      // A refused tool means the reserve is all that is left, so another round would only spend it on
      // more refusals. Out here rather than at the top of the next round, which asks whether one more
      // call fits and would say yes — the reserve is held, not spent.
      if (outOfBudget) {
        break
      }
    }
  } finally {
    releaseReserve()
  }

  // Not even one more call fits: answer with whatever the loop has rather than
  // throwing, so the turn still produces something the user can see.
  if (subrequests && !subrequests.canAfford(2)) {
    const reason = stopReason ?? 'subrequest-budget'
    log.event({ at: 'tool-loop', stage: 'out-of-subrequests', model, roundsUsed, spent: subrequests.spent, toolsUsed })
    log.event({
      at: 'tool-loop',
      stage: 'done',
      model,
      roundsUsed,
      stopReason: reason,
      elapsedMs: Date.now() - started,
      tokensSpent,
      toolsUsed,
    })
    return {
      text: lastContent.trim() ? safeText(lastContent) : OUT_OF_BUDGET_REPLY,
      toolsUsed,
      stopReason: reason,
      roundsUsed,
      messages,
      promptTokens,
      tokensSpent,
    }
  }

  const reasonSoFar = stopReason ?? 'max-rounds'
  if (input.forceFinalAnswer === false) {
    log.event({
      at: 'tool-loop',
      stage: 'done',
      model,
      roundsUsed,
      stopReason: reasonSoFar,
      elapsedMs: Date.now() - started,
      tokensSpent,
      toolsUsed,
    })
    return { text: '', toolsUsed, stopReason: reasonSoFar, roundsUsed, messages, promptTokens, tokensSpent }
  }

  // Round cap or budget hit: one last call that cannot request tools.
  const finalStarted = Date.now()
  const final = await chatCompletionWithTools(client, model, messages, specs, { toolChoice: 'none' })
  logCompletion(log, 'final', roundsUsed, model, final, Date.now() - finalStarted)
  // Counted like any other round. Left out, every `max-rounds` and `time-budget` turn under-reported
  // by exactly the call carrying the largest prompt of the turn.
  tokensSpent += (final.usage?.inputTokens ?? 0) + (final.usage?.outputTokens ?? 0)
  const reason = stopReason ?? 'max-rounds'
  log.event({
    at: 'tool-loop',
    stage: 'done',
    model,
    roundsUsed,
    stopReason: reason,
    elapsedMs: Date.now() - started,
    tokensSpent,
    toolsUsed,
  })
  return {
    text: safeText(final.content),
    toolsUsed,
    stopReason: reason,
    roundsUsed,
    messages,
    promptTokens,
    tokensSpent,
  }
}

async function executeTool(
  byName: Map<string, ToolDef>,
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<string> {
  const tool = byName.get(name)
  if (!tool) {
    return `error: unknown tool ${name}`
  }

  let raw: unknown
  try {
    raw = JSON.parse(rawArgs || '{}')
  } catch {
    return 'error: invalid arguments (not valid JSON)'
  }

  // Returned rather than thrown: a wrong argument is something the model can fix next round, and
  // it only can if the result says which field.
  const parsed = tool.params.safeParse(raw)
  if (!parsed.success) {
    return `error: invalid arguments\n${z.prettifyError(parsed.error)}`
  }

  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      tool.handler(parsed.data as never, ctx),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tool timed out')), tool.timeoutMs ?? timeoutMs)
      }),
    ])
  } catch (err) {
    // Answered rather than thrown, like every other tool failure: an unmatched tool_call id makes
    // the next request a 400, so a skipped call would trade an over-budget turn for a broken one.
    if (err instanceof BudgetExhausted) {
      return OUT_OF_BUDGET_RESULT
    }
    return `error: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer!)
  }
}
