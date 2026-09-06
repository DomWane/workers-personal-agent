import type OpenAI from 'openai'
import { chatCompletion } from '../connectors/llm.connector'
import type { HistoryMessage } from '../types'

export function transcript(messages: HistoryMessage[], opts: { labels?: boolean } = {}): string {
  return messages
    .map((m, i) => `${opts.labels ? `[${i + 1}] ` : ''}${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

export async function summarizeHead(
  client: OpenAI,
  model: string,
  previousSummary: string | undefined,
  evicted: HistoryMessage[],
  kept: HistoryMessage[],
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
        ...(kept.length
          ? [
              'The conversation continues with these turns, which the reader keeps verbatim. Do not summarize them; use them only so the summary does not describe as pending what they settle:',
              transcript(kept),
              '',
            ]
          : []),
        'Write the updated summary of the new turns: topics, decisions, durable facts about the user. Past tense, plain text, no headings, no preamble. Call nothing pending, unanswered or open. Leave out passing trouble with tools or model switches unless it was still unresolved.',
      ].join('\n'),
    },
  ])
  return text.trim()
}
