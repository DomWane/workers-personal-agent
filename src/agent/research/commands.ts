import { errorFields, type TurnLog } from '../log'
import { createMemoryStore } from '../memory/vault-store'
import type { PersonalAgent } from '../personal-agent'
import { concatFindings, formatResearchOffer, formatResearchProposal, ungroundedCitations } from './round'
import {
  planResearch,
  runResearchRound as runRound,
  runScoutWave,
  writeResearchReport,
  type PlanRevision,
  type ScoutOutcome,
} from './runner'
import {
  applyRound,
  applyWave,
  canPropose,
  chargeRound,
  finishRun,
  isCurrentRun,
  recordRoundDuration,
  waveAngles,
  RESEARCH_ROUND_GAP_SECONDS,
  proposeResearch as newProposal,
  replan,
  shouldContinue,
  startResearch as runFromProposal,
  RESEARCH_PRESETS,
  RESEARCH_SCOUT_BUDGET,
} from './state'
import { retryOnce } from '../retry'
import type { SubrequestBudget } from '../subrequest-budget'
import type { ResearchPreset, ResearchState, ScoutCounts, StopCause } from '../../types'

export async function proposeResearch(agent: PersonalAgent, topic: string): Promise<void> {
  const clean = topic.trim()
  if (!clean) {
    return agent.emit('Give me a topic to research.')
  }
  if (!canPropose(agent.state.research)) {
    return agent.emit(
      agent.state.research?.phase === 'done'
        ? `A finished report on "${agent.state.research.topic}" is waiting. Save it or drop it first.`
        : `Already researching "${agent.state.research?.topic}". Stop that run first.`,
    )
  }
  const log = agent.newLog('web')
  await agent.registerThread(clean, log)
  const plan = await planWithModel(agent, clean, log)
  if (!plan) {
    return
  }

  const proposal = newProposal(clean, plan)
  agent.setState({ ...agent.state, research: proposal })
  log.event({ at: 'research', stage: 'proposed', planLines: plan.length, fansOut: plan.length >= 2 })
  await announce(agent, formatResearchProposal(proposal), log)
}

export async function revisePlan(agent: PersonalAgent, note: string): Promise<void> {
  const clean = note.trim()
  if (!clean) {
    return agent.emit('Say what to change about the plan.')
  }
  const current = agent.state.research
  if (current?.phase !== 'proposed') {
    return agent.emit(current ? 'The run is already going — stop it first.' : 'Nothing proposed yet.')
  }
  const log = agent.newLog('web')
  const revised = await planWithModel(agent, current.topic, log, { plan: current.plan, note: clean })
  if (!revised) {
    return
  }
  const next = replan(current, revised)
  if (!next) {
    return
  }
  agent.setState({ ...agent.state, research: next })
  log.event({ at: 'research', stage: 'replanned', planLines: next.plan.length, fansOut: next.plan.length >= 2 })
  await announce(agent, formatResearchProposal(next), log)
}

async function announce(agent: PersonalAgent, text: string, log: TurnLog): Promise<void> {
  try {
    await agent.emit(text)
  } catch (err) {
    log.error({ at: 'research', stage: 'announce-failed', error: errorFields(err) })
  }
}

export async function startResearch(agent: PersonalAgent, preset: ResearchPreset): Promise<void> {
  const run = runFromProposal(agent.state.research, crypto.randomUUID())
  if (!run) {
    return agent.emit(agent.state.research ? 'A run is already going.' : 'Nothing to start — propose a topic first.')
  }
  // `hasOwn`, not `in`: `toString` would pass.
  const started = { ...run, preset: Object.hasOwn(RESEARCH_PRESETS, preset) ? preset : 'normal' }
  await agent.scheduleChain('runResearchRound', 0)
  agent.newLog('web').event({ at: 'research', stage: 'started', topic: started.topic, preset: started.preset })
  agent.setState({ ...agent.state, research: started })
}

export async function stopResearch(agent: PersonalAgent): Promise<void> {
  const was = agent.state.research
  await agent.cancelChain('runResearchRound')
  agent.setState({ ...agent.state, research: undefined })
  agent.newLog('web').event({ at: 'research', stage: 'stopped', phase: was?.phase })
  await agent.emit(was ? 'Research stopped.' : 'Research stopped (nothing was running).')
}

