# Pre-registration — ThinkingCap-Qwen3.6-27B against its base model

**Written before any data was collected.** Everything below — task, metrics, decision rules, and
what counts as a failure to replicate — is fixed in advance so the analysis cannot be chosen after
seeing the numbers.

## The claim under test

The model card for `bottlecapai/ThinkingCap-Qwen3.6-27B` states: _"Capability of Qwen3.6-27B with
50% less thinking tokens on average, and over 90% less in best cases."_ Its reported evidence is
GPQA-Diamond, MMLU-Pro, GSM8K and LiveCodeBench — English and Chinese academic benchmarks.

This tests the same claim in a setting those benchmarks do not cover: **Czech, over real
production context retrieved from a working agent's memory.**

It is a replication, not an audit. A negative result would say the saving does not transfer to
this setting, not that the published numbers are wrong.

## Task

For each of the 30 hard-set queries, retrieve the top 5 chunks with `bge-m3` and ask the model to
answer the question using only those chunks. Both models receive **byte-identical** input.

The hard set is used because those queries are largely diagnostic — _why did this break_, _why was
this decided_ — which is reasoning over incomplete evidence rather than lookup. A task that
requires no reasoning cannot test a claim about reasoning tokens.

Both models run at the same provider, same temperature, same max tokens. Any parameter that
differs is a confound and the run is void.

## Primary metric

**Reasoning tokens per item**, paired by question, reported as the median reduction with a 95%
paired-bootstrap interval.

**If the provider does not expose reasoning tokens separately** (`usage.completion_tokens_details.
reasoning_tokens` or equivalent), the primary metric cannot be measured and this is recorded as
such. The fallback — total completion tokens — mixes reasoning with the answer itself and tests a
weaker claim; it will be labelled as the weaker claim rather than presented as the original one.

## Secondary metrics

- Total completion tokens, prompt tokens.
- **Latency is recorded but not reported as a result.** It depends on batching, quantisation and
  load at the serving provider, not on the model. It will appear only as a descriptive note with
  that caveat attached.

## Quality control

Token savings mean nothing without holding capability fixed, so both answers to each question are
compared **blind and pairwise**: the two answers shown side by side in randomised order, with a
verdict of A / B / tie. 30 pairs, judged by the author.

No LLM judge. An unvalidated judge measures agreement with a model of unknown calibration, and
this project's own write-up argues against exactly that.

## Decision rules, fixed in advance

**Token saving replicates** if the 95% paired-bootstrap interval on per-item reasoning-token
reduction lies entirely above zero. The reported figure is the median reduction, not the mean —
the card's "over 90% in best cases" implies a skewed distribution.

**Capability is preserved** if, among non-tied pairs, the 95% binomial interval on the proportion
preferring the base model includes 0.5. If it lies above 0.5, the saving comes with a quality
cost and is reported as a trade-off, not as a replication.

**Both are reported whatever they show.** A result favouring the model under test is not a better
outcome than one that does not.

## Known limits, stated now

- n = 30, one judge, one corpus, one language. Intervals will be wide.
- The judge is the author, who is not blind to the project's context, only to which answer came
  from which model.
- Retrieved context comes from `bge-m3` at rank 5, so both models inherit the same retrieval
  errors. That is deliberate — it is the setting the agent actually runs in — but it means a
  question whose answer was never retrieved tests neither model.
- The corpus cannot be published, so this is reproducible in method only.

---

## Amendment, 2026-08-01 — the two models are not served by one provider

Written after the endpoints were located and **before any data was collected**. Recorded as an
amendment rather than an edit, so the original design stays legible.

The base model and the fine-tune are not available from a single host:

|                           | provider                    | quantisation   | context | price in / out      |
| ------------------------- | --------------------------- | -------------- | ------- | ------------------- |
| `qwen/qwen3.6-27b`        | DeepInfra (via OpenRouter)  | **fp8**        | 262K    | $0.32 / $3.20 per M |
| `thinkingcap-qwen3.6-27b` | Sference (via Requesty, EU) | **not stated** | 262K    | $0.40 / $3.00 per M |

The original text said any differing parameter voids the run. That was written about sampling
parameters and is kept for those — temperature, max tokens and the prompt stay byte-identical. The
serving host cannot be equalised without dropping the experiment, so it is declared instead:

- **Token counts survive this reasonably well.** Both models share the Qwen3 tokenizer, and the
  count reflects what the model generated rather than how it was served.
