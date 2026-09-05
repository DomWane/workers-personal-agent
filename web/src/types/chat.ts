/**
 * The client's own copy of what the agent broadcasts. Deliberately not imported from `src/`: the
 * Worker and the client build separately, and this holds only what the UI reads.
 *
 * A union rather than one interface with optional fields, so `spoken()` narrows and the template
 * cannot read a field off the arm that has none. Narrower than the Worker's on purpose: the
 * broadcast carries more than this, and a field nothing draws would only invite drift.
 */
export type HistoryMessage = SpokenMessage | ToolMessage

interface Persisted {
  content: string
  id?: string
  at?: number
}

export interface SpokenMessage extends Persisted {
  role: 'user' | 'assistant'
  /** Tool names the turn used; assistant messages only, rendered as a post-hoc line. */
  tools?: string[]
  /** What the turn cost, in and out, as the provider reported it; assistant answers only. */
  tokens?: number
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

/** Traffic, not conversation: kept in state so a later turn can quote a ref, filtered out by
 *  `spoken()` before anything is drawn. Carries `tool_call_id` on the wire; the client never reads
 *  it, so the field is not repeated here. */
export interface ToolMessage extends Persisted {
  role: 'tool'
}
