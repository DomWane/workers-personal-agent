import { getAgentByName, routeAgentRequest } from 'agents'
import { threadId, webAgentName, WEB_IDENTITY } from './agent/agent-name'
import { INDEX_INSTANCE, REFLECTION_INSTANCE } from './agent/maintenance-agent'
import { mcpRegistry, type McpResult } from './agent/mcp/registry'
import type { McpClientRpc } from './agent/mcp/client'
import { createMemoryStore } from './agent/memory/vault-store'
import { llmConfig } from './agent/llm-config'
import { readModels } from './agent/model-catalogue'
import type { AgentState, Env, ModelRow } from './types'

export { PersonalAgent } from './agent/personal-agent'
export { MaintenanceAgent } from './agent/maintenance-agent'
export { ResearchScout } from './agent/research/scout'
export { McpRegistry } from './agent/mcp/registry'
export { McpClient } from './agent/mcp/client'

function accessRefusal(request: Request, env: Env): Response | undefined {
  if (env.ENVIRONMENT === 'localhost') {
    return undefined
  }
  if (request.headers.has('cf-access-jwt-assertion')) {
    return undefined
  }

  if (env.ALLOW_UNPROTECTED === 'true') {
    console.log(JSON.stringify({ at: 'access', stage: 'unprotected', allowed: true }))
    return undefined
  }

  console.log(JSON.stringify({ at: 'access', stage: 'refused' }))
  return Response.json(
    {
      error: 'closed',
      detail:
        'Cloudflare Access is not in front of this Worker, so it refuses to serve rather than open your vault to whoever finds the URL.\n\n' +
        '1. Workers & Pages → this Worker → Access → Protect this Worker behind Access, scope All traffic\n' +
        '   (or Zero Trust → Access controls → Applications → Add → Self-hosted → Workers destination, this Worker)\n' +
        '2. Add a policy allowing your email — one-time PIN needs no identity provider\n\n' +
        'Then reload this page. To run it open on purpose instead, set the var ALLOW_UNPROTECTED=true and redeploy.',
    },
    { status: 503 },
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const refused = accessRefusal(request, env)
    if (refused) {
      return refused
    }

    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/dev/chat') {
      if (env.ENVIRONMENT !== 'localhost') {
        return new Response('not found', { status: 404 })
      }
      const { text, thread, model } = (await request.json()) as {
        text?: string
        thread?: string
        model?: string
      }
      if (!text) {
        return Response.json({ error: 'text required' }, { status: 400 })
      }
      const stub = await getAgentByName(env.PERSONAL_AGENT, `dev:${thread ?? 'default'}`)
      const reply = await stub.handleUserMessage(text, model)
      return Response.json({ reply })
    }

    if (request.method === 'POST' && url.pathname === '/dev/seed') {
      if (env.ENVIRONMENT !== 'localhost') {
        return new Response('not found', { status: 404 })
      }
      const state = (await request.json()) as AgentState
      const thread = url.searchParams.get('thread') ?? undefined
      const stub = await getAgentByName(env.PERSONAL_AGENT, webAgentName(WEB_IDENTITY, thread))
      await stub.seedState(state)
      if (thread) {
        const title = url.searchParams.get('title') ?? `seed: ${thread}`
        await createMemoryStore(env).touchThread(threadId(thread), title)
      }
      return Response.json({ seeded: state.messages?.length ?? 0, thread: threadId(thread) })
    }

    if (request.method === 'POST' && url.pathname === '/admin/reindex') {
      ctx.waitUntil(reconcileVault(env))
      return Response.json({ started: 'reconcile' }, { status: 202 })
    }

    if (request.method === 'GET' && url.pathname === '/api/models') {
      return handleModelList(env)
    }

    if (request.method === 'GET' && url.pathname === '/api/threads') {
      const threads = await createMemoryStore(env).listThreads()
      return Response.json(threads.sort((a, b) => b.at - a.at))
    }

    if (url.pathname.startsWith('/api/mcp/')) {
      return handleMcpApi(request, url, env)
    }

    if (url.pathname.startsWith('/agents/')) {
      return handleAgentRequest(request, url, env)
    }

    return new Response('not found', { status: 404 })
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runNightly(env))
  },
}

export async function runNightly(env: Env): Promise<void> {
  await reconcileVault(env)
  try {
    await env.MAINTENANCE.get(env.MAINTENANCE.idFromName(REFLECTION_INSTANCE)).reflect()
  } catch (err) {
    console.log(JSON.stringify({ at: 'reflection', stage: 'notify', error: String(err) }))
  }
}

