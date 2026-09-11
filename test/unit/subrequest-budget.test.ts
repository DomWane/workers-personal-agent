import { describe, expect, it, vi } from 'vitest'
import { BudgetExhausted, FREE_PLAN_SUBREQUESTS, SubrequestBudget } from '@/agent/subrequest-budget'

describe('SubrequestBudget', () => {
  it('defaults to the Free plan cap', () => {
    expect(new SubrequestBudget().remaining).toBe(FREE_PLAN_SUBREQUESTS)
  })

  it('tracks spend and affordability', () => {
    const budget = new SubrequestBudget(3)
    expect(budget.canAfford(3)).toBe(true)
    budget.charge()
    expect(budget.spent).toBe(1)
    expect(budget.remaining).toBe(2)
    expect(budget.canAfford(3)).toBe(false)
    expect(budget.canAfford(2)).toBe(true)
  })

  it('refuses to overspend rather than counting past the limit', () => {
    // Throwing rather than counting is what lets concurrent callers share one budget: none of them
    // has to predict what the others will spend before starting.
    const budget = new SubrequestBudget(1)
    expect(() => budget.charge(5)).toThrow(BudgetExhausted)
    expect(budget.spent).toBe(0)
    budget.charge(1)
    expect(budget.canAfford(1)).toBe(false)
  })

  it('refuses to spend into held room, and hands it back on release', () => {
    const budget = new SubrequestBudget(10)
    const release = budget.hold(8)

    expect(budget.canAfford(2)).toBe(true)
    expect(budget.canAfford(3)).toBe(false)
    budget.charge(2)
    expect(() => budget.charge(1)).toThrow(BudgetExhausted)

    // What the reserve exists for still gets to spend it.
    release()
    expect(budget.canAfford(8)).toBe(true)
  })

  it('charges one subrequest per fetch and delegates to the inner fetch', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('ok'))
    const budget = new SubrequestBudget(10, inner as unknown as typeof fetch)

    const res = await budget.fetch('https://example.com', { method: 'POST' })

    expect(await res.text()).toBe('ok')
    expect(inner).toHaveBeenCalledWith('https://example.com', { method: 'POST' })
    expect(budget.spent).toBe(1)
  })

  it('charges a fetch that rejects, since the platform counted it too', async () => {
    const inner = vi.fn().mockRejectedValue(new Error('boom'))
    const budget = new SubrequestBudget(10, inner as unknown as typeof fetch)

    await expect(budget.fetch('https://example.com')).rejects.toThrow('boom')
    expect(budget.spent).toBe(1)
  })

  it('survives being detached from the instance', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('ok'))
    const budget = new SubrequestBudget(10, inner as unknown as typeof fetch)
    const { fetch: detached } = budget

    await detached('https://example.com')

    expect(budget.spent).toBe(1)
  })
})
