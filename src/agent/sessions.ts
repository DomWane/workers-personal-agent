import type OpenAI from 'openai'
import { chatCompletion } from '../connectors/llm.connector'
import type { HistoryMessage } from '../types'

/**
 * Shared with the nightly reflection so the model reads one shape of conversation, not two. Turns
 * are labelled only there, by position — see `citationLabels`, which must agree with this.
 *
 * **Every caller must hand this `spoken(...)`.** Anything that is not a user renders as "Assistant",
 * so a `tool` row arrives as something the assistant said. Not filtered in here, because the labels
 * are positions in the array the caller also holds; filtering on one side moves every citation.
 */
export function transcript(messages: HistoryMessage[], opts: { labels?: boolean } = {}): string {
  return messages
    .map((m, i) => `${opts.labels ? `[${i + 1}] ` : ''}${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

/**
 * Rolls the history that is about to be dropped into the running summary. One call per compaction
 * rather than one per evicted message: the summary is re-compressed each time it grows, so keeping
 * the number of passes low is what keeps early turns recognisable.
 */
export async function summarizeHead(
  client: OpenAI,
  model: string,
  previousSummary: string | undefined,
  /** Already `spoken(...)`, and filtered by the caller before it *sized* this slice: filtering here
   *  instead would leave a slice chosen over rows this never reads, sometimes all of them. */
  evicted: HistoryMessage[],
): Promise<string> {
  const previous = previousSummary?.trim()
  const text = await chatCompletion(client, model, [
    {
      role: 'user',
      content: [
        'You keep a running summary of the earlier part of an ongoing conversation between a user and their assistant.',
        previous
          ? `Merge the new turns below into this existing summary, keeping what still matters:\n\n${previous}`
          : 'These are the first turns to summarize; there is no existing summary yet.',
        '',
        'New turns:',
        transcript(evicted),
        '',
        'Write the updated summary: topics, decisions, durable facts about the user, open follow-ups. Plain text, no headings, no preamble.',
      ].join('\n'),
    },
  ])
  return text.trim()
}
