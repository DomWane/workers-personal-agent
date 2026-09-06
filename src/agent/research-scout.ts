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

export interface ScoutInput {
  topic: string
  angle: string
  model: string
  turnId: string | null
  alreadyTried: string[]
  contextTokens?: number
  parent?: string
  runId?: string
}

function stateForAngle(input: ScoutInput): ResearchState {
  return {
    phase: 'running',
    topic: input.topic,
    plan: [input.angle],
    runId: '',
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
      return { ...emptyOutcome(input.angle, String(err)), spent: budget.spent }
    }
  }
}
