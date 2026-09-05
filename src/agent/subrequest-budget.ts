/**
 * Workers caps outbound subrequests per invocation (50 on the Free plan). A whole
 * turn — LLM rounds, vault reads, embeddings — runs inside one DO alarm, so it spends
 * one budget. Crossing the cap makes every later fetch throw,
 * including the one that reports the failure, which is how a turn ends in silence.
 * The turn therefore has to stop itself before the platform stops it.
 */
export const FREE_PLAN_SUBREQUESTS = 50

/** The documented paid figure. It can be raised further through wrangler's `limits`, so a
 *  deployment that has done so is under-counting here — which stops turns early rather than late. */
export const PAID_PLAN_SUBREQUESTS = 10_000

export class SubrequestBudget {
  private used = 0
  /** Room `hold` has set aside. Spending is refused into it, `remaining` still reports it. */
  private held = 0

  constructor(
    private readonly limit: number = FREE_PLAN_SUBREQUESTS,
    private readonly inner: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
  ) {}

  get spent(): number {
    return this.used
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used)
  }

  canAfford(n = 1): boolean {
    return this.remaining - this.held >= n
  }

  /**
   * Sets aside room this budget will refuse to spend, and returns the release.
   *
   * The alternative was for each caller to ask `canAfford` before spending, which cannot work once
   * calls run concurrently: nothing can be called off once it is in flight, so the caller would
   * have to predict what each one costs. It cannot — `web_search` tries three providers and
   * `read_page` two, and the next tool added will have its own number. Refusing here needs no
   * prediction, because it counts what is actually being spent.
   *
   * A hold rather than a permanent floor: the work the reserve exists for has to spend it.
   */
  hold(n: number): () => void {
    this.held += n
    return () => {
      this.held -= n
    }
  }

  /** For subrequests that are not fetches — Workers AI and other bindings count too. */
  charge(n = 1): void {
    if (!this.canAfford(n)) {
      throw new BudgetExhausted(this.limit, this.used)
    }
    this.used += n
  }

  /** Drop-in `fetch` that charges the budget. Charges on attempt, since a rejected
   * request has already been counted by the platform. */
  readonly fetch: typeof globalThis.fetch = (input, init) => {
    this.charge()
    return this.inner(input, init)
  }
}

/**
 * Thrown by the budget rather than returned, so a caller that forgets to check still cannot
 * overspend. It travels through the same path as a provider failure, which is why every fallback
 * chain has to tell the two apart — see `rethrowIfExhausted`.
 */
export class BudgetExhausted extends Error {
  constructor(limit: number, spent: number) {
    super(`subrequest budget exhausted: ${spent} of ${limit} spent, the rest is reserved`)
    this.name = 'BudgetExhausted'
  }
}

/**
 * For the `catch` of a chain that tries another provider on failure. Running out of budget is not a
 * provider failing, and reporting it as one produces "every provider refused" — a sentence this
 * repo added specifically so a research scout would not read an outage as a fact about the world.
 */
export function rethrowIfExhausted(err: unknown): void {
  if (err instanceof BudgetExhausted) {
    throw err
  }
}
