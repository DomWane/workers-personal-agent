import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { R2VaultConnector } from '../../src/connectors/r2-vault.connector'
import type { Env } from '../../src/types'

const vault = () => new R2VaultConnector((env as Env).VAULT)

describe('R2VaultConnector metadata', () => {
  it('lists the metadata a put stored, so a directory index needs no get per file', async () => {
    // Mutation check: drop `include: ['customMetadata']` from `list` and `meta` comes back undefined
    // on a runtime that honours `include`, which every compatibility date since 2022-08-04 does.
    const store = vault()
    await store.putFile('agent/skills/a.md', 'body', 'm', undefined, { name: 'A', description: 'first' })
    await store.putFile('agent/skills/b.md', 'body', 'm')

    const listed = await store.listDir('agent/skills')
    expect(listed).toEqual([
      { name: 'a.md', sha: expect.any(String), meta: { name: 'A', description: 'first' } },
      { name: 'b.md', sha: expect.any(String), meta: {} },
    ])
  })

  it('keeps the metadata through a conditional overwrite', async () => {
    const store = vault()
    await store.putFile('agent/skills/a.md', 'v1', 'm', undefined, { name: 'A' })
    const [first] = await store.listDir('agent/skills')
    await store.putFile('agent/skills/a.md', 'v2', 'm', first.sha, { name: 'A', use_count: '1' })
    expect((await store.listDir('agent/skills'))[0].meta).toEqual({ name: 'A', use_count: '1' })
  })
})
