import { describe, expect, it } from 'vitest'
import {
  RESEARCH_MAX_ROUNDS,
  RESEARCH_DEADLINE_MS,
  ROUND_WORST_CASE_MS,
  RESEARCH_SCOUT_BUDGET,
  MIN_ROUND_HEADROOM_MS,
  recordRoundDuration,
  roundHeadroomMs,
  RESEARCH_ROUND_GAP_SECONDS,
  SCOUT_TIMEOUT_MS,
  RESEARCH_SUBREQUEST_BUDGET,
  ROUND_WORST_CASE,
  applyRound,
  applyWave,
  canPropose,
  chargeRound,
  finishRun,
  isCurrentRun,
  waveAngles,
  proposeResearch,
  replan,
  shouldContinue,
  startResearch,
  type ResearchState,
  type RoundResult,
} from '../../src/agent/research-state'

const RUN = 'run-1'
/** Measured over three real runs: 28, 31 and 32 subrequests for a round that used all six loop rounds. */
const OBSERVED_ROUND_SPEND = 32
const proposed = (): ResearchState => proposeResearch('trends in agent evals', ['who publishes', 'what they measure'])

describe('proposeResearch', () => {
  it('records the topic and the plan without starting anything', () => {
    const state = proposed()
    expect(state).toMatchObject({ phase: 'proposed', topic: 'trends in agent evals', spent: 0, round: 0 })
    expect(state.plan).toEqual(['who publishes', 'what they measure'])
    expect(state.visited).toEqual([])
  })

  it('refuses an empty topic rather than researching nothing', () => {
    expect(() => proposeResearch('   ', [])).toThrow(/topic/i)
  })
})

describe('canPropose', () => {
  it('allows a proposal when nothing is going on, and when one is only proposed', () => {
    expect(canPropose(undefined)).toBe(true)
    expect(canPropose(proposed())).toBe(true)
  })

  it('refuses while a run is in flight', () => {
    // Replacing the state would leave the scheduled round looking at a proposal, so it returns
    // without a word: the run dies, the notes go, and nobody is told.
    expect(canPropose(startResearch(proposed(), RUN))).toBe(false)
  })
})

describe('replan', () => {
  it('swaps the plan and keeps everything else about the proposal', () => {
    const after = replan(proposed(), ['token cost per trajectory'])
    expect(after?.plan).toEqual(['token cost per trajectory'])
    expect(after?.topic).toBe('trends in agent evals')
    expect(after?.phase).toBe('proposed')
  })

  it('refuses once the run is going, because rounds already worked from the old plan', () => {
    expect(replan(startResearch(proposed(), RUN) as ResearchState, ['x'])).toBeUndefined()
  })

  it('refuses when there is nothing proposed', () => {
    expect(replan(undefined, ['x'])).toBeUndefined()
  })

  it('keeps the old plan rather than accepting an empty one', () => {
    // A model call that came back unusable must not silently leave the gate with nothing in it.
    expect(replan(proposed(), [])?.plan).toEqual(['who publishes', 'what they measure'])
  })
})

describe('finishRun', () => {
  const running = startResearch(proposed(), RUN) as ResearchState

  it('parks the report instead of throwing it away, so the user can pick a format', () => {
    const done = finishRun(running, 'model-done', 'the written report')
    expect(done).toMatchObject({ phase: 'done', report: 'the written report', stopCause: 'model-done' })
  })

  it('refuses a proposal while a finished report is waiting', () => {
    // Ten minutes and a hundred requests of work. Overwriting it with a new topic would lose it
    // with nothing said, which is the failure this codebase keeps finding.
    expect(canPropose(finishRun(running, 'model-done', 'report'))).toBe(false)
  })
})

describe('startResearch', () => {
  it('moves a proposal to running', () => {
    expect(startResearch(proposed(), RUN)?.phase).toBe('running')
  })

  it('stamps the run id the write-back check compares against', () => {
    expect(startResearch(proposed(), RUN)?.runId).toBe(RUN)
  })

  it('will not start from nothing, so /research go alone cannot launch a run', () => {
    expect(startResearch(undefined, RUN)).toBeUndefined()
  })

  it('will not restart a run that is already going', () => {
    const running = startResearch(proposed(), RUN) as ResearchState
    expect(startResearch(running, 'run-2')).toBeUndefined()
  })
})

