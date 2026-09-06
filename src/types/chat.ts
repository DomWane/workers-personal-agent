export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type HistoryMessage = SpokenMessage | ToolMessage

interface Persisted {
  content: string
  id: string
  at?: number
}

export interface SpokenMessage extends Persisted {
  role: 'user' | 'assistant'
  tools?: string[]
  tokens?: number
  tool_calls?: ToolCall[]
}

export interface ToolMessage extends Persisted {
  role: 'tool'
  tool_call_id: string
}
