# Pre-registration — how much of a fetched page the model should see first

> **This experiment was never run.** One of its four arms shipped on its own argument and is the
> deployed state; the rest are open. The document is kept because a pre-registration whose answer
> is "we did not collect this" is the case it was written to allow — the alternative is a decision
> rule chosen after the numbers, which is what fixing the rules in advance exists to prevent.
> Full reasoning under **Status** at the end.

**Written before any data was collected.** Task, arms, metrics and decision rules are fixed in
advance so the analysis cannot be chosen after the numbers arrive.

Narrowed repeatedly while being written — by arithmetic, by a research pass, and by a failed attempt
to settle it with live runs. What is left is smaller than the question that started it, and what
fell away is recorded rather than deleted: those are the reasons the remainder is worth asking.

**The failed attempt is itself a finding.** Comparing single real-model turns does not work here.
Two runs at identical settings, on the same page and the same three-round shape, differed by 26%
(38,888 vs 48,977 tokens) — and that shape never triggers the pruner at all, so those comparisons
were measuring the model's variance over a code path that did not run. Every token figure quoted
from one turn on 2026-09-01 is void. The counts of rounds are not: they are deterministic given a
trajectory, and they are what the `PROTECT_RECENT_RESULTS` reasoning below rests on.

## What started this

`read_page` hands the model up to `MAX_PAGE_CHARS` characters inline, once, and the whole result
also goes to the archive. From the round after, `PRUNE_OVER_CHARS = 8192` shortens it to a head, a
tail, and a ref the model can re-read. The constant was 50,000 when this was written and is 100,000
now — that raise is arm D below, and every "50,000" in the sections that follow is the number this
document was reasoning against, not the deployed one.

The alternative, proposed 2026-09-01: hand the model a **short preview and the ref immediately**,
and let it ask for the rest if the preview is not enough. Storage is unchanged either way — the
archive already holds the whole page and `read_tool_result` already pages through it.

**What the pruner is worth, measured once.** A production turn on 2026-08-31, seven rounds: a
16,080-character page read before round 3 was re-sent four times at ~5,100 tokens each, out of that
turn's 67,615 input tokens. Keeping head and tail rather than the whole page cuts roughly two thirds
of each re-send — about 15% of that turn. That is one turn and inherits the variance recorded above,
but it is the number the pruner exists for, and unlike the comparisons it does not rest on two runs
being alike: it is a count of re-sends within a single trajectory.

Two decisions are welded into one constant, and any version of this question separates them:

```
what we keep         the archive, unchanged in every arm
what we show first   50,000 characters, or a preview
```

## Where the borrowed numbers come from

`PRUNE_OVER_CHARS = 8192`, `PRUNE_HEAD_CHARS = 4096` and `PRUNE_TAIL_CHARS = 1024` are
`dsh-compaction-tool-result-pruner`'s defaults. Checked at source rather than assumed:

