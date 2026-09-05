import { tokenize } from './tokenize.ts'

/**
 * A light suffix stripper for Czech, applied to both the index and the query.
 *
 * It exists because the lexical retrievers fail on this corpus in a specific way: the median
 * share of query words that appear in the target chunk at all is 0.22, and Czech inflection is
 * the obvious suspect — `formulář`, `formuláře` and `formulářů` are three unrelated tokens to
 * BM25. Whether removing that difference actually helps is the experiment.
 *
 * This is written from the standard light-stemmer approach (strip case endings, then
 * possessives, then undo palatalisation), not reproduced from a specific published algorithm —
 * so it should be judged by what it conflates on this corpus, not by its pedigree.
 *
 * The corpus is bilingual, and English words are stemmed by the same rules ("table" → "tabl").
 * That is deliberate: a stemmer that guessed at the language would introduce a second thing to
 * be wrong about, and consistency between index and query matters more than linguistic accuracy.
 */

/** Input is already diacritic-folded by tokenize, so the suffixes are spelled without them. */
const CASE_SUFFIXES = [
  'atech',
  'etem',
  'atum',
  'ovech',
  'ovem',
  'ovmi',
  'ovi',
  'ove',
  'ovy',
  'ova',
  'ovo',
  'ych',
  'ymi',
  'ami',
  'ach',
  'ata',
  'aty',
  'emu',
  'eho',
  'imu',
  'ich',
  'emi',
  'ete',
  'eti',
  'iho',
  'imi',
  'ech',
  'em',
  'im',
  'um',
  'at',
  'am',
  'ou',
  'us',
  'os',
  'ys',
  'a',
  'e',
  'i',
  'o',
  'u',
  'y',
]

const POSSESSIVE_SUFFIXES = ['ov', 'in', 'uv']

/**
 * No palatalisation step. Undoing `ruka`/`ruce` needs to know the alternation happened, and the
 * blind version (`c$`→`k`, `z$`→`h`) rewrote `ulic` to `ulik` and `garaz` to `garah` —
 * it invented stems for far more words than it repaired.
 */

/**
 * Below this, stripping does more harm than good: three-letter stems collide with each other
 * fast, and the tokens this short are mostly acronyms and identifiers where the ending is part
 * of the name rather than grammar.
 */
const MIN_STEM = 4

function stripFirst(word: string, suffixes: string[]): string {
  for (const s of suffixes) {
    if (word.length - s.length >= MIN_STEM && word.endsWith(s)) {
      return word.slice(0, -s.length)
    }
  }
  return word
}

export function stem(word: string): string {
  if (word.length <= MIN_STEM) {
    return word
  }
  // Longest suffix first, or "ovi" would be stripped one letter at a time and leave a stem that
  // depends on how many passes ran rather than on the word.
  const sorted = [...CASE_SUFFIXES].sort((a, b) => b.length - a.length)
  // Two passes: one leaves `schematu` at `schemat` while `schemata` reaches `schem`, so the same
  // noun lands on two stems depending on which case it happened to be written in.
  let out = stripFirst(stripFirst(word, sorted), sorted)
  return stripFirst(out, POSSESSIVE_SUFFIXES)
}

export function tokenizeStemmed(text: string): string[] {
  return tokenize(text).map(stem)
}
