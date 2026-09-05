# Architecture

A personal agent on Cloudflare Workers, reachable from a web chat. A Durable Object
(`PersonalAgent`) holds one conversation and runs a tool loop against an OpenAI-compatible API.
Long-term memory is markdown in an R2 bucket; semantic recall is an embedding index in DO SQLite.
`evals/` is a separate Node-side harness for measuring the agent, not part of the deployed Worker.

```
  ┌─ the browser ────────────────────────────────────────────────────────────┐
  │   Vue client  ◄──WebSocket──►  Access  ──►  Worker  ◄──  cron 04:00      │
  └────────────────────────────────────┬─────────────────────────────────────┘
       setState broadcasts back up     │   a turn    ──►  PersonalAgent
       — there is no sending code      │   the night ──►  reflection, index
  ┌────────────────────────────────────┴─────────────────────────────────────┐
  │   Durable Objects — each holds its own SQLite, which dies with it        │
  │                                                                          │
  │     PersonalAgent   one per thread   ──►  archive                        │
  │         ├── RPC, free ───────────────►  index  ──►  embeddings           │
  │         └── fans out ──────►  ResearchScout  one per angle  ──►  archive │
  │                                                                          │
  │     reflection   woken nightly, never inside a turn                      │
  └────────────────────────────────────┬─────────────────────────────────────┘
                                       │   every instance above reaches out
  ┌────────────────────────────────────┴─────────────────────────────────────┐
  │   outside the isolate                                                    │
  │     R2 vault ····· markdown, outlives every instance ···· costs nothing  │
  │     LLM · search · browser · Workers AI ····· each call spends 1 of 50   │
  └──────────────────────────────────────────────────────────────────────────┘
```

**Read the bottom box off it: what crosses into "outside the isolate" is what an invocation spends,
and nothing else is.** A call to another Durable Object goes against the 1,000 internal cap instead,
and R2 through a binding costs nothing at all. The fan-out to scouts multiplies that budget rather
than sharing it — each child gets its own 50 — which is the whole reason research is shaped this way.

Each Durable Object's SQLite is **its own, and it dies with it**: the archive with its thread, the
embeddings with `index`. Only the vault outlives everything, which is why a memory's provenance can
point into a deleted thread and must resolve to "source deleted" rather than to silence.

The cron and the chat share the Worker and nothing else, which is the invariant below drawn as two
disjoint sets of arrows: **maintenance never runs inside a turn.**

**The web is the only channel.** It started on Telegram, which was removed on 2026-08-21 once
Cloudflare Access became the gate: Access binds to the Worker and authenticates every path, and a
webhook cannot sign in. The client is a Vue app in `web/`, built into `./public` and served by the
Worker's asset binding; it talks to the DO over the Agents SDK WebSocket. Its whole delivery
mechanism is `setState`: the SDK persists *and* broadcasts to every connected client, so the thread,
the research status card and the finished report need no sending code at all.

Runtime deps of the Worker are `agents`, `openai` and `zod`. The bundle cap that used to be the
argument against a third one was misread: **the 3 MB Free-plan limit is on the gzipped upload**, not
on the number `wrangler` prints first — measured 2026-08-20 at `Total Upload: 2262.73 KiB / gzip:
412.18 KiB`, so 13% of the cap is used, not 74%. `zod` cost **nothing measurable**: gzip went from
412.34 to 412.18 KiB, because the hand-written JSON Schema literals it replaced were bulk of their
own. Size is therefore not the reason to refuse a dependency here; needing it is. Everything the
web client needs is a **devDependency**: `web/` is built ahead of time and ships as static assets,
so it cannot grow the Worker bundle. shadcn-vue and ai-elements-vue are copy-paste registries rather
than packages — their components live in `web/src/components/` and are ours to edit, which is also
why re-running their CLI needs care.

## Platform limits, and which of them were measured

Which bucket a call falls into cannot be read off the docs with confidence. Measure it — a probe
Worker with a mode per call type settles it in ten minutes.

