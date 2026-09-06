import type { ResearchPreset, ResearchState, StopCause } from '../types'

/**
 * The rules for moving a research run between alarms; the state's shape is `types/research.ts`.
 * Pure: no I/O, no scheduling, so the transitions can be tested against literals rather than
 * against a Durable Object.
 *
 * Rounds pass *findings*, not pages: a round is given a window of what earlier rounds found and
 * appends its own, so no round has to hold the pages the run has read.
 */

/**
 * Subrequests across the whole run, not per round. Sized so the budget cannot bind before the
 * round cap does: a round measured 28-32 requests across three runs, and the check keeps a whole
 * invocation of headroom, so (RESEARCH_MAX_ROUNDS - 1) × 32 + ROUND_WORST_CASE. Set independently
 * of the cap, these two drifted apart once already.
 */
export const RESEARCH_SUBREQUEST_BUDGET = 402

/**
 * The `normal` preset's bound, and the only kind meant to fire. Five minutes is about as long as
 * anyone watches a status card, and the work fits inside it because the breadth pass is a wave of
 * parallel scouts rather than two sequential rounds.
 *
 * It replaced a floor of six rounds, because two authorities over when a run may end cannot both be
 * final — `docs/decisions/research.md` has what the floor was for and why the wave retires it.
 *
 * It bounds the gathering, not the report that follows: a run that gathered material and then
 * dropped it for the clock would be worse than one that ran half a minute long.
 */
export const RESEARCH_DEADLINE_MS = 300_000

/**
 * How long a run may gather and how wide its first wave is, chosen on the proposal card. `normal`
 * is the five minutes above; `quick` is for the Free plan: four scouts, one per plan line, so no
 * angle is dropped, and one fewer than `normal` against Browser Rendering's one request per ten
 * seconds. `deep` buys rounds, and the card says what they cost. Rounds and requests keep their
 * safety nets.
 */
export interface PresetLimits {
  deadlineMs: number
  scouts: number
}

export const RESEARCH_PRESETS: Record<ResearchPreset, PresetLimits> = {
  quick: { deadlineMs: 120_000, scouts: 4 },
  normal: { deadlineMs: RESEARCH_DEADLINE_MS, scouts: 5 },
  deep: { deadlineMs: 600_000, scouts: 5 },
}

/** Absent means `normal`: a run started before presets existed, or a seeded one. */
export function presetOf(state: Pick<ResearchState, 'preset'>): PresetLimits {
  return RESEARCH_PRESETS[state.preset ?? 'normal']
}

/** Gap between rounds. Short enough to finish while the user still cares, long enough that a round
 *  which overran is not competing with its own successor. Counted in the headroom below. */
export const RESEARCH_ROUND_GAP_SECONDS = 5

/**
 * A scout that never returns would otherwise hold the wave, and the wave holds the run.
 *
 * Was 120 s, derived from local runs where a scout took 45–90 s. The first production wave put two
 * of four scouts past it — they finished at about 138 s and 162 s, after the wave had closed, and
 * their pages were paid for and thrown away. Local timings were the wrong sample: the cap has to
 * clear the slowest scout that is still working, not the fastest that has finished.
 */
export const SCOUT_TIMEOUT_MS = 180_000

/**
 * What a round is assumed to cost before this run has seen one, derived from the scout timeout
 * rather than set beside it — the two were both 150 s once, which left no room at all.
 */
export const ROUND_WORST_CASE_MS = SCOUT_TIMEOUT_MS + RESEARCH_ROUND_GAP_SECONDS * 1000 + 25_000

/** No round has ever finished faster than this, so measurement never talks the guard below it. */
export const MIN_ROUND_HEADROOM_MS = 60_000

