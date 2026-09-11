export type McpServerState = 'authenticating' | 'connecting' | 'connected' | 'discovering' | 'ready' | 'failed'

export interface McpServerView {
  id: string
  name: string
  url: string
  state: McpServerState
  error: string | null
  authUrl: string | null
}

export interface McpToolView {
  serverId: string
  serverName: string
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type McpResult<T> = ({ ok: true } & T) | { ok: false; error: string }

export type McpCallResult = McpResult<{ text: string }>

export interface McpServerReport {
  state: McpServerState
  error: string | null
  authUrl: string | null
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
}