| Limit | Value | How we know |
| :--- | :--- | :--- |
| External subrequests per invocation | 50 free, 10,000 paid | measured: dies on the 51st; the paid figure is documented, not measured. Which one is asked of `/accounts/{id}/subscriptions` in each Durable Object's start and cached an hour — no runtime API reports the plan, and I/O is forbidden in a Worker's global scope, so a DO's start is the only place that can both wait and run before a request |
| Subrequests to Cloudflare services | 1,000 | documented |
| `fetch` to the internet | counts against the 50 | measured 2026-08-06 |
| **`env.AI.run` (Workers AI)** | **counts against the 50** | measured 2026-08-06: 50/60, dies on 51st |
| **R2 through a binding** | **does not count** | measured 2026-08-06: 200/200 pass |
| **A call to another Durable Object** | **counts against the 1,000, not the 50** | measured 2026-08-08: 60/60 pass, dies on the 1001st |
| CPU per `fetch` handler invocation | 10 ms | measured 2026-08-09: `exceededCpu` at `cpuTimeMs: 13` |
| **CPU per Durable Object invocation** | **30 s** | measured 2026-08-09: `exceededCpu` at `cpuTimeMs: 32000` |
| Wall time per Durable Object invocation | no limit found | measured 2026-08-09: 170 s awaiting children, `outcome: ok` |
| Worker bundle | 3 MB | documented |
| Requests per day | 100,000 | documented |
| Workers Logs retention | 3 days | documented, and it bites |
| R2 free tier | 10 GB, 1M class A, 10M class B / month | documented |

Workers AI counting against the *external* 50 is the surprising one and the docs do not say it
either way — the definition of a subrequest names R2, KV and D1 and omits Workers AI. So a
reindex is bounded by embeddings, not by vault reads: one embedding per changed chunk, 46 chunks
per invocation once the reserve is held back.

**A call from one Durable Object to another is internal, and a child spends from its own budget.**
Measured 2026-08-08 with a throwaway Worker (`do-subrequest-probe`), one parent DO calling children
in a loop, run against the deployed Worker because local dev does not enforce the caps:

- 60 calls to child DOs pass, by RPC and by `stub.fetch` alike, to sixty distinct ids and to one
  shared id. The same probe's control — 60 `fetch` calls to the internet — died on the 51st with
  *Too many subrequests by single Worker invocation*, so the harness does see the external cap.
- 1,100 calls to one child die on the 1,001st, and with a **different** error: *Too many API
  requests by single Worker invocation*. That is the 1,000-call internal cap, which is what settles
  which bucket a DO call falls into — the two limits have distinct messages.
- A parent that calls three children, each of which makes 40 `fetch` calls, completes all 120.
  A child's outbound spend comes out of the child's 50, not the parent's.
- CPU behaves the same way. A parent that awaited five children, each burning 26–30 s of CPU,
  finished with `cpuTimeMs: 1` of its own over a 170 s wall clock. Awaiting costs nothing; the
  child's spinning is charged to the child.
- `Promise.all` over children is genuinely concurrent, which is the measurement the whole case
  rests on. One child burning 3,000 units took 11.6 s; five took 11.5 s; ten took 11.4 s. The same
  five awaited in a `for` loop took 50.3 s.

So fan-out multiplies the external budget: N children is N × 50 external requests, and the parent
pays N against a separate 1,000. Alarms on a single DO serialise and a second agent inside one
invocation would overflow, so this is the only parallelism available on this plan. The Agents SDK
already exposes sub-agent facets (`/sub/{child-class}/{child-name}`, `onBeforeSubAgent`), so nothing
blocks it now — the probe was the blocker.

**The 10 ms CPU ceiling is a Worker ceiling, not a Durable Object one**, which this repo had
recorded as one number for both. Measured the same day: the plain `fetch` handler dies at
`cpuTimeMs: 13` — `units=1` of the probe's spin loop passes and `units=5` does not — while a
Durable Object ran 1,323 ms of the same loop without complaint and only died at `cpuTimeMs: 32000`.
Three thousand times the room, and every line of this agent's work runs on the second number. So
`search()`'s brute-force cosine is nowhere near a CPU ceiling; if it becomes slow it will be slow
for a reason that has to be measured, not because of the 10 ms in this table. The enforcement is
not crisp at the moment of breach — the first two over-budget handler calls were killed at
`cpuTimeMs: 2010` and only later ones at 10–13 — so treat 10 ms as the number to design against
and not as the number you will see in a log.

Vectorize is unresolved: the pricing page says "only available on the Workers paid plan" and one
paragraph below shows a Workers Free column. Untested, not needed yet.