const MAX_REINDEX_SLICES = 10

async function reconcileVault(env: Env): Promise<void> {
  const stub = env.MAINTENANCE.get(env.MAINTENANCE.idFromName(INDEX_INSTANCE))
  for (let slice = 0; slice < MAX_REINDEX_SLICES; slice++) {
    const report = await stub.reconcile()
    if (report.remaining === 0) {
      return
    }
  }
  console.log(JSON.stringify({ at: 'reindex', stage: 'slices-exhausted', slices: MAX_REINDEX_SLICES }))
}

async function handleModelList(env: Env): Promise<Response> {
  const cfg = llmConfig(env)
  let models: ModelRow[] = []
  try {
    const res = await fetch(cfg.catalogueUrl, { headers: { authorization: `Bearer ${cfg.apiKey}` } })
    if (res.ok) {
      models = readModels(await res.json(), cfg.catalogue)
    } else {
      console.log(JSON.stringify({ at: 'model-list', status: res.status, url: cfg.catalogueUrl }))
    }
  } catch (err) {
    console.log(JSON.stringify({ at: 'model-list', error: String(err) }))
  }

  return Response.json({ current: env.LLM_MODEL, models }, { headers: { 'cache-control': 'no-store' } })
}

async function handleAgentRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const [, , className, name, ...rest] = url.pathname.split('/')
  if (className === 'mcp-client' && MCP_SERVER_ID.test(name)) {
    const res = await routeAgentRequest(request, env)
    return res ?? new Response('not found', { status: 404 })
  }
  if (className !== 'personal-agent') {
    return new Response('not found', { status: 404 })
  }

  const rewritten = new URL(url)
  rewritten.pathname = ['', 'agents', className, webAgentName(WEB_IDENTITY, name), ...rest].join('/')

  const res = await routeAgentRequest(new Request(rewritten, request), env)
  return res ?? new Response('not found', { status: 404 })
}

const MCP_SERVERS_PATH = '/api/mcp/servers'
const MCP_SERVER_ID = /^[a-z][a-z0-9_-]{0,63}$/

function mcpReply<T extends object>(result: McpResult<T>, status = 200): Response {
  return result.ok ? Response.json(result, { status }) : Response.json({ error: result.error }, { status: 400 })
}

async function mcpClient(env: Env, id: string): Promise<McpClientRpc> {
  return (await getAgentByName(env.MCP_CLIENT, id)) as unknown as McpClientRpc
}

async function handleMcpApi(request: Request, url: URL, env: Env): Promise<Response> {
  const registry = mcpRegistry(env)
  const callbackHost = `${url.protocol}//${url.host}`
  const rest = url.pathname.startsWith(`${MCP_SERVERS_PATH}/`) ? url.pathname.slice(MCP_SERVERS_PATH.length + 1) : ''
  const [id, action] = rest.split('/').map(decodeURIComponent)
  const validId = MCP_SERVER_ID.test(id)
  try {
    if (request.method === 'GET' && url.pathname === MCP_SERVERS_PATH) {
      return Response.json({ servers: await registry.listServers() })
    }
    if (request.method === 'POST' && url.pathname === MCP_SERVERS_PATH) {
      const body = (await request.json()) as { name?: unknown; url?: unknown; bearer?: unknown }
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const serverUrl = typeof body.url === 'string' ? body.url.trim() : ''
      const bearer = typeof body.bearer === 'string' ? body.bearer : undefined
      if (!name || !serverUrl) {
        return Response.json({ error: 'name and url are required' }, { status: 400 })
      }
      const added = await registry.addServer(name, serverUrl)
      if (!added.ok) {
        return mcpReply(added)
      }
      const server = await mcpClient(env, added.id)
      return mcpReply(await server.configure({ id: added.id, name, url: serverUrl, bearer, callbackHost }), 201)
    }
    if (request.method === 'POST' && validId && action === 'connect') {
      return mcpReply(await (await mcpClient(env, id)).connectServer())
    }
    if (request.method === 'DELETE' && validId && !action) {
      const dropped = await (await mcpClient(env, id)).remove()
      if (dropped.ok) {
        await registry.removeServer(id)
      }
      return mcpReply(dropped)
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
  return Response.json({ error: 'not found' }, { status: 404 })
}