/**
 * Time headroom, the same shape as ROUND_WORST_CASE is for requests: a round is not started unless
 * a whole one still fits, because gating on elapsed time would make five minutes mean seven.
 *
 * Measured rather than assumed once this run has a round to measure. The constant is the worst case
 * — a wave where every scout runs to its timeout — and on the first real run it cost half the
 * deadline: rounds took 78 s and 69 s against a 150 s reservation, so a five-minute run stopped at
 * 152 s with two rounds done. What this run has actually done predicts it better than a bound sized
 * for the worst wave imaginable.
 */
export function roundHeadroomMs(state: ResearchState): number {
  if (!state.longestRoundMs) {
    return ROUND_WORST_CASE_MS
  }
  return Math.max(state.longestRoundMs + RESEARCH_ROUND_GAP_SECONDS * 1000, MIN_ROUND_HEADROOM_MS)
}

/** A safety net under the deadline rather than a mark to reach: at the round lengths measured so
 *  far the clock should stop a run first, which no run under the deadline has yet confirmed. */
export const RESEARCH_MAX_ROUNDS = 12

/** What one invocation can spend before the platform cuts it off. Doubles as the headroom the
 *  budget check keeps and as the charge a round takes before it starts. */
export const ROUND_WORST_CASE = 50

export interface RoundResult {
  /** What this round found, not a rewrite of the run so far. Empty when the round produced
   *  nothing usable — the caller appends nothing rather than appending a blank. */
  findings: string
  openQuestions: string[]
  /** Every URL a fetch was attempted on this round, whether or not it produced content. */
  urls: string[]
  /** Which of `urls` produced content. A list rather than a count so the run can dedupe it against
   *  `visited`: two scouts reading the same cached page once showed "-2 could not be opened". */
  readUrls: string[]
  /** URLs a search showed the round without it opening them. Grounds a citation the round made
   *  from a snippet, which is honest sourcing and must not read as an invention. */
  seenUrls?: string[]
  spent: number
  /** Input plus output as the provider reported them, 0 where it reported nothing. */
  tokens?: number
  modelDone?: boolean
}

export function proposeResearch(topic: string, plan: string[]): ResearchState {
  const trimmed = topic.trim()
  if (!trimmed) {
    throw new Error('research topic must not be empty')
  }
  return {
    phase: 'proposed',
    topic: trimmed,
    plan: plan.map((p) => p.trim()).filter(Boolean),
    runId: '',
    startedAt: 0,
    findings: [],
    openQuestions: [],
    visited: [],
    read: 0,
    spent: 0,
    round: 0,
    foundNewUrls: true,
    modelDone: false,
  }
}

/**
 * False while a run is in flight. Replacing the state then would leave the scheduled round looking
 * at a proposal, so it returns without a word: the run dies, the notes go, and nobody is told.
 */
export function canPropose(state: ResearchState | undefined): boolean {
  return state?.phase !== 'running' && state?.phase !== 'done'
}

/** Moves a finished run to `done`, holding its report until the user says where it goes. */
export function finishRun(state: ResearchState, stopCause: StopCause, report: string, tokens = 0): ResearchState {
  return { ...state, phase: 'done', stopCause, report, tokens: addTokens(state.tokens, tokens) }
}

/** Zero reported is not the same as nothing reported: the field stays absent until a provider
 *  has counted something, so the card shows no number rather than a wrong one. */
function addTokens(sofar: number | undefined, more: number): number | undefined {
  return more > 0 || sofar !== undefined ? (sofar ?? 0) + more : undefined
}

/**
 * Replaces the plan on a proposal that has not started. Undefined means there was nothing to
 * replan; an empty new plan keeps the old one, so a model call that came back unusable cannot
 * leave the confirmation gate with nothing in it.
 */
export function replan(state: ResearchState | undefined, plan: string[]): ResearchState | undefined {
  if (state?.phase !== 'proposed') {
    return undefined
  }
  const cleaned = plan.map((p) => p.trim()).filter(Boolean)
  return cleaned.length ? { ...state, plan: cleaned } : state
}