**A `pnpm deploy` does not mean the next request runs the new code.** A live Durable Object keeps
running its old version until the instance restarts. On 2026-08-06 a fix was deployed, the next
invocation 22 seconds later still ran the old code, and the new one took effect about five minutes
later once the DO had gone idle. Half an hour went into looking for a bug in code that was
correct and simply not running yet. When a deploy appears to have had no effect, wait for a
restart before doubting the change. *(Consistent with every number observed that day; the DO
lifecycle docs were not read.)*

## Where this agent runs out of room

Current sizes as of 2026-08-12: 47 indexable files, 93 chunks — the later measurement, because the
2026-08-06 one predates chunking and counted a file as one vector. Nothing below is
close except where marked. The column that matters is the last one — a ceiling that degrades
loudly is a scheduling problem, one that degrades silently is a correctness problem you will not
notice.

| Ceiling | Value | Bites at | What happens |
| :--- | :--- | :--- | :--- |
| Reindex per invocation | the subrequest budget, checked against the next file's chunk count | a night whose changed files exceed ~46 chunks | the cron runs up to `MAX_REINDEX_SLICES = 10` slices back-to-back, then logs `stage: 'slices-exhausted'` |
| `search()` brute-force cosine | 30 s CPU, 1024 dims/vector | far further out than the 1–5k vectors this row used to claim | recall throws or truncates |
| Reindex CPU per slice | same 30 s | not the binding constraint; embeddings are | — |
| Scheduled tasks | `MAX_SCHEDULED_TASKS = 20`, and a recurring task hourly at most | a model that reads a page telling it to poll every minute | `set_scheduled_task` answers with an error naming the limit; reminders are exempt, they send one message |
| `listSkills` | `MAX_SKILLS = 30` | 31 skills | loud since 2026-08-06: `stage: 'skills-truncated'` |
| `read_page` fallback | Firecrawl when Browser Rendering refuses | every blocked page | loud: `at: 'read_page'`, `via`, `fellBack`, `why` |
| `search_memory` keyword hits | `MAX_MEMORY_RESULTS = 3` + `MAX_SESSION_RESULTS = 2` | always | **silent** truncation of the tail |
| Semantic hits | 5 | always | **silent** |
| Memory/session body in a prompt | `MAX_CONTENT_CHARS = 4000` | long notes | **silent** truncation |
| Embedded text per file | none — `MAX_EMBED_CHARS = 1600` is now a chunk size | never | the whole file is indexed |
| `USER.md` / `AGENT.md` | 1300 / 2000 chars | profile growth | loud: the write is refused |
| Conversation history | `0.80 × context` to compact, `0.25 × context` of verbatim tail | every long chat | loud: `at: 'compact'`; the head becomes `historySummary` and the raw turns go to the thread's `archive` table |
| What one summarizing call can fold | `0.25 × context` of the evicted head | a switch to a much smaller window | loud: `at: 'compact'` carries `unsummarized`; the rest is archived raw rather than summarized twice. Counted over everything evicted, not over the spoken head the summarizer read — the tool traffic filtered out before the call also leaves with no summary describing it |
| The verbatim tail cutting a tool group | none — `ownedGroupStart` moves the boundary back to the assistant that owns the calls, even where that overshoots `0.25 × context` | a compaction landing mid-round | **silent**, and deliberately: the alternative is an unmatched `tool_call_id`, which the next request refuses with a 400 |
| Tool traffic whose other half is missing | none — dropped from the copy sent to the model | a turn interrupted between a call and its result | loud: `stage: 'unpaired-tool-traffic'` over stored state, `stage: 'unpaired-write'` when the loop's own output is the unbalanced one |
| Model catalogue | cached 1 h in the Cache API | a provider adding a model | stale for an hour; the browser also caches, which reads as a bug in dev |
| Tool rounds per turn | `maxRounds = 12` — a backstop, raised from 6 on 2026-08-27 | complex asks | loud: `stopReason: 'max-rounds'`, and now rare enough that the reason is worth reading |
| Tokens per turn | `maxRounds × context` by construction — a request over the window is refused, so a round cannot exceed it | never observed | measured, not guarded: `tokensSpent` on every `stage: 'done'`. A tighter budget was written and removed the same day — it halved a ceiling that already existed, on a number nothing had measured |
| A provider that reports no `usage` | none — `tokensSpent` reads 0 | a provider omitting the block | loud: `stage: 'unmetered'`, once per turn, so blindness cannot pass for thrift |
| A tool result kept whole | `ARCHIVE_MIN_CHARS = 2000` and up | every page and search | `archive` row per result, read back with `read_tool_result`; a failed write is loud (`stage: 'archive-failed'`) and costs only the ref. **A handler that cuts its own output cuts the row too** — `search_memory` did, and filed 4,041 of 12,213 characters while offering a ref to the rest. Cutting belongs to the loop |
| How long a tool result stays whole | `PROTECT_RECENT_RESULTS = 1`, and the prune runs after a round completes, so the first cut is round `N + 3` | a turn of four rounds or more — 13 of 16 real turns had fewer | not a truncation at all, which is the point: at `N = 3` it fired in 1 turn of 16. `stage: 'pruned'` is absent when nothing was old enough |
| A tool result the model already answered | `PRUNE_OVER_CHARS = 8192`, kept as 4096 + 1024 | a `read_page` in any round but the last | loud: `stage: 'pruned'` carries the characters saved. Only tools that raised `maxResultChars` reach it — `truncate`'s 4000 cuts the rest below the threshold first — and only a result carrying a ref, since the archive is what makes the cut recoverable. `search_memory` joined that set on 2026-09-02 at 20,000 |
| **The pruner against a small window** | `resultCap` falling under `PRUNE_OVER_CHARS` — any window below ~27,300 tokens | a scout on the picker's low end | loud since 2026-09-02: `stage: 'prune-inert'`. **The two caps cancel each other**: the smaller the window, the harder `resultCap` bites, and the more certainly every result lands under the 8,192 the pruner acts above. At 24k every result is 7,200 characters and nothing is ever shortened — so that model has protection against *one* result and none against the *sum*, which is the state a scout was in before it had an archive at all. Pinned by a test rather than fixed: tuning the two against each other buys a round or two before the sum overflows anyway, and research on a 24k model is not a thing anyone runs |
| A tool result in `state.messages` | the same 8192, as a hard `truncate` | a result whose filing threw | **silent**, and the loss is already reported by `archive-failed`: with no ref there is nothing to recover, so the choice is only whether the middle is also broadcast to every client on every later turn |
| `search_tool_results` matches | `MAX_HITS = 5` | a common word in a long thread | **silent**, and a `LIMIT` on the read rather than on the reply: each row carries a whole page, so the cap exists to avoid parsing fifty of them to cut fifty snippets. Doing the slice in SQL would retire it |
| The plan lookup itself | one `fetch` per instance per hour, uncounted | every cold start | the one outbound call `SubrequestBudget` does not see — it runs before any budget exists, which is what it is for. It spends one of that invocation's 50 |
| Compactable surface | neither the running summary nor the system prompt can be trimmed | either one alone over `COMPACT_AT_FRACTION` | loud: `stage: 'nothing-to-evict'`; every turn then schedules a pass that does nothing |
| An evicted head that is all tool traffic | none — the rows are archived and leave the surface, the summarizer is simply not called | a round of tool calls at the front of the history | loud: `stage: 'nothing-to-summarize'`. The call is skipped rather than spent on an empty transcript, whose answer would overwrite a summary it had nothing to add to |
| Tools re-run by an overflow retry | none — the loop restarts | a refusal after a mutating tool ran | silent, and accepted: the refusal is nearly always the turn's first call |
| Research requests per run | `RESEARCH_SUBREQUEST_BUDGET = 402` | never, by construction | loud: `stopCause: 'budget'` |
| Scouts in a wave | `MAX_SCOUTS - 2 × round` | round 0 is 4 wide — `MAX_SCOUTS` is 5 but a plan holds at most four angles — round 1 is 3, round 2 is a plain round | loud: `stage: 'wave'` carries `angles` |
| Citations in neither `visited` nor a search result | none — reported, not removed | a model inventing a source | loud: `stage: 'ungrounded-citations'` |
| Search vendor refusing every provider | none | a wave outrunning a rate limit | loud: `stage: 'unavailable'`; the model is told it is a tool fault |
| Firecrawl search | 10/min, 2 credits, 1000/month | a wave of four scouts | Tavily leads instead: 100/min, 1 credit |
| Workers AI on Free | 10,000 neurons a day, reset 00:00 UTC | a deep research run on a `@cf/` model — a wave of scouts plus the report | documented: error 3036 / HTTP 429 from the provider, which the loop reports as a failed turn. **Not measured**: how many runs a day fit; a paid plan or `LLM_BASE_URL` is the fix |
| Search with no key | keyless on both vendors since mid-2026; Firecrawl's launch post says 1,000 credits a month, Tavily publishes no number | a research run on a fresh deploy | 429 is reported as `stage: 'unavailable'`, never as an empty web. **Not measured**: how far a wave gets before the keyless limit; a key is the fix |
| Browser Rendering on Free | **1 request / 10 s**, plus 10 min/day of browser time | a wave of scouts reading — a single round outruns it | falls back to Firecrawl, with `why`. **The limit that binds is the Quick Actions one, not the session one.** `read_page` calls `/browser-rendering/markdown`, which Cloudflare documents as a Quick Action; the 3-concurrent / 3-new-a-minute figures on the same limits page govern Browser *Sessions*, which nothing here opens. One request every ten seconds is far tighter, and it is what a wave of four concurrent scouts actually hits — see `docs/manual-e2e.md`, where 14 of 30 reads failed on `code: 2001` |
| A scout that opened no page | none — reported | a run whose searches came back empty | loud: `stage: 'wave'` carries `unread` |
| A round that opened nothing *and* saw nothing | findings dropped | ~a third of searches return empty | loud: `stage: 'ungrounded-round'` |
| Scout spend across a run | `RESEARCH_SCOUT_BUDGET = 250` | a long run of full waves | loud: `stage: 'scout-budget-spent'`; the run continues as sequential rounds |
| A plan with one angle | none — reported | a plan model that answers in one line | loud: `fansOut: false`, and the proposal says so |
| Angles in a plan | `MAX_PLAN_LINES = 4` | asking a revision for a fifth | loud since 2026-08-23: `stage: 'plan-truncated'`; the card says "at most four angles", because the agent does not know the number and told a user there was no limit |
| One scout's wall clock | `SCOUT_TIMEOUT_MS = 180000` | a scout that hangs | loud: `stage: 'scout-failed'`; the wave keeps the other angles. **Raised from 120 s**, which was derived from local runs of 45–90 s: the first production wave put two of four scouts past it, finishing at about 138 s and 162 s after the wave had already closed, so their pages were paid for and thrown away. The cap has to clear the slowest scout still working, not the fastest that has finished |
| Research rounds per run | `RESEARCH_MAX_ROUNDS = 12` | every deep run | loud: `stopCause: 'max-rounds'` |
| **Wall clock per run** | `RESEARCH_DEADLINE_MS = 300000` | **every run — the bound meant to fire** | loud: `stopCause: 'time'` |
| Deadline headroom | `roundHeadroomMs` — measured, floor 60 s | every run's last round | the check refuses a round unless a whole one still fits |
| Research budget headroom | `ROUND_WORST_CASE = 50` | every run's last round | the cap is checked with a round's worth left, so the budget is not exceeded |
| `read_page`'s **first view** | `MAX_PAGE_CHARS = 100000` | pages over ~100k | loud: `stage: 'over-first-view'`, `chars`, `cap`. The field is `cap`, not `shown`, because the loop may cut further when the window is the tighter bound, and `stage: 'window-capped'` is what reports that. **Not a loss** — the handler returns the whole fetch and the loop archives it before `truncate` cuts the copy that goes in the request, so `read_tool_result` reaches the rest. Raised from 50,000 as arm D of `evals/results/inline-page-size-preregistration.md`, unmeasured: it stops firing on the real distribution (72k, 64k, 38k, 27k, 24k measured) at the cost of a bigger result re-sent until the pruner reaches it |
| `read_tool_result`'s window | `WINDOW_CHARS = 40000`, capped by `MAX_READBACK_CHARS` — which is derived as `WINDOW_CHARS + 4000` rather than written out, so the headroom for the reply's own framing cannot drift away from the window it frames — and **sized down to whatever `resultCap` will pass** | any model under ~134,000 tokens — every picker model but the default | the window is sized from the cap so that `chars=` and `more=` are true; computed from the full window they advertise an offset past text that never arrived, and a model following it skips the gap for good. Measured by mutating the fix out — 40,234 characters against a 7,200 cap. **The one place the absolute-versus-window mismatch produces a wrong instruction** rather than a smaller view |
| `read_research_report` result | 40,000 chars | a report over ~40k | `truncate` names the cut in the model's copy and logs nothing; the whole thing is in the archive |
| A `web_search` result | `MAX_SEARCH_CHARS = 10000` over `SEARCH_RESULTS = 10`, against a measured 4748–5979 and a structural ~6700 | never | all three numbers set 2026-09-01, all measured. Asking five rendered 2542–3016 and needed no cap; asking ten crosses the loop's default 4000 every time, so a cap must be declared and must sit above the *ceiling* rather than the sample — 6000 cleared six of six queries and would still have cut the first long one. An inherited `2000` sat under the distribution and cut **8 of 8** searches silently. Asking twenty returns 8–19 results and up to 10402 chars, which a round that opens one or two pages cannot use. `deepseek-harness` bounds the same tool at 8 results and sets no character cap |
| A search snippet | 500 chars, one of the three chunks Tavily joins | a long snippet | **silent**, and much smaller than it was: 400 cut *inside* the first chunk and kept 11,743 of 35,243 characters already paid for — 29 of 30 results measured were over it |
| **Any one tool result against the window** | `RESULT_SHARE_OF_WINDOW = 0.10` of the model's context, in estimated chars — 7,200 at 24k, 393,000 at 1.31M | the picker's low end, never the default model | loud: `stage: 'window-capped'`. The fraction binds below ~333k tokens (where 0.10 × 3 chars × window drops under `MAX_PAGE_CHARS`) and each tool's own cap binds above, which is the crossover one absolute number cannot have. **An unknown window is treated as unknown, not as small** — the opposite of `DEFAULT_CONTEXT_TOKENS` elsewhere, because a thread's window is simply unresolved until something asks, and guessing 24k would cut nine tenths off every first page read on the default model. It matters most in a **scout**, which has no overflow retry, so a request over the window loses the angle as `scout-failed` rather than being compacted and sent again. **Two comparable harnesses scale this with the window.** `openclaw` derives its live tool-result cap from the effective window in bands: 16,000 chars below 100k tokens, 32,000 at 100k+, 64,000 at 200k+ — read from `docs.openclaw.ai/gateway/config-agents` on 2026-09-02 — which is 5–11% of the window at this repo's own 3-chars-per-token estimate, so `0.10` lands inside their top band. `gemini-cli` bounds tool output a third way — `COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET`, one shared 50,000-token budget across all of them, walked newest-first, so a big result costs its neighbours rather than being capped alone; its `contextPercentageThreshold` default reads `0.7` in the published config docs and `0.5` in DeepWiki's account of the constants, and that conflict is unresolved. `hermes-lcm` and `deepseek-harness` do keep absolute per-result thresholds. So a fraction is an ordinary answer here, not a novel one. It is still a **patch for having a 100,000-char first view**, and **the only cap acting before the first send**: a ref, the pruner and `read_tool_result` all act from round `N + 1` and only on re-sends, so the round that *first* carries the page carries it whole, and in a scout that request is `scout-failed` rather than retried. The scout's archive fixed recoverability of a cut, not overflow. Arm B — a small first view plus a ref — is what could retire this |
| A `search_memory` result | `20000`, set 2026-09-02 | never, by construction | one memory may be `MAX_CONTENT_CHARS` alone and a result carries three plus sessions, so the default cut it to a third every time — **12,213 characters measured against a 4,000 cap**. It was the only one of nineteen tools overflowing the default systematically; the other eighteen are nowhere near it, which is why this is its own cap rather than a bigger default |
| Any other tool result | `truncate`'s default 4000 | tools that return volume | same — head and tail survive, the marker counts what went, and `read_tool_result` has the rest. **The recovery is an invariant, not a coincidence**: `ARCHIVE_MIN_CHARS = 2000` sits under the smallest cap anything is cut at, so a cut result is always filed and its marker always redeemable. `test/unit/tools.test.ts` holds that across the two files it spans, and it holds in a scout too |
| Earlier findings shown to a round | `FINDINGS_SHOWN = 3` | run past round 4 | loud: `stage: 'findings-windowed'`; the report still writes from all of them |
| Visited URLs shown to a round | `VISITED_SHOWN = 30` | 31 pages in one run | loud: `stage: 'visited-truncated'`; `read_page` still refuses the tail |
| R2 `list` page | 1000 keys | 1000 files in one folder | handled: the connector paginates |
| DO SQLite | 10 GB | never, at 93 vectors | — |
| Workers Logs | 3 days | every missed export | traces gone for good |

