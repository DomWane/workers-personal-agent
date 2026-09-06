# Deep research

Decisions behind the research mode. The current values sit in the limits table in
[ARCHITECTURE.md](../../ARCHITECTURE.md); this file holds why they are what they are.

## A round with several angles is a wave of scout Durable Objects

**Decision.** One `ResearchScout` per angle, awaited at once. Round 0 splits the plan, later rounds
the open questions. Width narrows by two a round (Static-DRA, arXiv 2512.03887); under two angles it
is a plain round.
**Why.** Each scout has its own fifty subrequests and thirty seconds of CPU (measured 2026-08-08),
so breadth costs the parent one internal call per angle.
**Rejected.** `RESEARCH_MIN_ROUNDS = 6`. Three runs ended after one round on `## Done: yes`; once
the wave covers every angle the verdict needs no overruling, and a deadline a floor can overrule is
not a deadline.
**Note.** Scout spend is reported as `scoutSpent` and never charged to `RESEARCH_SUBREQUEST_BUDGET`;
folding it in ended depth rounds early for money the parent never spent.

## Scouts run `SCOUT_MODEL`, and the picker overrides it

`modelOverride ?? SCOUT_MODEL ?? LLM_MODEL`. A wave is where the tokens go and a scout reads rather
than writes, so it is the part worth trading down; an explicit pick by the user still beats a
deployment default. Anthropic's multi-agent research system splits the same way.

## A scout has an archive of its own, in its SQLite, dead with the run

**Decision.** `toolArchiveOver(sqlTag(this.ctx.storage.sql))`, with `read_tool_result` offered and
`search_tool_results` not.
**Why.** Without one `shorten()` had no ref, the pruner saved nothing, and a 24k scout overflowed
around round four (a search plus a read is ~4,800 tokens). A scout has no overflow retry, so the
angle was lost as `scout-failed`.
**Rejected.** Writing results to the parent over RPC: one internal call per result, and the report
is written from findings, never from a scout's archive.
**Known limit.** Below ~27,300 tokens `resultCap` puts every result under `PRUNE_OVER_CHARS`, so
the pruner is inert. Logged as `stage: 'prune-inert'` and pinned by a test rather than tuned.
**Test.** `test/unit/research-scout.test.ts` runs the real Durable Object, because a failing
`appendArchive` is caught as `archive-failed` and the run looks healthy.

## A round's result lands in one `setState`, retried once

`saveResearchState` wraps the write in `retryOnce`, and the clear in the `catch` has its own
`catch`. On 2026-08-10 `SqlError: SQL query failed: internal error` discarded a four-scout wave: the
clear failed too, the rejection escaped, the SDK kept the schedule row, and the retried alarm ran an
ordinary round over the pre-wave state (`spent: 70`, `rounds: 1`).

## `SCOUT_TIMEOUT_MS` is 180 s

Local scouts took 45 to 90 s and the first value was 120 s. In production two of four finished at
about 138 s and 162 s after the wave had closed, their pages paid for and thrown away. The cap must
clear the slowest scout still working; a test ties the constant to the measurement.

## A round with no source has its findings dropped

No page opened and no search hit seen means the findings came from the model's memory; they are
discarded and logged `stage: 'ungrounded-round'`. Two scouts on the first real run wrote 2,000
characters each from zero pages. A snippet alone still counts. This is the one place something is
discarded rather than reported, because there is provably no source.

## Tavily leads the search chain, Firecrawl second, no scraper

**Decision.** Tavily (1 credit, 100 a minute) before Firecrawl (2 credits, 10 a minute). A refused
search returns an `error:` naming a tool failure, never `(no results)`, and is not counted as an
empty query.
**Why.** On the second real run 15 of 43 searches were Firecrawl 429s, the wave having asked for 19
in its first minute, and scouts read `(no results)` as a fact and closed the angle. Both vendors stay
because they find different things: domain overlap on five queries was 0, 0, 3, 1 and 2 of five.
Both work keyless (Tavily `X-Tavily-Access-Mode: keyless`, Firecrawl without `Authorization`).
**Rejected.** DuckDuckGo's HTML endpoint at the bottom: every Worker request got a 202 challenge
page.

## A Tavily hit carries its page, and `read_page` on it is a lookup

**Decision.** `include_raw_content: 'markdown'`; pages kept in `pageCache` for the invocation, keyed
by `pageKey`. A hit is logged `via: search-cache`, counted as a read, charged nothing.
**Evidence.** Probed keyless 2026-09-06: five results with raw pages of 1.8k to 26k characters in
1.5 s, same credit (the endpoint reference lists no charge for the parameter). On a real run 17 of
31 reads were served this way. The pages are not inlined into the search result: ten of them
overflow a 24k window that a snippet fits.
**Rejected.** Firecrawl `scrapeOptions`: 2 credits per ten results plus 1 per scraped page, 12 for a
search where the model opens one or two.

