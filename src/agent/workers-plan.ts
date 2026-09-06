import { FREE_PLAN_SUBREQUESTS, PAID_PLAN_SUBREQUESTS } from './subrequest-budget'
import { errorFields, type TurnLog } from './log'
import type { Env } from '../types'

const WORKERS_PAID_PLAN = 'workers_paid'

const LOOKUP_TIMEOUT_MS = 3_000

const PLAN_TTL_MS = 60 * 60 * 1000

const PLAN_KEY = 'workers-plan'

interface CachedPlan {
  limit: number
  at: number
}

export async function fetchSubrequestLimit(env: Env, log?: TurnLog): Promise<number | null> {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/subscriptions`, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`subscriptions: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { result?: { rate_plan?: { id?: string } }[] }
    const paid = (body.result ?? []).some((s) => s.rate_plan?.id?.toLowerCase() === WORKERS_PAID_PLAN)
    return paid ? PAID_PLAN_SUBREQUESTS : FREE_PLAN_SUBREQUESTS
  } catch (err) {
    log?.error({ at: 'workers-plan', stage: 'unknown', assumed: FREE_PLAN_SUBREQUESTS, error: errorFields(err) })
    return null
  }
}

export async function cachedSubrequestLimit(storage: DurableObjectStorage, env: Env, log?: TurnLog): Promise<number> {
  const cached = await storage.get<CachedPlan>(PLAN_KEY)
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) {
    return cached.limit
  }
  const limit = await fetchSubrequestLimit(env, log)
  if (limit === null) {
    return FREE_PLAN_SUBREQUESTS
  }
  await storage.put<CachedPlan>(PLAN_KEY, { limit, at: Date.now() })
  return limit
}

export async function forgetSubrequestLimit(storage: DurableObjectStorage): Promise<void> {
  await storage.delete(PLAN_KEY)
}
