import { env, fetchMock } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mcpRegistry } from '../../src/agent/mcp/registry'
import type { McpClientConfig, McpClientRpc } from '../../src/agent/mcp/client'
import { buildMcpTools } from '../../src/agent/mcp/tools'
import type { Env } from '../../src/types'
import { CONNECT_GETS, CONNECT_POSTS, mockMcpServer } from '../helpers/mcp-server'

/**
 * One `McpClient` per server: the framework's MCP client behind our RPC surface, holding one
 * connection and reporting its state and tools into the registry. The MCP server is mocked at the
 * HTTP layer (the SDK's own transport does the fetch).
 *
 * Driven through the same `getAgentByName` stub the Worker and a chat turn use, not
 * `runInDurableObject`: agents reads its own name when composing the OAuth callback URL, and only
 * an RPC/fetch entry point bootstraps that.
 */

const testEnv = env as Env

/** Each test owns an origin, so a leftover interceptor cannot serve (and so mask) another test's. */
const urlFor = (tag: string) => `https://mcp-${tag}.example/mcp`

const registry = () => mcpRegistry(testEnv)

async function server(id: string): Promise<McpClientRpc> {
  return (await getAgentByName(testEnv.MCP_CLIENT, id)) as unknown as McpClientRpc
}

async function add(name: string, url: string, extra: Partial<McpClientConfig> = {}) {
  const added = await registry().addServer(name, url)
  if (!added.ok) {
    throw new Error(added.error)
  }
  const result = await (
    await server(added.id)
  ).configure({ id: added.id, name, url, callbackHost: 'http://localhost:8787', ...extra })
  return { id: added.id, result }
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

describe('an MCP client', () => {
  it('connects a bearer-authenticated server in 3 POSTs and a GET, reports its tools, then one POST per call', async () => {
    const url = urlFor('bearer')
    const seen: { authorization?: string | null; calls: { name?: string; args?: unknown }[] } = { calls: [] }
    mockMcpServer(
      url,
      { posts: CONNECT_POSTS + 1, gets: CONNECT_GETS },
      {
        onRequest: ({ headers, params, rpcMethod }) => {
          if (rpcMethod === 'initialize') {
            seen.authorization = headers.get('authorization')
          }
          if (rpcMethod === 'tools/call') {
            const p = params as { name?: string; arguments?: unknown }
            seen.calls.push({ name: p.name, args: p.arguments })
          }
        },
      },
    )

    const { id, result } = await add('files', url, { bearer: 'sekrit' })
    expect(result).toMatchObject({ ok: true, server: { id, name: 'files', url, state: 'ready', error: null } })

    expect(await registry().listServers()).toEqual([expect.objectContaining({ id, name: 'files', state: 'ready' })])
    const tools = await registry().listTools()
    expect(tools).toEqual([
      expect.objectContaining({ serverId: id, serverName: 'files', name: 'echo', description: 'echoes text back' }),
    ])
    expect(tools[0].inputSchema).toMatchObject({ type: 'object' })

    expect(await (await server(id)).callTool('echo', { text: 'hi' })).toEqual({
      ok: true,
      text: 'mock:echo:{"text":"hi"}',
    })

    expect(seen.authorization).toBe('Bearer sekrit')
    expect(seen.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }])
  })

  it('reports a server that failed to connect as failed, and its tools stay out of the catalog', async () => {
    const goodUrl = urlFor('good')
    mockMcpServer(goodUrl, { posts: CONNECT_POSTS + 1, gets: CONNECT_GETS })

    // No interceptor answers this origin, and net connect is disabled: the transport fails fast.
    const down = await add('down', urlFor('down'))
    expect(down.result).toMatchObject({ ok: false })

    const good = await add('files', goodUrl)
    expect(good.result).toMatchObject({ ok: true })

    const byName = Object.fromEntries((await registry().listServers()).map((s) => [s.name, s]))
    expect(byName.down.state).toBe('failed')
    expect(byName.files.state).toBe('ready')
    expect((await registry().listTools()).map((t) => t.serverId)).toEqual([good.id])
    expect(await (await server(good.id)).callTool('echo', { text: 'hi' })).toMatchObject({ ok: true })
  })

  it('configuring the same name and url again keeps the connection and spends nothing on the wire', async () => {
    const url = urlFor('again')
    mockMcpServer(url, { posts: CONNECT_POSTS, gets: CONNECT_GETS })

    const first = await add('files', url)
    const second = await add('files', url)

    expect(second.id).toBe(first.id)
    expect(second.result).toMatchObject({ ok: true, server: { state: 'ready' } })
    expect(await registry().listServers()).toHaveLength(1)
  })

  it('connectServer retries a failed server from scratch, and is free on a ready one', async () => {
    // The Sign in button lands here: a stale auth URL is never handed back, the connect is started
    // again so an OAuth server issues a fresh one. Without OAuth in the mock, the observable half
    // is a server that was down at add time and answers now.
    const url = urlFor('retry')
    const { id, result } = await add('files', url)
    expect(result).toMatchObject({ ok: false })
    expect((await registry().listServers())[0]).toMatchObject({ state: 'failed' })

    mockMcpServer(url, { posts: CONNECT_POSTS, gets: CONNECT_GETS })
    expect(await (await server(id)).connectServer()).toEqual({ ok: true })
    expect((await registry().listServers())[0]).toMatchObject({ state: 'ready' })
    expect((await registry().listTools()).map((t) => t.name)).toEqual(['echo'])

    expect(await (await server(id)).connectServer()).toEqual({ ok: true })
  })

  it('calling a tool on an unconfigured server returns an error instead of throwing', async () => {
    expect(await (await server('nope')).callTool('echo', {})).toMatchObject({
      ok: false,
      error: expect.stringContaining('not connected'),
    })
  })

  it('remove drops the connection, and is a no-op on a client that never had one', async () => {
    // The registry row is the Worker's to delete: a blocked URL leaves the registry with an entry
    // and the client with nothing, and that entry still has to be removable.
    const url = urlFor('remove')
    mockMcpServer(url, { posts: CONNECT_POSTS, gets: CONNECT_GETS })
    const { id } = await add('files', url)

    expect(await (await server(id)).remove()).toEqual({ ok: true })
    expect(await (await server(id)).callTool('echo', {})).toMatchObject({ ok: false })
    expect(await (await server('never-configured')).remove()).toEqual({ ok: true })
  })

  it('a catalog entry becomes a passthrough tool whose handler calls back through the client', async () => {
    const url = urlFor('passthrough')
    mockMcpServer(url, { posts: CONNECT_POSTS + 1, gets: CONNECT_GETS })
    await add('files', url)

    const tools = buildMcpTools(
      await registry().listTools(),
      async (serverId, name, args) => (await server(serverId)).callTool(name, args),
      [],
    )

    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('files_echo')
    expect(tools[0].schema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })

    const out = await tools[0].handler({ text: 'hi' } as never, {} as never)
    expect(out).toBe('mock:echo:{"text":"hi"}')
  })
})