One row left that list rather than getting louder: `MAX_EMBED_CHARS` was a head-truncation that hid
half the vault's characters from the index (50,802 of 103,783, measured 2026-08-12), and it is now
the size of a chunk, so a file is covered end to end. Adopted for that coverage, not for ranking —
`evals/results/chunking-experiment.md` compared chunked against truncated on 78 labels and every
interval crossed zero.

The silent ones are the list to watch. `MAX_SKILLS = 30` was the nearest and now logs when it
truncates — the cap did not move, the invisibility did. Sessions accumulate forever with nothing
pruning them, so the manifest and the embedding index grow without bound while the CPU ceiling on
`search()` stays fixed.

When any of these moves, the fix is usually not a bigger number: it is making the truncation
loud first, so the next person finds out from a log line rather than from a wrong answer.

## Design decisions, by subsystem

The reasoning behind each subsystem — the rejected alternative, the measurement, the outage that
caused the rule — lives in `docs/decisions/`. Read the one you are about to touch. Nothing there is
a description of the code; it is what the code cannot tell you.

| | |
| :--- | :--- |
| [web-and-channels.md](docs/decisions/web-and-channels.md) | Delivery is a `setState`. Why Cloudflare Access is the gate and what kind it has to be, why clients only call RPCs, and how a turn finds its own message by id. |
| [history-and-archive.md](docs/decisions/history-and-archive.md) | Compaction on the model's context window, the archive that survives it, and what the nightly reflection is allowed to see. |
| [memory-and-the-gate.md](docs/decisions/memory-and-the-gate.md) | Provenance on every write, the gate on the two that destroy something, and the ratings nothing reads yet. |
| [tool-boundary.md](docs/decisions/tool-boundary.md) | One zod schema per tool: shown to the model and used to parse its reply, so the two cannot drift. |
| [research.md](docs/decisions/research.md) | Waves of scout Durable Objects, the four caps on a run, and what the first production runs measured. |
| [providers-and-models.md](docs/decisions/providers-and-models.md) | Why `/api/models` is proxied, and the one Cloudflare token that covers everything. |
| [linting-and-formatting.md](docs/decisions/linting-and-formatting.md) | Which oxlint rules are on, which were counted and refused, and why TypeScript 7 is blocked. |

