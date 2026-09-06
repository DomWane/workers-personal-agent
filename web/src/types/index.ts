/**
 * A hand-kept mirror of the parts of `src/types/` the web client renders. Importing the Worker's
 * own types would drag `@cloudflare/workers-types` and the whole agent module graph into the
 * browser build, so the shapes are duplicated instead — the two are structural, and a drift shows
 * up as a missing field in the UI rather than as a type error.
 */

export type { AgentState } from './agent-state'
export type { HistoryMessage } from './chat'
export type { ChatMode } from './mode'
export type { ModelRow } from './models'
export type { ResearchPhase, ResearchPreset, ResearchState } from './research'
export type { Thread } from './threads'