/** Undefined means "nothing to start": no proposal, or one that is already running. */
export function startResearch(
  state: ResearchState | undefined,
  runId: string,
  now: number = Date.now(),
): ResearchState | undefined {
  if (!state || state.phase !== 'proposed') {
    return undefined
  }
  return { ...state, phase: 'running', runId, startedAt: now }
}

/**
 * Whether what is in the state now is still the run a round started from. A round captures the
 * state, works for a minute, then writes its result; a `stopResearch` — or a fresh proposal —
 * that arrives in between is silently undone by that write unless it is checked for.
 */
export function isCurrentRun(current: ResearchState | undefined, started: ResearchState): boolean {
  return current?.runId === started.runId && current?.phase === 'running'
}

/**
 * One reason per run, in a fixed order, so "why did it stop" is answered by the field rather than
 * by whoever reads the record.
 *
 * The order is the hierarchy: time is the hard bound, requests and rounds are safety nets under it
 * that should never fire, and the two judgements come last. Four independent caps is one more than
 * this repo has already let drift apart, so which of them is authoritative is written here rather
 * than left to whichever happens to be checked first.
 */
export function shouldContinue(
  state: ResearchState,
  now: number = Date.now(),
): { go: true } | { go: false; reason: StopCause } {
  if (state.phase !== 'running') {
    return { go: false, reason: 'not-running' }
  }
  // Headroom, not elapsed: checked between rounds, "stop after five minutes" would mean "start a
  // round at 4:59 and finish at 7:30". Zero is a run that has not started, not one that began at
  // the epoch — without the guard it reads as expired before its first round.
  //
  // Never before the first round: the reservation is then the worst case, 210 s, which is more
  // than `quick`'s whole deadline, and a run refused its first round ends "done" with nothing.
  if (
    state.round > 0 &&
    state.startedAt &&
    now + roundHeadroomMs(state) > state.startedAt + presetOf(state).deadlineMs
  ) {
    return { go: false, reason: 'time' }
  }
  // Same shape for requests: a round may cost a whole invocation, so gating on what is already
  // spent lets a run one request short of the cap finish well past it.
  if (state.spent + ROUND_WORST_CASE > RESEARCH_SUBREQUEST_BUDGET) {
    return { go: false, reason: 'budget' }
  }
  if (state.round >= RESEARCH_MAX_ROUNDS) {
    return { go: false, reason: 'max-rounds' }
  }
  if (!state.foundNewUrls) {
    return { go: false, reason: 'no-new-ground' }
  }
  // No floor under this any more: the wave has already covered every angle of the plan by the time
  // a model can hold this opinion, which is what the floor was standing in for.
  if (state.modelDone) {
    return { go: false, reason: 'model-done' }
  }
  return { go: true }
}

/**
 * The charge a round takes *before* it runs. An invocation killed rather than thrown out of — CPU
 * limit, eviction — leaves its schedule row in place and the platform retries it from whatever
 * state was last written; charging only on success means a round that always dies is retried
 * forever, having recorded nothing. `applyRound` replaces this with the actual spend.
 */
export function chargeRound(state: ResearchState): ResearchState {
  return { ...state, round: state.round + 1, spent: state.spent + ROUND_WORST_CASE }
}

/** The widest a wave ever gets: the widest preset, which is also the default LangChain's
 *  open_deep_research carries for `max_concurrent_research_units`. Not measured here: five scouts
 *  already read past the Free plan's browser concurrency, so a wider wave would be bounded by the
 *  platform, not by this. */
export const MAX_SCOUTS = Math.max(...Object.values(RESEARCH_PRESETS).map((p) => p.scouts))

/**
 * Every scout spends from its own invocation, so nothing in `RESEARCH_SUBREQUEST_BUDGET` bounds
 * them — that one counts the parent, which spent 23 across a whole run. Two real runs used 169 and
 * 175 across all their scouts; the ceiling with no cap at all is a wave per round until the clock
 * stops it, and each request is a paid search or scrape credit. When it binds the run keeps going
 * as ordinary sequential rounds, which cost one invocation each: the run gets narrower, not shorter.
 */
