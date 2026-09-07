import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { MCP_REGISTRY_INSTANCE, type McpRegistry } from '../../src/agent/mcp-registry'
import type { Env } from '../../src/types'

const testEnv = env as Env
const registry = () => testEnv.MCP_REGISTRY.get(testEnv.MCP_REGISTRY.idFromName(MCP_REGISTRY_INSTANCE))

const echo = { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }

describe('the MCP registry', () => {
  it('derives the id from the name, refuses the same name for another url, and repeats itself for the same url', async () => {
    await runInDurableObject(registry(), async (reg: McpRegistry) => {
      const first = await reg.addServer('My Files', 'https://a.example/mcp')
      expect(first).toEqual({ ok: true, id: 'my-files' })

      expect(await reg.addServer('My Files', 'https://b.example/mcp')).toMatchObject({
        ok: false,
        error: expect.stringContaining('https://a.example/mcp'),
      })
      expect(await reg.addServer('My Files', 'https://a.example/mcp')).toEqual({ ok: true, id: 'my-files' })
      expect(await reg.listServers()).toEqual([
        {
          id: 'my-files',
          name: 'My Files',
          url: 'https://a.example/mcp',
          state: 'connecting',
          error: null,
          authUrl: null,
        },
      ])
    })
  })

  it("lists tools of ready servers only, and replaces a server's tools on every report", async () => {
    await runInDurableObject(registry(), async (reg: McpRegistry) => {
      await reg.addServer('files', 'https://a.example/mcp')
      await reg.addServer('down', 'https://b.example/mcp')
      await reg.report('files', { state: 'ready', error: null, authUrl: null, tools: [echo, { ...echo, name: 'ls' }] })
      await reg.report('down', { state: 'failed', error: 'refused', authUrl: null, tools: [echo] })

      // Mutation check: drop the `state = 'ready'` filter and `down`'s echo shows up in a turn as a
      // tool whose every call answers "not connected".
      expect((await reg.listTools()).map((t) => `${t.serverName}.${t.name}`)).toEqual(['files.echo', 'files.ls'])
      expect((await reg.listTools())[0]).toMatchObject({
        serverId: 'files',
        description: 'echoes',
        inputSchema: { type: 'object' },
      })

      await reg.report('files', { state: 'ready', error: null, authUrl: null, tools: [echo] })
      expect((await reg.listTools()).map((t) => t.name)).toEqual(['echo'])

      const down = (await reg.listServers()).find((s) => s.id === 'down')
      expect(down).toMatchObject({ state: 'failed', error: 'refused' })
    })
  })

  it('removing a server takes its tools with it', async () => {
    await runInDurableObject(registry(), async (reg: McpRegistry) => {
      await reg.addServer('files', 'https://a.example/mcp')
      await reg.report('files', { state: 'ready', error: null, authUrl: null, tools: [echo] })
      await reg.removeServer('files')

      expect(await reg.listServers()).toEqual([])
      expect(await reg.listTools()).toEqual([])
    })
  })
})
