import { createExecutionContext, env, fetchMock, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker from '@/index'
import type { Env } from '@/types'
import { readVault, seedVault } from '../helpers/vault'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const LLM_BASE = 'https://llm.example'

function mockCompletion(reply: string, capture?: (body: Record<string, unknown>) => void) {
  fetchMock
    .get(LLM_BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(
      200,
      ({ body }) => {
        capture?.(JSON.parse(body as string))
        return { choices: [{ message: { content: reply } }] }
      },
      { headers: { 'content-type': 'application/json' } },
    )
}

async function devChat(text: string, thread = crypto.randomUUID()) {
  const res = await SELF.fetch('http://agent/dev/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, thread }),
  })
  return { res, thread }
}

// An absent file is the empty case, so only non-null values need seeding at all.
async function mockCoreMemory(profile: string | null = null, notes: string | null = null) {
  await seedVault({
    ...(profile === null ? {} : { 'agent/USER.md': profile }),
    ...(notes === null ? {} : { 'agent/AGENT.md': notes }),
  })
}

describe('PersonalAgent via /dev/chat', () => {
  it('answers with the model reply and prepends the system prompt', async () => {
    await mockCoreMemory(null)
    let sent: Record<string, unknown> | undefined
    mockCompletion('Hi Sam!', (b) => {
      sent = b
    })

    const { res } = await devChat('hello')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reply: 'Hi Sam!' })

    const messages = sent!.messages as { role: string; content: string }[]
    expect(messages[0].role).toBe('system')
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'hello' })
  })

  it('keeps history across messages in the same thread', async () => {
    await mockCoreMemory(null)
    mockCompletion('first')
    const { thread } = await devChat('one')

    let sent: Record<string, unknown> | undefined
    mockCompletion('second', (b) => {
      sent = b
    })
    await devChat('two', thread)

    const messages = sent!.messages as { role: string; content: string }[]
    // system + user(one) + assistant(first) + user(two)
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('grows history past the old fixed window instead of dropping turns', async () => {
    const thread = crypto.randomUUID()
    await mockCoreMemory(null)
    for (let i = 0; i < 10; i++) {
      mockCompletion(`r${i}`)
      await devChat(`m${i}`, thread)
    }
    let sent: Record<string, unknown> | undefined
    mockCompletion('final', (b) => {
      sent = b
    })
    await devChat('last', thread)

    const messages = sent!.messages as { role: string }[]
    // 20 stored + the new user turn + 1 system: under the soft cap, nothing is dropped.
    expect(messages.length).toBe(22)
  })
})

describe('core memory injection', () => {
  it('injects USER.md into the system prompt at session start', async () => {
    await mockCoreMemory('- Sam likes tea')
    let sent: Record<string, unknown> | undefined
    mockCompletion('hi', (b) => {
      sent = b
    })

    await devChat('hello')

    const system = (sent!.messages as { role: string; content: string }[])[0]
    expect(system.content).toContain('<user_profile>')
    expect(system.content).toContain('- Sam likes tea')
  })

  it('injects AGENT.md into the system prompt at session start', async () => {
    await mockCoreMemory('- Sam likes tea', '- vault repo is owner/vault')
    let sent: Record<string, unknown> | undefined
    mockCompletion('hi', (b) => {
      sent = b
    })
    await devChat('hello')
    const system = (sent!.messages as { role: string; content: string }[])[0]
    expect(system.content).toContain('<agent_notes>')
    expect(system.content).toContain('- vault repo is owner/vault')
  })

  it('injects the skill index into the system prompt, so the model needs no list_skills call', async () => {
    await mockCoreMemory(null)
    await mockSkillHit('daily-digest')
    let sent: Record<string, unknown> | undefined
    mockCompletion('hi', (b) => {
      sent = b
    })
    await devChat('hello')
    const system = (sent!.messages as { role: string; content: string }[])[0]
    expect(system.content).toContain('<skills>\n- daily-digest — d\n</skills>')
    expect(system.content).not.toContain('Do the digest.')
  })

  it('does not refetch the profile mid-session (frozen snapshot)', async () => {
    await mockCoreMemory('- Sam likes tea')
    mockCompletion('first')
    const { thread } = await devChat('one')

    // no second USER.md interceptor registered: a refetch would throw NetConnectNotAllowed
    let sent: Record<string, unknown> | undefined
    mockCompletion('second', (b) => {
      sent = b
    })
    await devChat('two', thread)

    expect((sent!.messages as { content: string }[])[0].content).toContain('- Sam likes tea')
  })

  it('falls back to an empty profile when the vault is unreachable', async () => {
    await mockCoreMemory(null)
    let sent: Record<string, unknown> | undefined
    mockCompletion('hi', (b) => {
      sent = b
    })

    await devChat('hello')

    expect((sent!.messages as { content: string }[])[0].content).toContain('(nothing learned yet)')
  })
})

