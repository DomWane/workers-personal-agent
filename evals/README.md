# Evals: what was asked, and what came back

The agent searches its own memory, and every choice about how was measured rather than argued.
This is the index; each row links the write-up that holds the method, the numbers and the decision
rule.

Four things to know before reading any of them.

**What is here scores a corpus; the step that builds one is not**, for the reason the next
paragraph gives.

**The corpus is not here and never will be.** It is 673 real Claude Code exchanges from working
sessions, so `evals/data/` is git-ignored and the numbers below cannot be reproduced from this
repository. That is a real limitation of these results and not a formality: read them as a record
of how the decisions were made, not as a benchmark anyone can re-run.

**The scripts that call out read the same `.env` as `wrangler dev`.** `ingest.traces` wants
`CF_ACCOUNT_ID` and a `CF_API_TOKEN` with Account Analytics: Read; `models.llm_judge` wants
`JUDGE_MODEL`, `JUDGE_API_BASE` and `JUDGE_API_KEY`. The rest run offline over `evals/data/`.

## Running it

The harness is a Python project: `uv` manages the interpreter and the dependencies, `pytest` runs
the tests, `ruff` and `pyright` keep it honest. Everything runs from this directory.

```bash
cd evals
uv sync                                   # Python 3.14 and the dependencies, into .venv
uv run pytest                             # the unit tests, no data needed
uv run ruff check && uv run pyright       # what CI runs

uv run python run_retrieval.py            # score every retriever, write results/latest-retrieval.json
uv run python turn_table.py               # traces.jsonl → results/turns.csv, the publishable projection
uv run python -m ingest.traces            # export the last 3 days of Workers Logs into data/
uv run python -m gen.queries              # generate candidate queries (OpenRouter)
uv run python -m label.prescreen          # flag candidates a human would probably drop
uv run python -m label.retrieval          # keep / drop / edit the bulk set, interactively
uv run python -m label.hard               # write the hard set from memory, then locate the target
uv run python -m label.pool hard 3        # judge the union of every retriever's top-3
uv run python -m embed.precompute         # bge-m3 vectors for the corpus and the queries (Workers AI)
uv run python -m embed.rerank_precompute  # cross-encoder order per query (Workers AI)
uv run python -m embed.fasttext_extract   # corpus vocabulary out of cc.cs.300.vec.gz
uv run python -m models.compare           # ThinkingCap: both models over the same context
uv run python -m models.judge             # blind pairwise preference, interactively
uv run python -m models.llm_judge         # the same pairs through an LLM judge
uv run python -m models.judge_agreement   # Cohen's κ between the two
uv run python -m models.analyze           # the pre-registered analysis
```

The harness was ported from TypeScript in September 2026. The retrieval runner reproduces the
TypeScript numbers bit for bit, including every bootstrap interval, because the PRNG (`mulberry32`)
and the naive float summation were carried over unchanged. `results/` was written by the TypeScript
harness and stays valid.

**A negative result is a result.** Past the baseline there are five experiments below. One was
adopted on a clear win, **three were rejected outright**, and one came back null and was adopted on
a different argument entirely. Two of the rejections had a prediction written down before the run
that turned out wrong. All of them are kept in full.

## Retrieval: which retriever, and what to feed it

| Write-up                                                        | The question                                                                                                      | What came back                                                                                                                                                                                                                                                                                                       |
| :-------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [retrieval-baseline](results/retrieval-baseline.md)             | Five retrievers over 673 exchanges and 78 labelled queries                                                        | `bge-m3` at 0.588 bulk / 0.417 hard nDCG@10, well clear of the lexical field. The baseline everything else is measured against: **later write-ups report the same system at 0.426 hard**, because each new experiment pooled its own candidates and grew the judged set; the write-up says so where the number is    |
| [stemmer-experiment](results/stemmer-experiment.md)             | Does Czech stemming rescue BM25, when `formulář` and `formuláře` are unrelated tokens to it?                      | **Adopted.** +0.067 [0.008, 0.128] on the hard set, MRR 0.275 → 0.378 (the first relevant chunk arriving around rank 3 instead of 4) at no measurable cost                                                                                                                                                           |
| [fasttext-experiment](results/fasttext-experiment.md)           | What does a trained document embedder actually buy over averaged static word vectors?                             | **Rejected, and the prediction was wrong.** Averaged `cc.cs.300` vectors score 0.057 on the hard set and _lose_ to plain substring matching at 0.085. The comparison is deliberately unkind to the older method (averaging is not what those vectors are for), and that is what makes the gap to 0.417 worth stating |
| [hybrid-rerank-experiment](results/hybrid-rerank-experiment.md) | The standard production RAG recipe: BM25 + dense fused by RRF, then a cross-encoder                               | **Both made retrieval worse.** Added because the design is conventional, not because the data asked for them, and removed for the same reason                                                                                                                                                                        |
| [chunk-cap-experiment](results/chunk-cap-experiment.md)         | Ingest discards 58% of reply text, and the tail is where a reply reaches its verdict. Keep more, retrieve better? | **The opposite happened.** Every larger embedding window scored worse                                                                                                                                                                                                                                                |
| [chunking-experiment](results/chunking-experiment.md)           | Chunked index against a truncated one, 78 labels, paired bootstrap                                                | **Null; every interval contains zero.** Adopted anyway, on coverage rather than ranking: half the vault's characters were outside the index, which this experiment could not see because it only ranks documents that were already findable                                                                          |

## Pre-registrations

Task, arms, metrics and decision rules fixed before any data, so the analysis cannot be chosen
after the numbers arrive. The cost of that discipline is visible here: one of the two ends in "we
did not collect this", and it is kept.

| Write-up                                                        | Status                                                                                                                                                                                                                                                                                                                                                                                                |
| :-------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [thinkingcap](results/thinkingcap-preregistration.md)           | Ran. [First results](results/thinkingcap-results.md) went through aggregators whose quantisation and routing were unknown, at temperature 0 and a single pass, and are **superseded** by [the matched replication](results/thinkingcap-results-matched.md) on FP8 endpoints at the authors' sampling over three seeds. The weaker file stays because the amendments cite it; the two are never pooled |
| [inline-page-size](results/inline-page-size-preregistration.md) | **Never run.** One of four arms shipped on its own argument and is the deployed state; the rest are open                                                                                                                                                                                                                                                                                              |
