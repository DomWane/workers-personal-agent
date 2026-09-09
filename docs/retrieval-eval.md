# Choosing a retriever by measuring it

I built a personal agent on Cloudflare Workers that stores what I have worked on and retrieves it
later. This is the evaluation I built to decide how it should search that memory.

**Result:** dense retrieval (`bge-m3`) beats BM25 by **+0.200 nDCG@10 [0.070, 0.326]** on queries
written the way I ask them. Czech stemming closes about a fifth of that gap at no inference cost.
Static word vectors, unweighted and mean-pooled, are not competitive here; §7 says how narrow that
result is. Neither hybrid fusion nor a cross-encoder reranker improved on plain dense retrieval
(§4). Five measurements were wrong before they were right. §6 lists them, because they are the
part that transfers to other projects.

## 1. Data

673 exchanges from my own Claude Code transcripts, 28 working days (2026-06-13 to 2026-07-30),
117k words, median 1177 characters. One human turn plus the assistant reply is one chunk, which is
the unit the agent retrieves. About three quarters are engineering work, the rest is building the
agent itself.

The corpus is my own working sessions and stays on the machine that produced it. It is not in the
repository, not shared, and nothing in it is quoted here; questions and findings are described
rather than reproduced. The harness reproduces, the result does not.

## 2. Labels

Two sets, built differently, never averaged.

**bulk (n=48).** An LLM reads a chunk and writes a question it answers; I review each and drop
about half. Each generated query is scored for word overlap with its source chunk and rejected
above a threshold, so the set does not degenerate into "find the chunk containing these words".

**hard (n=30).** Questions written from my own notes months after the work, wording locked before
the corpus was searched. The labelling tool enforces two rules that good intentions would not:

- **The query cannot be edited after searching.** A question revised once its answer is on screen
  drifts into the answer's vocabulary.
- **Locating the target is an unranked filter, never a retriever.** The tool searches by substring
  or date and returns hits chronologically. Ranking them would mean picking targets off a list
  some retriever chose, and the eval would then score that retriever against its own suggestions.

All 30 hard targets were located by date, so no target was selected for containing the query's
vocabulary.

A further **11 questions had no answer in the corpus at all** and are kept rather than discarded:
the corpus holds the days I worked *with* the agent, a subset of the days I worked.

## 3. Results

| retriever | bulk nDCG@10 | hard nDCG@10 | hard MRR |
|---|---|---|---|
| fastText (static vectors, mean-pooled) | 0.085 | 0.057 | 0.078 |
| keyword (substring) | 0.082 | 0.085 | 0.112 |
| BM25 | 0.178 | 0.226 | 0.279 |
| BM25 + Czech stemming | 0.238 | 0.293 | 0.383 |
| **bge-m3 (dense)** | **0.588** | **0.426** | **0.458** |

Paired bootstrap on nDCG@10, 10 000 resamples, 95% interval:

| comparison | bulk | hard |
|---|---|---|
| bge-m3 − BM25 | **+0.410 [0.278, 0.544]** | **+0.200 [0.070, 0.326]** |
| bge-m3 − fastText | **+0.503 [0.372, 0.629]** | **+0.369 [0.233, 0.509]** |
| BM25-stem − BM25 | +0.060 [−0.003, 0.130] | **+0.066 [0.007, 0.126]** |
| BM25 − keyword | **+0.097 [0.033, 0.162]** | **+0.140 [0.057, 0.233]** |

Stemming on the bulk set is the one comparison that does not clear zero, and it is reported as
unresolved. The split has an explanation: the median share of query words present in the relevant
chunks is 0.22 on bulk against 0.29 on hard, so on the bulk side there is less lexical overlap for
merged word forms to join.

**recall@3 is capped.** Recall divides by the number of relevant chunks, so a query with seven
cannot exceed 3/7 at k=3; the runner prints the reachable maximum beside the score (0.916 on
hard). That is why nDCG and MRR lead the table. **recall@10 is a lower bound**, because judging
covered the union of the top-3 of all seven pooled systems (the five above plus the fusion and the
reranker of §4), so positions 4 to 10 hold unjudged chunks.

**Only the hard set was pooled.** All 394 judgments are hard-set; bulk labels stayed at their
original one relevant chunk per query (mean 1.04). Every bulk figure above is therefore measured
against single-chunk ground truth and understates every retriever. It does so uniformly, so the
comparisons hold, but the absolute bulk numbers are floors rather than estimates.

