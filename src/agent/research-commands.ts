/**
 * A research run as the agent drives it: the commands behind the card's buttons, the round alarm
 * and the finish. The other `research-*` files are pure; this is the part that needs the Durable
 * Object, and takes it as its first argument. Why not methods on the class: see `PersonalAgent`.
 */
import { errorFields, type TurnLog } from './log'
import { createMemoryStore } from './memory/vault-store'
import type { PersonalAgent } from './personal-agent'
import { concatFindings, formatResearchOffer, formatResearchProposal, ungroundedCitations } from './research-round'
import {
  planResearch,
  runResearchRound as runRound,
  runScoutWave,
  writeResearchReport,
  type PlanRevision,
  type ScoutOutcome,
} from './research-runner'
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
  // Aliased: the commands below carry the same names, and `proposeResearch(...)` inside
  // `proposeResearch()` reads as recursion to anyone who does not know it resolves to the import.
  proposeResearch as newProposal,
  replan,
  shouldContinue,
  startResearch as runFromProposal,
  RESEARCH_PRESETS,
  RESEARCH_SCOUT_BUDGET,
} from './research-state'
import { retryOnce } from './retry'
import type { SubrequestBudget } from './subrequest-budget'
import type { ResearchPreset, ResearchState, ScoutCounts, StopCause } from '../types'

/**
 * Proposing and starting are deliberately separate: a run costs hundreds of requests and several
 * minutes, so it is not something one click should be able to launch. This only writes a plan.
 */
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
  // A run is a conversation too: a thread opened straight into research had no message to
  // register it by, and never reached the sidebar.
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

/**
 * A proposal is written, then described. Losing the description is a nuisance; losing the
 * proposal with it is the bug this exists for — an escaping rejection rolls the Durable Object's
 * writes back, and Start twelve seconds later found nothing to run. Observed in
 * production against an invalid token, back when describing meant sending.
 */
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
  // The argument arrives over RPC untyped. An unknown name would make `presetOf` read
  // `undefined.deadlineMs` in every round; `hasOwn` rather than `in`, or `toString` passes.
  const started = { ...run, preset: Object.hasOwn(RESEARCH_PRESETS, preset) ? preset : 'normal' }
  await agent.scheduleChain('runResearchRound', 0)
  agent.newLog('web').event({ at: 'research', stage: 'started', topic: started.topic, preset: started.preset })
  agent.setState({ ...agent.state, research: started })
}

export async function stopResearch(agent: PersonalAgent): Promise<void> {
  // Read before the clear: the reply is the only signal the user gets that the stop landed on
  // something, and after setState there is nothing left to read.
  const was = agent.state.research
  await agent.cancelChain('runResearchRound')
  // Clear the state too: a surviving run would be resumed by the next round as if nothing
  // had been cancelled.
  agent.setState({ ...agent.state, research: undefined })
  agent.newLog('web').event({ at: 'research', stage: 'stopped', phase: was?.phase })
  await agent.emit(was ? 'Research stopped.' : 'Research stopped (nothing was running).')
}

/** Files the report in the vault and ends the run. There is no "post it to the thread" twin: the
 *  report is in broadcast state from the moment it is written, so the client already has it. */
