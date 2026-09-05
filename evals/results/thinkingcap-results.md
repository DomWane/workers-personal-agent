# ThinkingCap-Qwen3.6-27B against its base model — results, 2026-08-01

> **Superseded, 2026-08-02.** These runs went through two aggregators whose quantisation and
> routing were unknown, at temperature 0 and a single pass. `thinkingcap-results-matched.md`
> reports the same comparison on matched FP8 endpoints at the authors' sampling over three
> seeds. The two are not pooled; this file is kept because the amendments refer to it.

Design fixed in advance in [thinkingcap-preregistration.md](thinkingcap-preregistration.md) with
five dated amendments. Every metric and cut below is named there; nothing was chosen after seeing
the numbers. Reproduce with `pnpm eval:models:analyze`.

**n = 30** questions from the hard set, both models given byte-identical input: the same
`bge-m3` top-5 context, temperature 0, `max_tokens` 16 000.

## The headline

**The token saving replicates. Capability formally holds, but the quality check is weak and leans
against the fine-tune.**

|                           | base `qwen/qwen3.6-27b` | tuned `thinkingcap-qwen3.6-27b` |
| ------------------------- | ----------------------- | ------------------------------- |
| reasoning trace, median   | 6 191 znaků             | **2 931 znaků**                 |
| completion tokens, median | 1 924                   | **898**                         |

| metric                        | median reduction | 95% paired bootstrap |
| ----------------------------- | ---------------- | -------------------- |
| **reasoning trace (primary)** | **47.6%**        | **[31.5%, 60.8%]**   |
| completion tokens             | 45.8%            | [30.8%, 52.8%]       |

The interval lies entirely above zero, so by the rule fixed in advance, **the saving replicates**
— in Czech, over real production context, a setting none of the card's benchmarks cover. The
card claims "50% less thinking tokens on average"; 47.6% median here is squarely consistent with
it. The trace was shorter on 25 of 30 questions.

### The number that keeps this honest

**Noise floor: 25.9%.** A resume bug asked 14 questions twice with identical input, which
accidentally measured each model against itself. No two answers were identical and traces differed
by a median of 26% — temperature 0 is not deterministic at either provider.

So the 47.6% saving is roughly twice the run-to-run noise, but **the lower bound of the interval
(31.5%) is only modestly above it**. The effect is real and the direction is not in doubt; the
precise magnitude is worth less than three significant figures.

## Quality — blind pairwise, 30 pairs

|                 | count |
| --------------- | ----- |
| ties            | 18    |
| decided         | 12    |
| base preferred  | 9     |
| tuned preferred | 3     |

Proportion preferring base among decided pairs: **75%, 95% Wilson [46.8%, 91.1%]**.

The interval includes 0.5, so by the pre-registered rule **capability is preserved**. That rule
should not be leaned on. With 12 decided pairs, the interval spans almost half the scale, and the
point estimate is 3:1 against the fine-tune. The honest statement is: _this design cannot detect a
quality difference of the size that might be present here._ It is not evidence of parity.

### How the tuned model lost

The losses are not diffuse — they share one shape. In items 5, 8, 15, 27 and 30 the tuned model
produced fluent, specific, verifiable-sounding answers **about a different episode than the one
asked about**, or promoted an adjacent detail to a cause:

- asked what happened to a stalled batch of records, it described — every detail correct — the
  handling of a different batch;
- asked where two services disagreed on a schema, it named a bug from a different week as the
  cause;
- asked how a routing decision was made, it took a definitional precondition and generalised it
  into the whole rule, contradicting the routing table in its own context;
- asked what permissions one internal component should get, it answered about a different one.

The base model's characteristic failure was the opposite: refusing when a partial answer was
available. Between the two, the base model's failure is the cheaper one for this application —
an incomplete answer sends you looking, a confidently misattributed one sends you away.

**This is a hypothesis about the fine-tune, not a finding.** Shorter reasoning plausibly means
fewer steps spent checking which episode the context actually describes, but the two models were
served by different providers at different (undisclosed) quantisation, and n = 12.

## Retrieval, not the model, was the binding constraint

**On 12 of 30 questions the shared context contained no chunk the labeller marked relevant.**

|                               | n   | base : tuned | ties |
| ----------------------------- | --- | ------------ | ---- |
| context held a relevant chunk | 18  | 6 : 2        | 10   |
| context held none             | 12  | 3 : 1        | 8    |

Those 12 test whether a model admits it does not know, not whether it can answer. Both largely
passed — 12 chances to invent something, and neither did. That is a result worth stating on its
own: the refusal behaviour held on both sides even where the retrieved context was misleading
rather than merely empty.

## Judging integrity

- **Sides randomised per question**, deterministically seeded, so a position preference cannot
  read as a model preference.
- **The judge never saw model names**, and neither did the reviewer who fact-checked claims
  against the corpus during judging.
- **Answer length is not a tell**: base median 505 characters, tuned 490; the tuned answer was
  shorter on 18 of 30. The saving is in the _reasoning_, which the judge never saw.
- **Verdicts did not track length**: the longer answer won 7 of 12 decided pairs, 95% Wilson
  [32.0%, 80.7%] — indistinguishable from chance.
- **One verdict was revised** after judging, when re-checking all 30 against the corpus revealed
  the first three had been judged under a laxer standard. Recorded in amendment 5.

## Limits, restated

- n = 30, one judge, one corpus, one language. Intervals are wide and one of them is nearly useless.
- **The two models are not served by the same provider.** DeepInfra serves the base at fp8;
  Sference does not publish theirs. A quality difference may be partly precision.
- `reasoning_tokens` was unusable on **30 of 60 runs** — Sference reports 0 while returning a full
  trace, and OpenRouter reported 1 token against 6 000+ characters five times. Excluded from the
  analysis; characters used instead.
- Both models inherit the same retrieval errors by design, which is the setting the agent runs in
  — but it means 12 questions tested refusal rather than reasoning.
- The corpus cannot be published, so this is reproducible in method only.
