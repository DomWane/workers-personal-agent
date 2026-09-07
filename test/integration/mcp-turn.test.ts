import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mcpRegistry } from '../../src/agent/mcp-registry'
import type { McpClientRpc } from '../../src/agent/mcp-client'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import type { Env } from '../../src/types'
import { CONNECT_GETS, CONNECT_POSTS, mockMcpServer } from '../helpers/mcp-server'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => {
  vi.restoreAllMocks()
  fetchMock.assertNoPendingInterceptors()
})

const testEnv = env as Env
const LLM_BASE = 'https://llm.example'

function queueLlm(msg: Record<string, unknown>, capture?: (body: Record<string, unknown>) => void) {
  fetchMock
    .get(LLM_BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(
      200,
      ({ body }) => {
        capture?.(JSON.parse(body as string) as Record<string, unknown>)
        return { choices: [{ message: msg }] }
      },
      { headers: { 'content-type': 'application/json' } },
    )
}

describe('an MCP tool inside a chat turn', () => {
  it('web message → the registry catalog on the wire → tool_calls files_echo → the client answers → final reply in state', async () => {
    const url = 'https://mcp-turn.example/mcp'
    mockMcpServer(url, { posts: CONNECT_POSTS + 1, gets: CONNECT_GETS })
    const added = await mcpRegistry(testEnv).addServer('files', url)
    expect(added).toEqual({ ok: true, id: 'files' })
    const server = (await getAgentByName(testEnv.MCP_CLIENT, 'files')) as unknown as McpClientRpc
    const configured = await server.configure({
      id: 'files',
      name: 'files',
      url,
      callbackHost: 'http://localhost:8787',
    })
    expect(configured).toMatchObject({ ok: true })

    let first: Record<string, unknown> | undefined
    queueLlm(
      {
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'files_echo', arguments: '{"text":"hi"}' } }],
      },
      (b) => (first = b),
    )
    let second: Record<string, unknown> | undefined
    queueLlm({ content: 'The server said: mock:echo:{"text":"hi"}' }, (b) => (second = b))

    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line))

    const stub = await getAgentByName(testEnv.PERSONAL_AGENT, `mcp-turn-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.processWebMessage({ text: 'ask the files server to echo hi' })
      expect(agent.state.messages.at(-1)?.content).toContain('The server said')
    })

    const wire = ((first?.tools ?? []) as { function: { name: string; parameters: unknown } }[]).map((t) => t.function)
    expect(wire.map((t) => t.name)).toContain('files_echo')
    expect(wire.find((t) => t.name === 'files_echo')?.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    })

    const msgs = second?.messages as { role: string; tool_call_id?: string; content: string }[]
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 't1', content: 'mock:echo:{"text":"hi"}' })

    const turn = logged.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.at === 'turn')
    expect(turn).toMatchObject({ mcpTools: 1, toolsUsed: ['files_echo'] })
  })
})
