# Deep research: waves, what bounds a run, and what the first real runs taught

Read this before changing a cap, a scout, or how a round decides to stop. Every number here is
measured; where the first value was wrong, the measurement that replaced it is recorded beside it.

**A round with more than one angle to split is a wave, not a round.** One `ResearchScout` Durable
Object per angle, all awaited at once, each with its own fifty subrequests and its own thirty
seconds of CPU. Round zero splits the plan; later rounds split the open questions, which is where
the depth is. The width narrows by two a round, after Static-DRA's `max(b - 2i, 1)` (arXiv 2512.03887): the first round
is the landscape and deserves the whole wave, and a run that kept fanning out at every depth would
re-read the landscape instead of chasing what it did not settle. Under two angles it is an ordinary
round. The wave's spend is reported as `scoutSpent` and never charged to `RESEARCH_SUBREQUEST_BUDGET`,
because it was drawn from the scouts' invocations and not from this one; folding it in would end the
depth rounds early for money the run never spent.

The wave also replaced `RESEARCH_MIN_ROUNDS`, a floor of six added because three runs in a row ended
after one round and nine pages: the model answered `## Done: yes` and nothing overruled it. Once
every plan angle is covered before the model can hold that opinion, the verdict no longer needs
overruling — and a deadline a floor can overrule is not a deadline.

Scouts run `SCOUT_MODEL` when it is set, falling back to `LLM_MODEL`; the picker still overrides both,
because an explicit act by the user beats a deployment default. A wave is where the tokens go and a
scout reads and reports rather than writing the report, which is what makes it the part worth
trading down first. Anthropic's published multi-agent research system splits it the same way, a
stronger lead over cheaper subagents.

**A scout keeps an archive of its own, and it dies with the run.** Without one, `shorten()` returned
its input untouched — there was no ref to shorten to — so the pruner ran every round and saved
nothing, the request grew by a whole page per round, and with no overflow retry outside
`PersonalAgent` the angle was lost as `scout-failed`. At the picker's low end a search plus a read is
~4,800 tokens a round, so a 24k scout died around round four of twelve. Three choices inside it:

- **It lives in the scout's own SQLite and is never read again.** Writing to the parent over RPC was
  the alternative and costs one internal call per tool result; the report is written from findings,
  never from a scout's archive, so nothing needs to outlive the run.
- **The scout gets `read_tool_result` and not `search_tool_results`.** Its archive holds one run's
  own reads, so searching it is close to searching what it just did. The tool is offered only where
  an archive exists — one that can answer nothing but its own error is worse than an absent one.
- **Below ~27,300 tokens of window the pruner still cannot act**, because `resultCap` puts every
  result under `PRUNE_OVER_CHARS` — the two caps cancel, and the smaller the window the more surely
  they do. Said rather than fixed: `stage: 'prune-inert'` names it at the start of a run and a test
  pins the crossover. Tuning the two thresholds against each other buys a round or two before the
  sum overflows anyway.

The archive is exercised against the real Durable Object's SQLite in `test/unit/research-scout.test.ts`
because its failure mode is quiet: an `appendArchive` that throws is caught as `archive-failed`, the
angle still returns findings, and the pruner is simply mute for the whole run.

**A round's whole result becomes durable in one `setState`, and that write failed once.** The first
production wave logged `SqlError: SQL query failed: internal error` in the same second the wave
closed. Four scouts, 57 subrequests and four angles of findings were discarded: the clear in the
`catch` was the next write and failed too, the rejection escaped the handler, the Agents SDK kept
the schedule row, and the retried alarm ran an ordinary round over the state written *before* the
round. The evidence is in the next round's record: `spent: 70` is `chargeRound`'s 50 plus that
round's 20, and `rounds: 1` where a wave of four should have left four. Both writes now go through
`retryOnce`, and the clear has its own `catch` so a failure there can no longer take the handler
with it.

**`SCOUT_TIMEOUT_MS` is 180 s, set from production rather than from local runs.** Local scouts took
45–90 s and the first value was 120 s; in production two of four came back at about 138 s and 162 s,
after the wave had closed, with their pages paid for and thrown away. A test ties the constant to
that measurement.