export async function saveResearch(agent: PersonalAgent): Promise<void> {
  const log = agent.newLog('web')
  const done = agent.state.research
  if (done?.phase !== 'done' || !done.report) {
    return agent.emit('Nothing to save — no finished research is waiting.')
  }
  const slug = await createMemoryStore(agent.env).saveResearch(done.topic, done.report)
  // The card leaves with the state and the reconcile below takes seconds: with no indicator the
  // save read as stuck.
  agent.setState({ ...agent.state, research: undefined, status: 'thinking' })
  const filed = `In memory as research/${slug}.md`
  const startedAt = Date.now()
  try {
    // The file is new and the nightly sweep is hours away, so one reconcile runs now. It is an
    // RPC, so the embeddings are charged to the index instance's own invocation, not to this turn.
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

/**
 * Undefined means the user has already been told why there is no plan. This is the only outbound
 * call on the command path and a command is not a turn, so an unhandled rejection here would
 * reach ctx.waitUntil and the user would hear nothing at all.
 */
async function planWithModel(
  agent: PersonalAgent,
  topic: string,
  log: TurnLog,
  revision?: PlanRevision,
): Promise<string[] | undefined> {
  const budget = agent.budget()
  // Proposing and revising are model calls of several seconds behind a button, and only messages
  // used to raise the indicator — so a click looked like nothing had happened.
  agent.setState({ ...agent.state, status: 'thinking' })
  try {
    const client = agent.llm(budget)
    const plan = await planResearch(topic, { client, model: agent.model, budget, log }, revision)
    log.event({ at: 'research', stage: 'planned', planLines: plan.length, subrequests: budget.spent })
    return plan
  } catch (err) {
    log.error({ at: 'research', stage: 'plan-failed', subrequests: budget.spent, error: errorFields(err) })
    // The reason travels with the notice: "try again" alone sent a user retrying a model id the
    // provider had just refused, with the 400 visible only in the Worker's log.
    await agent.emit(`⚠️ Could not plan that research: ${errorFields(err).message.split('\n')[0]}`)
    return undefined
  } finally {
    // Not unconditionally: a message sent while this was working owns the indicator now.
    await agent.clearStatusIfIdle()
  }
}

/**
 * `/model` wins here, unlike REFLECTION_MODEL, which overrides it. The nightly reflection is a
 * background job that should stay cheap whatever the chat is doing; a scout is part of the work
 * `/model` is being used to try out, and a run whose scouts quietly kept the old model would make
 * that experiment half-invalid.
 */
function scoutModel(agent: PersonalAgent): string {
  return agent.state.modelOverride ?? agent.env.SCOUT_MODEL ?? agent.env.LLM_MODEL
}

/**
 * Named per run, round and angle, so two runs never share an instance and a retried wave
 * addresses the same one rather than accumulating instances.
 */
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

/**
 * A scout's running count, called over RPC while the wave is in flight. Keyed by run id so a
 * scout from a run the user has since stopped, or a wave that already landed, changes nothing.
 */
export function scoutProgress(agent: PersonalAgent, runId: string, angle: string, counts: ScoutCounts): void {
  const research = agent.state.research
  if (!research || research.runId !== runId || !research.scouts) {
    return
  }
  const scouts = research.scouts.map((s) => (s.angle === angle ? { ...s, ...counts } : s))
  agent.setState({ ...agent.state, research: { ...research, scouts } })
}

/** A round's whole result becomes durable in this one write, and a `SqlError: internal error`
 *  out of it discarded a four-scout wave on 2026-08-10. Hence the retry. */
async function saveResearchState(agent: PersonalAgent, next: ResearchState | undefined, log: TurnLog): Promise<void> {
  await retryOnce(
    () => agent.setState({ ...agent.state, research: next }),
    (err) => log.error({ at: 'research', stage: 'state-write-retry', error: errorFields(err) }),
  )
}

function logAbandoned(state: ResearchState, budget: SubrequestBudget, log: TurnLog): void {
  log.event({ at: 'research', stage: 'abandoned', round: state.round, subrequests: budget.spent })
}

/**
 * Alarm callback: one round of a research run. Each round is its own invocation with its own
 * fifty requests, which is the whole reason the run is a chain rather than a long turn.
 */
export async function runResearchRound(agent: PersonalAgent): Promise<void> {
  const state = agent.state.research
  if (!state || state.phase !== 'running') {
    return
  }

  const log = agent.newLog('research')
  // Checked on the way in as well as on the way out: a round the platform killed is retried from
  // the state it left behind, and that retry has to meet a cap rather than the model.
  const gate = shouldContinue(state)
  if (!gate.go) {
    return finishResearch(agent, state, gate.reason, log)
  }

  // Pessimistic, then corrected from the actuals below. See chargeRound. The wave's rows go in
  // the same write: a wave's two minutes once showed the card nothing but zeros, which reads as
  // a hang; `scoutProgress` fills them in as the scouts work and `applyWave` clears them.
  const angles = waveAngles(state)
  const scouts = angles?.map((angle) => ({ angle, reads: 0, searches: 0 }))
  agent.setState({ ...agent.state, research: { ...chargeRound(state), scouts } })

  const budget = agent.budget()
  const roundStarted = Date.now()
  try {
    // Loud, because the run silently narrowing to sequential rounds looks the same from outside
    // as a plan that never had angles to split.
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
      // The state may have moved on while the round was working — a stop, or a new proposal. The
      // write-back below would put the cancelled run back on its feet and reschedule it.
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
        // A scout that opened nothing and still wrote findings reported from the model's memory,
        // not from the web. Observed on two of four scouts the first time this ran.
        unread: outcomes.filter((o) => o.readUrls.length === 0 && o.findings).length,
        reads: outcomes.reduce((n, o) => n + o.readUrls.length, 0),
        // Pages paid for that produced nothing. `unread` misses this — it counts a scout that
        // opened *nothing*, so a wave losing 14 of 30 to a rate limit still read as healthy.
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
    // Everything the round did becomes durable here and nowhere else, so this write is the one
    // that must not be lost to a transient failure.
    await saveResearchState(agent, next, log)

    // A source the run never opened, cited as though it had been. Loud rather than removed: what
    // to do about one is a judgement, and a run that quietly dropped citations would read as
    // clean while losing real ones to a formatting slip.
    // Grounded by what the round saw, not only by what it opened: a claim cited from a search
    // snippet is honest sourcing, and counting it as invented cried wolf seventeen times in one
    // round the first time this ran.
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
    // The run is abandoned rather than retried: a round that threw has already spent, and a
    // chain that retries a failing round burns the budget without making progress. Clearing is
    // conditional for the same reason the success path's write-back is: whatever replaced this
    // run while it was failing is not ours to delete.
    //
    // Its own try/catch: when the round failed on a state write, this clear was the next write
    // and failed too, and the escaping rejection is what got the alarm retried.
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

/** The one place a run ends: write the report, clear the state, then post from a fresh invocation. */
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
      // Every finding still goes out, unwritten. A run that gathered material must not end with
      // nothing to show because the last call of twelve failed.
      log.error({ at: 'research', stage: 'report-failed', error: errorFields(err) })
    }
  }
  // The report call is the longest wait in a run, and Stop sits under the card the whole time:
  // writing `done` over a cleared state would put the stopped run back with a report attached.
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
  // The offer only: the report itself is already in broadcast state.
  await agent.emit(formatResearchOffer(done))
}
