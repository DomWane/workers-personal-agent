import { fetchMock } from 'cloudflare:test'

export interface MockMcpServerOptions {
  onRequest?: (info: { rpcMethod?: string; params?: unknown; headers: Headers }) => void
}

const TOOLS = [
  {
    name: 'echo',
    description: 'echoes text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

/** What one connect costs on the wire, measured 2026-09-07 against `agents@0.16.2`: `initialize`,
 *  `notifications/initialized` and `tools/list` as POSTs, plus one GET probing for an SSE stream. */
export const CONNECT_POSTS = 3
export const CONNECT_GETS = 1

interface JsonRpcMessage {
  id?: number | string | null
  method?: string
  params?: unknown
}

/**
 * A minimal streamable-HTTP MCP server: JSON-RPC over the SDK's request/response transport, no SSE
 * stream (the SDK tolerates a 405 on its GET), everything dispatched from the request body.
 * `wire` is the exact number of requests the test expects, so `assertNoPendingInterceptors` keeps
 * meaning something: one request too few leaves an interceptor pending, one too many is refused.
 */
export function mockMcpServer(
  url: string,
  wire: { posts: number; gets: number },
  options: MockMcpServerOptions = {},
): void {
  const rpc = (id: JsonRpcMessage['id'], result: unknown) => ({
    statusCode: 200,
    data: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
    responseOptions: { headers: { 'content-type': 'application/json' } },
  })

  const dispatch = (opts: { body?: unknown; headers: unknown }) => {
    const headers = new Headers(opts.headers as HeadersInit)
    let msg: JsonRpcMessage = {}
    try {
      const parsed = JSON.parse((typeof opts.body === 'string' ? opts.body : '{}') || '{}')
      msg = (Array.isArray(parsed) ? parsed[0] : parsed) as JsonRpcMessage
    } catch {
      return { statusCode: 400, data: '' }
    }
    options.onRequest?.({ rpcMethod: msg.method, params: msg.params, headers })
    if (msg.method === 'initialize') {
      return rpc(msg.id, {
        protocolVersion: (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock', version: '1.0.0' },
      })
    }
    if (msg.method === 'notifications/initialized') {
      return { statusCode: 202, data: '' }
    }
    if (msg.method === 'tools/list') {
      return rpc(msg.id, { tools: TOOLS })
    }
    if (msg.method === 'tools/call') {
      const p = msg.params as { name?: string; arguments?: unknown }
      return rpc(msg.id, { content: [{ type: 'text', text: `mock:${p.name}:${JSON.stringify(p.arguments ?? {})}` }] })
    }
    return {
      statusCode: 200,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: { code: -32601, message: `unhandled ${String(msg.method)}` },
      }),
      responseOptions: { headers: { 'content-type': 'application/json' } },
    }
  }

  const { origin, pathname } = new URL(url)
  if (wire.posts > 0) {
    fetchMock
      .get(origin)
      .intercept({ method: 'POST', path: pathname })
      .reply((opts) => dispatch(opts))
      .times(wire.posts)
  }
  if (wire.gets > 0) {
    fetchMock
      .get(origin)
      .intercept({ method: 'GET', path: pathname })
      .reply(() => ({ statusCode: 405, data: '' }))
      .times(wire.gets)
  }
}
