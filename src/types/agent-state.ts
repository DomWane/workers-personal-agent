import type { HistoryMessage } from './chat'
import type { ResearchState } from './research'

export interface AgentState {
  messages: HistoryMessage[]
  historySummary?: string
  modelOverride?: string
  contextTokens?: number
  contextModel?: string
  promptTokens?: number
  userProfile?: string
  agentNotes?: string
  research?: ResearchState
  status?: 'thinking' | 'compacting'
}
