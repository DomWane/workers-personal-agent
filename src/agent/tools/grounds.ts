import { z } from 'zod'
import type { MemorySource } from '../memory/memory-store'
import { explainRefusal } from '../provenance'
import type { ToolContext } from './registry'

/**
 * The two fields every gated write shares. Optional because in a chat the turn being answered is
 * the citation; the wording is the caller's because these strings steer the model.
 */
export function groundsFields(opts: { citedTurn: string; thread: string }) {
  return {
    cited_turn: z.string().describe(opts.citedTurn).optional(),
    thread: z.string().describe(opts.thread).optional(),
  }
}

type Grounds = z.infer<z.ZodObject<ReturnType<typeof groundsFields>>>

/**
 * What a destructive write has to show — archiving a memory, rewriting a profile line. Additive
 * writes never come here: they are reversible and carry provenance, and gating them would refuse
 * most of what an assistant learns.
 */
export async function checkGrounds(
  args: Grounds,
  ctx: ToolContext,
): Promise<{ ok: true; grounds: MemorySource } | { ok: false; error: string }> {
  // Brackets stripped: the transcript displays labels as `[3]`, and refusing a correct citation
  // for the shape we showed it in would be our bug.
  const cited = (args.cited_turn ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .trim()
  // In a chat the turn being answered is the evidence, and the only citable thing — the history the
  // model sees carries no ids. The nightly pass has no fallback, which is the case this is for.
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
