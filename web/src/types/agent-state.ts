import type { HistoryMessage } from './chat'
import type { ResearchState } from './research'

export interface AgentState {
  messages: HistoryMessage[]
  historySummary?: string
  status?: 'thinking' | 'compacting'
  modelOverride?: string
  /** What the provider counted for the last turn's prompt; absent until one has answered. */
  promptTokens?: number
  research?: ResearchState
}
