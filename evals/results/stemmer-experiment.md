# Czech stemming as a fourth retriever — 2026-08-01

The lexical retrievers fail on this corpus in a specific way: the median share of query words that
appear in the relevant chunks _at all_ is 0.22 on the bulk set and 0.29 on the hard set, and the
words that do match are mostly `se`, `na`, `to`. Czech inflection is the obvious suspect —
`formulář`, `formuláře` and `formulářů` are three unrelated tokens to BM25.

## Prediction, written before the run

BM25 rises on both label sets. bge-m3 does not move at all, since it scores precomputed vectors
and never touches the tokenizer. Keyword rises too but less, because substring matching already
absorbs some inflection.

## Result at n = 20 hard, before the set was finished

| comparison       | bulk                   | hard                   |
| ---------------- | ---------------------- | ---------------------- |
| BM25-stem − BM25 | +0.060 [−0.003, 0.130] | +0.043 [−0.024, 0.117] |

Every one of the eight metric/set combinations favoured stemming, and neither interval cleared
zero. Direction confirmed, claim not established — recorded that way at the time.

## Result at n = 30 hard, after pooling

| retriever           | bulk nDCG@10 | hard nDCG@10 | hard MRR  |
| ------------------- | ------------ | ------------ | --------- |
| BM25                | 0.178        | 0.222        | 0.275     |
| **BM25 + stemming** | **0.238**    | **0.288**    | **0.378** |
| bge-m3              | 0.588        | 0.417        | 0.447     |

| comparison       | bulk                   | hard                      |
| ---------------- | ---------------------- | ------------------------- |
| BM25-stem − BM25 | +0.060 [−0.003, 0.130] | **+0.067 [0.008, 0.128]** |

**Established on the hard set, still open on the bulk set.** Ten more queries and a pooling pass
moved the hard interval clear of zero; the bulk interval did not move at all.

That split is explainable rather than noisy. Bulk queries are generated paraphrases whose median
share of words present in the target is 0.22, against 0.29 for the hard set — there is so little
lexical overlap left on the bulk side that conflating word forms has little to join. The hard set, written in the author's own remembered
phrasing, has inflections to merge.

bge-m3 was byte-identical across the tokenizer change, which is the check that nothing else moved.

## A pooling bias this experiment nearly walked into

The stemmed retriever was added to the runner but not to the judging pool. A system left out of
the pool gets no chance to contribute a relevant chunk and is then measured against ground truth
the others built — which would have quietly penalised the one retriever under test, with nothing
failing and no number looking wrong. Adding it raised the pool from 66 pairs to 97: 31 candidates
that only the stemmer surfaced.

## A metric that was not reported

The gap is larger on recall@10 (0.271 → 0.354) and a bootstrap there would plausibly clear zero.
It was not run. The metric was fixed before the experiment and switching to whichever one reaches
significance is the most ordinary way to manufacture a result — particularly indefensible in a
project whose whole claim is that measurements need checking.

## Decision

Adopt it. On the hard set — the one that stands in for real use — the gain is established at
+0.067 [0.008, 0.128] nDCG@10, and MRR moves 0.275 → 0.378, which is the first relevant chunk
arriving around rank 3 instead of 4. It costs nothing measurable (p50 unchanged at ~0.2 ms, no
dependency) and the only observed downside is damage to English tokens.

It does not change the deployment decision, which stays bge-m3: stemming closes about a fifth of
the gap between BM25 and dense retrieval, not the whole of it.

## How the stemmer was built

A light suffix stripper: case endings longest-first, two passes, then possessives, with a minimum
stem of four characters. Written from the standard approach rather than reproduced from a
published algorithm, so it is judged by what it conflates here — vocabulary 13 475 → 10 952
(−19%), with the merged groups checked by hand.

Two things were removed after they proved wrong on real words:

- **Blind palatalisation** (`c$`→`k`, `z$`→`h`) rewrote `ulic` to `ulik` and `garaz` to `garah`.
  Undoing `ruka`/`ruce` requires knowing the alternation happened; applied blind it invented
  stems for far more words than it repaired.
- **A single pass** left `schematu` at `schemat` while `schemata` reached `schem`, so one noun
  landed on two stems depending on which case it was written in.

Known damage: English words are stemmed by Czech rules, and `stream` loses its `am` to become
`stre`. Guessing the language per token would add a second thing to be wrong about; consistency
between index and query matters more than linguistic accuracy, and both sides are stemmed alike.

Mild over-merge: `cesty`/`cesta` conflate with `čeština`/`češtině` under `cest`.
