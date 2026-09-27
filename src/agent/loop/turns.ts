import type { HistoryMessage, SpokenMessage, ToolCall, ToolMessage } from '../../types/chat'

export interface ToolStep {
  kind: 'tool'
  call: ToolCall
  result?: ToolMessage
}

export type Segment = { kind: 'text'; message: SpokenMessage } | ToolStep

export interface Turn {
  from: 'user' | 'assistant'
  id: string
  segments: Segment[]
  final?: SpokenMessage
}

export function groupTurns(messages: HistoryMessage[], draft?: string): Turn[] {
  const turns: Turn[] = []
  const pending = new Map<string, ToolStep>()
  let open: Turn | null = null
  let asked = 'start'
  let replies = 0

  const reply = (): Turn => ({ from: 'assistant', id: `${asked}:${replies++}`, segments: [] })
  const close = (final?: SpokenMessage) => {
    if (open) {
      turns.push(final ? { ...open, final } : open)
      open = null
      pending.clear()
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      close()
      turns.push({ from: 'user', id: m.id, segments: [{ kind: 'text', message: m }], final: m })
      asked = m.id
      replies = 0
      continue
    }
    if (m.role === 'tool') {
      const step = pending.get(m.tool_call_id)
      if (step) {
        step.result = m
      }
      continue
    }
    open ??= reply()
    if (m.content) {
      open.segments.push({ kind: 'text', message: m })
    }
    for (const call of m.tool_calls ?? []) {
      const step: ToolStep = { kind: 'tool', call }
      open.segments.push(step)
      pending.set(call.id, step)
    }
    if (!m.tool_calls?.length) {
      close(m)
    }
  }
  if (draft) {
    open ??= reply()
    open.segments.push({ kind: 'text', message: { role: 'assistant', content: draft, id: 'draft' } })
  }
  close()
  return turns
}
