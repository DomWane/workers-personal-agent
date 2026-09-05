import { env, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { describe, expect, it } from 'vitest'
import { threadId } from '../../src/agent/agent-name'
import { appendArchive } from '../../src/agent/archive'
import { sqlTag } from '../../src/agent/archive'
import { createMemoryStore } from '../../src/agent/memory/vault-store'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import type { Env } from '../../src/types'
import { seedVault } from '../helpers/vault'

const testEnv = env as Env

describe('threadId', () => {
  it('accepts a plain slug', () => {
    expect(threadId('klient-notes')).toBe('klient-notes')
  })

  it('falls back to main for anything that could escape the prefix or is absent', () => {
    // A colon would add a segment and let a client address someone else's instance; the rest are
    // ordinary client bugs, and a working default beats a 404 the user cannot act on.
    for (const bad of [undefined, '', '../other', 'web:dev-user:home:main', 'Upper', 'a'.repeat(41)]) {
      expect(threadId(bad)).toBe('main')
    }
  })
})

describe('the thread registry', () => {
  it('records a thread on its first message, with a title from that message', async () => {
    const stub = await getAgentByName(testEnv.PERSONAL_AGENT, 'web:dev-user:home:notes')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('what did we decide about the vault?')
      // The turn itself is not the subject here, and an alarm outliving the test corrupts storage.
      for (const s of await agent.listSchedules()) {
        await agent.cancelSchedule(s.id)
      }
    })

    const threads = await createMemoryStore(testEnv).listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ id: 'notes', title: 'what did we decide about the vault?' })
  })

  it('keeps the first title when the thread speaks again', async () => {
    const stub = await getAgentByName(testEnv.PERSONAL_AGENT, 'web:dev-user:home:keeps')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('first thing')
      await agent.enqueueWebMessage('second thing')
      for (const s of await agent.listSchedules()) {
        await agent.cancelSchedule(s.id)
      }
    })

    const threads = await createMemoryStore(testEnv).listThreads()
    expect(threads.find((t) => t.id === 'keeps')?.title).toBe('first thing')
  })

  it('keeps a title the user typed over the one the next message would derive', async () => {
    const stub = await getAgentByName(testEnv.PERSONAL_AGENT, 'web:dev-user:home:renamed')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('some rambling first message')
      await agent.renameThread('Vienna')
      // An explicit act by the user outranks a derivation, the same way /model beats SCOUT_MODEL.
      await agent.enqueueWebMessage('and another one')
      for (const s of await agent.listSchedules()) {
        await agent.cancelSchedule(s.id)
      }
    })

    const threads = await createMemoryStore(testEnv).listThreads()
    expect(threads.find((t) => t.id === 'renamed')?.title).toBe('Vienna')
  })

  it('drops the row, the state and the archive when a thread is deleted', async () => {
    const stub = await getAgentByName(testEnv.PERSONAL_AGENT, 'web:dev-user:home:doomed')
    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      await agent.enqueueWebMessage('temporary')
      appendArchive(sqlTag(state.storage.sql), 'compaction-start', { evicted: 1 })

      await agent.deleteThread()

      expect(agent.state.messages).toEqual([])
      expect(await agent.listSchedules()).toEqual([])
      // Deleting is the one gesture whose whole purpose is to destroy history, so the shadowed
      // copy has to go with it — asserted on the table, not on what the method reports.
      const table = state.storage.sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive'`)
        .toArray()
      expect(table).toEqual([])
    })

    expect((await createMemoryStore(testEnv).listThreads()).map((t) => t.id)).not.toContain('doomed')
  })

  it('throws on an unreadable registry rather than reporting no threads', async () => {
    await seedVault({ 'agent/threads.json': 'not json at all' })
    // Empty would mean the nightly run reflected over nothing and said so in no log line.
    await expect(createMemoryStore(testEnv).listThreads()).rejects.toThrow(/not valid JSON/)
  })
})