describe('isCurrentRun', () => {
  const running = startResearch(proposed(), RUN) as ResearchState

  it('recognises the run a round started from', () => {
    expect(isCurrentRun(running, running)).toBe(true)
  })

  it('rejects a state the user stopped, so the round cannot write the run back to life', () => {
    // A round captures the state, works for a minute, then writes its result. A /research stop
    // that arrives in between is undone by that write unless the round checks what it is
    // overwriting.
    expect(isCurrentRun(undefined, running)).toBe(false)
  })

  it('rejects a different run started while the round was in flight', () => {
    expect(isCurrentRun(startResearch(proposed(), 'run-2') as ResearchState, running)).toBe(false)
  })
})

describe('shouldContinue', () => {
  const running = (over: Partial<ResearchState> = {}): ResearchState => ({
    ...(startResearch(proposed(), RUN) as ResearchState),
    ...over,
  })

  it('continues while there is budget, rounds, new ground and no verdict', () => {
    expect(shouldContinue(running({ spent: 10, foundNewUrls: true }))).toEqual({ go: true })
  })

  it('stops with a whole round of headroom left, so the budget is a cap and not an average', () => {
    // A round may spend a full invocation. Gating on the spend already made lets a run that is one
    // request short of the cap start another round and finish well past it.
    // The last round that may start is the one whose worst case lands exactly on the cap.
    const edge = RESEARCH_SUBREQUEST_BUDGET - ROUND_WORST_CASE
    expect(shouldContinue(running({ spent: edge, foundNewUrls: true }))).toEqual({ go: true })
    expect(shouldContinue(running({ spent: edge + 1, foundNewUrls: true }))).toEqual({ go: false, reason: 'budget' })
  })

  it('stops at the round cap', () => {
    const state = running({ spent: 10, foundNewUrls: true, round: RESEARCH_MAX_ROUNDS })
    expect(shouldContinue(state)).toEqual({ go: false, reason: 'max-rounds' })
  })

  it('stops when a round found no URL it had not already seen', () => {
    // The across-rounds twin of the loop's no-progress guard, and free: visited is kept for
    // deduplication anyway.
    expect(shouldContinue(running({ spent: 10, foundNewUrls: false }))).toEqual({ go: false, reason: 'no-new-ground' })
  })

  it('stops when the model says it is done, with no floor left to overrule it', () => {
    // Three real runs out of three used to end after one round and nine pages on this verdict.
    // What answers that now is the wave, which covers every plan angle before the model can hold
    // the opinion at all.
    const state = running({ spent: 10, foundNewUrls: true, modelDone: true, round: 1 })
    expect(shouldContinue(state)).toEqual({ go: false, reason: 'model-done' })
  })

  it('stops on a round that found nothing new before it weighs the verdict', () => {
    // A symptom outranks an opinion: another round over the same pages would pay again for ground
    // already covered.
    expect(shouldContinue(running({ spent: 10, foundNewUrls: false, round: 0 }))).toEqual({
      go: false,
      reason: 'no-new-ground',
    })
  })

  it('can afford every round it promises', () => {
    // The two numbers are set independently and drifted apart once already: a budget that runs out
    // at round 7 makes a cap of 12 decorative, and a floor above that unreachable.
    let state = running({ foundNewUrls: true })
    let rounds = 0
    while (shouldContinue(state).go) {
      rounds++
      state = applyRound(state, {
        findings: 'n',
        openQuestions: [],
        urls: [`https://x/${rounds}`],
        read: 1,
        spent: OBSERVED_ROUND_SPEND,
      })
    }
    expect(rounds).toBeGreaterThanOrEqual(RESEARCH_MAX_ROUNDS)
  })

  it('reports the hard caps in a fixed order when several are true at once', () => {
    // One reason per run, and the one that actually bound it. Otherwise "why did it stop"
    // becomes a judgement call at read time. Cost before count.
    const all = running({
      spent: RESEARCH_SUBREQUEST_BUDGET,
      round: RESEARCH_MAX_ROUNDS,
      foundNewUrls: false,
      modelDone: true,
    })
    expect(shouldContinue(all)).toEqual({ go: false, reason: 'budget' })
    expect(shouldContinue({ ...all, spent: 0 })).toEqual({ go: false, reason: 'max-rounds' })
  })

  it('never continues a run that is not running', () => {
    expect(shouldContinue(proposed())).toEqual({ go: false, reason: 'not-running' })
  })
})

