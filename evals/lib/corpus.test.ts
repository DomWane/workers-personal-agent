import { describe, expect, it } from 'vitest'
import { corpusTextHash } from './corpus.ts'

const c = (text: string) => ({ text })

describe('corpusTextHash', () => {
  it('is stable for the same texts in the same order', () => {
    expect(corpusTextHash([c('a'), c('b')])).toBe(corpusTextHash([c('a'), c('b')]))
  })

  it('changes when any chunk text changes', () => {
    expect(corpusTextHash([c('a'), c('b')])).not.toBe(corpusTextHash([c('a'), c('b!')]))
  })

  it('changes when the order changes, because embeddings.bin is positional', () => {
    expect(corpusTextHash([c('a'), c('b')])).not.toBe(corpusTextHash([c('b'), c('a')]))
  })

  it('cannot be collided by moving the boundary between two chunks', () => {
    // The length prefix is what stops "ab"+"c" and "a"+"bc" hashing the same.
    expect(corpusTextHash([c('ab'), c('c')])).not.toBe(corpusTextHash([c('a'), c('bc')]))
  })

  it('covers the text and nothing else — ids and metadata do not enter it', () => {
    // Deliberate: the hash answers "is this the text the embedder saw", and ids are compared
    // separately. If it ever covered ids too, the two checks would stop being independent.
    const withMeta = [{ text: 'a', id: 's:0', session: 's', ts: 't', project: 'p' }]
    expect(corpusTextHash(withMeta)).toBe(corpusTextHash([c('a')]))
  })
})
