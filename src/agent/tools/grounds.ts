import { z } from 'zod'
import type { MemorySource } from '@/agent/memory/memory-store'
import { explainRefusal } from '@/agent/provenance'
import type { ToolContext } from '@/agent/tools/registry'

export function groundsFields(opts: { citedTurn: string; thread: string }) {
  return {
    cited_turn: z.string().describe(opts.citedTurn).optional(),
    thread: z.string().describe(opts.thread).optional(),
  }
}

type Grounds = z.infer<z.ZodObject<ReturnType<typeof groundsFields>>>

export async function checkGrounds(
  args: Grounds,
  ctx: ToolContext,
): Promise<{ ok: true; grounds: MemorySource } | { ok: false; error: string }> {
  const cited = (args.cited_turn ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .trim()
  const turn = cited || ctx.source?.turn
  const thread = (args.thread ?? '').trim() || ctx.source?.thread
  if (!turn || !thread) {
    return { ok: false, error: 'error: this needs cited_turn — the user message that shows the old text is wrong' }
  }
  if (!ctx.verifyCitation) {
    return { ok: false, error: 'error: cannot check a citation from here, so nothing may be destroyed' }
  }

  const verdict = await ctx.verifyCitation(thread, turn)
  if (!verdict.ok) {
    return { ok: false, error: explainRefusal(verdict.why, turn) }
  }
  return { ok: true, grounds: { thread, turn: verdict.message.id, at: Date.now() } }
}
