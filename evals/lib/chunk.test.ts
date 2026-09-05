import { describe, expect, it } from 'vitest'
import { chunkConfigFromEnv, expandChunks, parentOf, splitText } from './chunk.ts'

describe('splitText', () => {
  it('returns the text whole when it fits', () => {
    expect(splitText('short', { chars: 10, overlap: 2 })).toEqual(['short'])
  })

  it('slides by chars minus overlap so every cut appears whole in one neighbour', () => {
    // 12 chars, window 5, step 3 → 0-5, 3-8, 6-11, 9-12
    expect(splitText('abcdefghijkl', { chars: 5, overlap: 2 })).toEqual(['abcde', 'defgh', 'ghijk', 'jkl'])
  })

  it('covers the whole text', () => {
    const text = 'x'.repeat(4000)
    const parts = splitText(text, { chars: 1600, overlap: 200 })
    expect(parts.join('').length).toBeGreaterThanOrEqual(text.length)
    expect(parts.at(-1)).toBe(text.slice(-(text.length - 2800)))
  })

  it('does not emit a trailing chunk that is pure overlap', () => {
    // The final window ends exactly at the text end; another step would re-emit only seen text.
    expect(splitText('abcdefgh', { chars: 4, overlap: 2 })).toEqual(['abcd', 'cdef', 'efgh'])
  })
})

describe('chunkConfigFromEnv', () => {
  it('is absent by default, so the un-chunked baseline is untouched', () => {
    expect(chunkConfigFromEnv({})).toBeNull()
  })

  it('defaults the overlap but never the size', () => {
    expect(chunkConfigFromEnv({ EVAL_CHUNK_CHARS: '1600' })).toEqual({ chars: 1600, overlap: 200 })
  })

  it('refuses an overlap that would not advance', () => {
    expect(() => chunkConfigFromEnv({ EVAL_CHUNK_CHARS: '400', EVAL_CHUNK_OVERLAP: '400' })).toThrow(
      /EVAL_CHUNK_OVERLAP/,
    )
  })
})

describe('expandChunks', () => {
  const corpus = [
    { id: 'aaaa', text: 'x'.repeat(9) },
    { id: 'bbbb', text: 'fits' },
  ]

  it('is the identity without a config — the baseline arm must reuse its vectors', () => {
    expect(expandChunks(corpus, null)).toEqual([
      { id: 'aaaa', text: 'x'.repeat(9) },
      { id: 'bbbb', text: 'fits' },
    ])
  })

  it('suffixes ord and keeps corpus order, which the vector file is positionally keyed to', () => {
    const out = expandChunks(corpus, { chars: 4, overlap: 1 })
    expect(out.map((c) => c.id)).toEqual(['aaaa#0', 'aaaa#1', 'aaaa#2', 'bbbb#0'])
  })
})

describe('parentOf', () => {
  it('strips the ord', () => {
    expect(parentOf('aaaa#3')).toBe('aaaa')
  })

  it('leaves an unchunked id alone', () => {
    expect(parentOf('aaaa')).toBe('aaaa')
  })
})
