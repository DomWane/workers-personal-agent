import { describe, expect, it } from 'vitest'
import { buildMcpTools, mcpToolName, type McpCall } from '@/agent/mcp/tools'
import type { McpToolView } from '@/types'
import { buildTools } from '@/agent/tools'

const call: McpCall = async (serverId, name, args) => ({
  ok: true,
  text: `${serverId}:${name}:${JSON.stringify(args)}`,
})

const entry = (serverName: string, name: string, serverId = serverName): McpToolView => ({
  serverId,
  serverName,
  name,
  inputSchema: { type: 'object' },
})

describe('MCP tool names', () => {
  it('sanitises the server and tool names into one function name', () => {
    expect(mcpToolName('my-server', 'create_thing')).toBe('my_server_create_thing')
    expect(mcpToolName('a b', 'x.y')).toBe('a_b_x_y')
  })

  it('never lets a server shadow a native tool', () => {
    // Mutation check: seed `seen` with nothing instead of the native names and `web_search` here
    // becomes an MCP tool; the loop's name→tool map then keeps the last one, the MCP one, and the
    // real web search is gone from every turn while the wire shows two functions of one name.
    const native = buildTools().map((t) => t.name)
    const logged: Record<string, unknown>[] = []
    const log = { turnId: null, event: () => {}, error: (f: Record<string, unknown>) => void logged.push(f) }

    const tools = buildMcpTools([entry('web', 'search'), entry('web', 'fetch')], call, native, log)

    expect(tools.map((t) => t.name)).toEqual(['web_fetch'])
    expect(logged).toEqual([{ at: 'mcp', stage: 'tool-name-taken', tool: 'web_search', server: 'web' }])
  })

  it('keeps the first of two catalog entries that sanitise to the same name', async () => {
    const tools = buildMcpTools([entry('files', 'read-file'), entry('files', 'read_file', 'files-2')], call, [])

    expect(tools).toHaveLength(1)
    await expect(tools[0].handler({} as never, {} as never)).resolves.toBe('files:read-file:{}')
  })
})
