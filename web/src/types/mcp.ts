/** Mirrors `McpServerView` and the `/api/mcp` replies in `src/agent/mcp-registry.ts`, the way `threads.ts` does. */

export type McpServerState = 'authenticating' | 'connecting' | 'connected' | 'discovering' | 'ready' | 'failed'

export interface McpServer {
  id: string
  name: string
  url: string
  state: McpServerState
  error: string | null
  authUrl: string | null
}

export interface McpServersResponse {
  servers: McpServer[]
}

export interface McpAddResponse {
  ok: true
  server: McpServer
}

export interface McpConnectResponse {
  ok: true
  authUrl?: string
}