None of this measures answer quality. That is a separate eval:
[thinkingcap-replication.md](thinkingcap-replication.md).

### Incomplete ground truth

One relevant chunk per query understates every retriever: a redundant corpus answers a question in
several places, and a system finding a different but correct chunk scores as wrong. TREC pooling,
which judges the union of every system's top-k without knowing which system returned what, raised
the hard set to 2.73 relevant chunks per query over **394 judgments**, of which 26 were accepted.
The low acceptance rate is itself a finding: on this corpus a specific question is usually
answered once.

Pooling cannot fix its own blind spot. A relevant chunk no retriever ranks in its top-3 is never
offered for judging. One query's episode had four decision points and only one surfaced; I added
the other three by hand, which lowers every retriever's recall equally.

## 4. The production recipe, tested and rejected

Single-stage dense retrieval is not what a 2026 production RAG stack looks like. The conventional
answer is hybrid search fused with Reciprocal Rank Fusion, then a cross-encoder reranking a wide
candidate window. I built and measured both.

| | hard nDCG@10 | vs dense | bulk nDCG@10 | vs dense |
|---|---|---|---|---|
| **bge-m3 (dense)** | **0.426** | — | **0.588** | — |
| RRF, dense:BM25-stem 1:1 | 0.397 | −0.029 [−0.105, 0.040] | 0.494 | **−0.094 [−0.179, −0.007]** |
| RRF 4:1 | 0.399 | −0.028 [−0.085, 0.022] | 0.555 | −0.034 [−0.114, 0.046] |
| union top-20 → `bge-reranker-base` | 0.375 | −0.051 [−0.156, 0.046] | 0.330 | **−0.259 [−0.384, −0.131]** |

Weighting the fusion towards the stronger retriever reduces the damage monotonically and converges
on plain dense. There is no weight at which fusion helps. The reranker moved the relevant chunk
**up for 6 bulk queries and down for 28**, which is the failure a reranker exists to fix, happening
in reverse.

**The recall headroom is real and fusion cannot reach it.** The union of both top-20 lists covers 24
of 30 hard queries against dense's 20, and the stemmed BM25 finds a relevant chunk dense misses
entirely on 4. But those chunks sit at ranks 10 to 20 of a list whose first ten are wrong, and RRF
at k=60 cannot lift a rank-12 entry past a rank-2 one from a retriever 0.13 nDCG stronger. Fusion
only works when its inputs are comparable, and these are not.

**The reranker's failure is not truncation.** Re-run at 600, 1600 and 3000 characters per
candidate, the scores are identical within noise (hard 0.338 / 0.335 / 0.336), which also suggests
the model truncates internally below 600 characters. The likely cause is language: Workers AI hosts
`@cf/baai/bge-reranker-base` and no multilingual variant, so the pipeline pairs a first stage
trained for 100+ languages with a second trained on English and Chinese, over an all-Czech query
set. A multilingual reranker off-platform would separate "reranking does not help this corpus" from
"this reranker does not handle Czech". That is untested.

**A published diagnostic did not transfer.** A widely shared write-up on the same two techniques
recommends reading the gap between `hit@3` and `hit@50`: a small gap means ranking is already good
and a reranker will hurt. This corpus has a *large* gap (53→73 on hard, 54→90 on bulk) and the
reranker hurt anyway. The gap establishes that headroom exists; it says nothing about whether a
given reranker can reach it.

**Both systems were then pooled, and the rejection held.** Judging their unjudged top-3 candidates
added 67 assessments (5 accepted, a 7% rate against 6% in the earlier batch, so the same standard).
The reranker recovered part of its deficit, from −0.081 to −0.051, confirming that incomplete
ground truth had been penalising it; the remainder is the model. Fusion did not move. The bulk
figures stay unpooled, so they remain floors, and the bulk deficits are large enough that no
plausible number of missed relevant chunks would reverse them.

## 5. The design decisions that carried the weight

**Content-addressed chunk ids.** A chunk's id is a hash of the raw exchange, taken at ingest
*before* any of the text rules that follow it, so changing one of them rewrites every chunk's text
but not its identity. That preserved the labelling across five changes in one day. The hashing
happens locally, and the raw exchange never leaves the machine it was read on.

**Unranked search during labelling** (§2) is the single decision that keeps the hard set from
measuring the retriever that helped build it.