Two of these carry a rule worth knowing before you read any of them: **maintenance never runs inside
a turn**; and **compaction is the only thing that destroys history**, which is why it records what
it destroys.

## Invariants that cause outages when broken

**Every outbound call is counted.** The Free plan allows 50 external subrequests per invocation.
`SubrequestBudget` ([src/agent/subrequest-budget.ts](src/agent/subrequest-budget.ts)) wraps
`fetch` and counts. Every connector takes an optional trailing
`doFetch: typeof globalThis.fetch` — a new connector that calls `globalThis.fetch` directly is
invisible to the budget and will silently reintroduce the failure mode below.

**Maintenance never runs inside a turn.** Index reconciliation and `MEMORY.md` rebuilds belong in
alarms, which are separate invocations with their own budget. A turn may notice that maintenance
is needed and schedule it; it must not perform it. A full index sweep firing inside a chat turn is
what caused the 2026-08-03 outage. Bounding such work to "what fits in the leftover budget" is a
smaller version of the same mistake, not a fix.

**Retired 2026-08-22: "failure notices go out on a fresh invocation."** `catch` blocks used to
schedule `postNotice` rather than call `sendMessage` inline, because sending from an invocation that
had just exhausted its budget failed for the same reason the turn did and the user saw nothing at
all. With no outbound send left, a notice is a `setState` and costs no subrequest, so the hop
reported from one state write instead of another. `catch` blocks call `emit` directly. It is
recorded rather than deleted because the reasoning is still right — **it comes back the day
anything here sends again.**

