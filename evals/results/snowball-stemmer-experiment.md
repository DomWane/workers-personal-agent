# Snowball Czech against the hand-written stemmer — 2026-09-27

Arms, metric, decision rule and prediction are in
[snowball-stemmer-preregistration.md](snowball-stemmer-preregistration.md). It was written before
the run but committed after it, so git does not prove the order. The only edit before the run was
the limit about queries typed without diacritics.

## Result

nDCG@10, `bm25-snowball − bm25-stem`, 95% paired bootstrap.

| set                          | `bm25-stem` | `bm25-snowball` | difference                |
| ---------------------------- | ----------- | --------------- | ------------------------- |
| hard, n = 30, before pooling | 0.293       | 0.276           | −0.017 [−0.049, 0.014]    |
| **hard, n = 30, after pooling** | **0.294** | **0.282**     | **−0.013 [−0.041, 0.017]** |
| bulk, n = 48, not pooled     | 0.238       | 0.222           | −0.016 [−0.047, 0.010]    |

Pooling the hard set at depth 3 with `bm25-snowball` included gave 7 unjudged pairs; 1 was judged
relevant. The new label moves every retriever's hard figures slightly, not only Snowball's.

MRR, descriptive only: hard 0.383 → 0.352, bulk 0.211 → 0.191.

`bge-m3` and every other existing row were identical to the previous results before pooling.

## Prediction

Predicted between 0 and +0.02 on the hard set, interval containing zero. The interval contains
zero; the point estimate is negative, outside the predicted range.

## Decision

**Null.** The hard-set interval contains zero, so by the pre-registered rule the hand-written
stemmer stays and `pystemmer` is not adopted for the deployed retriever. The arm stays in the
runner so the result can be re-run.