export async function saveResearch(agent: PersonalAgent): Promise<void> {
  const log = agent.newLog('web')
  const done = agent.state.research
  if (done?.phase !== 'done' || !done.report) {
    return agent.emit('Nothing to save — no finished research is waiting.')
  }
  const slug = await createMemoryStore(agent.env).saveResearch(done.topic, done.report)
  agent.setState({ ...agent.state, research: undefined, status: 'thinking' })
  const filed = `In memory as research/${slug}.md`
  const startedAt = Date.now()
  try {
    const { indexed, remaining } = await agent.maintenance().reconcile()
    log.event({
      at: 'research',
      stage: 'delivered',
      slug,
      chars: done.report.length,
      indexed,
      remaining,
      reindexMs: Date.now() - startedAt,
    })
    await agent.emit(
      remaining > 0
        ? `${filed} — indexed; the index has more to catch up on, the nightly reindex finishes it.`
        : `${filed} — indexed, search_memory can find it now.`,
    )
  } catch (err) {
    log.error({ at: 'research', stage: 'reindex-failed', slug, error: errorFields(err) })
    await agent.emit(`${filed} — indexing failed, the nightly reindex will pick it up.`)
  } finally {
    await agent.clearStatusIfIdle()
  }
}

async function planWithModel(
  agent: PersonalAgent,
  topic: string,
  log: TurnLog,
  revision?: PlanRevision,
): Promise<string[] | undefined> {
  const budget = agent.budget()
  agent.setState({ ...agent.state, status: 'thinking' })
  try {
    const client = agent.llm(budget)
    const plan = await planResearch(topic, { client, model: agent.model, budget, log }, revision)
    log.event({ at: 'research', stage: 'planned', planLines: plan.length, subrequests: budget.spent })
    return plan
  } catch (err) {
    log.error({ at: 'research', stage: 'plan-failed', subrequests: budget.spent, error: errorFields(err) })
    await agent.emit(`⚠️ Could not plan that research: ${errorFields(err).message.split('\n')[0]}`)
    return undefined
  } finally {
    await agent.clearStatusIfIdle()
  }
}

function scoutModel(agent: PersonalAgent): string {
  return agent.state.modelOverride ?? agent.env.SCOUT_MODEL ?? agent.env.LLM_MODEL
}

function scoutCaller(agent: PersonalAgent, state: ResearchState, log: TurnLog) {
  const model = scoutModel(agent)
  return (angle: string, index: number): Promise<ScoutOutcome> => {
    const id = agent.env.RESEARCH_SCOUT.idFromName(`${state.runId}:${state.round}:${index}`)
    return agent.env.RESEARCH_SCOUT.get(id).scout({
      topic: state.topic,
      angle,
      model,
      turnId: log.turnId,
      alreadyTried: state.visited,
      contextTokens: agent.windowFor(model),
      parent: agent.name,
      runId: state.runId,
    })
  }
}

export function scoutProgress(agent: PersonalAgent, runId: string, angle: string, counts: ScoutCounts): void {
  const research = agent.state.research
  if (!research || research.runId !== runId || !research.scouts) {
    return
  }
  const scouts = research.scouts.map((s) => (s.angle === angle ? { ...s, ...counts } : s))
  agent.setState({ ...agent.state, research: { ...research, scouts } })
}

async function saveResearchState(agent: PersonalAgent, next: ResearchState | undefined, log: TurnLog): Promise<void> {
  await retryOnce(
    () => agent.setState({ ...agent.state, research: next }),
    (err) => log.error({ at: 'research', stage: 'state-write-retry', error: errorFields(err) }),
  )
}

function logAbandoned(state: ResearchState, budget: SubrequestBudget, log: TurnLog): void {
  log.event({ at: 'research', stage: 'abandoned', round: state.round, subrequests: budget.spent })
}

