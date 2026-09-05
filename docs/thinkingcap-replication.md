# Does ThinkingCap's token saving hold in Czech, over real work?

`bottlecapai/ThinkingCap-Qwen3.6-27B` claims *"capability of Qwen3.6-27B with 50% less thinking
tokens on average."* The release post measures it carefully — twelve out-of-domain benchmarks,
five seeds, per-question matched deltas — and lands at −45.8% out of domain, −57.7% in domain.
All of it is academic benchmarks in English or Chinese, and none of it answers from retrieved
context.

This tests the same claim on Czech questions about my own engineering work, answered from context
retrieved out of a working agent's memory.

**The saving replicates: 50.8% shorter reasoning traces, 95% CI [43.2%, 57.7%], shorter on 30 of
30 questions.** The capability half does not fail — but it has too little power to be read as
passing either, and §5 says why.

For a reader who wants only the practical answer:

- **Does the saving hold off-benchmark?** Yes, at the claimed magnitude, in Czech, over real work.
- **Is quality lost?** No difference was demonstrated, and this design could not have detected a
  small one. Ties on 24 of 30 pairs.
- **What was the actual bottleneck?** Retrieval, not reasoning. On 40% of questions the answer was
  not in the retrieved context for either model.
- **Can an LLM judge replace the human here?** No — κ = 0.31, 95% CI [−0.02, 0.62], and a quarter
  of its verdicts flip when the two answers swap places (§6).

## 1. Design

Fixed before the first API call: task, primary metric, decision rules, and what would count as a
failure to replicate. Ten amendments are dated and appended rather than edited in, including one
that withdraws a claim an earlier amendment made.

**Task.** 30 questions from the hard set of a retrieval eval over the same corpus
([retrieval-eval.md](retrieval-eval.md)): written from my notes months after the work, wording
locked before the corpus was searched, mostly diagnostic (*why did this break*, *why was this
decided*). A task with no reasoning in it cannot test a claim about reasoning tokens.

Each model receives the same top-5 chunks from `bge-m3` and answers from those alone.
Byte-identical input.

**Serving.** Both models in matched FP8 — the fine-tune's card states its quantisation is the same
DeepSeek-V3-style block-wise format at the same 128×128 block size that `Qwen/Qwen3.6-27B-FP8`
ships. Both deployed to dedicated endpoints on one NVIDIA RTX PRO 6000, same container
(`vllm/vllm-openai:v0.25.0`), same arguments, same region.

**Sampling.** The authors' published settings — temperature 1.0, top_p 0.95, top_k 20, min_p 0 —
over three seeds. 30 questions × 2 models × 3 seeds = 180 runs. Each question's trace length is
the median across its seeds.

**Corpus.** My own Claude Code transcripts, which stay on the machine that produced them: not in
the repository, not shared, and never quoted — questions and findings are described in this
document instead. The harness reproduces; the result does not.

## 2. What the first run could not settle, and what fixing it cost

The first version ran both models through commercial aggregators at temperature 0, one pass. It is
kept in the repository and superseded, for two reasons found afterwards.

**Neither side's precision was known.** OpenRouter lists nine endpoints for `qwen/qwen3.6-27b`:
seven declare fp8, two declare nothing, none offers bf16. No provider was pinned and none was
recorded, so which host answered any given question is unrecoverable. That the routing varied is
visible in the throughput — the base model's runs span 24–97 tok/s against 64–88 for the
fine-tune, whose host disclosed no quantisation at all.

**The sampling was wrong for the claim.** The authors measured at temperature 1.0 over five seeds,
explicitly because reasoning quality varies heavily at that setting. Greedy decoding measures the
model outside the regime the claim was made in.

Both were removed by deploying the two published FP8 checkpoints to identical hardware, for about
$6 of GPU time.

## 3. Three ways this measurement can silently lie

**The primary metric cannot be read from `usage`.** One aggregator returned a full trace in
`reasoning_content` while reporting `reasoning_tokens: 0`; the other reported 1 token against
6 000+ characters, five times. Trusting `usage` would have recorded the fine-tune as doing no
reasoning at all and produced a **100% saving** that nothing downstream would have flagged.

The primary metric is therefore trace length in **characters** — a stand-in for tokens forced by
the broken field, not a preference. It is only valid if both models spend characters at the same
rate, so that was checked rather than assumed: across all 180 completions the median is **3.48
characters per completion token for the base model and 3.46 for the fine-tune**, 0.5% apart. The
two share a tokenizer and both write Czech prose, and the ratio confirms it. A character ratio
between them is a token ratio. The independently measured completion-token saving, 48.8% against
50.8%, is the same statement arrived at without the substitution.

**The trace is not always in a field.** A plain vLLM server returns it inline, and this model's
chat template puts the opening `<think>` in the generation prompt — so the completion carries only
the closing tag. Read literally, the entire trace would have been recorded as the answer and the
saving would have measured zero. Caught by one smoke call before the paid run, not by the run.

The same tag arrangement makes a truncated completion indistinguishable from a plain answer — cut
off mid-thought, it arrives with no tags at all, and would be recorded as a long answer with no
reasoning at all. Handled explicitly; nothing truncated in the event.