**Assets answer before the Worker unless the path is listed.** `run_worker_first` in
`wrangler.jsonc` names every non-UI prefix (`/agents/*`, `/api/*`, `/admin/*`, `/dev/*`). A path
missing from that list is served the SPA shell and the handler never runs. It has bitten twice: once
the Telegram webhook, back when there was one (caught in review), once `/api/models` (caught by a
curl returning `<!doctype html>`). A new route means a new entry, and the symptom is HTML where JSON
was expected — not a 404, which is what makes it confusing.

**The tool loop keeps a reserve, and checks it per tool call.** `FINAL_ANSWER_RESERVE` calls stay
unspent so a turn that runs out of room still produces something readable instead of throwing
inside the OpenAI client. Checking only between rounds is not enough: a model can request many
tools in one round and each spends, which is how a turn reached 55 of 50 on 2026-08-07. A skipped
call still gets a tool result — an unmatched `tool_call` id makes the next request a 400, so
skipping quietly trades an over-budget turn for a broken one. The reserve is now the only claim on
that budget: the typing indicator, which used to yield at a higher floor so cosmetics lost before
answers did, went with the Telegram channel.

**A tool's schema is one object, and the loop validates against it before the handler runs.** A
handler is never entered with arguments the schema refused, and a refusal goes back to the model as
a tool result naming the field — see
[docs/decisions/tool-boundary.md](docs/decisions/tool-boundary.md). A new tool that hand-writes its
JSON Schema instead of deriving it from `params` reintroduces the drift this removed.

