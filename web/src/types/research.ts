export type ResearchPhase = 'proposed' | 'running' | 'done'

/** Mirrors `RESEARCH_PRESETS` in the Worker; the card's copy for each is in ResearchProposal.vue. */
export type ResearchPreset = 'quick' | 'normal' | 'deep'

export interface ResearchState {
  phase: ResearchPhase
  topic: string
  plan: string[]
  preset?: ResearchPreset
  /** The gathering is over and the report is being written; the deadline does not bound this part. */
  writing?: boolean
  /** The wave in flight, one row per scout; present only while scouts are out. */
  scouts?: Array<{ angle: string; reads: number; searches: number }>
  round: number
  visited: string[]
  openQuestions: string[]
  findings?: string[]
  read?: number
  /** Provider-reported spend so far; absent until a provider has counted something. */
  tokens?: number
  report?: string
  stopCause?: string
  startedAt: number
}
