/**
 * The research run as the web client sees it, broadcast inside `AgentState`. The transitions that
 * move it live in `src/agent/research-state.ts`; only the shape is here, beside the other
 * broadcast types, so `web/src/types/research.ts` mirrors one folder and not two.
 */

export type StopCause = 'time' | 'budget' | 'max-rounds' | 'no-new-ground' | 'model-done' | 'not-running'

/** Chosen on the proposal card; the numbers behind each name are `RESEARCH_PRESETS`. */
export type ResearchPreset = 'quick' | 'normal' | 'deep'

/** What a scout has done so far, sent to the parent as it works. */
export interface ScoutCounts {
  reads: number
  searches: number
}

export interface ScoutProgress extends ScoutCounts {
  angle: string
}

export interface ResearchState {
  phase: 'proposed' | 'running' | 'done'
  topic: string
  /** What the run said it would look for, shown in the proposal and carried into round one. */
  plan: string[]
  /** Identifies this run across invocations; a round writes its result back only if this still
   *  matches, so a stop that lands mid-round is not undone. Empty until the run starts. */
  runId: string
  /** Epoch milliseconds, zero until the run starts. Kept in state so the deadline survives the
   *  alarm chain rather than restarting with each invocation. */
  startedAt: number
  /**
   * One entry per round, appended and never rewritten. A single document rewritten each round
   * keeps the prompt small but recompresses everything twelve times; the report is written once
   * at the end from all of these instead, so each finding is compressed exactly once.
   */
  findings: string[]
  /** A list, because in prose it stops being obvious what is still unanswered. */
  openQuestions: string[]
  /** Every URL this run has spent a request on, read or failed, as `pageKey` keys: deduplication
   *  compares them, so they are never summarised. */
  visited: string[]
  /** How many of those actually produced content. The report counts pages, not attempts. */
  read: number
  /** Set when the run finishes. Held rather than sent so the user picks chat or a vault file: a
   *  report is five minutes and a few hundred requests of work, not something a timer discards. */
  report?: string
  stopCause?: StopCause
  spent: number
  /** Kept apart from `spent` because it is drawn from the scouts' invocations, not this one's
   *  budget. Reported, never gated on. */
  scoutSpent?: number
  round: number
  /** Set by the first wave. Rounds after it go deep; without one the first two rounds are the
   *  breadth pass instead. */
  waved?: boolean
  /** Chosen at start and kept here so every round of the alarm chain reads the same deadline. */
  preset?: ResearchPreset
  /** Set while the report is being written, which the deadline does not bound and which has taken
   *  longer than a `quick` run's whole clock. Never on a `done` state. */
  writing?: boolean
  /** What the run has spent, as the providers reported it: scouts, rounds and the report, not the
   *  plan. Absent until something reported, so a provider without `usage` shows nothing rather
   *  than zero. */
  tokens?: number
  /** The wave in flight, one row per scout, updated by `scoutProgress` as each scout works. Set
   *  when the wave starts and gone when it lands: a wave's two minutes showed nothing but zeros. */
  scouts?: ScoutProgress[]
  /** The longest round this run has finished, in milliseconds. Feeds the deadline's headroom. */
  longestRoundMs?: number
  foundNewUrls: boolean
  modelDone: boolean
}