## Memory

Vault layout in the R2 bucket bound as `VAULT`, under the `VAULT_AGENT_DIR` key prefix. It began
as a GitHub repository behind the same four methods, which is why `VaultBackend` is an interface
with one implementation: the swap was a class, not a rewrite.

```
agent/MEMORY.md      hand-written index — one "- slug — description" line per memory
agent/memory/*.md    the memories themselves
agent/memory/archive/*.md  memories reflection retired, filed with the evidence that retired them
agent/skills/*.md    skills the agent wrote for itself; retired ones under skills/archive/
agent/research/*.md  finished research reports, one file per run, reachable semantically only
agent/sessions/*.md  session summaries — 17 legacy files, still read, no longer written
agent/threads.json   the thread registry: id, title, last touched
agent/USER.md        user profile, hard-capped at 1300 chars
agent/AGENT.md       agent self-notes
```

**Three read paths, and they do not read the same thing.** `search()` and `list()` in
[src/agent/memory/vault-store.ts](src/agent/memory/vault-store.ts) parse `MEMORY.md` only;
`indexManifest()` lists the prefix. Any write that does not go through `save_memory` — a console
upload, a migration script — desynchronizes them, and the agent then answers confidently from the
half it can see. This has happened. When changing memory code, ask which of the three paths sees
your change.