## `read_page` falls back because of our own concurrency

`/browser-rendering/markdown` is a Quick Action, limited on Free to one request every ten seconds;
14 of 30 reads failed with `code: 2001` on 2026-09-03. The 3-concurrent figures on the same limits
page govern Browser Sessions, which nothing here opens. The fallback logs `why` and `fallbackWhy`.

## Ungrounded citations are logged, not removed

`ungroundedCitations` compares a round's URLs against `visited` and the URLs searches showed, with
no model and no network. Grounding on `visited` alone flagged 17 real citations in one round.
Reported rather than stripped: an invented source looks exactly like a real one (DeepHalluBench,
arXiv 2601.22984), and stripping would lose real ones to a formatting slip.

## Findings are appended per round; the report is written once

The first design rewrote one `notes` document every round, putting early findings through twelve
compressions. `FINDINGS_SHOWN = 3` bounds what a round is shown, not what the report reads.

## The request budget derives from the round cap

A round measured 28, 31 and 32 subrequests over three runs, so
`RESEARCH_SUBREQUEST_BUDGET = (12 - 1) × 32 + 50 = 402` and cannot bind before `RESEARCH_MAX_ROUNDS`.
Set independently, 250 against a cap of 20 once funded 7 rounds under a floor of 8.

## Three presets; the deadline is the only cap meant to fire

**Decision.** `quick` 120 s and 4 scouts, `normal` 300 s and 5, `deep` 600 s and 5. The preset rides
on the run, so a run cannot change shape halfway. Five minutes is a judgement about a watched status
card, not a cited figure.
**`quick`.** Started at three scouts, which dropped the fourth plan angle silently; raised to four
once the search cache halved what a scout asks of Browser Rendering. In practice one wave and the
report.
**The first round is never refused for time.** Before any round the reservation is the 210 s worst
case, more than `quick`'s deadline, and the first `quick` run ended "done" with nothing.
**The clock bounds the reading, not the report.** Writing took 91 s, 239 s and 172 s on the first
three `quick` runs (13k to 17k characters out). The card says "Writing the report" (`state.writing`)
for that stretch, and Stop during it holds because `finishResearch` checks `isCurrentRun` before
writing `done`.
**Headroom is measured.** `roundHeadroomMs` reserves the longest round this run has finished, floor
60 s. The worst case alone (150 s) stopped a five-minute run at 152 s with two rounds of 78 s and
69 s done. `ROUND_WORST_CASE_MS` derives from `SCOUT_TIMEOUT_MS`: when both were 150 s the
reservation was the whole headroom.
**Order in `shouldContinue`.** Time, budget, rounds, `no-new-ground`, `model-done`. Each replaced
booleans that could all be true at once.

## The wave reports as it goes

The parent writes one `scouts` row per angle before the wave; each scout calls `scoutProgress` over
RPC after every search and read, not awaited, dropped after the first failure, keyed by run id.
Two minutes of zeros on the card read as a hang.

## A run carries its token cost

Rounds, scouts and the report call sum `usage` into `state.tokens`; the plan call is not counted;
no `usage` means no number rather than zero. Three `quick` runs cost 516k, 548k and 536k tokens,
about three cents each on deepseek flash via OpenRouter. On Workers AI Free that is a large share of
the day's 10,000 neurons, unmeasured, which the `deep` preset says on the card.

## Reflection had the same two faults

The loop's 90 s budget cut a real night at 113.6 s, and the forced final call came back empty with
every edit already written. `REFLECTION_BUDGET_MS = 240_000`, and the summary is asked for only
when the loop said nothing.

## `stopReason` and `stopCause` are separate fields

The loop's `stopReason` (`complete`, `max-rounds`, `time-budget`, `subrequest-budget`,
`no-progress`, `error`) and a run's `stopCause` (`time`, `budget`, `max-rounds`, `no-new-ground`,
`model-done`, `not-running`) share no key: two unions under one name made a log line unreadable.

## The composer toggle is the only way to start a run

A `deep_research` tool was tried and removed: it stayed silent on "Research companies using
Cloudflare" against a description opening with REQUIRED, and the same latitude proposed runs nobody
wanted. The cost is discoverability. Where the finished report lives and how a turn reads it:
[web-and-channels.md](web-and-channels.md).
