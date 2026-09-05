# Chunking versus one vector per document — 2026-08-15

`chunk-cap-experiment.md` (2026-07-31) found every larger embedding window scoring _worse_ and read
truncation as a focusing step. It listed one option as untested: splitting a document into several
vectors instead of embedding its head. This is that arm.

Corpus 673 exchanges, 78 labels (48 bulk, 30 hard), bge-m3, `@cf/baai/bge-m3` at 1024 dims.

| arm                                 | ingest cap | embedded                     | bulk nDCG@10 | hard nDCG@10 |
| :---------------------------------- | :--------- | :--------------------------- | -----------: | -----------: |
| **A** — today's shape               | 1200       | first 1600 chars, one vector |    **0.588** |    **0.426** |
| **B** — more text, still one vector | 6000       | first 1600 chars, one vector |        0.588 |        0.407 |
| **C** — chunked                     | 6000       | 1600/200, 1227 vectors       |        0.551 |        0.405 |

Paired bootstrap, C against A, 10 000 resamples:

```
bulk  all          n=48   -0.037  [-0.085, +0.014]
bulk  target>1600  n=26   -0.014  [-0.085, +0.066]
hard  all          n=30   -0.021  [-0.074, +0.031]
hard  target>1600  n=17   -0.007  [-0.096, +0.076]
```

**Every interval contains zero.** The point estimates lean negative, in the same direction as the
July finding, but nothing here separates from noise at these sample sizes. The result is a null, and
reporting it as "chunking is worse" would be the same error as reporting it as "chunking is better".

Measured cost, which is not null: 1227 vectors instead of 673, and dense search 0.75 ms → 1.42 ms per
query. Both scale with chunk count, and both are far from any ceiling this agent has (the Durable
Object CPU limit is 30 s, measured 2026-08-09).

## What this experiment cannot see, and it is the reason chunking ships anyway

Every document in arm A was **already retrievable**: its first 1600 characters were in the index. So
the comparison measures whether splitting improves _ranking_ among findable documents. It does not
measure whether splitting makes unfindable content findable, because this corpus has almost none —
the `target>1600` subset only means the target document is long, not that the answer lies past
character 1600 in it.

The vault has the second problem and it is arithmetic rather than hypothesis (measured against the
production vault on 2026-08-12): 50 802 of 103 783 characters are
inside the index, 11 of 24 memories are truncated, and `agent/memory/retrieval-eval.md` has 1600 of
its 14 444 characters represented. A query matching only the unrepresented part scores against
nothing.

So chunking is adopted on the coverage argument — a demonstrated gap, the practice every primary
source consulted uses — with this experiment contributing the thing it _can_
establish: **no measurable ranking cost**. That is a weaker claim than the one originally hoped for,
and stating it as anything stronger would misrepresent four intervals that all cross zero.

## The corpus nearly died to produce this

Ingest rewrites `evals/data/corpus.jsonl` in place. Run on 2026-08-15 it would have
produced **415 of the 673 exchanges**: Claude Code rotates transcripts, and 38% of the sources behind
a corpus built on 2026-08-01 were already gone. 48 of 121 labelled chunk ids no longer exist in the
sources.

It would not have failed. `partitionLabels` excludes labels pointing at missing chunks with a
warning and scores the remainder, so every number would have been computed over a different, smaller
label set and compared against previous runs as though it were the same measurement.

Two things came out of that. Re-ingesting at a higher cap now **merges by chunk id** instead of
overwriting — chunk ids are content-addressed over the raw exchange, so a
surviving id identifies the same conversation and only its text lengthens. And arm A's artifacts are
kept in `evals/data/arm-a-cap1200/`, because `evals/data/` is not reproducible and is now known not
to be.

The merge leaves a confound that has to be stated: 330 of 673 exchanges carry the higher cap and the
rest keep the old one, and the lengthened ones are exactly the _recent_ half. Arms B and C therefore
compare against A with a corpus that is longer in a non-random subset.

## What was assumed wrong before it was checked

- **"The corpus can test chunking."** It could not. `ASSISTANT_CAP = 1200` truncates replies at
  ingest, so before the merge only 54 of 673 entries exceeded 1600 characters and only 14 of 78
  labels had a target that long. Running it as-is would have produced an uninterpretable null — the
  same signature as the July run's hardcoded window, by a different mechanism.
- **"Re-ingesting is free and safe."** It destroys 38% of the corpus and 40% of the labels.
- **"A null here settles the question."** It settles the ranking question. The coverage question is
  not in this corpus at all.

## Not tested

Contextual prefixes on chunks (Anthropic's contextual retrieval): the prefix source is
`MEMORY.md`'s one-line descriptions, which exist in the vault and not in this corpus, and measuring
it against a proxy would produce a number about the proxy.

Whether retrieval improves for content that is _only_ in a document's tail — the failure chunking is
actually adopted to fix. That needs labels whose answer lies past character 1600, which neither this
corpus nor the vault has yet.
