import { describe, expect, it } from 'vitest'
import { isFromService, stripClientMetadata } from './ingest-filter.ts'

/** Shaped like the observability export, including the parts nobody asked for. */
function event(over: Record<string, unknown> = {}) {
  return {
    dataset: 'cloudflare-workers',
    timestamp: 1_786_135_480_817,
    $metadata: { id: 'abc', service: 'personal-agent', requestId: 'R1' },
    $workers: {
      scriptName: 'personal-agent',
      eventType: 'fetch',
      outcome: 'ok',
      cpuTimeMs: 4,
      event: {
        request: {
          url: 'https://personal-agent.example.workers.dev/api/threads',
          method: 'POST',
          headers: {
            'cf-connecting-ip': '2001:db8::1',
            'x-real-ip': '2001:db8::1',
            'content-type': 'application/json',
          },
          cf: { city: 'Springfield', postalCode: '00000', latitude: '0.00', longitude: '0.00', country: 'XX' },
        },
        response: { status: 200 },
      },
    },
    source: { v: 1, turnId: 'a3f1c092', at: 'turn' },
    ...over,
  }
}

describe('isFromService', () => {
  it('keeps this agent and drops other workers on the same account', () => {
    // The export is account-wide. Without this the corpus quietly mixes in other projects.
    expect(isFromService(event(), 'personal-agent')).toBe(true)
    expect(isFromService(event({ $metadata: { id: 'x', service: 'other-worker' } }), 'personal-agent')).toBe(false)
  })

  it('falls back to the workers block when metadata carries no service', () => {
    const e = event({ $metadata: { id: 'x' } })
    expect(isFromService(e, 'personal-agent')).toBe(true)
  })

  it('drops an event that names no service at all rather than guessing it is ours', () => {
    expect(isFromService({ $metadata: { id: 'x' }, $workers: {} }, 'personal-agent')).toBe(false)
  })
})

describe('stripClientMetadata', () => {
  it('removes the caller IP and location, which no metric uses', () => {
    const json = JSON.stringify(stripClientMetadata(event()))

    expect(json).not.toContain('2001:db8')
    expect(json).not.toContain('Springfield')
    expect(json).not.toContain('00000')
    expect(json).not.toContain('0.00')
  })

  it('keeps what a turn is reconstructed from', () => {
    const json = JSON.stringify(stripClientMetadata(event()))

    expect(json).toContain('a3f1c092')
    expect(json).toContain('personal-agent')
    // The request line still says what was called; only who called it goes.
    expect(json).toContain('/api/threads')
    expect(json).toContain('"status":200')
  })

  it('does not mutate the event it was given', () => {
    const original = event()
    stripClientMetadata(original)
    expect((original.$workers.event.request.cf as { city: string }).city).toBe('Springfield')
  })

  it('survives an event with no request block', () => {
    const alarm = { $metadata: { id: 'x' }, $workers: { eventType: 'alarm' }, source: { v: 1 } }
    expect(() => stripClientMetadata(alarm)).not.toThrow()
    expect(stripClientMetadata(alarm)).toMatchObject({ source: { v: 1 } })
  })
})
