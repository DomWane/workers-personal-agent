export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Wire format for the OpenAI-compatible API (superset of what we persist). */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * What we persist in DO state. Tool traffic is here too, but never at full size: a result over the
 * pruner's threshold is stubbed on its way in, so the ref is what survives and the page stays in
 * the archive. Everything in this array is re-sent to the model every turn and broadcast to every
 * connected client, which is why the stub — not the result — is the thing that lives here.
 *
 * `content` stays a `string` rather than becoming nullable: an assistant that only called tools
 * carries `''`, and `toChatMessages` turns that into the `null` the wire format wants. Nullable
 * here would reach `transcript`, `historyTokens`, `provenance` and the Vue client for nothing.
 */
export type HistoryMessage = SpokenMessage | ToolMessage

/**
 * A union rather than one interface with every field optional. Optional is what let a `tool` row
 * exist with no `tool_call_id` — a value the provider answers with a 400 — so the shape had to be
 * checked at runtime and argued about at every reader. Here the compiler refuses to build one.
 */
interface Persisted {
  content: string
  /** Required, so the readers that point at a turn need no "impossible" branch. Nothing persisted
   *  can lack one: every message written since ids existed carries one, and the history that
   *  predated them was cleared by the idle flush that ran until this branch removed it. */
  id: string
  at?: number
}

/** What a person or the model said, which is what `spoken()` keeps and the client draws. */
export interface SpokenMessage extends Persisted {
  role: 'user' | 'assistant'
  /** Tool names the turn used; assistant messages only. Shown post-hoc in the web UI. */
  tools?: string[]
  /** Input plus output the turn cost, as the provider reported it; assistant messages only. */
  tokens?: number
  /** What this assistant asked for. `content` is whatever it said in the same breath, usually
   *  nothing — `''` where the wire format wants `null`. */
  tool_calls?: ToolCall[]
}

export interface ToolMessage extends Persisted {
  role: 'tool'
  /** Which call this answers. An unmatched id makes the next request a 400, so nothing may separate
   *  one of these from the assistant that requested it — see `pairedOnly` and `ownedGroupStart`. */
  tool_call_id: string
}