describe('chargeRound', () => {
  const running = startResearch(proposed(), RUN) as ResearchState

  it('charges a whole invocation before the round runs', () => {
    // The platform retries an alarm whose invocation was killed rather than thrown out of — CPU
    // limit, eviction — from whatever state was last written. Charging afterwards means a round
    // that always dies is retried forever, having recorded nothing.
    const charged = chargeRound(running)
    expect(charged.round).toBe(1)
    expect(charged.spent).toBe(ROUND_WORST_CASE)
  })

  it('is undone by applyRound, which charges the actual spend instead', () => {
    const settled = applyRound(running, { findings: 'n', openQuestions: [], urls: [], read: 0, spent: 6 })

    expect(settled.spent).toBe(6)
    expect(settled.round).toBe(1)
    expect(chargeRound(running).spent).toBeGreaterThan(settled.spent)
  })

  it('reaches the budget in a handful of retries, so a round that always dies still stops', () => {
    let state = running
    for (let i = 0; i < 50 && shouldContinue(state).go; i++) {
      state = chargeRound(state)
    }

    expect(shouldContinue(state).go).toBe(false)
  })
})

describe('applyRound', () => {
  const running = startResearch(proposed(), RUN) as ResearchState

  it('appends what each round found rather than rewriting it', () => {
    // A document rewritten every round is recompressed every round. Appending keeps each finding
    // at compression depth one; the report is written from all of them at the end.
    const first = applyRound(running, {
      findings: 'first pass',
      openQuestions: ['a'],
      urls: ['https://x'],
      read: 1,
      spent: 8,
    })
    const second = applyRound(first, {
      findings: 'second pass',
      openQuestions: [],
      urls: ['https://y'],
      read: 1,
      spent: 7,
    })

    expect(second.findings).toEqual(['first pass', 'second pass'])
  })

  it('appends nothing when a round produced nothing usable', () => {
    const after = applyRound(running, { findings: '', openQuestions: [], urls: [], read: 0, spent: 4 })
    expect(after.findings).toEqual([])
  })

  it('accumulates visited urls and spend, which are never summarised', () => {
    const first = applyRound(running, { findings: 'n', openQuestions: [], urls: ['https://x'], read: 1, spent: 8 })
    const second = applyRound(first, {
      findings: 'n',
      openQuestions: [],
      urls: ['https://y', 'https://x'],
      read: 2,
      spent: 7,
    })

    expect(second.visited).toEqual(['https://x', 'https://y'])
    expect(second.spent).toBe(15)
    expect(second.round).toBe(2)
  })

  it('records a page read twice in one round only once', () => {
    // visited is the deduplication key; a repeat inside a round would inflate it and the page
    // count in the report along with it.
    const after = applyRound(running, {
      findings: 'n',
      openQuestions: [],
      urls: ['https://x', 'https://x'],
      read: 2,
      spent: 8,
    })
    expect(after.visited).toEqual(['https://x'])
  })

  it('reports whether the round broke new ground', () => {
    const first = applyRound(running, { findings: 'n', openQuestions: [], urls: ['https://x'], read: 1, spent: 8 })
    const repeat = applyRound(first, { findings: 'n', openQuestions: [], urls: ['https://x'], read: 1, spent: 8 })

    expect(first.foundNewUrls).toBe(true)
    expect(repeat.foundNewUrls).toBe(false)
  })

  it('keeps open questions as a list, not prose', () => {
    const after = applyRound(running, {
      findings: 'n',
      openQuestions: ['what about cost?'],
      urls: [],
      read: 0,
      spent: 1,
    })
    expect(after.openQuestions).toEqual(['what about cost?'])
  })
})

