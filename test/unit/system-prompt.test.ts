import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../src/agent/system-prompt'

/**
 * The one place the assembled prompt is pinned verbatim. Everything else that touches it asserts a
 * fragment, so editing the persona churns one reviewed snapshot instead of a dozen fixtures — and a
 * change to how the pieces are *assembled* (a missing profile block, a summary that stopped being
 * wrapped, a heading that moved) fails here rather than surfacing as the agent answering differently,
 * which is the slowest signal there is.
 *
 * The persona itself is deliberately not in the snapshot: it is 24 lines of prose that changes for
 * its own reasons, and pinning it would make every wording edit look like a structural one.
 */
const PERSONA_HEAD = "You are the user's personal AI assistant"

function assembly(prompt: string): string {
  const start = prompt.indexOf('What you know about the user')
  return prompt.slice(start)
}

describe('buildSystemPrompt', () => {
  it('assembles profile, notes and summary in one pinned shape', () => {
    const prompt = buildSystemPrompt('Lives in Prague.', 'Prefers short replies.', 'Earlier: we sized the vault.')

    expect(prompt.startsWith(PERSONA_HEAD)).toBe(true)
    expect(assembly(prompt))
      .toBe(`What you know about the user (core memory — keep it current with update_user_profile):
<user_profile>
Lives in Prague.
</user_profile>

Your own working notes (operational facts you've learned — keep current with update_agent_notes):
<agent_notes>
Prefers short replies.
</agent_notes>

Earlier parts of this conversation were compacted; this summary is what the dropped turns said:
<earlier_conversation_summary>
Earlier: we sized the vault.
</earlier_conversation_summary>`)
  })

  it('says nothing learned yet rather than leaving an empty block', () => {
    // An empty tag reads to the model as "this is known to be empty" and to a human as a bug.
    const prompt = buildSystemPrompt('', '')
    expect(assembly(prompt)).toContain('<user_profile>\n(nothing learned yet)\n</user_profile>')
    expect(assembly(prompt)).toContain('<agent_notes>\n(nothing learned yet)\n</agent_notes>')
  })

  it('leaves the summary block out entirely when there is nothing compacted', () => {
    // Present-but-empty would tell the model turns were dropped when none were.
    expect(buildSystemPrompt('x', 'y', '   ')).not.toContain('earlier_conversation_summary')
    expect(buildSystemPrompt('x', 'y')).not.toContain('earlier_conversation_summary')
  })
})