- **The quality comparison does not survive it cleanly.** Quantisation changes output quality, and
  Sference does not publish theirs. If the pairwise judging favours one model, part of that may be
  precision rather than fine-tuning, and the result will say so.
- Consequently the headline claim this run can support is about **tokens**, with quality reported
  as a check that capability did not visibly collapse — not as a precise measurement.

If Sference's quantisation can be established later and differs from fp8, that goes in the results
rather than being quietly dropped.

Both endpoints advertise reasoning support, so the primary metric is expected to be measurable.
That is confirmed on the first call, not assumed.

Estimated cost of the whole run: about 2500 prompt tokens and roughly 1000–2000 completion tokens
per answer, 30 questions, two models — **well under one dollar**. Cost is not a reason to cut the
sample.

## Amendment 2, 2026-08-01 — completion ceiling raised to 16 000

Still before any data. The first draft capped completions at 4 000 tokens, which is a systematic
bias in favour of the model under test: a low ceiling truncates whichever model thinks longer, and
by hypothesis that is the base. Any saving measured against a truncated baseline is partly the
ceiling rather than the fine-tune.

Raised to 16 000 for both models, which is under both endpoints' limits (Sference 33K, DeepInfra
81K). Worst case this costs a few dollars across the whole run rather than cents — cheap enough
that the ceiling should never be the binding constraint.

If either model still hits the ceiling, the affected items are reported and excluded from the
token comparison rather than counted as a saving.

## Amendment 3, 2026-08-01 — the primary metric cannot be read from `usage`

Found on the single probe call agreed in advance, before the run. One call to each endpoint:

|                             | completion_tokens | reasoning_tokens | trace field         | answer |
| --------------------------- | ----------------- | ---------------- | ------------------- | ------ |
| base (OpenRouter/DeepInfra) | 151               | **88**           | `reasoning`         | `391`  |
| tuned (Requesty/Sference)   | 145               | **0**            | `reasoning_content` | `391`  |

The tuned side reports zero reasoning tokens while returning a full reasoning trace in
`reasoning_content`. The arithmetic gives it away: 145 completion tokens for a three-character
answer. The model thought; the provider does not count it.

Taking `usage` at face value would have recorded ThinkingCap as doing no reasoning at all and
produced a **100% saving** — a fabricated headline that nothing in the pipeline would have
flagged.

**Revised primary metric: length of the reasoning trace in characters**, paired per question,
median reduction with a 95% paired-bootstrap interval. Characters need no tokenizer, and both
traces are Czech prose from the same model family, so the two are comparable. `completion_tokens`
is reported alongside as the practical cost measure, and is trustworthy on both sides.

`reasoning_tokens` is recorded but excluded from the analysis, with the reason above. Any item
where a zero count accompanies a non-empty trace is counted and reported.

This is the third time in this project that a plausible number turned out to measure something
other than what it named, and the second where the error would have flattered the model under
test.

## Amendment 4, 2026-08-01 — what the run itself produced

Written after the 30×2 run, before any judging and before any comparison was computed. Three
things happened during collection that the analysis has to account for, recorded here so the
handling is fixed before the numbers are looked at.

**One item hit the 16 000 ceiling.** The base model returned `finish_reason: length` with no
answer at all — the entire budget went to reasoning. Amendment 2 fixed the handling in advance:
the item is reported and excluded, and the ceiling is **not** raised in response. Raising it now,
with the data in hand, would be choosing the analysis after seeing it. On the resumed call the
same question completed, so the recorded data has no truncated rows; the event is reported
because it happened, not because it survived into the file.

**Temperature 0 is not deterministic at either provider.** A resume bug (below) asked 14 questions
twice, which accidentally produced 7 repeated calls per model with byte-identical input. No pair
of answers was identical, and the reasoning trace differed by a median of about 26%, ranging to
78%. These repeats are kept and reported as a **noise floor**: any per-item difference between the
models smaller than the same model's own spread is not evidence. The paired bootstrap over 30
items still estimates the median difference — sampling noise widens the interval rather than
biasing it, and both models show the effect — but the per-item figures cannot be read as exact.

**The resume check never matched**, so those 14 questions were paid for twice. Both sides of the
key are now built by one function, and the test that should have caught it has been replaced: it
only checked the missing-file case, which is why a live mismatch passed for free. Only the first
run per model per question is judged; the repeats stay in the data as the variance estimate above.

Nothing here changes the primary metric, the decision rules, or the sample.

## Amendment 5, 2026-08-01 — one verdict revised, and how

