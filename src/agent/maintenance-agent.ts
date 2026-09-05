import { DurableObject } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { createLlmClient } from '../connectors/llm.connector'
import { embedText } from '../connectors/embeddings.connector'
import { llmConfig } from './llm-config'
import { archiveStaleSkills, citationLabels, runReflectionLoop, type ThreadActivity } from './reflection'
import { WEB_IDENTITY, webAgentName } from './agent-name'
import type { PersonalAgent } from './personal-agent'
import type { MemoryStore } from './memory/memory-store'
import type { CitationVerdict } from './provenance'
import type { Env } from '../types'
import { contentEnabled, createLog, errorFields, type TurnLog } from './log'
import { sqlTag } from './archive'
import { EmbeddingIndex, type MemoryIndex, type ReindexReport, reindexInto } from './memory/embedding-index'
import { createMemoryStore } from './memory/vault-store'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from './subrequest-budget'
import { cachedSubrequestLimit } from './workers-plan'

/**
 * Two instances of one class, not two classes: they share every dependency and differ only in
 * which of them is busy when. The split is about contention — a Durable Object is one actor, and
 * the nightly reflection runs to `REFLECTION_BUDGET_MS = 240000`, four minutes during which every
 * `search_memory` from every thread would be entering the same instance. One extra name is the
 * whole cost of avoiding it. They become one pair per folder when folders land.
 */
export const INDEX_INSTANCE = 'index'
export const REFLECTION_INSTANCE = 'reflection'

/** A reconcile stops with this much budget unspent so it can still log what it did and say
 *  whether a continuation is due. */
const REINDEX_RESERVE = 4

/** The reflection instance's own storage: the time it last read the threads. Kept here rather than
 *  in the vault because only this instance reads or writes it. */
const WATERMARK_KEY = 'reflection-watermark'

/** Workers AI has no local simulation — the binding only resolves remotely — so outside production
 *  there are no vectors and `search_memory` falls back to keyword. Deciding it here rather than at
 *  each caller keeps one answer to "is the index live". */
const NOOP_INDEX: MemoryIndex = {
  upsert: async () => {},
  remove: async () => {},
  search: async () => [],
  count: async () => 0,
  fingerprints: async () => new Map(),
}

/**
 * The vault's embedding index, in one instance instead of one per conversation.
 *
 * It lives here because the index is about the vault, not about a conversation. Held per agent
 * instance it was rebuilt from scratch by every new one — 47 files is 93 embeddings, paid again
 * for each — while every copy indexed the same vault. One instance builds it once.
 *
 * It is also cheaper per query, and in the currency that binds: a `search_memory` call used to
 * spend one of the chat turn's fifty *external* subrequests embedding the query, and now spends
 * one call against the separate allowance of a thousand internal ones (both measured 2026-08-08).
 * A turn doing five searches gets five slots back.
 */