The embedding index is derived data keyed by the R2 `etag`. A file whose etag is unchanged must
never be re-read or re-embedded. **It is keyed by `(kind, slug)`, not by slug** — a memory and a
session can share a slug, and this vault has one that does. Keyed by slug alone the two overwrote
each other: every reconcile re-embedded whichever lost, and only one of them was searchable at a
time, flipping on each run. A reconcile over an unchanged vault must report `indexed: 0` and spend
zero subrequests; anything else means the key is wrong again.

Slugs are not stable identifiers either. `slugify` trims a trailing `-YYYY-MM-DD` so a dated name
updates in place, which means two different memories can slugify to the same string. Lookups go
through `slugCandidates()` — the name as given first, the trimmed form second — because trimming
on the way *in* once archived the wrong file.

## Deploying this

The two things a fresh deploy gets wrong if nobody says them, and both are deliberate.

- **The committed defaults are opinions, not neutral.** `LLM_BASE_URL` points at OpenRouter — omit
  it, point `LLM_MODEL` at a `@cf/` model, and Workers AI answers with no second key — and
  `LOG_CONTENT` is on, which means message bodies, tool arguments and tool results reach the logs.
  Both are one line in `wrangler.jsonc`.
- Cloudflare Access is **decided and lives outside this repository**, and it must be the
  **hostname-based** kind: a worker-level policy 403s WebSocket upgrades, which is all this client
  does. `ctx.access` is empty here either way — the assets router does not pass it — so the signal
  is the `Cf-Access-Jwt-Assertion` header, and `accessRefusal` in [src/index.ts](src/index.ts)
  **refuses with 503** when it is missing rather than warning. `ALLOW_UNPROTECTED=true` is the
  deliberate way out and logs on every request. **Both paths measured 2026-08-23**: with a policy
  live the chat connects and answers, which a fail-closed gate could not do if the header were
  absent; with the policy off for a minute the same URL answers `503` and the log carries
  `at: 'access', stage: 'refused'`. An Access application on the **Workers** destination covers
  `*.workers.dev` as well as a custom domain — a `curl` there gets Access's own 302 before the
  Worker runs — so in normal operation there is no unprotected door.
- **`wrangler deploy` cannot provision any of that.** It creates the Durable Objects and binds
  Workers AI, and the bucket is one `r2 bucket create`, but Zero Trust is a separate product with its
  own activation. So a stranger's first deploy is a Worker that answers 503 until they set Access up
  — which is the intended shape, and the reason the default is closed rather than open.
