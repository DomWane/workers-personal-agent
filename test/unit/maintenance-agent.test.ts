import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { VaultStore } from '../../src/agent/memory/vault-store'
import { seedVault, skillFile } from '../helpers/vault'
import { EmbeddingIndex } from '../../src/agent/memory/embedding-index'
import { sqlTag } from '../../src/agent/archive'
import type { MaintenanceAgent } from '../../src/agent/maintenance-agent'
import { PersonalAgent as PersonalAgentClass, type PersonalAgent } from '../../src/agent/personal-agent'
import { WEB_IDENTITY, webAgentName } from '../../src/agent/agent-name'
import type { Env } from '../../src/types'

const testEnv = env as Env

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const fakeEmbed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase()
  return [t.includes('tea') ? 1 : 0, t.includes('vienna') ? 1 : 0]
}

async function freshMaintenance() {
  return testEnv.MAINTENANCE.get(testEnv.MAINTENANCE.idFromName(`maint-${crypto.randomUUID()}`))
}

/** The registry says whom to ask, and the instance itself holds what was said — reflection reads
 *  the live surface now, not session files. */
async function seedThread(id: string, said: string) {
  await seedVault({ 'agent/threads.json': JSON.stringify([{ id, title: id, at: Date.now() }]) })
  const stub = await getAgentByName<Env, PersonalAgent>(testEnv.PERSONAL_AGENT, webAgentName(WEB_IDENTITY, id))
  await stub.seedState({ messages: [{ role: 'user', content: said, id: 'u1', at: Date.now() }] })
}

describe('the night resolving a citation', () => {
  it('resolves a label through the registry, and tells a gone thread from a missing turn', async () => {
    await seedThread('t-live', 'the tea thing was wrong')
    const labels = new Map([['t-live#1', 'u1']])
    const stub = await freshMaintenance()

    await runInDurableObject(stub, async (m: MaintenanceAgent) => {
      // The label the run showed, resolved to the id the thread actually holds.
      expect(await m.verifyCitation('t-live', '1', labels)).toMatchObject({ ok: true })
      // A raw id still works: a model copying one out of a memory's provenance is citing correctly.
      expect(await m.verifyCitation('t-live', 'u1', labels)).toMatchObject({ ok: true })
      // A label this run never showed reaches the thread and is refused there.
      expect(await m.verifyCitation('t-live', '99', labels)).toEqual({ ok: false, why: 'missing' })
      // Only the registry can say this, and saying it about a live thread would be the false
      // refusal the three-way split exists to prevent.
      expect(await m.verifyCitation('t-vanished', '1', labels)).toEqual({ ok: false, why: 'thread-gone' })
    })
  })
})