**A round that could not have sourced anything has its findings dropped.** No page opened *and* no
search result seen means whatever the model wrote came out of its own memory, and the report is
written from these entries beside researched text. Two scouts on the first real run did exactly that
— zero pages, two thousand characters each. A snippet alone still counts, because a claim cited from
a search result is honest sourcing. It is the one place where something is discarded rather than
reported, and it earns that because there is provably no source behind it.

**A third of searches came back "empty" on the second real run, and none of them were.** All 15 of
43 were Firecrawl **429s** — `Consumed (req/min): 11, Remaining: 0`, with the counter climbing while
rejecting, so a retry inside the same minute makes it worse. The Free plan allows 10 searches a
minute and the wave asked for 19 in its first. Two things came from that. A refused search reads as a
tool failure rather than `(no results)` — the old wording was the reason scouts closed an angle and
wrote from memory — and it is never filed as a query that found nothing, which is what
`emptySearches` is for. And **Tavily leads the search chain**: 1 credit against Firecrawl's 2, and
100 requests a minute against 10. Firecrawl stays under it because the two return different things —
Tavily finds official and primary sources, Firecrawl finds preprints; domain overlap on five real
queries was 0, 0, 3, 1 and 2 out of five. Both answer without a key — Tavily behind an
`X-Tavily-Access-Mode: keyless` header, Firecrawl by omitting `Authorization` — at rate limits
neither states precisely, so a deploy with no search secret still searches and a key is what raises
the ceiling. There is no scraper under them: DuckDuckGo's HTML endpoint sat at the bottom of the
chain once and never returned a result from a Worker, answering 202 with a challenge page.

