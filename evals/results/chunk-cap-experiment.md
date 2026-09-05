# Reply cap and embedding window — 2026-07-31

Ingest keeps only the first `ASSISTANT_CAP` characters of each reply, which discards 58% of all
reply text across 79% of exchanges. The discarded part is the tail, where a reply reaches its
verdict, so the cap looked like a cheap win: keep more, retrieve better. The opposite happened.

Corpus 673 chunks, 59 labels (48 bulk, 11 hard), bge-m3.

| reply cap | embed window | bulk nDCG@10 | hard nDCG@10 |
| --------- | ------------ | ------------ | ------------ |
| **1200**  | **1600**     | **0.588**    | **0.470**    |
| 1200      | 8000         | 0.571        | 0.436        |
| 2400      | 3200         | 0.572        | 0.442        |
| 3600      | 4400         | 0.577        | 0.445        |

Every variant that gave the model more text scored lower, on both label kinds. Truncation is
acting as a focusing step: one vector over a longer passage covers more ground and matches a
specific question less sharply. The gaps are small (0.02–0.03) and carry no confidence interval —
the bootstrap in the runner compares retrievers within one corpus, not corpora against each
other. The evidence is the consistent direction across four configurations, not any single gap.

The default was already the best of the four. It is now measured rather than assumed.

## The bug this uncovered

The first run of this experiment produced byte-identical numbers for caps 2400 and 3600. The
embedder truncated its input at a hardcoded 1600 characters, so both corpora reached the model as
the same text — the experiment measured nothing and looked like a clean null result.

Two changes came out of it: the embedding window is configurable and documented as needing to
track the ingest cap, and `embeddings.index.json` records the window it was built with. Without
the second, raising the window leaves the corpus text unchanged, the text hash still reports
fresh, and stale vectors are reused silently — which is how the restored baseline first came
back wrong.

## Not tested

Splitting long replies into several chunks rather than truncating them. It is the remaining way
to keep the tail, and unlike a cap change it would alter chunk ids and cost a full relabel.
