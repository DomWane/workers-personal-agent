import { Agent } from 'agents'
import { mcpRegistry } from '@/agent/mcp/registry'
import type { Env, McpCallResult, McpResult, McpServerReport, McpServerView } from '@/types'

export interface McpClientConfig {
  id: string
  name: string
  url: string
  bearer?: string
  callbackHost: string
}

export interface McpClientRpc {
  configure(config: McpClientConfig): Promise<McpResult<{ server: McpServerView }>>
  connectServer(): Promise<McpResult<{ authUrl?: string }>>
  remove(): Promise<McpResult<object>>
  callTool(name: string, args: unknown): Promise<McpCallResult>
}

const AUTH_RESULT_HTML = (heading: string, note: string) => {
  const escaped = note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' +
    heading +
    '</title><script>window.close()</script></head>' +
    `<body style="font-family:sans-serif;padding:2rem"><h1>${heading}</h1><p>${escaped}</p>` +
    '<p>You can close this tab.</p></body></html>'
  )
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  return (content as { type?: string; text?: string }[])
    .map((block) =>
      block?.type === 'text' && typeof block.text === 'string'
        ? block.text
        : `[${block?.type ?? 'unknown'} content omitted]`,
    )
    .join('\n')
}

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export class McpClient extends Agent<Env> implements McpClientRpc {
  async onStart(): Promise<void> {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        const html = result.authSuccess
          ? AUTH_RESULT_HTML('MCP server connected', 'The server is connected.')
          : AUTH_RESULT_HTML(
              'MCP server connection failed',
              `The server returned: ${result.authError ?? 'unknown error'}`,
            )
        return new Response(html, { headers: { 'content-type': 'text/html' } })
      },
    })
    this.mcp.onServerStateChanged(() => void this.report())
    await this.mcp.waitForConnections()
    await this.report()
  }

  private get row() {
    return this.mcp.listServers()[0]
  }

  private snapshot(): McpServerReport {
    const row = this.row
    const conn = row ? this.mcp.mcpConnections[row.id] : undefined
    const state = conn?.connectionState ?? (row?.auth_url ? 'authenticating' : 'connecting')
    return {
      state,
      error: conn?.connectionError ?? null,
      authUrl:
        state === 'authenticating' ? (conn?.options.transport.authProvider?.authUrl ?? row?.auth_url ?? null) : null,
      tools:
        state === 'ready'
          ? this.mcp.listTools().map((t) => ({
              name: t.name,
              ...(t.description ? { description: t.description } : {}),
              inputSchema: t.inputSchema,
            }))
          : [],
    }
  }

  private reporting: Promise<void> = Promise.resolve()

  private report(): Promise<McpServerView | undefined> {
    const row = this.row
    if (!row) {
      return this.reporting.then(() => undefined)
    }
    const { state, error, authUrl, tools } = this.snapshot()
    this.reporting = this.reporting.then(() => mcpRegistry(this.env).report(row.id, { state, error, authUrl, tools }))
    return this.reporting.then(() => ({ id: row.id, name: row.name, url: row.server_url, state, error, authUrl }))
  }

  async configure(config: McpClientConfig): Promise<McpResult<{ server: McpServerView }>> {
    try {
      const token = config.bearer?.trim()
      await this.addMcpServer(config.name, config.url, {
        id: config.id,
        callbackHost: config.callbackHost,
        transport: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
      })
      const server = await this.report()
      return server ? { ok: true, server } : { ok: false, error: 'the server was not registered' }
    } catch (err) {
      await this.report()
      return failure(err)
    }
  }

  async connectServer(): Promise<McpResult<{ authUrl?: string }>> {
    try {
      const row = this.row
      if (!row) {
        return { ok: false, error: 'this server has no connection here; remove it and add it again' }
      }
      if (this.mcp.mcpConnections[row.id]?.connectionState === 'ready') {
        return { ok: true }
      }
      const result = await this.mcp.connectToServer(row.id)
      if (result.state === 'failed') {
        await this.report()
        return { ok: false, error: result.error }
      }
      if (result.state === 'authenticating') {
        await this.report()
        return { ok: true, authUrl: result.authUrl }
      }
      await this.mcp.discoverIfConnected(row.id, { timeoutMs: 15_000 })
      await this.report()
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  }

  async remove(): Promise<McpResult<object>> {
    try {
      const row = this.row
      if (row) {
        await this.mcp.removeServer(row.id)
      }
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    try {
      const row = this.row
      const conn = row ? this.mcp.mcpConnections[row.id] : undefined
      if (!row || conn?.connectionState !== 'ready') {
        return { ok: false, error: `MCP server ${row?.name ?? 'unknown'} is not connected` }
      }
      const result = await this.mcp.callTool({
        serverId: row.id,
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      })
      const text = renderContent(result.content)
      if (result.isError) {
        return { ok: false, error: text || `MCP tool ${name} failed` }
      }
      return { ok: true, text }
    } catch (err) {
      return failure(err)
    }
  }
}
