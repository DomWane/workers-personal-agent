import type { HistoryMessage } from '../types'

/** Huang et al. (ICLR 2024) is why the gate exists at all: with no external feedback, a model's
 *  judgment about its own output tends to make things worse, and "newest wins" is that judgment. */
export type CitationVerdict = { ok: true; message: HistoryMessage } | { ok: false; why: Refusal }

type Refusal = 'missing' | 'not-a-user-turn' | 'thread-gone'

/** Three reasons rather than one: a source that is *gone* is a different fact from a citation that
 *  never existed, and collapsing them makes "no evidence" mean both. */
export function explainRefusal(why: Refusal, turn: string): string {
  if (why === 'thread-gone') {
    return `error: the thread that turn ${turn} belongs to was deleted — its source is gone, not missing`
  }
  if (why === 'not-a-user-turn') {
    return `error: turn ${turn} is not something the user said, so it cannot evidence a correction`
  }
  return `error: turn ${turn} is not in that thread`
}

/** Checked, never trusted — `ungroundedCitations`'s shape, imperfect the same way: nothing stops a
 *  model citing a real message that says something else. `thread-gone` is the registry's answer. */
export function verdictFor(message: HistoryMessage | null): CitationVerdict {
  if (!message) {
    return { ok: false, why: 'missing' }
  }
  if (message.role !== 'user') {
    return { ok: false, why: 'not-a-user-turn' }
  }
  return { ok: true, message }
}
