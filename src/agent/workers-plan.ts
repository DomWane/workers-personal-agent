import { FREE_PLAN_SUBREQUESTS, PAID_PLAN_SUBREQUESTS } from './subrequest-budget'
import { errorFields, type TurnLog } from './log'
import type { Env } from '../types'

/**
 * Which subrequest cap this deployment gets, asked of Cloudflare rather than configured.
 *
 * No runtime API reports the plan and I/O is forbidden in a Worker's global scope, so the question
 * is asked in each Durable Object's start — the one place that runs before a request and can await.
 *
 * The endpoint's documented `rate_plan.id` enum lists only zone plans, yet this account's own
 * response carried `r2_paid` and `teams_free` (2026-08-27). Absent from the schema therefore says
 * nothing about what the response contains, which is what makes looking for Workers worth doing.
 */

/** `WORKERS_PAID` in Cloudflare's subscription catalogue, lower case in the account endpoint's own
 *  answers — matched case-insensitively rather than betting on one spelling. */
const WORKERS_PAID_PLAN = 'workers_paid'

/** Inside `blockConcurrencyWhile`, so this delays the instance's first request. A slow answer is
 *  worth less than a fast start on the cap we would have assumed anyway. */
const LOOKUP_TIMEOUT_MS = 3_000

/** Long enough that the call is rare, short enough that a *downgrade* is not believed for a day —
 *  that direction over-spends and dies past the platform cap, where the other only stops early.
 *  One hour is also what the model catalogue already caches for. */
const PLAN_TTL_MS = 60 * 60 * 1000

const PLAN_KEY = 'workers-plan'

interface CachedPlan {
  limit: number
  at: number
}

/**
 * `null` where the account could not be asked, which a number cannot express: a free account and a
 * failed lookup both mean 50, and only the first is worth remembering for an hour.
 *
 * Public for the tests; the cached form is what production calls.
 */
export async function fetchSubrequestLimit(env: Env, log?: TurnLog): Promise<number | null> {
  try {
    // The one place a bare `fetch` is right, against the invariant that every outbound call is
    // counted: this call is what decides how large the budget is, so there is no budget to charge
    // it to yet. It spends one of the invocation's 50 unseen, once an hour per instance.
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

/**
 * Resolved in each Durable Object's start, where it blocks the first request rather than riding on
 * a turn — the budget is needed synchronously on the turn's first line, and this keeps it there.
 * A failed lookup is not stored, so the next start tries again instead of believing a guess.
 */
export async function cachedSubrequestLimit(storage: DurableObjectStorage, env: Env, log?: TurnLog): Promise<number> {
  const cached = await storage.get<CachedPlan>(PLAN_KEY)
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) {
    return cached.limit
  }
  const limit = await fetchSubrequestLimit(env, log)
  if (limit === null) {
    // Free, even over an expired `paid`. Keeping the stale answer would be the more forgiving
    // choice and the wrong one: an endpoint failing for hours would hold a downgraded account at
    // 10,000 forever, and that direction crosses the platform cap and takes the error message with
    // it. Wrong here stops a turn early and says so.
    return FREE_PLAN_SUBREQUESTS
  }
  await storage.put<CachedPlan>(PLAN_KEY, { limit, at: Date.now() })
  return limit
}

/** What the settings panel's refresh does: drop the answer so the next start asks again. */
export async function forgetSubrequestLimit(storage: DurableObjectStorage): Promise<void> {
  await storage.delete(PLAN_KEY)
}