- **No published rationale.** `deepseek-harness`'s `BENCHMARK.md` is a three-line stub. In
  [discussion #2107](https://github.com/deepseek-ai/deepseek-harness/discussions/2107), where the
  numbers appear in a workaround config, they are described as _"inherited defaults rather than
  tuned values"_ and _"no maintainer provided measurements defending these numbers."_
- **Their own web profile ships the pruner disabled, and _why_ is contested.** This said "by
  accident, as the fallout of an incomplete move of the compaction backend to the host plane"; a
  second source describes it as mounted by default in the base bundle and _explicitly_ disabled in
  the web-mode one. The pruner's own README settles neither — it does not state a default at all.
  Nothing here rests on the answer, so it stays recorded as open rather than resolved by preference.
- `hermes-lcm` has large-output externalisation **off by default**
  (`LCM_LARGE_OUTPUT_EXTERNALIZATION_ENABLED`), and when on it spills at
  `LCM_LARGE_OUTPUT_EXTERNALIZATION_THRESHOLD_CHARS`, **12,000 characters**, with a separate
  token-aware stub threshold of 25,000 tokens. Read from their README on 2026-09-02.

  **This document said 100,000, and 50,000 for MCP tools. Both were invented, and the first has a
  traceable origin worth keeping.** A literature pass, since folded into
  `docs/decisions/tool-boundary.md`, reported correctly that Hermes Agent's compressor "is described as sustaining coherent multi-hour sessions
  **within a 100K context window**". That is a window, not a threshold. It was read here as a
  spillover value, restated as "hermes-lcm spills at 100,000 characters", and then used to justify
  raising `MAX_PAGE_CHARS` to 100,000 — so a sentence about how much a harness _holds_ became a rule
  about how much of one page to _show_, with an attribution attached.

  The measured page distribution still supports being above 72,000. **An external number does exist
  and was found a day later**, once other harnesses were read instead of one: `deepseek-harness`
  caps `web_fetch` at `fetchMaxOutputChars`, default **200,000 characters**, bounding both the
  characters it converts and the rendered result. Ours is half of it. That does not make 100,000
  borrowed — it was still picked from our own distribution — but the case for it being reckless is
  gone, and it was the only remaining argument for treating arm D as provisional.

**Unmeasured is not wrong.** These defaults run in a widely used harness without visible complaint,
which is weak evidence but not none — weaker than it looks, though, because a pruner that is too
aggressive costs answer quality, and quality complaints are exactly what does not surface as a bug
report. What this rules out is _adopting the numbers on the authority of whoever chose them_.

## What fell away, first: the model's window is 1.31M, not 131k

Measured 2026-09-01 from this deployment's own `/api/models`:

```
deepseek/deepseek-v4-flash-latest   1 310 720
deepseek/deepseek-chat                163 840
deepseek/deepseek-r1                   64 000
Workers AI models (2026-08-12)         24 000 – 131 072
```

An earlier draft of this document reasoned against a 131k window and concluded that a single
`read_page` was a large fraction of the verbatim tail compaction keeps. Against 1.31M it is not:
`COMPACT_KEEP = 0.25 × context` is ~983,000 characters, and 50,000 is 5% of it.

**So on the deployment's default model there may be nothing here to fix.** That has to be said
first, because everything below is about the picker's low end rather than about normal operation.

## What fell away, second: the safety half needs no eval

The constant is still wrong in the way `HISTORY_SOFT_CAP = 50` was wrong, and
`docs/decisions/history-and-archive.md` already records that lesson: a threshold in absolute units
cannot hold across a picker whose models span 24k to 1.31M. Same arithmetic, at the low end:

```
                    24k window            1.31M window
verbatim tail       18 000 chars          983 000 chars
MAX_PAGE_CHARS      50 000 chars          50 000 chars
                    2.8× the whole tail   5% of it
```

A single page read cannot fit in a 24k model's verbatim tail at all, so after a compaction that
tail _is_ that one page. That is a defect derivable from constants already in the repo, and fixing
it is a change of shape — a fraction of the window, as compaction already does — not a measurement.

**One published number belongs in that fraction, and an earlier draft of this section had it
wrong.** It said 60–70% of the advertised window, citing RULER. RULER states no such rule: it
defines effective length as the longest length holding above a quality threshold and reports that
_"almost all models fall below the threshold before reaching the claimed context lengths"_ — GPT-4's
128K claim resolving to 64K, i.e. 50%. NoLiMa (arXiv:2502.05167) is harsher once literal lexical
matches are removed: 10 of 12 models below half their short-context baseline at 32K, and GPT-4.1's
effective length around 16K against a claimed 1M. Chroma's 18-model report finds degradation on
every model, on trivial retrieval, worse with distractors.

So the denominator is the _discounted_ window and the discount is **~50%, lower for hard multi-hop
reads** — not 60–70%, which was a vendor-blog gloss this document repeated for a day.

This half is **not part of this eval**. It ships on the arithmetic above — and it has now shipped,
as `RESULT_SHARE_OF_WINDOW = 0.10` in `context-window.ts`, applied by the loop to every tool result
rather than by `read_page` to itself. Two things came out of writing it that this section had not
anticipated:

- **The rule belongs to the loop, not the tool.** A handler that cuts for itself cuts the archive
  row too, which is how `search_memory` filed 4,041 of 12,213 characters while offering a ref to the
  rest. So the window check sits beside the archive write, and every tool inherits it.
- **An unknown window must not be read as a small one.** `DEFAULT_CONTEXT_TOKENS = 24000` is the
  right guess for scheduling a compaction, where being wrong costs a pass nobody notices. Here it
  would cut nine tenths off every first page read on the 1.31M default model, because a thread's
  window is simply unresolved until something asks the catalogue. The two cases point opposite ways
  and the constant is not transferable between them.

**Where it actually bites is the scout**, which this document did not consider at all. A scout has
an archive of its own now, but no overflow retry, so a request over the window does not degrade,
it loses the angle as
`scout-failed`. Arms B and C are about a chat turn with three nets under it; the scout has none.

## What is actually left to measure

Only this: **below the size the arithmetic already permits, does a preview cost answers?**

The published work says this cannot be borrowed, and says why twice over.

- "Masking Stale Observations Helps Search Agents — Until It Doesn't" (arXiv:2606.00408) sweeps
  4B–284B backbones over three retrievers and finds an asymmetric inverted-U against the model's
  unmanaged accuracy: a plateau under weak retrievers, a peak where a strong retriever meets a
  mid-capacity model, and a **sharp collapse when the model is saturated**. Its framing is the one
  adopted here — _"a token-for-turn trade-off, where success depends on whether added turns convert
  failures into successes or remove needed evidence."_ Shape depends on the backbone; a point on
  their curve is not a point on ours.
- Size sensitivity is **task-dependent as much as model-dependent**: _"a model that handles simple
  retrieval well at 5,000 tokens may fail at complex sorting or summarization tasks at just 400 to
  1,200 tokens."_ Pulling one fact out of a page and comparing two pages are not the same question,
  and this deployment does both.

`LineRetriever` (arXiv:2507.00210) was the one paper that might have retired this document by
supplying a transferable ratio. Read since: it does not, and it argues the other way. Measured
reductions of 61–73% cost real success — 52.7% → 44.8% on WorkArena L1 at 61% — and a
structure-preserving variant at only 30% reduction recovers to 49.1%. Naive semantic chunking
collapses outright, 19.4% against 52.7%. Its one directly useful number is about the _first_ look,
not the remnant: bottom-truncating at 10K tokens rather than 40K costs ~3.6 points, so a ~10K-token
head carries most of what is answerable.

The two sources this rests on were checked against their primary text and are cited in
`docs/decisions/tool-boundary.md`.

## Arms

Byte-identical questions, byte-identical pages, one variable.

- **A — inline.** `MAX_PAGE_CHARS = 50000`, `PRUNE_OVER_CHARS = 8192`, `PROTECT_RECENT_RESULTS = 1`.
  Written as "today" before arm D shipped; it is now the _old_ baseline, and a run must set the
  constant back to 50,000 rather than assume the deployed value.
- **B — preview first.** `read_page` returns head + tail totalling ~8,000 characters plus the ref;
  the model reaches the rest through `read_tool_result` windows.

  **No harness read so far ships this arm, and one sentence here claimed otherwise.** It said
  `hermes-lcm` never hands the model a large first view — "arm B, as somebody's default". They have
  the mechanism and it is **off by default**, which the section above this one already said
  correctly, so the document contradicted itself for a day. Corrected 2026-09-02.

  What the same day's reading did settle is the other end. `deepseek-harness`'s `web_fetch` caps at
  `fetchMaxOutputChars`, default **200,000 characters** — twice arm D's first view and four times
  arm A's. So the only comparable number found runs _against_ arm B rather than for it, and the
  question the arm poses is open in the direction this document did not expect.

  **It does not retire `RESULT_SHARE_OF_WINDOW`, which this document twice said it would.** Traced
  2026-09-02 rather than argued: a ~8,000-character first view does fit both ends of the picker, so
  `read_page` stops needing the fraction — but the rest of the page is then fetched through
  `read_tool_result`, whose `WINDOW_CHARS = 40000` is ~13,300 tokens, over half of a 24k window, and
  absolute. Arm B makes that tool the _common_ path rather than the rare one, so it **moves** the
  variable-window problem onto the one cap still expressed as a constant. Bounding that window by
  the model's is `resultCap` again under another name.

  The saving is nil in any case: `resultCap` is applied generically in `fileAndTrim`, one line for
  all nineteen tools. Narrowing it to one tool deletes nothing and adds a condition. So arm B must
  be argued on re-send tokens — the reason written above — and measured. **As a simplification it
  is a loss**, and it costs a round per page on every size in the measured distribution (72k, 64k,
  38k, 27k, 24k), two on the largest.

- **C — prune a round earlier.** `PROTECT_RECENT_RESULTS = 0`, everything else as A.
- **D — a larger first view.** `MAX_PAGE_CHARS = 100000`, everything else as A. **Deployed
  2026-09-01 without being run**, which is the one place this document describes something already
  shipped: 50,000 cut every page in the measured distribution (72k, 64k, 38k, 27k, 24k), and 100,000
  is a round number of ours — see the correction above. It is recorded as an arm rather than as a decision
  because what it costs — a page between the two values re-sent whole until the pruner reaches it,
  which is round four at the earliest — is exactly what B and C are about. A run of B or C against
  the deployed constant measures D as well and confounds both.

All four run on `deepseek/deepseek-v4-flash-latest`, the deployment default, at the same temperature.
Any other difference — model, page set, prompt — voids the run. **This is a replication in our
setting, not an audit of the published sweep**, in the same sense as
`thinkingcap-preregistration.md`.

### Why arm C exists, and why it goes _below_ every published value

Pruning has two independent gates, and only the first is `PROTECT_RECENT_RESULTS`:

```
N        is this result old enough to be a candidate?
threshold  is it over 8,192 characters and does it carry a ref?
```

The second gate is narrow by construction: `truncate`'s default 4,000 keeps every tool under the
threshold except the three that raised `maxResultChars` — `read_page` (50k), `read_tool_result`
(44k), `read_research_report` (40k). So `N` only ever decides when a _document_ stops being re-sent.

The first gate is where the horizon bites. The prune runs after a round's completion, so a result is
first considered one round after it arrives, and `N` delays it further:

```
N = 0   whole for 1 completion, then shortened   acts from R ≥ 3
N = 1   whole for 2                              acts from R ≥ 4   ← today
N = 3   whole for 4                              acts from R ≥ 6
```

Measured over 16 real-model turns on 2026-09-01: **13 had fewer than 4 rounds.** So today's `N = 1`
does nothing in most turns, and `N = 3` — the floor of the deployed defaults, tried and reverted the
same day — did nothing in 15 of 16. The published values (`M = 10` SWE-agent, `K = 5` search) come
from 250- and 500-turn horizons where ten recent observations is a rounding error; ours is 2–10
rounds, so the same reasoning that rejects raising `N` argues for lowering it. Arm C is that.

### What a null on C also settles

If A and C are indistinguishable, that is an argument **against** exposing `N` as a setting — a knob
between two values nobody can tell apart is surface without benefit, and the user has less evidence
than this document does. If C wins, the preset shape belongs in the settings dialog, when there is one
("gentle: documents stay in view longer, turns cost more" / "lean: documents are shortened sooner,
the model re-reads"), never `N` as a raw number.

## Task

30–40 questions over real pages: for half the set the known answer appears **only in the tail** of
the page, for the other half in the opening. The split is the point — arm B is expected to win where
the opening suffices and to lose where it does not, and a set weighted to either end would decide
the result by construction.

`evals/data/` is not the corpus here — it is Claude Code transcripts, which contain no pages — so
this needs its own fixture set, stored as fetched HTML so both arms read identical input and no
vendor is called twice.

## Primary metric

**Answer contains the known fact**, judged per item, paired by question, reported as the difference
in success rate with a 95% paired-bootstrap interval.

A correctness metric, not a token metric, deliberately: the cheap arm is only better if it is not
also wronger.

## Secondary metrics

- `tokensSpent` per turn and rounds used. Arm B should spend fewer tokens and more rounds.
- How often arm B calls `read_tool_result` at all — a model that never asks for the rest is the
  failure the primary metric is watching for.
- Wall clock, recorded with the caveat that it tracks provider load rather than the arm.

## Decision rule, fixed in advance

- **Adopt B** if its success rate is not worse (interval's lower bound above −0.05) _and_ it spends
  measurably fewer tokens.
- **Keep A** if B loses accuracy beyond that bound, whatever it saves.
- **If both intervals cross zero**, keep A and record the null — the outcome
  `chunking-experiment.md` reached, and the same rule after it: a null is not a licence to adopt the
  change on argument later.

## What would void the run

- Any prompt change between arms, including the system-prompt line that names `read_tool_result`.
- A page whose content changed between the arms' fetches — hence the stored fixtures.
- Fewer than 30 items with a verified known answer.

## Status

**Not run, and possibly not worth running** — arm D excepted, which shipped unmeasured and is the
current deployed state. Two things would retire the rest: the window-fraction fix landing and
proving sufficient, or `LineRetriever`'s full text supplying a reduction ratio that transfers.

Written 2026-09-01 after a real-model session established that the machinery works end to end —
`stage: 'pruned'` fired twice on one turn (44,951 and 14,145 characters), and the model called
`read_tool_result` across a turn boundary without being told to. Both facts make arm B plausible.
Neither says it is better.
