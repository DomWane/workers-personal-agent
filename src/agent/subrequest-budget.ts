export const FREE_PLAN_SUBREQUESTS = 50

export const PAID_PLAN_SUBREQUESTS = 10_000

export class SubrequestBudget {
  private used = 0
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

  hold(n: number): () => void {
    this.held += n
    return () => {
      this.held -= n
    }
  }

  charge(n = 1): void {
    if (!this.canAfford(n)) {
      throw new BudgetExhausted(this.limit, this.used)
    }
    this.used += n
  }

  readonly fetch: typeof globalThis.fetch = (input, init) => {
    this.charge()
    return this.inner(input, init)
  }
}

export class BudgetExhausted extends Error {
  constructor(limit: number, spent: number) {
    super(`subrequest budget exhausted: ${spent} of ${limit} spent, the rest is reserved`)
    this.name = 'BudgetExhausted'
  }
}

export function rethrowIfExhausted(err: unknown): void {
  if (err instanceof BudgetExhausted) {
    throw err
  }
}
