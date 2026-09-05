/** One row of `agent/threads.json`: the client draws its list from these, and the nightly
 *  maintenance run reads them to know which conversations to ask about. */
export interface Thread {
  id: string
  /** Derived from the first user message, or typed by the user — see `touchThread`. */
  title: string
  /** Last activity, epoch ms. Ordering only. */
  at: number
}
