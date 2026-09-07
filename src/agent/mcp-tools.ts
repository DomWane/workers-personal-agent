import type { McpCallResult, McpToolView } from './mcp-registry'
import type { ToolDef } from './tools/registry'
import type { TurnLog } from './log'

const SANITIZE = /[^A-Za-z0-9_]/g
const MAX_NAME = 64

export type McpCall = (serverId: string, name: string, args: unknown) => Promise<McpCallResult>

export function mcpToolName(serverName: string, name: string): string {
  const joined = `${serverName.replace(SANITIZE, '_')}_${name.replace(SANITIZE, '_')}`
  return joined.length <= MAX_NAME ? joined : joined.slice(0, MAX_NAME)
}

export function buildMcpTools(
  catalog: McpToolView[],
  call: McpCall,
  taken: Iterable<string>,
  log?: TurnLog,
): ToolDef[] {
  const seen = new Set(taken)
  const tools: ToolDef[] = []
  for (const tool of catalog) {
    const name = mcpToolName(tool.serverName, tool.name)
    if (seen.has(name)) {
      log?.error({ at: 'mcp', stage: 'tool-name-taken', tool: name, server: tool.serverName })
      continue
    }
    seen.add(name)
    tools.push({
      name,
      description: tool.description ?? `Call the ${tool.name} tool on the ${tool.serverName} MCP server`,
      schema: tool.inputSchema,
      handler: async (args: unknown) => {
        const result = await call(tool.serverId, tool.name, args)
        if (!result.ok) {
          return `error: ${result.error}`
        }
        return result.text.trim() ? result.text : '(MCP tool returned nothing)'
      },
    })
  }
  return tools
}
