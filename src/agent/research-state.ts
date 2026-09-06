import type { ResearchPreset, ResearchState, StopCause } from '../types'

export const RESEARCH_SUBREQUEST_BUDGET = 402

export const RESEARCH_DEADLINE_MS = 300_000

export interface PresetLimits {
  deadlineMs: number
  scouts: number
}

export const RESEARCH_PRESETS: Record<ResearchPreset, PresetLimits> = {
  quick: { deadlineMs: 120_000, scouts: 4 },
  normal: { deadlineMs: RESEARCH_DEADLINE_MS, scouts: 5 },
  deep: { deadlineMs: 600_000, scouts: 5 },
}

export function presetOf(state: Pick<ResearchState, 'preset'>): PresetLimits {
  return RESEARCH_PRESETS[state.preset ?? 'normal']
}

export const RESEARCH_ROUND_GAP_SECONDS = 5

export const SCOUT_TIMEOUT_MS = 180_000

export const ROUND_WORST_CASE_MS = SCOUT_TIMEOUT_MS + RESEARCH_ROUND_GAP_SECONDS * 1000 + 25_000

export const MIN_ROUND_HEADROOM_MS = 60_000

export function roundHeadroomMs(state: ResearchState): number {
  if (!state.longestRoundMs) {
    return ROUND_WORST_CASE_MS
  }
  return Math.max(state.longestRoundMs + RESEARCH_ROUND_GAP_SECONDS * 1000, MIN_ROUND_HEADROOM_MS)
}

export const RESEARCH_MAX_ROUNDS = 12

export const ROUND_WORST_CASE = 50

export interface RoundResult {
  findings: string
  openQuestions: string[]
  urls: string[]
  readUrls: string[]
  seenUrls?: string[]
  spent: number
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

export function canPropose(state: ResearchState | undefined): boolean {
  return state?.phase !== 'running' && state?.phase !== 'done'
}

export function finishRun(state: ResearchState, stopCause: StopCause, report: string, tokens = 0): ResearchState {
  return { ...state, phase: 'done', stopCause, report, tokens: addTokens(state.tokens, tokens) }
}

function addTokens(sofar: number | undefined, more: number): number | undefined {
  return more > 0 || sofar !== undefined ? (sofar ?? 0) + more : undefined
}

export function replan(state: ResearchState | undefined, plan: string[]): ResearchState | undefined {
  if (state?.phase !== 'proposed') {
    return undefined
  }
  const cleaned = plan.map((p) => p.trim()).filter(Boolean)
  return cleaned.length ? { ...state, plan: cleaned } : state
}

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

export function isCurrentRun(current: ResearchState | undefined, started: ResearchState): boolean {
  return current?.runId === started.runId && current?.phase === 'running'
}

export function shouldContinue(
  state: ResearchState,
  now: number = Date.now(),
): { go: true } | { go: false; reason: StopCause } {
  if (state.phase !== 'running') {
    return { go: false, reason: 'not-running' }
  }
  if (
    state.round > 0 &&
    state.startedAt &&
    now + roundHeadroomMs(state) > state.startedAt + presetOf(state).deadlineMs
  ) {
    return { go: false, reason: 'time' }
  }
  if (state.spent + ROUND_WORST_CASE > RESEARCH_SUBREQUEST_BUDGET) {
    return { go: false, reason: 'budget' }
  }
  if (state.round >= RESEARCH_MAX_ROUNDS) {
    return { go: false, reason: 'max-rounds' }
  }
  if (!state.foundNewUrls) {
    return { go: false, reason: 'no-new-ground' }
  }
  if (state.modelDone) {
    return { go: false, reason: 'model-done' }
  }
  return { go: true }
}

export function chargeRound(state: ResearchState): ResearchState {
  return { ...state, round: state.round + 1, spent: state.spent + ROUND_WORST_CASE }
}

export const MAX_SCOUTS = Math.max(...Object.values(RESEARCH_PRESETS).map((p) => p.scouts))

export const RESEARCH_SCOUT_BUDGET = 250

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

function freshUrls(state: ResearchState, urls: string[]): string[] {
  const fresh: string[] = []
  for (const url of urls) {
    if (!state.visited.includes(url) && !fresh.includes(url)) {
      fresh.push(url)
    }
  }
  return fresh
}

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
    modelDone: false,
  }
}

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