describe('reflect', () => {
  it('stays silent when there is nothing to reflect on', async () => {
    // The vault is simply empty — with R2 there is nothing to mock, so absence is the fixture.
    await runInDurableObject(await freshMaintenance(), async (m: MaintenanceAgent, state) => {
      await m.reflect()
      // A run that read every thread — all zero of them — moves the watermark. Holding it here
      // would re-read the same nothing every night. afterEach's assertNoPendingInterceptors is
      // what proves the model was never called.
      expect(await state.storage.get<number>('reflection-watermark')).toBeGreaterThan(0)
    })
  })

  it('reports no change when the loop only reads and answers NO_CHANGES', async () => {
    await seedThread('t-one', 'Yesterday we discussed X.')
    await seedVault({
      'agent/skills/skill-a.md': skillFile(
        { name: 'Skill A', description: 'does a', date: '2026-07-01', use_count: '2', last_used: '2026-07-01' },
        'Body.',
      ),
    })
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 't1', type: 'function', function: { name: 'read_skill', arguments: '{"name":"skill-a"}' } },
                ],
              },
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      )
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'NO_CHANGES' } }] },
        { headers: { 'content-type': 'application/json' } },
      )

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(await freshMaintenance(), (m: MaintenanceAgent) => m.reflect())
    } finally {
      spy.mockRestore()
    }

    // A night that changed nothing still has to say so: the alternative is a silent run that is
    // indistinguishable from one that never fired.
    const record = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.at === 'reflection' && 'citationsRefused' in r)
    expect(record).toMatchObject({ changed: false, skillsArchived: 0 })
    expect(record).not.toHaveProperty('report')
  })

  it('rethrows so the cron can report it, rather than notifying from the failed run', async () => {
    // R2 has no HTTP layer to return a 500 from, so the failure is induced where it originates.
    const boom = vi.spyOn(VaultStore.prototype, 'listSkills').mockImplementation(async () => {
      throw new Error('boom')
    })
    try {
      await expect(runInDurableObject(await freshMaintenance(), (m: MaintenanceAgent) => m.reflect())).rejects.toThrow(
        'boom',
      )
    } finally {
      boom.mockRestore()
    }
  })

  it('records what the night did, report included', async () => {
    await seedThread('t-said', 'Something happened tonight.')
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'update_agent_notes', arguments: '{"text":"noted"}' },
                  },
                ],
              },
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      )
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'Tidied one note.' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    // Nothing is delivered any more, so the log line *is* the run's account of itself and has to
    // carry what it did, not just that it did something.
    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(await freshMaintenance(), (m: MaintenanceAgent) => m.reflect())
    } finally {
      logSpy.mockRestore()
    }

    const record = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.at === 'reflection' && 'citationsRefused' in r)
    expect(record).toMatchObject({ changed: true, citationsRefused: 0 })
    // The prose goes through the content parameter, so a deployment that has not opted in gets the
    // counts and none of what the night read. `vitest.config.ts` pins LOG_CONTENT off.
    expect('content' in record!).toBe(false)
    expect(JSON.stringify(record)).not.toContain('Tidied one note.')
  })

  it('holds the watermark when one thread could not be read', async () => {
    await seedThread('t-silent', 'Something happened tonight.')
    const stub = await freshMaintenance()
    // The night still runs for the threads that answer; what it must not do is call itself done.
    const boom = vi.spyOn(PersonalAgentClass.prototype, 'recentActivity').mockImplementation(async () => {
      throw new Error('unreachable')
    })
    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, (m: MaintenanceAgent) => m.reflect())
    } finally {
      boom.mockRestore()
      logSpy.mockRestore()
    }

    await runInDurableObject(stub, async (_m: MaintenanceAgent, state: DurableObjectState) => {
      // Moving it would skip those turns for good; not moving it costs one re-read.
      expect(await state.storage.get('reflection-watermark')).toBeUndefined()
    })
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).some((r) => r.stage === 'watermark-held')).toBe(
      true,
    )
  })

  it('leaves the watermark where it was when the run failed', async () => {
    await seedThread('t-unread', 'Something happened tonight.')
    const stub = await freshMaintenance()
    const boom = vi.spyOn(VaultStore.prototype, 'listSkills').mockImplementation(async () => {
      throw new Error('boom')
    })
    try {
      await expect(runInDurableObject(stub, (m: MaintenanceAgent) => m.reflect())).rejects.toThrow('boom')
    } finally {
      boom.mockRestore()
    }

    // A night nobody reflected on must be shown to the next run, not skipped because the failed
    // one already moved the mark past it.
    await runInDurableObject(stub, async (_m: MaintenanceAgent, state: DurableObjectState) => {
      expect(await state.storage.get('reflection-watermark')).toBeUndefined()
    })
  })
})

describe('sqlTag', () => {
  it('binds template values as parameters rather than interpolating them', async () => {
    // Any DO with SQLite serves: the adapter is about `storage.sql`, not about which class holds it.
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `sqltag-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (_agent: PersonalAgent, state: DurableObjectState) => {
      const sql = sqlTag(state.storage.sql)
      const index = new EmbeddingIndex(sql, fakeEmbed)
      await index.upsert('memory', 'a', 'Sam likes tea')
      await index.upsert('memory', 'b', 'a trip to Vienna')

      expect(await index.count()).toBe(2)
      expect((await index.search('vienna', 1))[0]).toMatchObject({ slug: 'b' })

      // A value carrying a quote would end the statement if it were interpolated.
      await index.upsert('memory', "o'brien", 'tea again')
      expect(await index.count()).toBe(3)
    })
  })
})
