import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getAgentByName } from 'agents'
import { readArchive, sqlTag } from '../../src/agent/archive'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import type { ResearchScout } from '../../src/agent/research-scout'
import { proposeResearch, startResearch } from '../../src/agent/research-state'
import type { Env } from '../../src/types'
import { requestBody } from '../helpers/request'

/**
 * The real Durable Object, not a stand-in. Every other scout test hands the loop a `Map` for its
 * archive, so `sqlTag(this.ctx.storage.sql)` against a class declared under `new_sqlite_classes`
 * had never executed anywhere — and its failure mode is quiet: `appendArchive` throwing inside
 * `fileAndTrim` is caught as `archive-failed`, the angle still returns findings, and the pruner is
 * simply inert for the whole run. Nothing goes red; research just gets worse.
 */

const testEnv = env as Env
const BASE = 'https://llm.example'
const CF = 'https://api.cloudflare.com'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

function queueLlm(msg: Record<string, unknown>) {
  fetchMock
    .get(BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(200, { choices: [{ message: msg }] }, { headers: { 'content-type': 'application/json' } })
}

/** Past `resultCap` at the 24k window below (7,200), so the archived row and the model's copy are
 *  different lengths and the test can tell which one each side got. */
const PAGE = `# Findings\n\n${'A real sentence that survives the prose extractor. '.repeat(400)}`

const NOTES = '## Findings\nOne lab published in 2026.\n\n## Open questions\n- cost?\n\n## Done\nno'

describe('a scout files its reads in its own SQLite', () => {
  it('keeps the whole page in SQLite while the model gets the capped copy', async () => {
    let wroteUp: Record<string, unknown> | undefined
    queueLlm({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{"url":"https://x.example/a"}' } },
      ],
    })
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: PAGE }, { headers: { 'content-type': 'application/json' } })
    // Captured rather than queued blind: the second request is the only place the *model's* copy of
    // the page can be read, and it is half of what this test is about.
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        (opts) => {
          wroteUp = JSON.parse(requestBody(opts) || '{}') as Record<string, unknown>
          return { choices: [{ message: { content: NOTES } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const id = testEnv.RESEARCH_SCOUT.idFromName(`scout-${crypto.randomUUID()}`)
    const stub = testEnv.RESEARCH_SCOUT.get(id)

    await runInDurableObject(stub as never, async (scout: ResearchScout, state) => {
      const outcome = await scout.scout({
        topic: 'agent evals',
        angle: 'who publishes',
        model: 'test-scout-model',
        turnId: 't1',
        alreadyTried: [],
        contextTokens: 24_000,
      })

      // The angle worked, so a failure below is about the archive and not about the round.
      expect(outcome.error).toBeUndefined()
      expect(outcome.findings).toBe('One lab published in 2026.')

      // Mutation check: drop `toolArchive` from the scout's ctx and this is empty, which nothing
      // else in the suite would catch.
      const rows = readArchive<{ tool: string; content: string }>(sqlTag(state.storage.sql))
      expect(rows.map((r) => r.type)).toEqual(['tool-result'])
      expect(rows[0].data.tool).toBe('read_page')

      // The row is filed from the raw fetch, so it holds the page the cap never touched. Mutation
      // check: file `trimmed` instead of `raw` in `fileAndTrim` and this drops to the 7,200 below.
      expect(rows[0].data.content.length).toBeGreaterThan(19_000)

      // And the model's copy is the capped one, carrying the ref that reaches the rest. Without it
      // the marker naming the cut would point at nothing.
      const sent = (wroteUp?.messages ?? []) as { role: string; content: string }[]
      const page = sent.find((m) => m.role === 'tool')!
      expect(page.content.length).toBeLessThan(7_400)
      expect(page.content).toContain('read_tool_result(1)')
    })
  })
})

describe('a scout tells its parent how far it is', () => {
  it('lands its counts in the parent state for the run in flight, over a real RPC', async () => {
    // Mutation check: drop `onProgress` from the scout's deps, or `parent` from the input, and the
    // parent's row stays at zero.
    queueLlm({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{"url":"https://x.example/a"}' } },
      ],
    })
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: PAGE }, { headers: { 'content-type': 'application/json' } })
    queueLlm({ content: NOTES })

    const parentName = 'web:dev-user:home:wave-parent'
    const parent = await getAgentByName(testEnv.PERSONAL_AGENT, parentName)
    await runInDurableObject(parent, async (agent: PersonalAgent) => {
      const run = startResearch(proposeResearch('agent evals', ['who publishes']), 'r1') as NonNullable<
        PersonalAgent['state']['research']
      >
      agent.setState({
        ...agent.state,
        research: { ...run, scouts: [{ angle: 'who publishes', reads: 0, searches: 0 }] },
      })
    })

    const stub = testEnv.RESEARCH_SCOUT.get(testEnv.RESEARCH_SCOUT.idFromName(`scout-${crypto.randomUUID()}`))
    await runInDurableObject(stub as never, async (scout: ResearchScout) => {
      const outcome = await scout.scout({
        topic: 'agent evals',
        angle: 'who publishes',
        model: 'test-scout-model',
        turnId: 't1',
        alreadyTried: [],
        contextTokens: 24_000,
        parent: parentName,
        runId: 'r1',
      })
      expect(outcome.error).toBeUndefined()
    })

    // The report is not awaited by the scout, so the parent is read until it has landed.
    await expect
      .poll(
        () => runInDurableObject(parent, async (agent: PersonalAgent) => agent.state.research?.scouts?.[0]?.reads),
        { timeout: 3000 },
      )
      .toBe(1)
    await runInDurableObject(parent, async (agent: PersonalAgent) => {
      agent.setState({ ...agent.state, research: undefined })
    })
  })
})
