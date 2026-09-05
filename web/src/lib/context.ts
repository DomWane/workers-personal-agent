import type { AgentState, HistoryMessage } from '@/types'

/**
 * Duplicated from `src/agent/context-window.ts` rather than asked for over an RPC: the confirm
 * dialog answers "would this switch compact?" about a model the server has never seen, whose window
 * only the browser's catalogue knows. Nothing keeps the two in step, and a wrong prediction only
 * means the dialog asks when it need not.
 */
const CHARS_PER_TOKEN = 3
const COMPACT_AT_FRACTION = 0.8

/**
 * Tool traffic is in `state.messages` so a later turn can quote a ref at `read_tool_result`. It is
 * not conversation: it is never drawn, and it does not count towards whether there is anything left
 * to fold. It *is* counted by `contextUsage`, because the model is sent it either way.
 */
export function spoken(messages: HistoryMessage[]): HistoryMessage[] {
  // `?.length`, not `?.` — an assistant with `tool_calls: []` spoke, and the two copies of this
  // filter disagreeing about that is the drift the comment above predicts.
  return messages.filter((m) => m.role !== 'tool' && !m.tool_calls?.length)
}

/** Mirrors `messageTokens` in `src/agent/context-window.ts`. The two copies drifted apart twice on
 *  the day the fraction changed, which is the standing cost of this file existing. */
function callChars(m: HistoryMessage): number {
  if (m.role === 'tool') {
    return 0
  }
  return m.tool_calls?.reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0) ?? 0
}

export interface ContextUsage {
  tokens: number
  /** The provider's own count, rather than our chars/3 estimate. A meter that does not say which
   *  invites the reader to trust a guess. */
  measured: boolean
}

export function contextUsage(state: AgentState): ContextUsage {
  // Tool traffic counts — the model is sent it — and an assistant that only called tools has an
  // empty `content`, so counting that alone would price a whole round of calls at zero.
  const chars =
    state.messages.reduce((n, m) => n + m.content.length + callChars(m), 0) + (state.historySummary?.length ?? 0)
  return {
    tokens: state.promptTokens ?? Math.ceil(chars / CHARS_PER_TOKEN),
    measured: state.promptTokens !== undefined,
  }
}

export function wouldCompact(tokens: number, window?: number): boolean {
  return window !== undefined && tokens > window * COMPACT_AT_FRACTION
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
