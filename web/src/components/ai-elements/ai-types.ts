/**
 * Stand-in for the handful of types the copied ai-elements components import from the `ai`
 * package. This agent never uses the Vercel AI SDK — the Worker talks to OpenRouter through
 * `openai` — so pulling `ai` in for four type aliases would add a dependency for nothing.
 *
 * `MessageRole` is deliberately our `HistoryMessage['role']` and not the SDK's wider union: the
 * only roles this UI can ever render are the two the Durable Object persists.
 */

import type { HistoryMessage } from '@/types'

export type MessageRole = HistoryMessage['role']

export type ToolState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

export interface ToolUIPart {
  type: `tool-${string}`
  state: ToolState
  input?: unknown
  output?: unknown
  errorText?: string
}

export interface DynamicToolUIPart {
  type: 'dynamic-tool'
  state: ToolState
  input?: unknown
  output?: unknown
  errorText?: string
}

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

export interface FileUIPart {
  type: 'file'
  mediaType: string
  filename?: string
  url: string
}
