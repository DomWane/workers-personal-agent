import type { ResearchState } from '../agent/research-state'
import type { HistoryMessage } from './chat'

/** Durable Object state, one instance per thread. */
export interface AgentState {
  /** Conversation history (system prompt is prepended at call time, not stored). */
  messages: HistoryMessage[]
  /** Rolling summary of the turns compaction has dropped from `messages`. */
  historySummary?: string
  /** Runtime model override set via /model; undefined = use env default. */
  modelOverride?: string
  /** The context window compaction is measured against, and the model it belongs to — a switch
   *  invalidates it rather than carrying one model's window onto another's. */
  contextTokens?: number
  contextModel?: string
  /** What the last turn's prompt actually cost, as the provider counted it. Measured beats the
   *  chars/3 estimate, so the trigger uses it when a call has already reported one. */
  promptTokens?: number
  /** Frozen-per-session USER.md snapshot; refreshed when history is empty. */
  userProfile?: string
  /** Frozen-per-session AGENT.md snapshot; refreshed when history is empty. */
  agentNotes?: string
  /** A proposed or running research run; cleared when it finishes or is stopped. */
  research?: ResearchState
  /** Present while a turn is being generated; the web client's typing indicator. */
  status?: 'thinking' | 'compacting'
}
