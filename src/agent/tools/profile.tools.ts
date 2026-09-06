import { z } from 'zod'
import { createMemoryStore } from '../memory/vault-store'
import { checkGrounds, groundsFields } from './grounds'
import { defineTool, type ToolDef } from './registry'

export const profileTools: ToolDef[] = [
  defineTool({
    name: 'update_user_profile',
    description:
      'Update the always-visible user profile (core memory, max 1300 chars). op=add appends a line; op=replace swaps exact existing text for replace_with; op=remove deletes exact existing text. When full, consolidate: replace/remove less important lines, move details to save_memory. replace and remove destroy a line, so they need cited_turn and thread — the user turn that shows the old text is wrong.',
    params: z.object({
      op: z.enum(['add', 'replace', 'remove']),
      text: z.string().describe('add: the line to append. replace/remove: exact existing text'),
      replace_with: z.string().describe('replace only: the new text').optional(),
      ...groundsFields({
        citedTurn:
          'replace/remove only: the [number] beside the user turn that evidences this. It is checked, so an invented one is refused.',
        thread: 'replace/remove only: the thread="..." the cited turn is in.',
      }),
    }),
    handler: async (args, ctx) => {
      if (args.op !== 'add') {
        const checked = await checkGrounds(args, ctx)
        if (!checked.ok) {
          return checked.error
        }
      }
      return createMemoryStore(ctx.env).updateUserProfile(args.op, args.text, args.replace_with)
    },
  }),
]
