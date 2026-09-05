# ThinkingCap against its base model, on matched hardware — hard set, 2026-08-02

Replication of the claim that `bottlecapai/ThinkingCap-Qwen3.6-27B` reaches its base model's
quality with roughly half the thinking tokens. Design and every change to it are in
`thinkingcap-preregistration.md`; this file reports only what the runs produced.

Supersedes the figures in `thinkingcap-results.md`, which were collected through aggregators whose
quantisation and routing were unknown. The two are not pooled.

## Conditions

Both models in matched FP8 — the fine-tune's card states its quantisation is the same
DeepSeek-V3-style block-wise format at the same 128×128 block size that `Qwen/Qwen3.6-27B-FP8`
ships. Both on dedicated Hugging Face Inference Endpoints: one NVIDIA RTX PRO 6000, `us-east-2`,
`vllm/vllm-openai:v0.25.0`, identical arguments. Sampling as the authors published theirs —
temperature 1.0, top_p 0.95, top_k 20, min_p 0 — over three seeds. 30 questions × 2 models ×
3 seeds = 180 runs, no truncations, no empty completions, no duplicates.

Each question's trace length is the median across its three seeds, per model.

## Trace length

|                     |                                  |
| ------------------- | -------------------------------- |
| base, median        | 5 717 chars                      |
| ThinkingCap, median | 2 660 chars                      |
| **saving**          | **50.8%**, 95% CI [43.2%, 57.7%] |
| shorter on          | **30 of 30 questions**           |

Completion tokens, the practical cost: 1 815 → 889, a **48.8%** saving, 95% CI [42.9%, 51.7%].

The claim is 50%. Both metrics land on it.

The 30-of-30 is the stronger statement. A sign test over 30 questions without a single exception
gives p ≈ 10⁻⁹, and it holds despite individual measurements being extremely noisy: the same model
asked the same question three times varies in trace length by a median of 45% (range across
seeds, n = 30 per model, base 43.1% and ThinkingCap 45.6% — the two are indistinguishable, so the
fine-tune is shorter without being steadier).

That noise is why three seeds were run. A single pass would have reported a number substantially
made of sampling, which is what the design originally called for and what the authors' own use of
five seeds warned against.

## Quality — blind pairwise judging

30 pairs, sides randomised per question, model names never shown.

|                    |                              |
| ------------------ | ---------------------------- |
| ties               | 24                           |
| decided            | 6                            |
| base : ThinkingCap | **3 : 3**                    |
| share for base     | 50.0%, 95% CI [18.8%, 81.2%] |

**This does not show that quality was preserved.** Six decided pairs give an interval that would
contain 0.5 under nearly any outcome; only something close to a clean sweep could have rejected
it. The honest reading is that no difference was demonstrated and that this test could not have
demonstrated a small one.

What does argue against a hidden degradation, without quantifying it: the tie rate is the same
whether or not retrieval had put a relevant chunk in the context — 15 of 18 against 9 of 12. The
ties are not an artefact of questions that had no available answer. On the questions where
answering was possible, the two models answered alike.

**Blindness check.** The longer answer won 2 of 6 decided pairs, 95% CI [9.7%, 70.0%] —
indistinguishable from chance, so the verdicts did not track answer length.

**A limit on the judging itself.** The judge was blind to which model produced which answer, but
not naive to the questions: the same 30 were judged in the superseded run a day earlier, several
of them discussed with chunks quoted. Prior knowledge of a question favours neither model, so the
comparison stands; its second intended use — as the uncontaminated reference for validating an
automated judge — is weakened, and the eventual agreement figure has to be read that way.

## What is still not controlled

The two FP8 quantisations share format and block size but not their exclusion lists: the fine-tune
keeps `lm_head`, the MTP head, the vision tower and the Gated-DeltaNet input gates in bf16, and
the official base quant documents no exclusions. This is a difference between the published
artefacts rather than one this experiment introduced, and it is far narrower than the confound it
replaces — two aggregators, nine possible hosts, and a fine-tune whose host disclosed no
quantisation at all.

## What this is not

The authors measured MMLU-Pro and RealWorldQA. This is a Czech-language RAG task over work
transcripts, five retrieved chunks per question, and 40% of the questions have no answer in their
context at all — they test refusal rather than recall. That the token figure matches theirs so
closely on a task this different is the interesting part; it is not a check of their benchmarks.

Cost of the run: about $6 of GPU time.

## The automated judge, and why it is not used

An LLM judge was built to extend the quality comparison to the larger set, behind a gate fixed
before it ran: it had to reproduce the blind human verdicts first. `google/gemini-3.5-flash`,
chosen from outside the Qwen family since both candidates are Qwen3.6-27B derivatives and a judge
shares its own lineage's preferences. Each pair judged in both presentations.

|                                        |                                       |
| -------------------------------------- | ------------------------------------- |
| raw agreement with the human           | 70.0% (21/30)                         |
| **Cohen's κ**                          | **0.308**, 95% CI **[−0.024, 0.618]** |
| verdict reversed by swapping the sides | **8/30**                              |

**The interval contains zero: the agreement is not distinguishable from chance.** This is why κ is
reported rather than raw agreement — with 24 of 30 pairs tied, a judge that simply ties often
scores 70% and has learned nothing.

Where they part is systematic. The judge is more decisive than the human — 10 decided pairs against
6 — and six of the nine disagreements are the human calling a tie where the judge picked a side.
Reluctance to call two answers equal is a known failure of LLM judges and is visible here directly.
On top of that, more than a quarter of its verdicts depend on which answer was shown first.

The judge is therefore not used on the larger set, which was the condition set in advance. The
result is reported rather than discarded: on this corpus an automated judge does not reproduce
human preference well enough to substitute for it.

## What would come next, and why it did not happen here

Dense retrieval leaves headroom — `bge-m3` finds a relevant chunk in its top 3 on 53% of hard
queries against 73% in its top 50 — and a stronger multilingual embedder is the likeliest way to
close it, given that the one reranker available on-platform is an English/Chinese model against
Czech queries.

It was not tried because doing it honestly is not one API call. The ground truth here was pooled
over seven systems; an eighth would promote chunks no judgment covers, those count as
non-relevant by default, and it would be scored against ground truth it never contributed to.
That is the pool bias already measured and closed once in this project, at the cost of 67 fresh
judgments. A commercial embedder is a product improvement with a labelling bill attached, not a
free win, and it would demonstrate nothing this eval does not already show.
