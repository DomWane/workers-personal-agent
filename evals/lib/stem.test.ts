import { describe, expect, it } from 'vitest'
import { stem, tokenizeStemmed } from './stem.ts'
import { tokenize } from './tokenize.ts'

const s = (word: string) => stem(tokenize(word)[0])

describe('stem', () => {
  it('collapses the cases of one noun onto one stem', () => {
    for (const group of [
      ['formulář', 'formuláře', 'formulářů', 'formuláři'],
      ['zahrada', 'zahrady', 'zahradu', 'zahradě'],
      ['učitel', 'učitele', 'učitelovi', 'učitelech'],
      ['schéma', 'schémata', 'schémat', 'schématu'],
    ]) {
      expect(new Set(group.map(s)).size).toBe(1)
    }
  })

  it('does not invent a consonant, which a blind palatalisation rule did', () => {
    // c$→k turned ulic into ulik and z$→h turned garaz into garah.
    expect(s('ulice')).toBe('ulic')
    expect(s('garáže')).toBe('garaz')
  })

  it('leaves short tokens alone, since their ending is a name rather than grammar', () => {
    for (const word of ['vs', 'api', 'r2', 'json']) {
      expect(s(word)).toBe(tokenize(word)[0])
    }
  })

  it('keeps unrelated words apart', () => {
    expect(s('stavba')).not.toBe(s('stav'))
    expect(s('ruka')).not.toBe(s('růže'))
  })

  it('stems the query the same way as the index, which is the only property that must hold', () => {
    expect(tokenizeStemmed('Která schémata se lišila?')).toContain(s('schéma'))
  })
})
