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

export function groupTurns(messages: HistoryMessage[]): Turn[] {
  const turns: Turn[] = []
  const pending = new Map<string, ToolStep>()
  let open: Turn | null = null

  const close = (final?: SpokenMessage) => {
    if (open) {
      turns.push(final ? { ...open, id: final.id, final } : open)
      open = null
      pending.clear()
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      close()
      turns.push({ from: 'user', id: m.id, segments: [{ kind: 'text', message: m }], final: m })
      continue
    }
    if (m.role === 'tool') {
      const step = pending.get(m.tool_call_id)
      if (step) {
        step.result = m
      }
      continue
    }
    open ??= { from: 'assistant', id: m.id, segments: [] }
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
  close()
  return turns
}
