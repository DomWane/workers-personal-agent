export type ResearchPhase = 'proposed' | 'running' | 'done'

export interface ResearchState {
  phase: ResearchPhase
  topic: string
  plan: string[]
  round: number
  visited: string[]
  openQuestions: string[]
  findings?: string[]
  read?: number
  report?: string
  stopCause?: string
  startedAt: number
}