describe('waveAngles', () => {
  const running = (over: Partial<ResearchState> = {}): ResearchState => ({
    ...startResearch(proposed(), RUN)!,
    ...over,
  })
  const questions = (n: number) => Array.from({ length: n }, (_, i) => `q${i}`)

  it('splits the plan on the first round', () => {
    expect(waveAngles(running())).toEqual(['who publishes', 'what they measure'])
  })

  it('splits the open questions on a later round, which is where the depth is', () => {
    expect(waveAngles(running({ round: 1, openQuestions: questions(4) }))).toEqual(['q0', 'q1', 'q2'])
  })

  it('narrows by two a round, after Static-DRA', () => {
    // A run that kept fanning out five ways at every depth would re-read the landscape instead of
    // chasing what it did not settle.
    expect(waveAngles(running({ openQuestions: questions(9), plan: questions(9) }))).toHaveLength(5)
    expect(waveAngles(running({ round: 1, openQuestions: questions(9) }))).toHaveLength(3)
    expect(waveAngles(running({ round: 2, openQuestions: questions(9) }))).toBeUndefined()
  })

  it('takes the ordinary round rather than a wave of one', () => {
    // One scout is the same work through a Durable Object, an RPC and a timeout.
    expect(waveAngles(running({ plan: ['who publishes'] }))).toBeUndefined()
    expect(waveAngles(running({ round: 1, openQuestions: ['q0'] }))).toBeUndefined()
  })

  it('takes the ordinary round when a depth round has nothing open to chase', () => {
    expect(waveAngles(running({ round: 1, openQuestions: [] }))).toBeUndefined()
  })

  it('splits the open questions, not the plan, once the first wave has run', () => {
    // `waved` and `round + 1` are set together by applyWave, so the round is what carries this;
    // there is no state where a wave has run and the round is still zero.
    const after = running({ waved: true, round: 1, openQuestions: ['q0', 'q1'] })
    expect(waveAngles(after)).toEqual(['q0', 'q1'])
  })
})

describe('applyWave', () => {
  const running = (): ResearchState => startResearch(proposed(), RUN)!
  const scout = (over: Partial<RoundResult> = {}): RoundResult => ({
    findings: 'f',
    openQuestions: [],
    urls: [],
    read: 0,
    spent: 0,
    ...over,
  })

  it('keeps one findings entry per scout, so the report is written from all of them', () => {
    const after = applyWave(running(), [scout({ findings: 'a' }), scout({ findings: 'b' })], 0)
    expect(after.findings).toEqual(['a', 'b'])
    expect(after.round).toBe(1)
    expect(after.waved).toBe(true)
  })

  it('drops a scout that found nothing rather than appending a blank', () => {
    const after = applyWave(running(), [scout({ findings: 'a' }), scout({ findings: '' })], 0)
    expect(after.findings).toEqual(['a'])
  })

  it('charges the run only what this invocation spent, never what the scouts did', () => {
    // A scout spends from its own invocation's fifty. Folding it in would stop the depth rounds
    // early for money this budget never drew.
    const after = applyWave(running(), [scout({ spent: 30 }), scout({ spent: 28 })], 2)
    expect(after.spent).toBe(2)
    expect(after.scoutSpent).toBe(58)
  })

  it('merges the pages the scouts opened, counting an overlap once', () => {
    const after = applyWave(
      running(),
      [scout({ urls: ['https://x', 'https://y'], read: 2 }), scout({ urls: ['https://y', 'https://z'], read: 2 })],
      0,
    )
    expect(after.visited).toEqual(['https://x', 'https://y', 'https://z'])
    expect(after.read).toBe(4)
    expect(after.foundNewUrls).toBe(true)
  })

  it('merges open questions without repeating one two scouts both raised', () => {
    const after = applyWave(
      running(),
      [scout({ openQuestions: ['cost?', 'who pays?'] }), scout({ openQuestions: ['cost?'] })],
      0,
    )
    expect(after.openQuestions).toEqual(['cost?', 'who pays?'])
  })

  it('never ends the run, whatever the scouts think', () => {
    // "Done" is a judgement about depth, and a scout has seen one angle of the plan.
    const after = applyWave(running(), [scout({ modelDone: true }), scout({ modelDone: true })], 0)
    expect(after.modelDone).toBe(false)
  })

  it('reports no new ground when every scout came back empty', () => {
    const after = applyWave(running(), [scout({ findings: '' }), scout({ findings: '' })], 0)
    expect(after.foundNewUrls).toBe(false)
  })
})

