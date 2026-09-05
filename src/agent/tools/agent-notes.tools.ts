import { z } from 'zod'
import { createMemoryStore } from '../memory/vault-store'
import { defineTool, type ToolDef } from './registry'

export const agentNotesTools: ToolDef[] = [
  defineTool({
    name: 'update_agent_notes',
    description:
      'Update your own always-visible working notes (AGENT.md, max 2000 chars) — durable operational facts you have learned (project conventions, tool quirks, recurring context, techniques). op=add appends a line; op=replace swaps exact existing text for replace_with; op=remove deletes exact existing text. When full, consolidate: replace/remove less important lines, move details to save_memory.',
    params: z.object({
      op: z.enum(['add', 'replace', 'remove']),
      text: z.string().describe('add: the line to append. replace/remove: exact existing text'),
      replace_with: z.string().describe('replace only: the new text').optional(),
    }),
    handler: ({ op, text, replace_with }, ctx) => createMemoryStore(ctx.env).updateAgentNotes(op, text, replace_with),
  }),
]
