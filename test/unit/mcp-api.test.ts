import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import worker, { McpClient } from '../../src/index'
import type { Env } from '../../src/types'
import type { McpServerView } from '../../src/types'
import { CONNECT_GETS, CONNECT_POSTS, mockMcpServer } from '../helpers/mcp-server'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

/** The pool runs as `ENVIRONMENT=localhost`, so the Access gate lets these through the way `wrangler dev` does. */
async function api(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`http://agent${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
    env as Env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('/api/mcp/servers', () => {
  it('starts empty', async () => {
    expect(await api('GET', '/api/mcp/servers')).toEqual({ status: 200, body: { servers: [] } })
  })

  it('refuses an add without a name or url before touching the registry', async () => {
    const res = await api('POST', '/api/mcp/servers', { name: 'files' })
    expect(res).toEqual({ status: 400, body: { error: 'name and url are required' } })
  })

  it('adds, lists and removes a server, with the callback host taken from the request origin', async () => {
    const url = 'https://mcp-api.example/mcp'
    mockMcpServer(url, { posts: CONNECT_POSTS, gets: CONNECT_GETS })

    const added = await api('POST', '/api/mcp/servers', { name: 'files', url })
    expect(added.status).toBe(201)
    const server = (added.body as { server: McpServerView }).server
    expect(server).toMatchObject({ name: 'files', url, state: 'ready' })

    const listed = await api('GET', '/api/mcp/servers')
    expect(listed.body).toEqual({ servers: [expect.objectContaining({ id: server.id, state: 'ready' })] })

    expect(await api('DELETE', `/api/mcp/servers/${encodeURIComponent(server.id)}`)).toEqual({
      status: 200,
      body: { ok: true },
    })
    expect(await api('GET', '/api/mcp/servers')).toEqual({ status: 200, body: { servers: [] } })
  })

  it('names the MCP client binding so the SDK routes its own OAuth callback', () => {
    // The SDK routes `/agents/<segment>/…` by the kebab-cased *binding* name and composes the
    // callback URL from the kebab-cased *class* name. Mutation check: rename the binding to
    // `MCP_SERVER` and the two differ, which is the 404 a real provider redirect got on 2026-09-07.
    // The kebab rule is the SDK's own (partyserver `camelCaseToKebabCase`).
    const kebab = (s: string) =>
      s === s.toUpperCase()
        ? s.toLowerCase().replace(/_/g, '-')
        : s.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`).replace(/^-/, '')
    expect('MCP_CLIENT' in env).toBe(true)
    expect(kebab('MCP_CLIENT')).toBe(kebab(McpClient.name))
    expect(kebab(McpClient.name)).toBe('mcp-client')
  })

  it('deletes a registry entry whose client never connected, such as a blocked URL', async () => {
    // Mutation check: put the registry delete back inside the client's `remove` and this entry
    // is stuck: the client has no row, so it answers "not configured" and the row outlives it.
    const added = await api('POST', '/api/mcp/servers', { name: 'local', url: 'http://127.0.0.1:8788/mcp' })
    expect(added.status).toBe(400)
    expect(await api('GET', '/api/mcp/servers')).toMatchObject({
      body: { servers: [expect.objectContaining({ id: 'local' })] },
    })

    expect(await api('DELETE', '/api/mcp/servers/local')).toEqual({ status: 200, body: { ok: true } })
    expect(await api('GET', '/api/mcp/servers')).toEqual({ status: 200, body: { servers: [] } })
  })

  it('answers a server refusal as 400 with the reason, and an unknown route as 404', async () => {
    const connect = await api('POST', '/api/mcp/servers/nope/connect')
    expect(connect.status).toBe(400)
    expect(typeof connect.body.error).toBe('string')

    expect((await api('GET', '/api/mcp/other')).status).toBe(404)
  })
})