describe('the deadline', () => {
  const at = (startedAt: number, over: Partial<ResearchState> = {}): ResearchState => ({
    ...(startResearch(proposed(), RUN, startedAt) as ResearchState),
    spent: 10,
    foundNewUrls: true,
    ...over,
  })

  it('lets the slowest scout production has produced actually finish', () => {
    // Two of four scouts on the first production wave came back at about 138 s and 162 s, past the
    // 120 s the cap was set to from local runs — the wave had closed and their pages were paid for
    // and discarded. The number is tied to that measurement rather than left to taste.
    expect(SCOUT_TIMEOUT_MS).toBeGreaterThan(162_000)
  })

  it('leaves room over the longest thing a round can be', () => {
    // The two were both 150 s once, which left none: a wave that ran to its per-scout timeout
    // consumed the whole headroom, and the gap before the round then pushed the run past the
    // deadline.
    expect(ROUND_WORST_CASE_MS).toBeGreaterThan(SCOUT_TIMEOUT_MS + RESEARCH_ROUND_GAP_SECONDS * 1000)
  })

  it('records when the run started, so the clock survives the alarm chain', () => {
    expect(startResearch(proposed(), RUN, 1000)?.startedAt).toBe(1000)
  })

  it('keeps a whole round of headroom rather than stopping on elapsed time', () => {
    // Checked between rounds, "stop after five minutes" would mean starting a round at 4:59 and
    // finishing at 7:30.
    const started = 1_000_000
    const latest = started + RESEARCH_DEADLINE_MS - ROUND_WORST_CASE_MS
    expect(shouldContinue(at(started), latest)).toEqual({ go: true })
    expect(shouldContinue(at(started), latest + 1)).toEqual({ go: false, reason: 'time' })
  })

  it('outranks every other cap, because it is the only one meant to fire', () => {
    const doomed = at(1_000_000, { spent: RESEARCH_SUBREQUEST_BUDGET, round: RESEARCH_MAX_ROUNDS, foundNewUrls: false })
    expect(shouldContinue(doomed, 1_000_000 + RESEARCH_DEADLINE_MS)).toEqual({ go: false, reason: 'time' })
  })

  it('treats a run from before the clock existed as one that has only just begun', () => {
    // startedAt 0 is "not recorded", and reading it as epoch zero would expire every such run.
    expect(shouldContinue({ ...at(1_000_000), startedAt: 0 }, Date.now())).toEqual({ go: true })
  })
})

describe('roundHeadroomMs', () => {
  const running = (over: Partial<ResearchState> = {}): ResearchState => ({
    ...startResearch(proposed(), RUN, 1000)!,
    ...over,
  })

  it('assumes the worst until this run has finished a round', () => {
    expect(roundHeadroomMs(running())).toBe(ROUND_WORST_CASE_MS)
  })

  it('reserves what this run has actually shown a round costs', () => {
    // The constant is sized for a wave where every scout runs to its timeout. On the first real run
    // rounds took 78 s and 69 s against a 150 s reservation, which cost half the deadline.
    const after = recordRoundDuration(running(), 78_000)
    expect(roundHeadroomMs(after)).toBe(78_000 + RESEARCH_ROUND_GAP_SECONDS * 1000)
    expect(roundHeadroomMs(after)).toBeLessThan(ROUND_WORST_CASE_MS)
  })

  it('keeps the longest round, not the most recent', () => {
    const after = recordRoundDuration(recordRoundDuration(running(), 90_000), 20_000)
    expect(after.longestRoundMs).toBe(90_000)
  })

  it('never reserves less than a round has ever taken', () => {
    expect(roundHeadroomMs(recordRoundDuration(running(), 1_000))).toBe(MIN_ROUND_HEADROOM_MS)
  })

  it('lets a run that proved itself quick fit more rounds in', () => {
    const quick = recordRoundDuration(running({ spent: 10, foundNewUrls: true }), 70_000)
    const at200s = 1000 + 200_000
    expect(shouldContinue(quick, at200s)).toEqual({ go: true })
    // The constant would have refused this round at 151 s and ended the run with half the clock left.
    expect(shouldContinue({ ...quick, longestRoundMs: undefined }, at200s)).toEqual({ go: false, reason: 'time' })
  })
})

describe("the scouts' shared budget", () => {
  const running = (over: Partial<ResearchState> = {}): ResearchState => ({
    ...startResearch(proposed(), RUN)!,
    ...over,
  })

  it('fans out while there is credit for it', () => {
    expect(waveAngles(running({ scoutSpent: RESEARCH_SCOUT_BUDGET - 1 }))).toHaveLength(2)
  })

  it('falls back to a sequential round rather than ending the run', () => {
    // Nothing in RESEARCH_SUBREQUEST_BUDGET bounds the scouts — that one counts the parent, which
    // spent 23 across a whole run. The run gets narrower here, not shorter.
    const broke = running({ scoutSpent: RESEARCH_SCOUT_BUDGET })
    expect(waveAngles(broke)).toBeUndefined()
    expect(shouldContinue({ ...broke, spent: 10, foundNewUrls: true })).toEqual({ go: true })
  })
})
