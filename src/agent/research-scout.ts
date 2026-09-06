import { DurableObject } from 'cloudflare:workers'
import type OpenAI from 'openai'
import { sqlTag, toolArchiveOver } from './archive'
import { resultCap } from './context-window'
import { PRUNE_OVER_CHARS } from './tool-loop'
import { MAX_PAGE_CHARS } from './tools/browser.tools'
import { createLlmClient } from '../connectors/llm.connector'
import { llmConfig } from './llm-config'
import type { Env, ResearchState, ScoutCounts } from '../types'
import { contentEnabled, createLog, errorFields, type TurnLog } from './log'
import { buildScoutPrompt } from './research-round'
import { emptyOutcome, runResearchRound, type ScoutOutcome } from './research-runner'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from './subrequest-budget'
import { cachedSubrequestLimit } from './workers-plan'

/**
 * One angle of a research plan, covered in a Durable Object of its own.
 *
 * The point is the invocation, not the class: a child DO's subrequests are charged to the child, so
 * five scouts have five budgets of fifty rather than a fifth of one (measured 2026-08-08, CPU the
 * day after). The parent that awaits them spends neither — one internal call each, out of a
 * separate allowance of a thousand.
 */
export interface ScoutInput {
  topic: string
  angle: string
  model: string
  /** The parent's turn id, so the wave's records read as one turn across six invocations. */
  turnId: string | null
  /** URLs the run has already paid for, so a scout cannot re-buy them. */
  alreadyTried: string[]
  /**
   * Resolved by the parent because a scout cannot: asking the catalogue costs one of its own fifty
   * subrequests, and five scouts would ask five times for one answer. It binds harder here than in
   * a chat turn — a scout has no overflow retry, so a request over the window loses the angle.
   */
  contextTokens?: number
  /** Who to tell about progress, and which run it belongs to. Absent, the scout works silently. */
  parent?: string
  runId?: string
}

/** The scout reuses the round machinery whole — only the prompt differs — so the parse, the
 *  write-up retry and the page accounting stay in one place. */
function stateForAngle(input: ScoutInput): ResearchState {
  return {
    phase: 'running',
    topic: input.topic,
    plan: [input.angle],
    runId: '',
    // Bounded by its own timeout, not the run's deadline: the parent already refused to start this
    // wave unless a whole round still fit.
    startedAt: 0,
    findings: [],
    openQuestions: [],
    visited: input.alreadyTried,
    read: 0,
    spent: 0,
    round: 0,
    foundNewUrls: true,
    modelDone: false,
  }
}

export class ResearchScout extends DurableObject<Env> {
  /** A scout is short-lived and named per run, so this is asked once per instance and never reused
   *  — the hour of cache in `workers-plan.ts` is what keeps a wave from asking five times. */
  private planLimit = FREE_PLAN_SUBREQUESTS
  private progressFailed = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.planLimit = await cachedSubrequestLimit(ctx.storage, env, createLog('research'))
    })
  }

  private budget(): SubrequestBudget {
    return new SubrequestBudget(this.planLimit)
  }

  /** Not awaited: an internal call, out of the thousand rather than the fifty, and a report that
   *  fails must cost the angle nothing, so the first failure is logged and the rest are dropped. */
  private tellParent(input: ScoutInput, counts: ScoutCounts, log: TurnLog): void {
    if (!input.parent || !input.runId) {
      return
    }
    const parent = this.env.PERSONAL_AGENT.get(this.env.PERSONAL_AGENT.idFromName(input.parent))
    void parent.scoutProgress(input.runId, input.angle, counts).catch((err: unknown) => {
      if (!this.progressFailed) {
        this.progressFailed = true
        log.error({ at: 'research', stage: 'progress-failed', angle: input.angle, error: errorFields(err) })
      }
    })
  }

  private llm(budget: SubrequestBudget): OpenAI {
    const cfg = llmConfig(this.env)
    return createLlmClient(cfg.apiKey, cfg.baseUrl, budget.fetch)
  }

  async scout(input: ScoutInput): Promise<ScoutOutcome> {
    const log = createLog('research', { turnId: input.turnId, content: contentEnabled(this.env) })
    const budget = this.budget()
    // Below ~27,300 tokens the two caps cancel — `resultCap` puts every result under the pruner's
    // threshold — so results accumulate until the request overflows. Said, not fixed: a pruner that
    // is silently inert reads as one that had nothing to do.
    if (input.contextTokens && resultCap(MAX_PAGE_CHARS, input.contextTokens) <= PRUNE_OVER_CHARS) {
      log.event({ at: 'research', stage: 'prune-inert', model: input.model, window: input.contextTokens })
    }
    try {
      const client = this.llm(budget)
      const result = await runResearchRound(stateForAngle(input), {
        client,
        model: input.model,
        ctx: {
          env: this.env,
          budget,
          log,
          contextTokens: input.contextTokens,
          // In the scout's own SQLite, which **dies with the run** and is meant to: it exists so a
          // page the loop cut stays readable within the angle, and reporting reads findings rather
          // than the archive, so nothing needs to outlive it.
          toolArchive: toolArchiveOver(sqlTag(this.ctx.storage.sql)),
        },
        budget,
        log,
        prompt: buildScoutPrompt(input.topic, input.angle, input.alreadyTried),
        onProgress: (progress) => this.tellParent(input, progress, log),
      })
      log.event({
        at: 'research',
        stage: 'scout-done',
        angle: input.angle,
        reads: result.readUrls.length,
        urls: result.urls.length,
        findingsChars: result.findings.length,
        subrequests: budget.spent,
      })
      return { ...result, angle: input.angle }
    } catch (err) {
      log.error({
        at: 'research',
        stage: 'scout-failed',
        angle: input.angle,
        subrequests: budget.spent,
        error: errorFields(err),
      })
      // Returned rather than thrown: the wave reads a rejection and an error outcome the same way,
      // but the spend so far only survives on this path.
      return { ...emptyOutcome(input.angle, String(err)), spent: budget.spent }
    }
  }
}
