import type { HistoryMessage } from '../types'

export type CitationVerdict = { ok: true; message: HistoryMessage } | { ok: false; why: Refusal }

type Refusal = 'missing' | 'not-a-user-turn' | 'thread-gone'

export function explainRefusal(why: Refusal, turn: string): string {
  if (why === 'thread-gone') {
    return `error: the thread that turn ${turn} belongs to was deleted — its source is gone, not missing`
  }
  if (why === 'not-a-user-turn') {
    return `error: turn ${turn} is not something the user said, so it cannot evidence a correction`
  }
  return `error: turn ${turn} is not in that thread`
}

export function verdictFor(message: HistoryMessage | null): CitationVerdict {
  if (!message) {
    return { ok: false, why: 'missing' }
  }
  if (message.role !== 'user') {
    return { ok: false, why: 'not-a-user-turn' }
  }
  return { ok: true, message }
}