export const RESEARCH_SCOUT_BUDGET = 250

/**
 * What this round fans out over, or undefined for an ordinary sequential round.
 *
 * The width narrows by two a round, after Static-DRA's `max(b - 2i, 1)`: a run that kept fanning
 * out five ways at every depth would re-read the landscape instead of chasing what it did not
 * settle. Under two angles it is an ordinary round, because a single scout is the same work routed
 * through a Durable Object, an RPC and a timeout.
 */
export function waveAngles(state: ResearchState): string[] | undefined {
  if ((state.scoutSpent ?? 0) >= RESEARCH_SCOUT_BUDGET) {
    return undefined
  }
  const width = presetOf(state).scouts - 2 * state.round
  if (width < 2) {
    return undefined
  }
  const angles = (state.round === 0 ? state.plan : state.openQuestions).slice(0, width)
  return angles.length >= 2 ? angles : undefined
}

/** Keys as given, deduplicated against the run as well as within the batch: `visited` is what
 *  `foundNewUrls` and the page count are both read from. */
function freshUrls(state: ResearchState, urls: string[]): string[] {
  const fresh: string[] = []
  for (const url of urls) {
    if (!state.visited.includes(url) && !fresh.includes(url)) {
      fresh.push(url)
    }
  }
  return fresh
}

/**
 * The wave, merged as one round. Each scout contributes its own findings entry, so the report is
 * still written from a flat list; what changes is that a round can now add several.
 *
 * `ownSpend` is the parent's, and it is the only thing charged to the run: a scout spends from its
 * own invocation's fifty (measured 2026-08-08), so folding its spend into `spent` would stop the
 * depth rounds early for money this budget never drew.
 */
export function applyWave(state: ResearchState, results: RoundResult[], ownSpend: number): ResearchState {
  const findings: string[] = []
  const openQuestions: string[] = []
  let scoutSpent = 0
  for (const result of results) {
    if (result.findings) {
      findings.push(result.findings)
    }
    for (const question of result.openQuestions) {
      if (!openQuestions.includes(question)) {
        openQuestions.push(question)
      }
    }
    scoutSpent += result.spent
  }
  const fresh = freshUrls(
    state,
    results.flatMap((r) => r.urls),
  )
  const freshRead = freshUrls(
    state,
    results.flatMap((r) => r.readUrls),
  )
  const tokens = results.reduce((n, r) => n + (r.tokens ?? 0), 0)
  return {
    ...state,
    findings: [...state.findings, ...findings],
    openQuestions,
    visited: [...state.visited, ...fresh],
    read: state.read + freshRead.length,
    scouts: undefined,
    tokens: addTokens(state.tokens, tokens),
    spent: state.spent + ownSpend,
    scoutSpent: (state.scoutSpent ?? 0) + scoutSpent,
    round: state.round + 1,
    waved: true,
    foundNewUrls: fresh.length > 0,
    // A wave never ends a run. "Done" is a judgement about depth, and a scout has seen one angle.
    modelDone: false,
  }
}

/** Kept as the longest rather than the last: the headroom has to cover the slowest round the run
 *  has shown itself capable of, not the one that happened to finish most recently. */
export function recordRoundDuration(state: ResearchState, elapsedMs: number): ResearchState {
  return { ...state, longestRoundMs: Math.max(state.longestRoundMs ?? 0, elapsedMs) }
}

export function applyRound(state: ResearchState, result: RoundResult): ResearchState {
  const fresh = freshUrls(state, result.urls)
  return {
    ...state,
    findings: result.findings ? [...state.findings, result.findings] : state.findings,
    openQuestions: result.openQuestions,
    visited: [...state.visited, ...fresh],
    read: state.read + freshUrls(state, result.readUrls).length,
    tokens: addTokens(state.tokens, result.tokens ?? 0),
    spent: state.spent + result.spent,
    round: state.round + 1,
    foundNewUrls: fresh.length > 0,
    modelDone: result.modelDone ?? false,
  }
}