describe('/dev/chat production guard', () => {
  it('404s when ENVIRONMENT is production, closing the route by default', async () => {
    const ctx = createExecutionContext()
    const res = await worker.fetch(
      new Request('http://agent/dev/chat', {
        method: 'POST',
        // Past the Access gate on purpose: without it this would 503 and prove nothing about the
        // route's own guard, which is what closes /dev/* for someone who *is* signed in.
        headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'a.b.c' },
        body: JSON.stringify({ text: 'hi' }),
      }),
      { ...env, ENVIRONMENT: 'production' } as Env,
      ctx,
    )
    expect(res.status).toBe(404)
  })
})

const SKILL_FILE =
  '---\nname: Daily digest\ndescription: d\ndate: 2026-06-01\nuse_count: 0\n---\n\n## Procedure\nDo the digest.\n'

function mockSkillHit(slug: string) {
  return seedVault({ [`agent/skills/${slug}.md`]: SKILL_FILE })
}

describe('slash skill invocation', () => {
  it('expands /<slug> <text> into the skill prompt but persists the raw text', async () => {
    await mockCoreMemory(null)
    await mockSkillHit('daily-digest')
    let sent: Record<string, unknown> | undefined
    mockCompletion('done', (b) => {
      sent = b
    })
    const { thread } = await devChat('/daily-digest for AI news')

    const user = (sent!.messages as { role: string; content: string }[]).at(-1)
    expect(user?.content).toContain('<skill name="Daily digest">')
    expect(user?.content).toContain('Do the digest.')
    expect(user?.content).toContain('Request: for AI news')

    // next turn: history holds the raw command, not the expanded skill
    let sent2: Record<string, unknown> | undefined
    mockCompletion('ok', (b) => {
      sent2 = b
    })
    await devChat('thanks', thread)
    const history = sent2!.messages as { content: string }[]
    expect(history.some((m) => m.content === '/daily-digest for AI news')).toBe(true)
  })

  it('passes unknown slash commands through as plain text', async () => {
    await mockCoreMemory(null)
    let sent: Record<string, unknown> | undefined
    mockCompletion('hm', (b) => {
      sent = b
    })

    await devChat('/nope whatever')

    expect((sent!.messages as { content: string }[]).at(-1)?.content).toBe('/nope whatever')
  })
})

describe('core memory invalidation after a write', () => {
  function mockToolCallCompletion(name: string, args: string) {
    fetchMock
      .get(LLM_BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }],
              },
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      )
  }

  it('refetches the profile on the next turn once update_user_profile has run', async () => {
    await mockCoreMemory('- Works at OLDCORP')

    // Turn one rewrites the profile: tool call, the write itself, then the spoken answer.
    mockToolCallCompletion(
      'update_user_profile',
      JSON.stringify({ op: 'replace', text: '- Works at OLDCORP', replace_with: '- Works at ACME' }),
    )
    mockCompletion('done')
    const { thread } = await devChat('I moved to ACME')
    // Turn two reads whatever is actually in the vault — no second mock scripts the answer,
    // so a stale frozen copy would show up as OLDCORP rather than be papered over.
    expect(await readVault('agent/USER.md')).toContain('ACME')

    let sent: Record<string, unknown> | undefined
    mockCompletion('ok', (b) => {
      sent = b
    })
    await devChat('and now?', thread)

    const system = (sent!.messages as { content: string }[])[0].content
    expect(system).toContain('- Works at ACME')
    expect(system).not.toContain('OLDCORP')
  })

  it('shows a skill saved in one turn in the prompt of the next, read from the vault', async () => {
    await mockCoreMemory(null)
    mockToolCallCompletion(
      'save_skill',
      JSON.stringify({ name: 'Weekly review', description: 'Sunday wrap-up', content: '## Procedure\nReview.' }),
    )
    mockCompletion('saved')
    const { thread } = await devChat('save this as a skill')

    let sent: Record<string, unknown> | undefined
    mockCompletion('ok', (b) => {
      sent = b
    })
    await devChat('and now?', thread)

    const system = (sent!.messages as { content: string }[])[0].content
    expect(system).toContain('<skills>\n- weekly-review — Sunday wrap-up\n</skills>')
  })
})

describe('POST /admin/reindex', () => {
  // No secret of its own any more: Cloudflare Access authenticates every route before the Worker
  // runs, and a second gate here would be one more thing to get wrong rather than defence.
  it('starts a reconcile', async () => {
    const res = await SELF.fetch('http://agent/admin/reindex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(202)
  })
})

describe('dev traffic is countable on its own', () => {
  it('writes a turn record marked dev, so replay never pools with organic turns', async () => {
    mockCompletion('dev answer')
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await devChat('hello from dev')
    } finally {
      spy.mockRestore()
    }
    const turn = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .find((r) => r !== null && r.at === 'turn')

    expect(turn).toMatchObject({ source: 'dev', outcome: 'ok', stopReason: 'complete' })
  })
})