export async function runResearchRound(agent: PersonalAgent): Promise<void> {
  const state = agent.state.research
  if (!state || state.phase !== 'running') {
    return
  }

  const log = agent.newLog('research')
  const gate = shouldContinue(state)
  if (!gate.go) {
    return finishResearch(agent, state, gate.reason, log)
  }

  const angles = waveAngles(state)
  const scouts = angles?.map((angle) => ({ angle, reads: 0, searches: 0 }))
  agent.setState({ ...agent.state, research: { ...chargeRound(state), scouts } })

  const budget = agent.budget()
  const roundStarted = Date.now()
  try {
    if (!angles && (state.scoutSpent ?? 0) >= RESEARCH_SCOUT_BUDGET) {
      log.event({
        at: 'research',
        stage: 'scout-budget-spent',
        scoutSpent: state.scoutSpent,
        cap: RESEARCH_SCOUT_BUDGET,
      })
    }
    let seenUrls: string[]
    let next: ResearchState
    if (angles) {
      const outcomes = await runScoutWave(angles, scoutCaller(agent, state, log), log)
      if (!isCurrentRun(agent.state.research, state)) {
        return logAbandoned(state, budget, log)
      }
      next = applyWave(state, outcomes, budget.spent)
      seenUrls = outcomes.flatMap((o) => o.seenUrls ?? [])
      log.event({
        at: 'research',
        stage: 'wave',
        angles: angles.length,
        failed: outcomes.filter((o) => o.error).length,
        unread: outcomes.filter((o) => o.readUrls.length === 0 && o.findings).length,
        reads: outcomes.reduce((n, o) => n + o.readUrls.length, 0),
        lost: outcomes.reduce((n, o) => n + (o.urls.length - o.readUrls.length), 0),
        scoutSpent: next.scoutSpent,
        tokens: outcomes.reduce((n, o) => n + (o.tokens ?? 0), 0),
      })
    } else {
      const result = await runRound(state, {
        client: agent.llm(budget),
        model: agent.model,
        ctx: agent.toolContext(budget, log),
        budget,
        log,
      })
      if (!isCurrentRun(agent.state.research, state)) {
        return logAbandoned(state, budget, log)
      }
      next = applyRound(state, result)
      seenUrls = result.seenUrls ?? []
    }
    next = recordRoundDuration(next, Date.now() - roundStarted)
    await saveResearchState(agent, next, log)

    const ungrounded = ungroundedCitations(next.findings.slice(state.findings.length).join('\n'), [
      ...next.visited,
      ...seenUrls,
    ])
    if (ungrounded.length) {
      log.event(
        { at: 'research', stage: 'ungrounded-citations', round: next.round, count: ungrounded.length },
        { sample: ungrounded.slice(0, 5).join(' ') },
      )
    }

    const verdict = shouldContinue(next)
    log.event({
      at: 'research',
      round: next.round,
      spent: next.spent,
      subrequests: budget.spent,
      visited: next.visited.length,
      findingsChars: next.findings.join('').length,
      rounds: next.findings.length,
      openQuestions: next.openQuestions.length,
      stopCause: verdict.go ? undefined : verdict.reason,
    })

    if (verdict.go) {
      await agent.scheduleChain('runResearchRound', RESEARCH_ROUND_GAP_SECONDS)
      return
    }
    await finishResearch(agent, next, verdict.reason, log)
  } catch (err) {
    log.error({ at: 'research', outcome: 'error', subrequests: budget.spent, error: errorFields(err) })
    try {
      if (isCurrentRun(agent.state.research, state)) {
        await saveResearchState(agent, undefined, log)
      }
    } catch (clearErr) {
      log.error({ at: 'research', stage: 'clear-failed', error: errorFields(clearErr) })
    }
    await agent.emit('⚠️ Research failed. Check logs.')
  }
}

async function finishResearch(
  agent: PersonalAgent,
  state: ResearchState,
  reason: StopCause,
  log: TurnLog,
): Promise<void> {
  const budget = agent.budget()
  let report = concatFindings(state)
  let reportTokens = 0
  if (state.findings.length) {
    try {
      agent.setState({ ...agent.state, research: { ...state, writing: true } })
      const client = agent.llm(budget)
      const written = await writeResearchReport(state, { client, model: agent.model, budget, log })
      report = written.text
      reportTokens = written.tokens
    } catch (err) {
      log.error({ at: 'research', stage: 'report-failed', error: errorFields(err) })
    }
  }
  if (!isCurrentRun(agent.state.research, state)) {
    return logAbandoned(state, budget, log)
  }
  const done = finishRun(state, reason, report, reportTokens)
  agent.setState({ ...agent.state, research: done })
  log.event({
    at: 'research',
    stage: 'finished',
    round: done.round,
    spent: done.spent,
    stopCause: reason,
    reportChars: report.length,
    tokens: done.tokens,
  })
  await agent.emit(formatResearchOffer(done))
}