**Fail-closed guards.** The runner refuses to start if a labelled query lacks a vector, if
embedded ids do not match the corpus, or if the stored text hash differs. Without the first, two
newly added queries would have scored a uniform zero, dragged the mean down, and looked like a
regression caused by adding queries.

**Recording bias rather than arguing it away.** Where a hand-edited query or a search-located
target could have leaked, the row carries a flag and the runner reports those rows against their
complement. Hand-edited queries score higher for every lexical retriever (BM25 0.37 against 0.18,
stemmed BM25 0.47 against 0.24) and *lower* for bge-m3 (0.48 against 0.53): the edits added words,
which helps only lexical matching. Seven of 78 queries are affected, so this is an indication
rather than a measurement.

## 6. Five silent failures, and what caught each

Each produced a plausible number. None failed loudly, which is why they are listed.

**1. The corpus ingested the conversation that built the eval.** Seven of the sixty queries
labelled at that point appeared word for word in chunks, because those chunks were transcripts of
me choosing the queries. They were perfect lexical matches that answered nothing, and they inflated
the lexical retrievers and polluted the judging pool. The labelling tool's similar-chunk suggestion
then offered them as also relevant and I accepted three.

I fixed it with a cutoff date rather than a content rule, because excluding chunks that contain a
labelled query would let the label set decide the corpus. It cost 86 chunks and one label. The
BM25-over-substring gap, which had looked established, dissolved to [−0.031, 0.115] on the clean
corpus. It re-established itself later on a larger, properly judged set, but the significance at
that moment had been partly contamination.

**2. A hardcoded cap made an experiment measure nothing.** Testing whether longer chunks retrieve
better, caps of 2400 and 3600 characters produced byte-identical numbers, because the embedding
step truncated its input at 1600. It read as a clean null result, which is exactly what an
unnoticed no-op looks like. The same investigation surfaced a vector cache that invalidated on
corpus text but not on embedding parameters, so raising the limit silently reused stale vectors.

**3. Two judging standards in one pool.** I judged the first half leniently and the second half
strictly: 22% acceptance, then 1.6%. Rather than redo the strict half I re-judged the 18 lenient
acceptances against the strict standard and withdrew seven, mostly chunks from the same *topic*
but a different *episode*. That cost 0.06 nDCG on the hard set and the conclusion held: dense over
BM25 was +0.228 [0.042, 0.413] before and +0.200 [0.024, 0.379] after. The table in §3 still
reports that point estimate, on an interval later judging narrowed to [0.070, 0.326]. A single
lenient pass could not have shown that the result was not an artifact of generous judging.

**4 and 5. Pool bias, twice.** I added stemmed BM25 to the runner and forgot the judging pool. A
system left out of the pool contributes no relevant chunks and is then measured against ground
truth the others built, so it loses quietly and nothing fails. Including it added 31 candidates
only it surfaced. I then repeated the mistake with fastText and caught it while re-reading my own
paragraph about the stemmer; judging its 84 unique candidates moved its hard score from 0.047 to
0.057.

## 7. Limits

- n = 30 on the hard set; intervals are wide and one comparison is unresolved.
- The Czech stemmer is a homegrown light suffix stripper, not a published algorithm. Two rules
  were removed after failing on real words: blind palatalisation turned `ulic` into `ulik`, and a
  single stripping pass left one noun on two stems.
- **The static-vector row is one configuration, not a verdict on static embeddings.** fastText was
  run as unweighted mean-pooling over ~1200-character chunks, which is the cheapest thing that fits
  an edge runtime and the reason it was the baseline. It is not the strongest way to use static
  vectors. Term weighting, SIF-style common-component removal and aligned cross-lingual vectors are
  all untested here, and the first two are the standard answers to exactly this setting. What the
  row supports is that naive pooling does not survive the move to paragraph-length chunks; the
  ceiling for the method is not what was measured.
- Why it does so badly is a hypothesis this corpus cannot test: the reply cap makes chunk lengths
  nearly uniform, so the "does it degrade with length" check has no range to work with. Of the
  candidate explanations only vocabulary is quantified. 6.9% of tokens are OOV English, which
  cannot account for a 0.369 gap.
- Coverage may bound this system more than retrieval does: 11 of 41 questions I wanted to ask had
  no answer in the corpus.

---

*The harness, the retrievers and the per-experiment write-ups are versioned alongside the agent in
this repository. The corpus, labels and judgments are not published.*
