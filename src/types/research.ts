export type StopCause = 'time' | 'budget' | 'max-rounds' | 'no-new-ground' | 'model-done' | 'not-running'

export type ResearchPreset = 'quick' | 'normal' | 'deep'

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
  plan: string[]
  runId: string
  startedAt: number
  findings: string[]
  openQuestions: string[]
  visited: string[]
  read: number
  report?: string
  stopCause?: StopCause
  spent: number
  scoutSpent?: number
  round: number
  waved?: boolean
  preset?: ResearchPreset
  writing?: boolean
  tokens?: number
  scouts?: ScoutProgress[]
  longestRoundMs?: number
  foundNewUrls: boolean
  modelDone: boolean
}