Recorded because a judged verdict was changed after the fact, which is exactly the kind of edit
that has to be visible rather than silent.

The first three pairs were judged before the judge began fact-checking claims against the
retrieved context; the remaining 27 were judged with that check available. That is two standards
in one set — the same failure this project already hit once while pooling, where a lenient first
half and a strict second half had to be reconciled.

All 30 pairs were therefore re-examined against the context after judging. **One verdict changed**
(item 3, sorting in the orders table: `tie` → the answer that named the real cause). The other
side had taken a TypeScript union error appearing in the context and presented it as the reason
sorting failed; the actual cause, stated in both chunks the judge had marked relevant, is that
three columns are flagged sortable while the backend cannot sort by them. The remaining 29
verdicts stood unchanged.

The direction of the change is worth stating: it favours neither model by design, and the judge
did not know which model either answer came from — the reviewer checking the claims withheld it,
and the model names were never printed alongside the answers.

The revised file keeps a `.bak` of the original verdicts.

## Amendment 6, 2026-08-02 — the experiment moves to hardware we control, and to the sampling the claim was made at

The first 74 runs went through two aggregators. That was recorded as a limit from the start (see
the first amendment), but two things found since make it worth paying to remove rather than
continue to disclose.

**Neither side's precision was known.** OpenRouter lists nine endpoints for `qwen/qwen3.6-27b`:
seven declare `fp8`, two declare nothing, none offers bf16. No provider was pinned and no
`provider` field was recorded, so which host answered any given question is now unrecoverable.
That the routing did vary is visible in the throughput: the base model's runs span 24–97 tok/s, a
fourfold spread, against 64–88 for the fine-tune with 33 of 37 runs inside 78–88. One machine
against several. The fine-tune's quantisation was never disclosed by its host at all.

Both models are now published in matched FP8 — `bottlecapai/ThinkingCap-Qwen3.6-27B-FP8` and
`Qwen/Qwen3.6-27B-FP8`, which the former's model card states ship the same DeepSeek-V3-style
block-wise format at the same 128×128 block size. Both are deployed to dedicated Hugging Face
Inference Endpoints, same container (`vllm/vllm-openai:v0.25.0`), same arguments, same GPU
(1× RTX PRO 6000, the Blackwell part the authors published their own numbers on), same region.

**The sampling was wrong for the claim.** This pre-registration fixed `temperature: 0`. The
authors measured their numbers at `temperature=1.0, top_p=0.95, top_k=20, min_p=0.0` over five
seeds, explicitly because of "high variability of reasoning quality" at that setting. Greedy
decoding measures the model outside the regime the claim was made in, and is a likelier
explanation for the ceiling-length completions in the first runs than a model that merely thinks
at length — reasoning models loop when decoded greedily. The runs now use the authors' parameters
over three seeds; the spread across seeds is reported rather than a single number.

The completion ceiling rises from 16 000 to 24 576, the larger of the two budgets the authors
used. A truncated item is dropped under amendment 2, and the dropped ones are the hardest
questions rather than a random sample of them.

**The earlier 74 runs are superseded, not pooled.** They were produced under different serving
conditions and different sampling, and averaging the two would hide both. They stay in their file;
the new runs go to files named for the conditions that produced them.

Two consequences follow and are accepted rather than worked around:

- **The 30 judged verdicts do not transfer.** They were judgments of different answers. The hard
  set is judged again from scratch.
- **Judging changes to two passes.** Amendment 5 recorded that fact-checking against the context
  entered partway through the first round, leaving two standards in one set. It also means those
  verdicts are unusable for validating an automated judge, since a model contributed to them. The
  new protocol: pass one is judged blind with no model assistance of any kind, and recorded; pass
  two allows fact-checking and revision, and is recorded separately. Agreement between a candidate
  LLM judge and the human is measured against pass one. The difference between the two passes —
  how many verdicts a human changes once allowed to check the claims — is reported as its own
  result. A claim checked on one side must be checked on the other.

**What is still not controlled.** The two FP8 quantisations share format and block size but not
their exclusion lists: the fine-tune keeps `lm_head`, the MTP head, the vision tower and the
Gated-DeltaNet input gates in bf16, and the official base quant documents no exclusions. This is
narrower than the confound it replaces, and it is a difference between the published artefacts
rather than one introduced by this experiment. MTP speculative decoding is available on both and
enabled on neither.

### Amendment 6a, 2026-08-02 — how the seeds are aggregated