**A search brings every hit back whole, and `read_page` on one of them is a lookup.** Tavily's
`include_raw_content: "markdown"` returns each result's page in the same call and the same one
subrequest; its [endpoint reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
prices `search_depth` and lists no charge for the parameter. Probed keyless on 2026-09-06:

```
curl https://api.tavily.com/search -H 'x-tavily-access-mode: keyless' \
  -d '{"query":"Cloudflare Workers subrequest limit free plan","max_results":5,"include_raw_content":"markdown"}'
```

Five results, `raw_content` of 1.8k, 19k, 26k, 3.3k and 3.2k characters, 1.5 s. The round keeps
them for the invocation, and a chat turn for the turn; `read_page` checks that store before it
fetches, and a hit is logged `via: search-cache`, counted as a read because the model saw the page,
and charged nothing because nothing was requested. On the Free plan this is what lets a wave read
at all: Browser Rendering allows one request every ten seconds per account and five scouts were
losing half their reads to it (below). The pages are not put into the search result itself, because
ten of them inline would overflow a 24k window that a 500-character snippet fits. Firecrawl's search
can do the same with `scrapeOptions`, and [its docs](https://docs.firecrawl.dev/features/search)
price it at 2 credits per ten results plus 1 per scraped page — 12 for a ten-result search where
the model opens one or two — so the fallback vendor stays snippet-only.

**`read_page` falls back to Firecrawl because of our own concurrency, not the site.** The fallback
records `why`, and a run on 2026-09-03 settled it: 14 of 30 reads failed with Cloudflare's own
`code: 2001, Rate limit exceeded`. `read_page` calls `/browser-rendering/markdown`, a **Quick
Action**, limited on the Free plan to one request every ten seconds; the 3-concurrent /
3-new-a-minute figures in the same limits page govern Browser Sessions, which nothing in this repo
opens.

**A citation the run never saw is logged, not removed.** `ungroundedCitations` compares the URLs in a
round's findings against `visited` *and the URLs searches put in front of the model*, so the check
needs no model and no network. Grounding on `visited` alone flagged seventeen citations in one round
of the first real run, and every one was a real page a search had returned and the round had chosen
not to open. The check exists because findings are appended and never verified and the report is
written from all of them: an invented source reaches the reader looking exactly like a real one —
the failure DeepHalluBench (arXiv 2601.22984) names as invisible to end-to-end evaluation, and a wave
makes it likelier, since four scouts never see each other's sources. Reported rather than stripped,
because dropping them quietly would read as clean while losing real citations to a formatting slip.

A research run keeps one entry per round in `findings`, appended and never rewritten, and the
report is written from all of them in one call at the end. The first design rewrote a single
`notes` document every round, which put every early finding through twelve compressions; this puts
each through one. `FINDINGS_SHOWN` bounds only what a round is *shown* — nothing shown there is the
only copy.

**The request budget is derived from the round cap, not set beside it.** A round measured 28, 31
and 32 subrequests across three real runs, each using all six of the tool loop's rounds, so
`RESEARCH_SUBREQUEST_BUDGET` is `(12 - 1) × 32 + 50` and cannot bind before `RESEARCH_MAX_ROUNDS`
does. Set independently, the two drifted apart once: 250 with a cap of 20 funded 7 rounds, which
would have made a floor of 8 unreachable. A later run spent 15 to 28 per round, so the cap is looser
than intended rather than tighter.

**Five minutes is a choice about the user.** The run is watched: a status card someone is looking at
is a different product from a job they come back to, and what buys the shortness is the wave, which
covers the breadth a sequential agent spends rounds on. No competitor's figure is cited for it,
because it is a judgement and a citation would only make it look derived.

**Four caps bound a run, and only one of them is meant to fire.** The order in `shouldContinue` is
the hierarchy: the five-minute deadline is the hard bound, requests and rounds are safety nets under
it that a ~150 s round should never reach, and the two judgements — `no-new-ground`, then
`model-done` — come last. The deadline keeps a whole round of headroom, because "stop after five
minutes" checked between rounds otherwise means starting a round at 4:59 and finishing at 7:30. The
headroom is **measured**: `roundHeadroomMs` reserves the longest round this run has actually
finished, and falls back to `ROUND_WORST_CASE_MS` only until there is a round to measure. The
constant alone cost half the deadline on the first real run — rounds took 78 s and 69 s against a
150 s reservation, so a five-minute run stopped at 152 s with two rounds done.
`ROUND_WORST_CASE_MS` is derived from `SCOUT_TIMEOUT_MS`, because when the two were both 150 s a
wave where every scout ran to its timeout consumed the entire headroom. The deadline bounds the
gathering and not the report that follows: a run that collected material and then dropped it for
the clock would be worse than one that ran half a minute long.

The nightly reflection had the same two faults as a research round — a budget its work outran, and a
forced final call that came back empty — after a real night produced `🪞 Reflection: (no answer
produced — try rephrasing)` with every edit written and only the sentence describing them lost. It
runs with `REFLECTION_BUDGET_MS = 240000` and asks for its own summary, and the extra call is made
only when the loop had nothing to say.

Both the `done` record and the `turn` record carry `stopReason`: one of `complete`, `max-rounds`,
`time-budget`, `subrequest-budget`, `no-progress`, or `error` on a failed turn. A research run has
its own vocabulary and its own field name — `stopCause`, one of `time`, `budget`, `max-rounds`,
`no-new-ground`, `model-done`, `not-running` — because two unrelated unions under one key made a
log line unreadable without knowing which produced it. Each replaced independent booleans that could
be true at once and never said which fired first.

**The composer's toggle is the only way to start a run, and the model has no say.** A
`deep_research` tool that let the model propose a run was tried and removed, because the judgement
it asked for — is this ask worth minutes and hundreds of requests — went wrong in both directions:
silent on *"Research companies using Cloudflare"* against a description that opened with
**REQUIRED**, and the same latitude would have proposed runs nobody wanted. What the toggle gives up
is discoverability: a user who does not know it exists will not be told. That is the trade, and it
is one line of system prompt to undo if it starts to matter.

A finished report lives in `state.research.report`, never in the conversation; how the agent fetches
it when a turn needs it is in [web-and-channels.md](web-and-channels.md).
