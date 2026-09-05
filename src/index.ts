import { getAgentByName, routeAgentRequest } from 'agents'
import { threadId, webAgentName, WEB_IDENTITY } from './agent/agent-name'
import { INDEX_INSTANCE, REFLECTION_INSTANCE } from './agent/maintenance-agent'
import { createMemoryStore } from './agent/memory/vault-store'
import { llmConfig } from './agent/llm-config'
import { readModels } from './agent/model-catalogue'
import type { AgentState, Env, ModelRow } from './types'

export { PersonalAgent } from './agent/personal-agent'
export { MaintenanceAgent } from './agent/maintenance-agent'
export { ResearchScout } from './agent/research-scout'

/**
 * Access is the gate and it is not in this repository, so a deployment nobody protected is not a
 * broken one — it is a working one that serves the vault, the profile and every thread to whoever
 * has the URL. Closed by default is the only honest default for that: refusing is recoverable in a
 * minute, and a leak is not.
 *
 * Cloudflare stamps `Cf-Access-Jwt-Assertion` on requests it forwards, so its presence is the
 * signal. Nothing here verifies it — an unauthenticated request never reaches this Worker — it is
 * read only as "something authenticated ahead of me". Both directions were watched on 2026-08-23:
 * with a policy live the chat connects, which a fail-closed gate could not do if the header were
 * absent, and with the policy off the same URL answers 503.
 */
function accessRefusal(request: Request, env: Env): Response | undefined {
  // Only the exact word opens it: `staging` or a typo is a deployment, and a deployment is gated.
  if (env.ENVIRONMENT === 'localhost') {
    return undefined
  }
  if (request.headers.has('cf-access-jwt-assertion')) {
    return undefined
  }

  if (env.ALLOW_UNPROTECTED === 'true') {
    // Loud every time: this is someone's vault answering the open internet, and a line that only
    // appeared once a day would be a line nobody reads.
    console.log(JSON.stringify({ at: 'access', stage: 'unprotected', allowed: true }))
    return undefined
  }

  console.log(JSON.stringify({ at: 'access', stage: 'refused' }))
  return Response.json(
    {
      error: 'closed',
      detail:
        'Cloudflare Access is not in front of this Worker, so it refuses to serve rather than open your vault to whoever finds the URL.\n\n' +
        '1. Cloudflare dashboard → Zero Trust → Access controls → Applications → Add → Self-hosted\n' +
        '2. Pick the Workers destination and this Worker, so its workers.dev hostname is covered\n' +
        '3. Add a policy allowing your email — one-time PIN needs no identity provider\n\n' +
        'Then reload this page. To run it open on purpose instead, set the var ALLOW_UNPROTECTED=true and redeploy.',
    },
    { status: 503 },
  )
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Before routing, so no branch can be reached without passing it. Static assets are served
    // without running this Worker at all, so the SPA shell still loads — it has no data in it, and
    // Access protects the assets too once it is on.
    const refused = accessRefusal(request, env)
    if (refused) {
      return refused
    }

    const url = new URL(request.url)

    // Dev-only: synchronous chat against the agent, no browser needed.
    // curl -s localhost:8787/dev/chat -d '{"text":"hi","thread":"t1"}'
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
      // Prefix so a dev thread can never land on a web instance's name.
      const stub = await getAgentByName(env.PERSONAL_AGENT, `dev:${thread ?? 'default'}`)
      const reply = await stub.handleUserMessage(text, model)
      return Response.json({ reply })
    }

    // Dev-only: overwrite the web agent's state so the UI can be seen without spending a model
    // call per feature. The state is supplied by the caller (scripts/seed-web-chat.mjs), so no
    // fixture ever enters the Worker bundle.
    if (request.method === 'POST' && url.pathname === '/dev/seed') {
      if (env.ENVIRONMENT !== 'localhost') {
        return new Response('not found', { status: 404 })
      }
      const state = (await request.json()) as AgentState
      // `?thread=` because the landing is not a conversation: a message sent from `main` starts a
      // new thread, so a scenario seeded there can never be the one a turn is added to.
      const thread = url.searchParams.get('thread') ?? undefined
      const stub = await getAgentByName(env.PERSONAL_AGENT, webAgentName(WEB_IDENTITY, thread))
      await stub.seedState(state)
      // Registered too, or the seeded thread exists but nothing in the sidebar can reach it.
      if (thread) {
        const title = url.searchParams.get('title') ?? `seed: ${thread}`
        await createMemoryStore(env).touchThread(threadId(thread), title)
      }
      return Response.json({ seeded: state.messages?.length ?? 0, thread: threadId(thread) })
    }

    // Forces the nightly reconcile to run now. Schedules the alarm rather than calling the
    // callback here, so what runs is the same invocation shape as at 04:00 — a reconcile
    // tested on the fetch path would not prove the alarm path works.
    // No secret of its own: `accessRefusal` gates the Worker ahead of every route, and only
    // `ALLOW_UNPROTECTED` lets this answer with no Access in front.
    if (request.method === 'POST' && url.pathname === '/admin/reindex') {
      ctx.waitUntil(reconcileVault(env))
      return Response.json({ started: 'reconcile' }, { status: 202 })
    }

    if (request.method === 'GET' && url.pathname === '/api/models') {
      return handleModelList(request, env, ctx)
    }

    // A Worker route rather than an agent RPC: the client needs the list *before* it has picked a
    // thread to connect to, so there is no instance to ask.
    if (request.method === 'GET' && url.pathname === '/api/threads') {
      const threads = await createMemoryStore(env).listThreads()
      return Response.json(threads.sort((a, b) => b.at - a.at))
    }

    if (url.pathname.startsWith('/agents/')) {
      return handleAgentRequest(request, url, env)
    }

    return new Response('not found', { status: 404 })
  },

  /** A cron rather than a per-instance schedule: there is one vault and many conversations, and
   *  every instance arming its own alarm bought one nightly run per thread over the same files. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runNightly(env))
  },
}

/** Split from `scheduled` so it can be awaited directly: driving the handler means driving
 *  `waitUntil`, and the pool cannot keep isolated storage straight across that. */