**An automated judge scores well on this task while knowing nothing.** With 24 of 30 pairs tied, a
judge that simply ties often reaches 70% raw agreement with the human. Raw agreement is therefore
not reported anywhere here; §6 uses Cohen's κ, which subtracts what chance produces.

## 4. Token results

| | base `Qwen3.6-27B-FP8` | tuned `ThinkingCap-...-FP8` |
|---|---|---|
| reasoning trace, median | 5 717 characters | **2 660 characters** |
| completion tokens, median | 1 815 | **889** |

| metric | median reduction | 95% paired bootstrap |
|---|---|---|
| **reasoning trace (primary)** | **50.8%** | **[43.2%, 57.7%]** |
| completion tokens | 48.8% | [42.9%, 51.7%] |

The card claims 50%; the release post's own macro figures are −45.8% out of domain and −57.7% in
domain. The interval here spans both, on a task outside every benchmark in the suite — and the
per-question pairing is the same *matched* design the post itself argues for, for the same reason:
an unpaired average would reward a model that bails on the hard questions.

**The 30-of-30 is the stronger statement.** A sign test over 30 questions without a single
exception gives p ≈ 10⁻⁹, and it holds despite individual measurements being extremely noisy.

**How noisy.** Asked the same question three times, the same model's trace length varies by a
median of 45% (range across seeds; base 43.1%, tuned 45.6% — indistinguishable, so the fine-tune
is shorter without being steadier). This is why three seeds were run and why no single question's
number is quoted anywhere in this document. A one-pass design — which is what this
pre-registration originally called for — would have reported a figure substantially made of
sampling.

## 5. Quality: 24 ties, 6 decided, 3:3

Both answers to each question were judged blind and pairwise, sides randomised per question, model
names never shown.

| | |
|---|---|
| ties | 24 |
| decided | 6 |
| base : tuned | **3 : 3** |
| share for base | 50.0%, 95% Wilson [18.8%, 81.2%] |

**This does not show that quality was preserved.** Six decided pairs give an interval that would
contain 0.5 under almost any outcome; rejecting it would have needed something close to a clean
sweep. The supportable statement is that no difference was demonstrated and that this design could
not have demonstrated a small one.

One thing argues against a hidden degradation without quantifying it: the tie rate is the same
whether or not retrieval put a relevant chunk in the context — 15 of 18 against 9 of 12. The ties
are not an artefact of questions that had no available answer. Where answering was possible, the
two models answered alike.

**Blindness check**, specified before judging: the longer answer won 2 of 6 decided pairs,
[9.7%, 70.0%] — indistinguishable from chance, so verdicts did not track length.

**A limit on the judge.** The judge was me. I was blind to which model produced which answer but
not naive to the questions: the same 30 were judged in the superseded run a day earlier, several
discussed with chunks quoted. Prior knowledge of a question favours neither model, so the comparison stands; it
weakens the set's second use, below.

## 6. An automated judge was built, tested, and rejected

An LLM judge was built to extend the quality comparison to a larger set, behind a condition fixed
before it ran: reproduce the blind human verdicts first. `google/gemini-3.5-flash`, chosen from
outside the Qwen family since both candidates are Qwen3.6-27B derivatives. Each pair judged in
both presentations.

| | |
|---|---|
| raw agreement with the human | 70.0% (21/30) |
| **Cohen's κ** | **0.308**, 95% CI **[−0.024, 0.618]** |
| verdict reversed by swapping the sides | **8/30** |

**The interval contains zero.** The agreement is not distinguishable from chance.

The disagreements are systematic. The judge is more decisive than the human — 10 decided pairs
against 6 — and six of the nine disagreements are the human calling a tie where the judge picked a
side. On top of that, more than a quarter of its verdicts depend on which answer came first.

So the larger set was not judged automatically, which is what the gate was for. The negative
result is reported rather than dropped: on this corpus an automated judge does not reproduce human
preference well enough to substitute for it.

## 7. Retrieval, not reasoning, is the binding constraint

**On 12 of 30 questions the shared context contained no chunk marked relevant.** Those questions
test whether a model admits it does not know, not whether it reasons well. Both models inherit the
same retrieval errors by design — that is the setting the agent actually runs in — but it means
40% of the sample is measuring refusal.

Closing that gap is the obvious next step and was not taken. `bge-m3` finds a relevant chunk in its
top 3 on 53% of hard queries against 73% in its top 50, and a stronger multilingual embedder is the
likeliest way to reach it. Doing it honestly is not one API call: the ground truth here was pooled
over seven retrieval systems, and an eighth would be scored against ground truth it never
contributed to. That bias was already measured and closed once in this project, at the cost of 67
fresh judgments.

## 8. Limits

- n = 30; six decided quality pairs; one judge, one corpus, one language.
- The two FP8 quantisations share format and block size but not their exclusion lists — the
  fine-tune keeps `lm_head`, the MTP head, the vision tower and the Gated-DeltaNet input gates in
  bf16, and the official base quant documents no exclusions. Narrower than the confound it
  replaced, and a difference between published artefacts rather than one introduced here.
- `reasoning_tokens` unusable, so the primary metric is characters — validated against tokens in
  §3, not assumed equivalent.
- Per-question figures are not interpretable at this noise level, only the aggregate.
- Reproducible in method only. The corpus is not published.

---

*The harness and the pre-registration with its ten amendments are versioned alongside the agent in
this repository; the corpus cannot be.*
