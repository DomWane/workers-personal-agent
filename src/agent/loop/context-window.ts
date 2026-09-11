import type { TurnLog } from '../log'
import type { HistoryMessage, ToolCall } from '../../types'

const COMPACT_AT_FRACTION = 0.8
const COMPACT_KEEP_FRACTION = 0.25
export const DEFAULT_CONTEXT_TOKENS = 24_000

export const CHARS_PER_TOKEN = 3

export const RESULT_SHARE_OF_WINDOW = 0.1

export function resultCap(toolCap: number, context: number | undefined): number {
  return context === undefined
    ? toolCap
    : Math.min(toolCap, Math.floor(RESULT_SHARE_OF_WINDOW * context * CHARS_PER_TOKEN))
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function callsOf(m: HistoryMessage | undefined): ToolCall[] {
  return m && m.role !== 'tool' ? (m.tool_calls ?? []) : []
}

export function spoken(messages: HistoryMessage[]): HistoryMessage[] {
  return messages.filter((m) => m.role !== 'tool' && !m.tool_calls?.length)
}

export function historyForTurn(messages: HistoryMessage[], at: number, question: HistoryMessage): HistoryMessage[] {
  const answeredSince = spoken(messages.slice(at + 1)).filter((m) => m.role === 'assistant')
  return [...messages.slice(0, at), ...answeredSince, question]
}

export function pairedOnly(history: HistoryMessage[], log?: TurnLog): HistoryMessage[] {
  const answered = new Set(history.flatMap((m) => (m.role === 'tool' && m.tool_call_id ? [m.tool_call_id] : [])))
  const fullyAnswered = (m: HistoryMessage) => callsOf(m).every((c) => answered.has(c.id))
  const live = new Set(history.filter(fullyAnswered).flatMap((m) => callsOf(m).map((c) => c.id)))
  const kept = history.filter((m) => (m.role === 'tool' ? live.has(m.tool_call_id) : fullyAnswered(m)))
  if (kept.length !== history.length) {
    log?.error({ at: 'history', stage: 'unpaired-tool-traffic', dropped: history.length - kept.length })
  }
  return kept
}

function messageTokens(m: HistoryMessage): number {
  const calls = callsOf(m).reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0)
  return estimateTokens(m.content) + Math.ceil(calls / CHARS_PER_TOKEN)
}

export function historyTokens(messages: HistoryMessage[], summary?: string): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0) + estimateTokens(summary ?? '')
}

export const compactAt = (context: number) => Math.floor(context * COMPACT_AT_FRACTION)
export const compactKeep = (context: number) => Math.floor(context * COMPACT_KEEP_FRACTION)

function ownedGroupStart(messages: HistoryMessage[], first: number): number {
  let i = first
  while (i > 0 && messages[i].role === 'tool') {
    i--
  }
  return callsOf(messages[i]).length ? i : first
}

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

export function planCompaction(messages: HistoryMessage[], keepTokens: number): HistoryMessage[] {
  return messages.slice(0, tailFrom(messages, keepTokens, 2))
}

export function fitHead(
  evicted: HistoryMessage[],
  budgetTokens: number,
): { summarize: HistoryMessage[]; unsummarized: HistoryMessage[] } {
  const first = tailFrom(evicted, budgetTokens, 1)
  return { summarize: evicted.slice(first), unsummarized: evicted.slice(0, first) }
}

export function isContextOverflow(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  return /context (length|window)|maximum context|too many tokens|reduce the length|prompt is too long/i.test(text)
}
