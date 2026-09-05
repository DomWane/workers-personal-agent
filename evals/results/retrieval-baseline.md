# Retrieval baseline — 2026-08-01

Which retriever should the agent use to search its own memory? Corpus of 673 chunks (one Claude
Code exchange each, 2026-06-13 to 2026-07-30), 78 labelled queries, five retrievers.

| retriever                           | bulk nDCG@10 | hard nDCG@10 | hard MRR  |
| ----------------------------------- | ------------ | ------------ | --------- |
| fastText (static vectors, averaged) | 0.085        | 0.057        | 0.078     |
| keyword (substring)                 | 0.082        | 0.085        | 0.112     |
| BM25                                | 0.178        | 0.222        | 0.275     |
| BM25 + Czech stemming               | 0.238        | 0.288        | 0.378     |
| **bge-m3 (dense)**                  | **0.588**    | **0.417**    | **0.447** |

Paired bootstrap on nDCG@10, 10 000 resamples, 95% interval:

| comparison        | bulk                      | hard                      |
| ----------------- | ------------------------- | ------------------------- |
| bge-m3 − BM25     | **+0.410 [0.278, 0.544]** | **+0.195 [0.066, 0.323]** |
| BM25-stem − BM25  | +0.060 [−0.003, 0.130]    | **+0.067 [0.008, 0.128]** |
| BM25 − keyword    | **+0.097 [0.033, 0.162]** | **+0.137 [0.054, 0.230]** |
| bge-m3 − fastText | **+0.503 [0.372, 0.629]** | **+0.360 [0.221, 0.502]** |

Dense retrieval wins on both label sets by a wide margin. Every step up the table is backed by an
interval clear of zero, with one exception: stemming on the bulk set stops at −0.003.

That exception is explainable rather than noisy. Bulk queries are generated paraphrases with a
median 0.22 share of their words present in the relevant chunks at all, against 0.29 for the hard
set; there is so little lexical overlap left on the bulk side that conflating word forms has
little to join. On the hard set, where queries are the
author's own remembered phrasing, the same change clears zero.

## Two label sets, and why

**bulk (n=48)** — queries generated from a chunk by an LLM, then reviewed by hand. Cheap to
produce and to regenerate, which is what gives the comparison its statistical power. 1.04 relevant
chunks per query.

**hard (n=30)** — queries written from the author's own notes and memory, months after the work,
with the query locked before the corpus was searched. This is the task the agent actually
performs. 2.53 relevant chunks per query after pooling. **All 30 targets were located by date or
project, never by typing query words** — searching by the query's own words would have restricted
the set to chunks a lexical retriever can find, inflating exactly the retrievers under test.

They are never averaged. The interesting quantity is the gap: dense falls from 0.588 to 0.417
while BM25 _rises_ slightly, because the bulk set's generated paraphrases are in some ways harder
for a lexical matcher than a human's remembered wording.

A further 11 queries were written and found to have **no answer in the corpus at all**. They are
kept in `hard.unmatched.jsonl`: the limit on this agent's memory is at least as much coverage as
retrieval, since the corpus holds only the days its author worked _with_ the agent.

## What the numbers are not

**recall@3 is capped.** Recall divides by the number of relevant chunks, so a query with seven of
them cannot exceed 3/7 at k=3. The runner prints the reachable maximum next to the score (0.932 on
the hard set). This is why nDCG and MRR lead the table.

**recall@10 is a lower bound.** Pooling judged the union of all five retrievers' top-3, so
positions 4–10 hold chunks nobody assessed.

**Neither is a claim about answer quality.** This measures whether the right chunk is retrieved,
not whether the agent then answers correctly.

## The judging standard, and what it cost

Ground truth started at roughly one relevant chunk per query, which understates every retriever: a
corpus this redundant answers a question in several places, and a retriever finding a
different-but-correct chunk was scored as wrong. Pooling — judge the union of every system's
top-3, blind to which system returned what — raised the hard set to 2.57 relevant per query across
327 judgments, of which 21 were accepted.

**So the hard-set number here is not the one the later write-ups quote, and that is the pool
growing rather than a disagreement.** This document's `0.417` is measured against 2.57 relevant per
query across 327 judgments. The fusion and reranker experiments that came afterwards contributed
their own candidates, which took the hard set to 2.73 across 394 judgments and moved the same
system to `0.426`; `docs/retrieval-eval.md`, `hybrid-rerank-experiment.md` and
`chunking-experiment.md` all report it at that. Comparisons are only ever made within one pool, so
nothing below is affected — but a reader putting two of these files side by side sees two numbers
for one retriever and deserves to be told why.

Each retriever was pooled as it was added, never after the fact. Adding the stemmed variant to the
runner but not the pool would have scored it against ground truth the others built; the same
applied to fastText, whose 84 unjudged candidates were judged before its numbers were quoted. One
of the 84 was relevant, so the correction was small — but it was measured rather than assumed.

The first 82 judgments were made leniently (22% accepted), the next 64 strictly (1.6%). Rather
than leave the set split between two standards, the 18 lenient acceptances were re-judged against
the strict one and seven were withdrawn — mostly chunks from the same _topic_ but a different
_episode_, and messages to operators rather than findings. That pass cost 0.06 nDCG and did not
move the conclusion, which is the one thing a single lenient run could never have shown.

Pooling has a known blind spot it cannot fix: a relevant chunk no retriever ranks in its top-3 is
never offered for judging. One query's episode had four decision points and only one surfaced; the
other three were added by hand. Doing so _lowers_ every retriever's recall equally — it is the
opposite of a selection that would flatter the measurement.

## Known limits

- n = 30 on the hard set. Intervals are wide.
- Stemming on the bulk set remains unresolved at [−0.003, 0.130].
- Hard queries come from days the author worked _with_ the agent, a subset of the days he worked.
- The Czech stemmer is a light suffix stripper written for this project, not a published
  algorithm. See `stemmer-experiment.md`.
- Static word vectors were run with mean pooling only; why they do so badly is a hypothesis this
  corpus cannot test. See `fasttext-experiment.md`.
