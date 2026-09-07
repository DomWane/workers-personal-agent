import { DurableObject } from 'cloudflare:workers'
import { normalizeServerId } from 'agents/mcp/client'
import { sqlTag } from './archive'
import type { SqlTag } from './memory/embedding-index'
import type { Env } from '../types'

export const MCP_REGISTRY_INSTANCE = 'mcp-registry'

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

export interface McpRegistryRpc {
  listServers(): Promise<McpServerView[]>
  addServer(name: string, url: string): Promise<McpResult<{ id: string }>>
  removeServer(id: string): Promise<void>
  report(id: string, report: McpServerReport): Promise<void>
  listTools(): Promise<McpToolView[]>
}

export function mcpRegistry(env: Pick<Env, 'MCP_REGISTRY'>): McpRegistryRpc {
  return env.MCP_REGISTRY.get(env.MCP_REGISTRY.idFromName(MCP_REGISTRY_INSTANCE)) as unknown as McpRegistryRpc
}

interface ServerRow {
  id: string
  name: string
  url: string
  state: McpServerState
  error: string | null
  auth_url: string | null
}

interface ToolRow {
  server_id: string
  server_name: string
  name: string
  description: string | null
  schema: string
}

export class McpRegistry extends DurableObject<Env> implements McpRegistryRpc {
  private readonly sql: SqlTag

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = sqlTag(ctx.storage.sql)
    this.sql`CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      auth_url TEXT
    )`
    this.sql`CREATE TABLE IF NOT EXISTS tools (
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      schema TEXT NOT NULL,
      PRIMARY KEY (server_id, name)
    )`
  }

  async listServers(): Promise<McpServerView[]> {
    return this.sql<ServerRow>`SELECT * FROM servers ORDER BY name`.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      state: row.state,
      error: row.error,
      authUrl: row.auth_url,
    }))
  }

  async addServer(name: string, url: string): Promise<McpResult<{ id: string }>> {
    const id = normalizeServerId(name)
    const [existing] = this.sql<ServerRow>`SELECT * FROM servers WHERE id = ${id}`
    if (existing && existing.url !== url) {
      return { ok: false, error: `the name "${name}" is already used for ${existing.url}` }
    }
    if (!existing) {
      this.sql`INSERT INTO servers (id, name, url, state) VALUES (${id}, ${name}, ${url}, 'connecting')`
    }
    return { ok: true, id }
  }

  async removeServer(id: string): Promise<void> {
    this.sql`DELETE FROM tools WHERE server_id = ${id}`
    this.sql`DELETE FROM servers WHERE id = ${id}`
  }

  async report(id: string, report: McpServerReport): Promise<void> {
    this
      .sql`UPDATE servers SET state = ${report.state}, error = ${report.error}, auth_url = ${report.authUrl} WHERE id = ${id}`
    this.sql`DELETE FROM tools WHERE server_id = ${id}`
    for (const tool of report.tools) {
      this.sql`INSERT INTO tools (server_id, name, description, schema)
        VALUES (${id}, ${tool.name}, ${tool.description ?? null}, ${JSON.stringify(tool.inputSchema)})`
    }
  }

  async listTools(): Promise<McpToolView[]> {
    return this.sql<ToolRow>`SELECT t.server_id, s.name AS server_name, t.name, t.description, t.schema
      FROM tools t JOIN servers s ON s.id = t.server_id
      WHERE s.state = 'ready'
      ORDER BY s.name, t.name`.map((row) => ({
      serverId: row.server_id,
      serverName: row.server_name,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      inputSchema: JSON.parse(row.schema) as Record<string, unknown>,
    }))
  }
}