export class MaintenanceAgent extends DurableObject<Env> {
  /** Resolved before the first request, so every budget below starts at the right cap rather than
   *  discovering it mid-reconcile. See `workers-plan.ts` for why it is asked rather than configured. */
  private planLimit = FREE_PLAN_SUBREQUESTS

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // `void`, not awaited: a constructor cannot be async, and the runtime holds requests until the
    // block resolves whether or not anyone holds its promise.
    void ctx.blockConcurrencyWhile(async () => {
      this.planLimit = await cachedSubrequestLimit(ctx.storage, env, createLog('reflection'))
    })
  }

  private budget(): SubrequestBudget {
    return new SubrequestBudget(this.planLimit)
  }

  private index(budget: SubrequestBudget): MemoryIndex {
    if (this.env.ENVIRONMENT !== 'production') {
      return NOOP_INDEX
    }
    return new EmbeddingIndex(sqlTag(this.ctx.storage.sql), (text) => embedText(this.env.AI, text, budget))
  }

  /** One RPC is one invocation with a budget of its own, so these three pass a fresh one that
   *  nothing reads; only `reconcile` spends enough to check it. */
  private get live() {
    return this.index(this.budget())
  }

  async upsert(kind: string, slug: string, text: string, sha?: string): Promise<void> {
    await this.live.upsert(kind, slug, text, sha)
  }

  async remove(kind: string, slug: string): Promise<void> {
    await this.live.remove(kind, slug)
  }

  async search(query: string, limit: number): Promise<Array<{ kind: string; slug: string; score: number }>> {
    return this.live.search(query, limit)
  }

  /**
   * The nightly pass over the vault: archive stale skills, then let the model curate memories,
   * profile and notes.
   *
   * It lives here rather than in a conversation because it is about the vault, and a conversation
   * is the wrong thing to attach it to once there are several — ten threads would have bought ten
   * nightly runs over one vault. `agent` is absent from its `ToolContext` deliberately: nothing
   * here schedules, the cron does.
   *
   * One behaviour deliberately dropped in the move: a `/model` override set in some chat no longer
   * steers this. An override is a choice about one conversation, and a global nightly job should
   * not inherit whichever thread last set one.
   */
  async reflect(): Promise<void> {
    const log = createLog('reflection', { content: contentEnabled(this.env) })
    const budget = this.budget()
    try {
      const store = createMemoryStore(this.env)
      const archived = await archiveStaleSkills(store, new Date().toISOString().slice(0, 10))
      const startedAt = Date.now()
      const { activity, complete } = await this.activitySinceLastRun(store, log)
      const labels = citationLabels(activity)
      // Counted, because the gate's own failure mode is silent: a model that never manages a valid
      // citation stops curating memory altogether, and the only trace is a tool result in a log
      // with three days of retention.
      let refused = 0
      const cfg = llmConfig(this.env)
      const { changed, report } = await runReflectionLoop(
        createLlmClient(cfg.apiKey, cfg.baseUrl, budget.fetch),
        this.env.REFLECTION_MODEL ?? this.env.LLM_MODEL,
        // The night's own writes are sourced too, and to a name no thread can collide with: a
        // memory promoted here came from a batch over many threads, not from one exchange.
        {
          env: this.env,
          index: this.index(budget),
          budget,
          log,
          source: { thread: REFLECTION_INSTANCE, at: startedAt },
          verifyCitation: async (thread, turn) => {
            const verdict = await this.verifyCitation(thread, turn, labels)
            if (!verdict.ok) {
              refused++
            }
            return verdict
          },
        },
        activity,
        log,
      )
      // Only if every thread answered: turns this run could not read must reach the next one.
      // Not moving it costs a re-read; moving it costs those turns for good.
      if (complete) {
        await this.ctx.storage.put(WATERMARK_KEY, startedAt)
      } else {
        log.event({ at: 'reflection', stage: 'watermark-held', since: startedAt })
      }
      // The run's whole account of itself: nothing is delivered any more, so this line is where a
      // night is read. `report` is model prose about the user's memory, so it goes through the content
      // parameter — the field bag is emitted whatever `LOG_CONTENT` says.
      log.event(
        {
          at: 'reflection',
          changed,
          // `skills`, not `archived`: this counts the deterministic staleness sweep and never a
          // memory, which the model's own `sample` in the same record does — the bare name reads as
          // a contradiction between the two.
          skillsArchived: archived.length,
          citationsRefused: refused,
          subrequests: budget.spent,
        },
        changed ? { sample: report } : undefined,
      )
    } catch (err) {
      log.error({
        at: 'reflection',
        outcome: 'error',
        stopReason: 'error',
        subrequests: budget.spent,
        error: errorFields(err),
      })
      // Rethrown rather than notified from here: the usual cause of a failure this late is an
      // exhausted budget, and the invocation that ran out is the one that cannot send. The cron
      // is a separate invocation with a whole budget of its own, so it does the telling.
      throw err
    }
  }

  /** The registry is what makes "deleted" answerable: a deleted thread's instance answers as an
   *  empty one, so without it "never existed" and "destroyed with its thread" look alike. */
  async verifyCitation(thread: string, turn: string, labels: Map<string, string>): Promise<CitationVerdict> {
    const known = (await createMemoryStore(this.env).listThreads()).some((t) => t.id === thread)
    if (!known) {
      return { ok: false, why: 'thread-gone' }
    }
    // A label if this run showed one, the raw id otherwise: a model that copies the UUID out of a
    // memory's own provenance is citing correctly and must not be refused for the spelling.
    const stub = await getAgentByName<Env, PersonalAgent>(this.env.PERSONAL_AGENT, webAgentName(WEB_IDENTITY, thread))
    return stub.verifyCitation(labels.get(`${thread}#${turn}`) ?? turn)
  }

  /** One thread at a time: a Durable Object namespace cannot be enumerated, which is what the
   *  registry is for, and these calls spend from the internal thousand, not the external fifty. */
  private async activitySinceLastRun(
    store: MemoryStore,
    log: TurnLog,
  ): Promise<{ activity: ThreadActivity[]; complete: boolean }> {
    const since = (await this.ctx.storage.get<number>(WATERMARK_KEY)) ?? 0
    const threads = await store.listThreads()
    const activity: ThreadActivity[] = []
    let complete = true
    for (const t of threads) {
      const name = webAgentName(WEB_IDENTITY, t.id)
      try {
        const stub = await getAgentByName<Env, PersonalAgent>(this.env.PERSONAL_AGENT, name)
        activity.push({ id: t.id, title: t.title || t.id, messages: await stub.recentActivity(since) })
      } catch (err) {
        // The others still get reflected on; only the watermark pays, see `complete` above.
        complete = false
        log.error({ at: 'reflection', stage: 'thread-unreadable', thread: t.id, error: errorFields(err) })
      }
    }
    log.event({
      at: 'reflection',
      stage: 'activity',
      since,
      threads: threads.length,
      complete,
      messages: activity.reduce((n, a) => n + a.messages.length, 0),
    })
    return { activity, complete }
  }

  /** Reconciles against the vault. Returns the report so the caller can decide about chaining
   *  rather than this instance owning a schedule the caller cannot see. */
  async reconcile(): Promise<ReindexReport & { subrequests: number }> {
    const log = createLog('reindex', { content: false })
    const budget = this.budget()
    try {
      const index = this.index(budget)
      const report = await reindexInto(index, createMemoryStore(this.env), (cost) =>
        budget.canAfford(REINDEX_RESERVE + cost),
      )
      log.event({ at: 'reindex', ...report, rows: await index.count(), subrequests: budget.spent })
      return { ...report, subrequests: budget.spent }
    } catch (err) {
      log.error({
        at: 'reindex',
        outcome: 'error',
        stopReason: 'error',
        subrequests: budget.spent,
        error: errorFields(err),
      })
      throw err
    }
  }
}
