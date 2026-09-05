import { describe, expect, it, vi } from 'vitest'
import { embedText } from '../../src/connectors/embeddings.connector'

describe('embedText', () => {
  it('refuses to silently truncate: over-long input errors instead of losing its tail', async () => {
    const run = vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] }))
    const ai = { run } as unknown as Ai
    const vec = await embedText(ai, 'hello')
    expect(vec).toEqual([0.1, 0.2, 0.3])
    expect(run).toHaveBeenCalledWith('@cf/baai/bge-m3', { text: ['hello'], truncate_inputs: false })
  })

  it('returns [] when the response has no data', async () => {
    const ai = { run: vi.fn(async () => ({})) } as unknown as Ai
    await expect(embedText(ai, 'x')).resolves.toEqual([])
  })
})
