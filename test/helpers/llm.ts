import type { ToolCall } from '@/types'

export interface CompletionMessage {
  content?: string | null
  tool_calls?: ToolCall[]
}

export interface Completion {
  message: CompletionMessage
  usage?: Record<string, unknown>
  extra?: Record<string, unknown>
}

export function sseCompletion({ message, usage, extra }: Completion): string {
  const chunk = (choices: unknown[], more: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: 'chunk', object: 'chat.completion.chunk', model: 'stub', ...extra, ...more, choices })}\n\n`
  const delta = (d: Record<string, unknown>, finish_reason: string | null = null) =>
    chunk([{ index: 0, delta: d, finish_reason }])
  const words = message.content ? message.content.split(/(?<=\s)/) : []
  const calls = message.tool_calls ?? []
  return [
    delta({ role: 'assistant', content: '' }),
    ...words.map((w) => delta({ content: w })),
    ...(calls.length ? [delta({ tool_calls: calls.map((c, index) => ({ index, ...c })) })] : []),
    delta({}, calls.length ? 'tool_calls' : 'stop'),
    ...(usage ? [chunk([], { usage })] : []),
    'data: [DONE]\n\n',
  ].join('')
}

export function completionReply(completion: Completion, capture?: (body: Record<string, unknown>) => void) {
  return ({ body }: { body?: unknown }) => {
    const request = JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>
    capture?.(request)
    return request.stream
      ? {
          statusCode: 200,
          data: sseCompletion(completion),
          responseOptions: { headers: { 'content-type': 'text/event-stream' } },
        }
      : {
          statusCode: 200,
          data: JSON.stringify({
            choices: [{ message: completion.message }],
            usage: completion.usage,
            ...completion.extra,
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        }
  }
}
