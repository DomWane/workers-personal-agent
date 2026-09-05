# Hybrid search and reranking — 2026-08-01

Testing the standard production RAG recipe on this corpus: BM25 + dense fused with Reciprocal Rank
Fusion, then a cross-encoder reranking the union down to the final ranks. Both stages were added
because the design is conventional, not because anything in the data asked for them.

**Both made retrieval worse.**

## Prediction, written before the runs

Hybrid gains a little — the corpus is full of exact tokens (`BOM`, `ECONNRESET`) that lexical
matching should catch and embeddings blur. Reranking gains more, because dense `hit@3` is
53% against `hit@50` 73% on the hard set, a 20-point gap that a cross-encoder exists to close.

## Results

|                             | hard nDCG@10 | vs dense               | bulk nDCG@10 | vs dense                    |
| --------------------------- | ------------ | ---------------------- | ------------ | --------------------------- |
| **bge-m3 (dense)**          | **0.426**    | —                      | **0.588**    | —                           |
| RRF 1:1                     | 0.397        | −0.029 [−0.105, 0.040] | 0.494        | **−0.094 [−0.179, −0.007]** |
| RRF 2:1                     | 0.399        | −0.028 [−0.090, 0.027] | 0.537        | −0.051 [−0.132, 0.028]      |
| RRF 4:1                     | 0.399        | −0.028 [−0.085, 0.022] | 0.555        | −0.034 [−0.114, 0.046]      |
| union → `bge-reranker-base` | 0.375        | −0.051 [−0.156, 0.046] | 0.330        | **−0.259 [−0.384, −0.131]** |

Weighting RRF towards the stronger retriever monotonically reduces the damage, converging on plain
dense. There is no weight at which fusion helps.

The reranker moved the relevant chunk **up for 6 queries and down for 28** on the bulk set. That is
the failure mode a reranker is supposed to fix, running in reverse: it is not rescuing buried
chunks, it is demoting correct ones.

## Why fusion cannot use the headroom it appears to have

The union of both retrievers' top-20 covers 24 of 30 hard queries against dense's 20, and the
stemmed BM25 finds a relevant chunk dense misses entirely on 4. The recall headroom is real.

RRF cannot reach it. The chunks only BM25 finds sit at ranks 10–20 of a list whose first ten are
wrong, and rank fusion at k=60 cannot lift a rank-12 entry past a rank-2 one from a retriever
scoring 0.13 nDCG higher overall. Fusion assumes roughly comparable inputs; these are not.

## The reranker: three checks

**Input window is not the cause.** Re-run at 600, 1600 and 3000 characters per candidate:

| window | hard  | bulk  |
| ------ | ----- | ----- |
| 600    | 0.338 | 0.336 |
| 1600   | 0.335 | 0.330 |
| 3000   | 0.336 | 0.329 |

Identical within noise, which also indicates the model truncates internally well below 600
characters — so chunk length is not what it is failing on.

**Language is the likely cause.** Workers AI hosts `@cf/baai/bge-reranker-base` and no
multilingual variant. `bge-m3` is explicitly trained for 100+ languages; the base reranker is an
English/Chinese model. The pipeline therefore pairs a multilingual first stage with a
monolingual second one, and every query here is Czech.

**Not tested:** a multilingual reranker (`bge-reranker-v2-m3`) run off-platform. That would
separate "reranking does not help this corpus" from "the reranker available on this platform does
not handle Czech". The distinction matters and is not resolved here.

## Pool bias, measured rather than assumed

Both systems promote chunks into their top-3 that no earlier judgment covered — RRF 134, the
reranker 178 — and unjudged counts as non-relevant, so the first numbers were floors. Both were
then added to the pool and their hard-set candidates judged blind: **67 assessments, 5 accepted**,
a 7% rate against 6% in the earlier batch, so the standard held across sessions.

The hard-set figures above are post-pooling. The reranker recovered from −0.081 to −0.051, which
says incomplete ground truth had been carrying part of its deficit and the rest is the model.
Fusion did not move at any weight.

Bulk stays unpooled and its figures remain floors. Its deficits (−0.094 fusion, −0.259 reranking)
are too large for any plausible number of missed relevant chunks to reverse.

## What this replicates

The Reddit case study _"Hybrid search and reranking made my RAG worse"_ (250 curated Q&A pairs,
crypto support bot) found the same ordering: dense alone best, reranking −10 points, hybrid −19.
This corpus is different in size, language and content and reproduces the direction.

Its diagnostic did not transfer, though. That write-up suggests reading the gap between `hit@3` and
`hit@50`: a small gap means ranking is fine and a reranker will hurt. This corpus shows a **large**
gap — 53→73 on hard, 54→90 on bulk — and the reranker hurt anyway. The gap says headroom exists;
it says nothing about whether a given reranker can reach it.

## What it cost, and what runs in production

Reranking adds one cross-encoder call over 20 candidates per query — real latency on a Worker, and
`$0.0031` per M input tokens. The agent keeps single-stage dense retrieval: fewer moving parts,
lower latency, better numbers.