Fixed now, with two rows of the new data seen and nothing analysed, because an aggregation chosen
after looking at the spread is a choice about the result.

Each question yields one trace length per model per seed. The measurement for a question is the
**median across its seeds, per model**; the per-question saving is then computed from those two
medians, and the bootstrap interval is taken over questions as before. The median rather than the
mean, because a single run that hits the ceiling would otherwise drag a question's figure with it.

The **seed-to-seed spread within a model** is reported separately as the noise floor — the same
role the accidental repeats played under amendment 4, now produced deliberately. A saving smaller
than that floor is not a finding.

Judging still sees one answer per model per question: seed 1, the first full pass. Judging three
answers per question would triple the human cost to compare a model against itself.

### Amendment 6b, 2026-08-02 — correcting a claim made in amendment 6

Amendment 6 argued for the sampling change partly on the grounds that "ceiling-length completions
in the first runs" pointed at the repetition loops greedy decoding induces. **That was wrong and
is withdrawn.** All 74 recorded runs were re-checked: no completion in either model reached the
ceiling, the longest being 3 343 tokens against a limit of 16 000. The truncation that prompted
amendment 2 happened at the earlier limit of 8 000 and does not appear in the retained data.

The other ground stands and was the primary one: the claim under replication was measured at the
authors' sampling over five seeds, so greedy decoding measures a different regime from the one the
claim was made in. The decision is unchanged; one of its two justifications is not.

The first complete pass at the new settings makes the point directly. Base model, same 30 hard
questions, first run per question:

|                                             | median trace | median completion | longest completion | truncated |
| ------------------------------------------- | ------------ | ----------------- | ------------------ | --------- |
| temperature 0, aggregator, ceiling 16 000   | 6 190 chars  | 1 924 tok         | 3 343              | 0/30      |
| temperature 1, own endpoint, ceiling 24 576 | 5 672 chars  | 1 721 tok         | 3 864              | 0/30      |

An 8% shorter trace and nothing else. Greedy decoding was not distorting the base model's length
on this corpus, and the raised ceiling is not binding on either setting.

### Amendment 7, 2026-08-02 — two limits of the completed hard set

Written after the blind judging pass, before the fact-checked one.

**The quality comparison has almost no power, and the analysis script overstated it.** Of 30 pairs,
24 were called ties, leaving six decided and a Wilson interval of [18.8%, 81.2%]. That interval
would contain 0.5 under nearly any outcome; rejecting 0.5 would have needed something close to
6:0. The script prints "capability preserved" whenever the interval spans 0.5, which is the wrong
sentence — the finding is a **failure to demonstrate a difference**, not a demonstration of
its absence. This test could only have caught a total collapse.

One thing does argue against a hidden degradation, though it cannot be quantified here. The tie
rate is the same whether or not retrieval put a relevant chunk in the context (15/18 against
9/12), so the ties are not an artefact of questions that had no answer available. The two models
answered alike on questions where answering was possible.

**The blind pass was blind to the models but not naive to the questions.** The same 30 questions
were judged in the superseded run a day earlier, and several were discussed then with chunks
quoted to settle what the context actually said. The judge therefore carried prior knowledge of
some items into this pass.

For the base-versus-fine-tune comparison this is harmless: prior knowledge of a question does not
favour either model, and the model names were never shown. For its intended second use — as the
uncontaminated reference an LLM judge is validated against — it is a real weakening, and the
agreement figure has to be reported as agreement with a judge who had seen some of the material
before rather than with a naive one. The alternative, a fresh question set, would cost another
labelling pass; the weakening is accepted and disclosed instead.

### Amendment 8, 2026-08-02 — the second judging pass is not run

Amendment 6 set out a two-pass protocol: judge blind, then judge again with fact-checking allowed,
and report the difference between them as its own result. The second pass is dropped.

Of the 30 pairs, 24 were called ties. "How many verdicts change once the claims can be checked"
would therefore rest on six decided items, and any number it produced — one changed, two changed —
would be noise reported to two significant figures. A selective second pass over only the items
the judge already doubted was considered and rejected for the same reason, with the added problem
that its result would be conditioned on that doubt.

The blind pass stays as the single human reference. For validating an automated judge that is
cleaner than two sets with a note about which one counts.

What the second pass would have caught does not vanish, and is recorded qualitatively instead: the
judge flagged two pairs where an answer's factual claim looked wrong to him. Those doubts are
reported as evidence that blind judging without fact-checking is a noisy instrument, not as verdict
changes. No verdict recorded in the blind pass is altered.
