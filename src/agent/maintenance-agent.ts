import { DurableObject } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { createLlmClient } from '@/connectors/llm.connector'
import { embedText } from '@/connectors/embeddings.connector'
import { llmConfig } from '@/agent/llm-config'
import { archiveStaleSkills, citationLabels, runReflectionLoop, type ThreadActivity } from '@/agent/reflection'
import { WEB_IDENTITY, webAgentName } from '@/agent/agent-name'
import type { PersonalAgent } from '@/agent/personal-agent'
import type { MemoryStore } from '@/agent/memory/memory-store'
import type { CitationVerdict } from '@/agent/provenance'
import type { Env } from '@/types'
import { contentEnabled, createLog, errorFields, type TurnLog } from '@/agent/log'
import { sqlTag } from '@/agent/archive'
import { EmbeddingIndex, type MemoryIndex, type ReindexReport, reindexInto } from '@/agent/memory/embedding-index'
import { createMemoryStore } from '@/agent/memory/vault-store'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from '@/agent/subrequest-budget'
import { cachedSubrequestLimit } from '@/agent/workers-plan'

export const INDEX_INSTANCE = 'index'
export const REFLECTION_INSTANCE = 'reflection'

const REINDEX_RESERVE = 4

const WATERMARK_KEY = 'reflection-watermark'

const NOOP_INDEX: MemoryIndex = {
  upsert: async () => {},
  remove: async () => {},
  search: async () => [],
  count: async () => 0,
  fingerprints: async () => new Map(),
}

export class MaintenanceAgent extends DurableObject<Env> {
  private planLimit = FREE_PLAN_SUBREQUESTS

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
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

  async reflect(): Promise<void> {
    const log = createLog('reflection', { content: contentEnabled(this.env) })
    const budget = this.budget()
    try {
      const store = createMemoryStore(this.env)
      const archived = await archiveStaleSkills(store, new Date().toISOString().slice(0, 10))
      const startedAt = Date.now()
      const { activity, complete } = await this.activitySinceLastRun(store, log)
      const labels = citationLabels(activity)
      let refused = 0
      const cfg = llmConfig(this.env)
      const { changed, report } = await runReflectionLoop(
        createLlmClient(cfg.apiKey, cfg.baseUrl, budget.fetch),
        this.env.REFLECTION_MODEL ?? this.env.LLM_MODEL,
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
      if (complete) {
        await this.ctx.storage.put(WATERMARK_KEY, startedAt)
      } else {
        log.event({ at: 'reflection', stage: 'watermark-held', since: startedAt })
      }
      log.event(
        {
          at: 'reflection',
          changed,
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
      throw err
    }
  }

  async verifyCitation(thread: string, turn: string, labels: Map<string, string>): Promise<CitationVerdict> {
    const known = (await createMemoryStore(this.env).listThreads()).some((t) => t.id === thread)
    if (!known) {
      return { ok: false, why: 'thread-gone' }
    }
    const stub = await getAgentByName<Env, PersonalAgent>(this.env.PERSONAL_AGENT, webAgentName(WEB_IDENTITY, thread))
    return stub.verifyCitation(labels.get(`${thread}#${turn}`) ?? turn)
  }

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
