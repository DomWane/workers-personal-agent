import type OpenAI from 'openai'
import { z } from 'zod'
import { chatCompletionWithTools } from '@/connectors/llm.connector'
import type { CompletionResult } from '@/connectors/llm.connector'
import { errorFields, ORPHAN_LOG } from '@/agent/log'
import type { TurnLog } from '@/agent/log'
import { pairedOnly, resultCap } from '@/agent/loop/context-window'
import { retryOnce } from '@/agent/retry'
import { BudgetExhausted, type SubrequestBudget } from '@/agent/subrequest-budget'
import type { ChatMessage, HistoryMessage } from '@/types'
import {
  DEFAULT_RESULT_CHARS,
  recoverableAt,
  REF_MARKER,
  toolSpec,
  truncate,
  type ToolContext,
  type ToolDef,
} from '@/agent/tools/registry'

const EMPTY_REPLY_FALLBACK = '(no answer produced — try rephrasing)'

export const FINAL_ANSWER_RESERVE = 6

const OUT_OF_BUDGET_RESULT = 'error: skipped, request budget exhausted'

const OUT_OF_BUDGET_REPLY =
  '(stopped early — this turn ran out of its request budget before I could answer. Try again, ideally in smaller steps.)'

// U+FF5C fullwidth pipe: deepseek emits `<｜DSML｜tool_calls>`, which an ASCII-only guard let through.
const TEXT_TOOL_CALL = /<tool_call>|<arg_key>|<function=|<[|｜]tool▁call|<｜|DSML｜/

function safeText(content: string): string {
  const trimmed = content.trim()
  if (!trimmed || TEXT_TOOL_CALL.test(trimmed)) {
    return EMPTY_REPLY_FALLBACK
  }
  return trimmed
}

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

export type StopReason = 'complete' | 'max-rounds' | 'time-budget' | 'subrequest-budget' | 'no-progress'

export interface ToolLoopInput {
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
  subrequests?: SubrequestBudget
  forceFinalAnswer?: boolean
}

export interface LoopResult {
  text: string
  toolsUsed: string[]
  stopReason: StopReason
  roundsUsed: number
  messages: ChatMessage[]
  promptTokens?: number
  tokensSpent: number
}

export const ARCHIVE_MIN_CHARS = 2000

const PRUNE_HEAD_CHARS = 4096
const PRUNE_TAIL_CHARS = 1024
export const PRUNE_OVER_CHARS = 8192

function shorten(content: string): string {
  const ref = REF_MARKER.exec(content)
  if (content.length <= PRUNE_OVER_CHARS || !ref) {
    return content
  }
  const cut = content.length - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
  const gap = `\n…[${cut} characters dropped from this copy — read_tool_result(${ref[1]}) has the whole result]…\n`
  return content.slice(0, PRUNE_HEAD_CHARS) + gap + content.slice(-PRUNE_TAIL_CHARS)
}

const PROTECT_RECENT_RESULTS = 1

function pruneToolResults(messages: ChatMessage[], protectFrom: number, round: number, log: TurnLog): void {
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
  if (saved > 0) {
    log.event({ at: 'tool-loop', stage: 'pruned', round, chars: saved })
  }
}

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
      return {
        ...base,
        role: 'tool' as const,
        content: truncate(shorten(m.content), PRUNE_OVER_CHARS),
        tool_call_id: m.tool_call_id,
      }
    }
    return {
      ...base,
      role: 'assistant' as const,
      content: m.content ?? '',
      ...('tool_calls' in m && m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    }
  })
}

async function fileAndTrim(
  raw: string,
  def: ToolDef | undefined,
  args: string,
  ctx: ToolContext,
  log: TurnLog,
): Promise<string> {
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
    ref = await retryOnce(
      () => archive.save({ tool: def.name, args, content: raw }),
      (err) => log.error({ at: 'tool-loop', stage: 'archive-retried', tool: def.name, error: errorFields(err) }),
    )
  } catch (err) {
    log.error({ at: 'tool-loop', stage: 'archive-failed', tool: def.name, chars: raw.length, error: errorFields(err) })
    return trimmed
  }
  const note =
    raw.length > trimmed.length
      ? `this copy skips the middle of ${raw.length} characters — read_tool_result(${ref}) reads it from the start`
      : `read_tool_result(${ref}) returns it again in a later turn, when this copy is gone`
  return `${trimmed}\n\n${recoverableAt(ref, note)}`
}

export async function runToolLoop(input: ToolLoopInput): Promise<LoopResult> {
  const { client, model, tools, ctx, maxRounds = 12, budgetMs = 90_000, perToolTimeoutMs = 10_000 } = input
  const log = input.log ?? ctx.log ?? ORPHAN_LOG
  const subrequests = input.subrequests ?? ctx.budget
  const started = Date.now()
  const byName = new Map(tools.map((t) => [t.name, t]))
  const specs = tools.map(toolSpec)
  const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt }, ...input.history]
  const toolsUsed: string[] = []
  const releaseReserve = subrequests?.hold(FINAL_ANSWER_RESERVE) ?? (() => {})

  let roundsUsed = 0
  let stopReason: StopReason | null = null
  let lastContent = ''
  let promptTokens: number | undefined
  let tokensSpent = 0
  const seenResults = new Set<string>()
  let sawRepeat = false
  let outOfBudget = false
  try {
    for (let round = 0; round < maxRounds; round++) {
      if (Date.now() - started > budgetMs) {
        stopReason = 'time-budget'
        break
      }
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

      pruneToolResults(messages, messages.length, round, log)
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls })
      const executed = await Promise.all(
        toolCalls.map(async (call) => ({
          call,
          raw: await executeTool(byName, call.function.name, call.function.arguments, ctx, perToolTimeoutMs),
        })),
      )
      for (const { call, raw } of executed) {
        toolsUsed.push(call.function.name)
        if (raw === OUT_OF_BUDGET_RESULT) {
          stopReason = 'subrequest-budget'
          outOfBudget = true
        }
        const result = await fileAndTrim(raw, byName.get(call.function.name), call.function.arguments, ctx, log)
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
      if (outOfBudget) {
        break
      }
    }
  } finally {
    releaseReserve()
  }

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

  const finalStarted = Date.now()
  const final = await chatCompletionWithTools(client, model, messages, specs, { toolChoice: 'none' })
  logCompletion(log, 'final', roundsUsed, model, final, Date.now() - finalStarted)
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

  let args: unknown = raw
  if (!tool.schema) {
    const parsed = tool.params.safeParse(raw)
    if (!parsed.success) {
      return `error: invalid arguments\n${z.prettifyError(parsed.error)}`
    }
    args = parsed.data
  }

  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      tool.handler(args as never, ctx),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('tool timed out')), tool.timeoutMs ?? timeoutMs)
      }),
    ])
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      return OUT_OF_BUDGET_RESULT
    }
    return `error: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer!)
  }
}
