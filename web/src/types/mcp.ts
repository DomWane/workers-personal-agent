import type { McpResult, McpServerView } from '@agent/types/mcp'

export type McpServer = McpServerView

export interface McpServersResponse {
  servers: McpServer[]
}

export type McpAddResponse = Extract<McpResult<{ server: McpServer }>, { ok: true }>

export type McpConnectResponse = Extract<McpResult<{ authUrl?: string }>, { ok: true }>
