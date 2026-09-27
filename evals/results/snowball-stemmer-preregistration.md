# Pre-registration — Snowball Czech against the hand-written stemmer

**Written before any code or data.** Arms, metric, decision rule and prediction are fixed here so
the analysis cannot be chosen after the numbers arrive.

## The question

[stemmer-experiment.md](stemmer-experiment.md) adopted a hand-written light stemmer for BM25. It
has no palatalisation, after blind palatalisation rewrote `ulic` to `ulik`, and a minimum stem of
four characters.

Snowball 3.1.0 added a Czech light stemmer based on Dolamic's, available in PyStemmer 3.1.0. It
does palatalise, and per its [algorithm page](https://snowballstem.org/algorithms/czech/stemmer.html)
R1 starts "at least 3 characters into the word", so stems can be three characters long.

Does it rank better on this corpus than the hand-written one?

### Where the two differ, probed by hand

PyStemmer 3.1.0 `Stemmer('czech')` against `lib/stem.py`, on words chosen to show the differences.
It is not a sample of the corpus.

| words                            | hand-written            | Snowball                  |
| -------------------------------- | ----------------------- | ------------------------- |
| `ruka`, `ruce`, `ruku`           | `ruka`, `ruce`, `ruku`  | `ruk` ×3                  |
| `matka`, `matce`                 | `matk`, `matc`          | `matk` ×2                 |
| `nový`, `nová`, `nových`         | `novy`, `nova`, `novych`| `nov` ×3                  |
| `otázky`, `otázek`               | `otazk`, `otazek`       | `otázk` ×2                |
| `ulice`, `ulic`                  | `ulic` ×2               | `ulik`, `ulic`            |
| `schema`, `schemata`, `schematu` | `schem` ×3              | `schem`, `schem`, `schemat` |
| `cesta`, `čeština`, `česky`      | `cest`, `cest`, `cesk`  | `cest`, `česk`, `česk`    |
| `stream`, `deploy`               | `stre`, `depl`          | `stream`, `deplo`         |
| `formulář`, `formuláře`, `soubor`, `souboru` | same stem per noun in both |       |

Neither dominates on these words.

## Arms

- **`bm25-stem`**, the baseline: `tokenize` (fold diacritics, lowercase, split on anything that is
  not `a-z0-9`, drop one-character tokens), then `stem`.
- **`bm25-snowball`**: the same BM25 (`k1 = 1.2`, `b = 0.75`) over the same chunks. Tokens are
  split on the same boundaries but with diacritics kept, because Snowball's rules read them; each
  token is stemmed and then folded. Index and query go through the same function.

`bge-m3` must come out byte-identical to the run before; if it moves, the run is void.

## Data and pooling

The labels in `evals/data/`: 48 bulk, 30 hard.

A retriever missing from the judging pool is scored against relevance judgments the others
produced ([retrieval-baseline.md](retrieval-baseline.md)). So:

1. Run with the new arm, record the hard-set numbers as pre-pooling.
2. Add `bm25-snowball` to `label/pool.py` and judge `label.pool hard 3` blind. Report how many
   pairs were judged and how many accepted.
3. Run again. The post-pooling hard set is the primary result.

The bulk set is not pooled, as in [hybrid-rerank-experiment.md](hybrid-rerank-experiment.md), so
the new arm's bulk figure is a lower bound.

## Metric

nDCG@10, `bm25-snowball − bm25-stem`, paired by query, 95% paired bootstrap with 10 000 resamples
and seed 1, as the runner computes every comparison. Hard and bulk reported separately. MRR and
recall@10 are shown without intervals and decide nothing.

## Decision rule

On the post-pooling hard set:

- interval above zero: adopt Snowball, delete `lib/stem.py`;
- interval below zero: reject;
- interval contains zero: null, the hand-written stemmer stays, because Snowball would add a
  dependency without a measured gain.

The bulk set does not decide.

## Prediction

Hard: between 0 and +0.02, interval contains zero. Bulk: interval contains zero. Reason: on the
probed words most nouns stem the same in both, and the differences go both ways.

## Limits

- n = 30 hard. The first stemmer comparison had an interval about 0.12 wide at this n.
- Snowball stems before folding, so a word typed without diacritics can miss its accented form:
  `novych` stays `novych` while `nových` becomes `nov`. The hand-written stemmer folds first and
  does not have this problem. A query typed without diacritics counts against Snowball, and that
  is part of what is measured, not an error in the measurement.
- One labeller, one corpus. The corpus is not public, so this is reproducible in method only.