export async function runNightly(env: Env): Promise<void> {
  await reconcileVault(env)
  try {
    await env.MAINTENANCE.get(env.MAINTENANCE.idFromName(REFLECTION_INSTANCE)).reflect()
  } catch (err) {
    // Nothing to notify any more: the web client is not connected at 04:00 and the log is where a
    // failed nightly run has always actually been read.
    console.log(JSON.stringify({ at: 'reflection', stage: 'notify', error: String(err) }))
  }
}

/** Enough slices for a vault many times today's size; the log says so rather than looping on. */
const MAX_REINDEX_SLICES = 10

/**
 * The only thing that reconciles. The agent used to chain its own reindex alarm as well, which
 * made two things decide when a sweep was finished — the shape ARCHITECTURE.md records as drift. A slice
 * is one RPC and therefore one invocation with its own fifty subrequests, which is what that chain
 * was buying and what this loop buys without a second scheduler.
 */
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

/** An hour: a provider's catalogue moves on the order of days, and the browser asks on every load. */
const MODEL_LIST_TTL_SECONDS = 3600

/**
 * The model picker's catalogue. Proxied rather than fetched from the browser because the list
 * needs the LLM credential; cached so a page reload does not spend a subrequest. Any failure
 * answers with the model this deployment runs and an empty list — the picker then still names the
 * model, which is the part the user must always see, and merely offers nothing to switch to.
 */
async function handleModelList(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The cache is process-wide and outlives a test's mocks, so one test's payload would answer the
  // next one's request. Off outside production, where a repeated fetch costs nothing that matters.
  const cache = env.ENVIRONMENT === 'production' ? caches.default : null
  const cached = await cache?.match(request)
  if (cached) {
    return cached
  }

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

  const body = Response.json(
    { current: env.LLM_MODEL, models },
    { headers: { 'cache-control': `public, max-age=${MODEL_LIST_TTL_SECONDS}` } },
  )
  if (cache) {
    ctx.waitUntil(cache.put(request, body.clone()))
  }
  return body
}

/** The SDK routes /agents/{kebab-class}/{name}. Only PersonalAgent is reachable from the web, and
 *  the name is rewritten rather than trusted — see `webAgentName`. */
async function handleAgentRequest(request: Request, url: URL, env: Env): Promise<Response> {
  const [, , className, name, ...rest] = url.pathname.split('/')
  if (className !== 'personal-agent') {
    return new Response('not found', { status: 404 })
  }

  const rewritten = new URL(url)
  rewritten.pathname = ['', 'agents', className, webAgentName(WEB_IDENTITY, name), ...rest].join('/')

  // `new Request(url, request)` preserves method, headers and body — including Upgrade, which a
  // WebSocket handshake needs.
  const res = await routeAgentRequest(new Request(rewritten, request), env)
  return res ?? new Response('not found', { status: 404 })
}
