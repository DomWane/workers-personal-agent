# Manual walkthrough: threads, compaction, the context meter, the tool archive

What the automated suites cannot see. `pnpm test` runs the Worker without a browser and
`pnpm test:evals` runs Node; neither loads the built client, and neither opens a WebSocket to a live
Durable Object. Every bug found on 2026-08-17 lived in exactly that gap:

- a `<button>` inside the composer's form defaulted to `type="submit"`, so **Compact** sent an empty
  message instead of compacting;
- a forced compaction against a million-token window found nothing to evict and returned in
  silence, which reads as a dead button;
- the compaction threshold measured against the conservative default window until something forced
  a lookup, so a model *smaller* than that default never triggered a compaction on its own.

None of the three would have failed a unit test, and all three took under a minute to see by hand.

## Setup

Two terminals, and no provider spend: the stub answers every completion and serves its own
catalogue, so the model windows are fixed and the walkthrough is repeatable.

**Once, if the account has Cloudflare Access on it:** `brew install cloudflared`. The `ai` binding
has no local simulator, so `wrangler dev` opens a remote proxy session against the deployed Worker,
which Access gates. Wrangler then sends you to the Access login — so **run terminal 2 without a
pipe**. Through `tee` it is non-interactive and fails asking for service-token credentials, which
looks like a permissions problem and is not. `script -q /tmp/dev.log pnpm dev` if you want the log
in a file as well.

```bash
# 1 — the fake provider. STUB_PROMPT_TOKENS is what it reports as prompt_tokens; the compaction
#     threshold reads exactly that number, so this is the knob that decides when compaction is due.
STUB_PROMPT_TOKENS=13400 STUB_DELAY_MS=1500 node scripts/stub-llm.mjs

# 2 — the Worker, pointed at the stub. `--var` beats `.env` (verified 2026-08-17, wrangler 4.107).
pnpm build:web
npx wrangler dev --local \
  --var LLM_BASE_URL:http://127.0.0.1:8899/v1 --var LLM_API_KEY:stub --var LLM_MODEL:stub-large
```

`STUB_DELAY_MS` is what keeps the in-flight states — *Thinking…*, *Compacting…* — on screen long
enough to look at. Without it a local answer arrives faster than the eye.

The catalogue the stub serves is two models, chosen so the thresholds are arithmetic you can check:

| Model | Window | 80% (compaction due) | 25% (verbatim tail) |
| :--- | ---: | ---: | ---: |
| `stub-large` | 200,000 | 160,000 | 50,000 |
| `stub-small` | 8,000 | 6,400 | 2,000 |

**Reload with the cache bypassed** (⇧⌘R) after restarting the Worker: `/api/models` is served with
`max-age=3600` and the browser will otherwise show the previous run's model list — which reads as a
bug and is not one.

## Scenarios

Each seeds a **real thread** (not the `main` landing — a message sent from there starts a new thread,
so anything seeded in it could never receive the turn being tested) and prints the URL to open.

```bash
node scripts/seed-web-chat.mjs --scenario compact      # 10 long turns, nothing near the threshold
node scripts/seed-web-chat.mjs --scenario threshold    # 20 turns on stub-small: the next turn compacts
node scripts/seed-web-chat.mjs --scenario switch       # ~7k tokens: fits stub-large, not stub-small
node scripts/seed-web-chat.mjs --scenario compacted    # already folded once
node scripts/seed-web-chat.mjs --scenario chat         # the original UI tour: markdown, tools, research
```

`--tokens` overrides the reported prompt size and `--model` the override the thread runs on; both
default to values derived from the seeded text, because a fixture that claims 150k tokens over 15k of
messages makes the threshold fire and then find nothing to evict — which looks like a broken feature
and is a broken fixture. That mistake is why the numbers are computed rather than typed.

## Walkthrough

### 1. A conversation, from nothing

Open `http://localhost:8787/`, type anything, send.

- the message appears **before** the answer, with *Thinking…* under it
- the answer renders as markdown
- a thread appears in the sidebar named after the first message, and the URL gains `?t=t-…`
- the meter reads a measured number — hover it: *counted by the provider*, not *estimated*

Send a second message **while the first is still answering** (this is what `STUB_DELAY_MS` buys):

- both questions and both answers land, in order
- neither answer is attached to the wrong question — this was broken until 2026-08-17: turn one
  rewrote turn two's text with its own, and turn two read turn one's question as an assistant line

**That very first message is its own check**, and it was broken until 2026-08-31. Sending from the
landing page creates the thread, which switches the socket, and the send raced the new handshake:
the message was refused and lost, every time, with the header admitting *Disconnected*. The `ready`
promise existed for exactly that case and was unreachable — the `connected` guard above it returned
first. So: **send from `/`, not from a thread**, and watch the message survive the switch. A queued
outbox was rejected as the fix; it would deliver into a thread the user had already left.

The other half of that guard is worth checking in the same minute, because the fix could have cost
it: stop the Worker (⌃C in terminal 2) and send. The toast must be **immediate** — measured at 3 ms
— not after the handshake bound. A dropped socket keeps the previous connection's already-resolved
`ready`, so nothing waits; only a page load against a dead Worker spends the full 5 s.

### 2. Threads

- reload the page: the thread is still in the sidebar (it comes from `agent/threads.json`, not from
  `localStorage` — a cleared browser must not strand a conversation)
- the pencil on a thread you are **not** in: one click opens it *and* starts editing
- type a name, click the check: the sidebar shows it, and a reload keeps it
- the trash asks first; confirming empties the thread and drops it from the list

### 3. The Compact button — `--scenario compact`

The thread is far under the threshold, so nothing automatic will happen here.

- the meter shows the size against `stub-large`'s 200k
- press **Compact**: *Compacting…* appears on the button (disabled) and
  *Folding the earlier turns into a summary…* in the thread
- when it finishes: only the last exchange is left, *Earlier conversation* sits at the top, and
  opening it shows the stub's summary
- the button is now disabled — with one exchange left there is nothing to fold

### 4. Compaction that fires on its own — `--scenario threshold`

The thread runs on `stub-small` (8k) and holds ~13k tokens, so the very next turn is over 80%.

- send any message
- the answer arrives first, then the thread folds: *Earlier conversation* appears and the tail is the
  last exchange or two
- the meter drops and gains `~` — the surface it measured is gone, so the number is an estimate again
  until the next turn reports one

### 5. Switching models — `--scenario switch`

- open the model picker in the composer and choose `stub-small`
- the dialog names both numbers: *This conversation is 7k tokens and stub-small holds 8k…*
- **Cancel**: nothing happens — the model stays `stub-large` and the history is untouched
- pick it again and **Switch and compact**: the model changes *and* the thread folds
- switching back to `stub-large` asks nothing: it fits

### 6. Overflow — the trigger that matters most

No threshold can rule out a single large tool result, so the provider's own refusal is the net under
the other two. Restart the stub so its first completion refuses the way a provider does, then seed
any thread and send a message:

```bash
STUB_OVERFLOW_ONCE=1 node scripts/stub-llm.mjs
node scripts/seed-web-chat.mjs --scenario switch --thread t-overflow
```

- the turn does **not** fail: the thread folds mid-turn and the retry answers
- *Earlier conversation* appears, and the tail is the last exchange
- no *Sorry — I hit a problem* notice
- the log carries `stage: 'overflow-retry'`

This is the one place where maintenance deliberately runs inside a turn: the turn is already lost
otherwise, and scheduling an alarm would answer a question with an apology.

### 7. The tool archive — `STUB_TOOLS=1`, and no browser

A tool result is cut to 4,000 characters before the model sees it, and a later round shortens it
again to a stub once it has been answered on. Both are why the archive exists, and neither is
visible in the UI — what the walkthrough checks is that a ref quoted in one turn still reads in
another. `/dev/chat` is enough, so this one needs no browser at all.

`STUB_TOOLS=1` makes the stub call a tool when the *user's* words say to, which is the half a stub
can honestly stand in for: whether a real model chooses `search_tool_results` over a fresh
`web_search` is a question about the model, and section 8's shape is how to ask it.

```bash
STUB_TOOLS=1 node scripts/stub-llm.mjs
npx wrangler dev --local \
  --var LLM_BASE_URL:http://127.0.0.1:8899/v1 --var LLM_API_KEY:stub --var LLM_MODEL:stub-large

# A memory long enough to be filed — the threshold is 2,000 characters — and an index that finds it.
# `search_memory` is the one tool that returns volume from local R2, so nothing here costs a vendor.
python3 -c "print('---\nname: e2e-big-note\ndescription: a long e2e note about lorem\n---\n\n' + 'lorem ipsum dolor sit amet consectetur adipiscing elit ' * 200)" > /tmp/e2e-big.md
printf '# Agent memory\n\n- e2e-big-note — a long e2e note about lorem\n' > /tmp/e2e-index.md
npx wrangler r2 object put personal-agent-vault/agent/memory/e2e-big-note.md --file /tmp/e2e-big.md --local
npx wrangler r2 object put personal-agent-vault/agent/MEMORY.md --file /tmp/e2e-index.md --local

for t in "dump vault" "read ref 1" "find in results"; do
  curl -s localhost:8787/dev/chat -d "{\"text\":\"$t\",\"thread\":\"arch\"}"; echo
done
```

Three turns, three deliberately separate ones — a ref that only worked inside the turn that made it
would prove nothing. Read the log, verified this way on 2026-08-31:

- turn 1 files the result: `stage: 'tool-result'`, `tool: 'search_memory'`, `resultLen` **larger**
  than the archived length, because what the model got is the cut copy plus the `[kept whole as
  ref 1]` footer
- turn 2 reads it back whole: `chars="0-4039 of 4039"` and no `more=` — one window covers it
- `fetched="2026-08-31 14:19"` on both reads is the row's own time. A date that renders
  `Invalid Date` means the record's `at` stopped coming from the row and is the failure
  `test/unit/tool-archive.test.ts` pins
- turn 3 finds it by content: one hit, `ref="1"`, an `…`-fenced snippet, and the page itself never
  leaves SQLite
- **the ref stays 1 across all three.** `read_tool_result` and `search_tool_results` set `noArchive`,
  so reading the archive does not file a copy of what it just read; a ref climbing here means that
  flag stopped being honoured and every read is now paying for a duplicate row

The local vault is overwritten by the two `r2 object put` lines above. It is Miniflare state, so
`rm -rf .wrangler/state` resets it — but a walkthrough run after this one starts with a one-memory
vault, which is worth knowing before section 8 is read as broken.

### 7b. Tool traffic in the thread — the browser half of section 7

Since 2026-09-01 a turn's calls and results are persisted, so `state.messages` holds rows the client
must never draw and the model must always get. Section 7 proves the model half over `/dev/chat`;
this one needs the browser, because the failure is a bubble that should not exist.

Same two terminals as section 7, then **send from `/`, not from a thread** — that path was losing
its message until 2026-08-31 and is the one a stranger hits first. Ask `dump vault`, then in a
second turn `read ref 1`.

Verified this way on 2026-09-01:

- two exchanges on screen, four bubbles — not eight. The `assistant` carrying `tool_calls` and the
  `tool` row are traffic, and `spoken()` keeps them out of the thread
- under each answer: `used search_memory`, then `used read_tool_result`, and a `2k tokens` line
- **Compact stays disabled.** State holds eight messages; one exchange is still nothing to fold, and
  the button counts what was said rather than what is stored
- the second turn calls `read_tool_result` at all — the ref survived a turn boundary, which is the
  whole point of persisting the traffic

Read the state itself rather than trusting the screen, over the same socket the client uses:

```js
// in the browser console, on ?t=<thread>
const ws = new WebSocket(`ws://${location.host}/agents/personal-agent/${new URLSearchParams(location.search).get('t')}`)
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.state) console.table(m.state.messages.map(x => ({ role: x.role, len: x.content.length, id: x.tool_call_id ?? '', tokens: x.tokens ?? '' }))) }
```

What that must show, and did:

```
user 10 · assistant 0 (tool_calls) · tool 4140 (tool_call_id) · assistant 41 (tokens 2400)   ×2
```

Every pair whole — a `tool` row without the assistant above it, or an id-less one, is the 400 that
`pairedOnly` exists to prevent, and it would be **written** here rather than read. `tokens` sits on
the answering assistant only.

The log must carry none of these:

```
stage: 'unpaired-write'          this turn wrote half a pair — a bug in turnToolTraffic or its offset
stage: 'unpaired-tool-traffic'   stored state held half a pair — housekeeping, not this turn
stage: 'archive-failed'          both attempts at the row failed; the page is unrecoverable
```

### 7c. Compacting a thread that holds tool traffic

The one path nothing had walked until 2026-09-01, and the one where the two new guards are the
difference between a thread that survives and a thread that is dead. Continue straight from 7b —
the two exchanges it leaves are exactly the fixture — and press **Compact**.

- **Compact is enabled now and was disabled after the first turn.** Eight messages in state, two
  exchanges said: the button counts what was spoken
- *Earlier conversation* appears and holds the stub's summary
- the tail begins with the **assistant that made the call**, never with the `tool` row under it.
  Read it over the socket, with the snippet from 7b:

```
assistant 0 (tool_calls) · tool 4227 (tool_call_id) · assistant 41
```

  `ownedGroupStart` is what moved the boundary back; without it the tail starts at the `tool` row
  and the next request is a 400 that never recovers, because the orphan stays in state
- the user turn *above* that assistant is evicted while its answer stays. That reads oddly on
  screen and is correct: the boundary may only move to a whole group, and the summary describes the
  question that went
- **send one more message.** This is the half that matters — a compacted thread with tool traffic
  still has to be sendable. The answer arrives and the log carries no `unpaired-tool-traffic`

**What this found the first time it was run:** with `STUB_TOOLS=1` the stub answered the
*summarizing* call with a tool call, since the transcript it is handed quotes the user's own
trigger words. `chatCompletion` then returned `''`, and compaction wrote the empty string over
`historySummary` — the head is archived by then, so the running summary was the only description
of it left. Both halves are fixed: the stub returns plain text for a summarizing prompt, and an
empty answer now keeps the previous summary and logs `stage: 'empty-summary'`, counting the whole
head as `unsummarized`. The log for a healthy run carries none of:

```
stage: 'empty-summary'   the summarizer returned nothing; the running summary was kept
stage: 'unpaired-write'  this turn wrote half a pair
stage: 'archive-failed'  both attempts at the row failed
```

### 7d. Tripping the pruner locally — and the loss that hid it

This walkthrough used to say `stage: 'pruned'` was out of reach without a vendor, blaming the
keyword path for returning one hit. **That diagnosis was wrong**, and chasing it on 2026-09-01
turned up a real defect instead.

`renderEntries` in `memory.tools.ts` called `truncate` *inside the handler*, so the string the loop
archived was already cut: three memories rendered 12,213 characters and the row held **4,041**. The
model's copy was identical either way — the loop applies the same default — but `read_tool_result`
then offered to return the rest of a result nothing had kept, which is the one thing the archive
exists to make impossible. The `truncate` call is gone; the loop cuts on the way out.

With the archive whole, the pruner is reachable with no vendor at all. Seed three long memories
whose index lines all match one word, then:

```bash
for n in one two three; do
  python3 -c "print('---\nname: e2e-lorem-$n\ndescription: a long e2e note about lorem\n---\n')" > /tmp/e2e-$n.md
  python3 -c "print('lorem ipsum dolor sit amet consectetur adipiscing elit ' * 200)" >> /tmp/e2e-$n.md
  npx wrangler r2 object put personal-agent-vault/agent/memory/e2e-lorem-$n.md --file /tmp/e2e-$n.md --local
done
printf '# Agent memory\n\n- e2e-lorem-one — a long e2e note about lorem\n- e2e-lorem-two — a long e2e note about lorem\n- e2e-lorem-three — a long e2e note about lorem\n' > /tmp/e2e-index.md
npx wrangler r2 object put personal-agent-vault/agent/MEMORY.md --file /tmp/e2e-index.md --local

curl -s localhost:8787/dev/chat -d '{"text":"dump vault","thread":"prune"}'
curl -s localhost:8787/dev/chat -d '{"text":"read ref 1 twice","thread":"prune"}'
```

`read ref 1 twice` is the one stub shape that trips it: `read_tool_result` raised
`maxResultChars`, so its 12k result is over the threshold, and it now carries a ref of its own.
Verified 2026-09-01:

```
stage: 'pruned', round: 2, chars: 7197
```

**Four rounds, not three, and that is the arithmetic rather than a stub quirk.** The prune runs once
a round's results have landed and spares the newest, so with `PROTECT_RECENT_RESULTS = 1` the first cut
is round `N + 3`. A three-round turn reaches the pruner and never trips it — which is why the first
attempt here logged nothing and looked like a broken path.

**One more thing this found, and it will bite again:** the stub counted `role: 'tool'` over the
whole message array to decide which round it was in. Tool traffic has been persisted since
2026-09-01, so an earlier turn's results made round 0 look like round 1 and the first tool call was
silently skipped. It counts from the last user message now. Anything else written against this
stub's shape before that date is worth re-reading for the same assumption.

### 7e. A ref read *after* a compaction

The claim the archive is for, and nothing walked it until 2026-09-01: a pointer stays good for the
life of the thread, not for the life of the surface. Continue from 7c — the thread is folded and
the `tool` row that carried ref 1 is gone from `state.messages` — and ask `read ref 1` again.

- the answer comes back and the log shows `chars="0-12213 of 12213"`: the *whole* result, read out
  of a row whose message left the thread two turns ago
- no `unpaired-tool-traffic`, and the turn is ordinary in every other way

If this ever returns a short window or an error, the archive has become a cache of the surface
rather than the thing that outlives it.

### 7f. Two tabs on one thread

`setState` persists **and** broadcasts, and that is the whole delivery mechanism — there is no
sending code anywhere. Nothing checked the broadcast half by hand, because one tab cannot.

Open the same `?t=…` in a second tab, then:

- **send from tab 1.** Tab 2 shows the question and the answer with no reload
- **press Compact in tab 2.** Tab 1 folds: *Earlier conversation* appears and the meter drops.
  Verified 2026-09-01 — 48/200k in the tab that did not press anything

This is also the only hand check of the caveat the README opens with: whatever one client can see,
every connected client sees, `userProfile` and finished reports included.

### 7g. Deleting a thread while a turn is running

`deleteThread` is the compaction id guard's stated racer, and the comment says so while nothing had
ever run it. Send `read ref 1 twice` (four rounds, ~6 s at `STUB_DELAY_MS=1500`), wait about two
seconds, then delete the thread from the sidebar and confirm.

Verified 2026-09-01:

- the client moves to another thread, the row leaves the sidebar, no toast and no error
- the turn **finishes** — `outcome: 'ok'` — and the log carries no error at all
- the deleted instance reads back empty over its own socket: `messages: 0`, no `historySummary`,
  no `status` left set

**What this does not establish**, and the doc should not pretend otherwise: whether the guard
refused the write or the delete simply landed after it. The outcome is right either way; telling
the two apart needs the delete to land between the model's answer and the `setState`, which this
by-hand timing cannot aim at.

### 7h. A read-back window that tells the truth — the model picker is the trigger

`read_tool_result` computes `chars=` and `more=` from `WINDOW_CHARS`, and the loop trims the reply
to `resultCap` afterwards. Where the model's window is the tighter bound the two disagree, and the
reply then advertises an offset past text that never arrived — a model following `more=` skips the
gap for good. It is the one place the absolute-versus-window mismatch produces a wrong *instruction*
rather than a smaller view, and it needs the browser for a reason worth stating: **`contextTokens`
is populated by `setModel` and by compaction, and by nothing else**, so a `curl` at `/dev/chat`
cannot reach the state this depends on. Picking the model in the UI *is* the path under test.

Setup is section 7's, plus the picker:

```bash
STUB_TOOLS=1 STUB_DELAY_MS=300 node scripts/stub-llm.mjs
pnpm build:web
npx wrangler dev --local \
  --var LLM_BASE_URL:http://127.0.0.1:8899/v1 --var LLM_API_KEY:stub --var LLM_MODEL:stub-large
# then section 7's two `r2 object put` lines, which seed the memory that returns volume
```

New chat → **"dump vault"** → switch the picker to **stub-small** → **"read ref 1"**. Walked
2026-09-03, zero `level: 'error'` across the run:

- the composer's meter reads **`1k /8k`** after the switch. That is the whole plumbing in one glance
  — `/api/models` → `setModel` → `resolveContextWindow` → `state.contextTokens` → `windowFor` →
  `ToolContext`. Still `/200k` means the switch never resolved, and everything below is vacuous
- turn 1 files 4,068 characters under ref 1
- turn 2 answers `chars="0-1985 of 4068" more="read_tool_result(1, 1985)"`, `resultLen: 2206`

**1,985 is checkable arithmetic, which is why this scenario uses stub-small.** `resultCap(44000,
8000)` is 2,400; less 400 of render overhead and the 15 characters of the archived call's own
`args` (`{"query":"e2e"}`) leaves 1,985. The reply lands under the cap, so `truncate` never runs and
**no `stage: 'window-capped'` appears** — the handler sized itself and left nothing to cut. That
absence is a pass, not a gap.

Before the fix the same turn read `chars="0-4068 of 4068"` with no `more=` at all, and a ~4,300
character reply cut to 2,400 with a hole in the middle — the model told it held the whole memory
while a third of it had been removed. `test/unit/tool-archive.test.ts` pins it; mutating the sizing
back out there produces a 40,234-character reply against a 7,200 cap.

### 7i. A research run, locally, against real vendors

The stub cannot stand in here: it has no notion of a plan, a round's `## Findings` shape or a
report, so a research run means the real `LLM_MODEL` and real search credits. What it does **not**
mean is the production vault — `read_page` reaches Browser Rendering over its REST endpoint with
`CF_API_TOKEN` rather than through a binding, so everything a run touches works under
`wrangler dev --local` with R2 and the Durable Objects local.

```bash
npx wrangler dev --local     # no --var: the real provider is the point
```

Two traps ahead of the run itself, both cost a few minutes:

- **`/research <topic>` is not a command any more.** The `deep_research` tool was removed
  2026-08-23 ([research.md](decisions/research.md)); typing it just asks the model, which answers
  from a normal turn. `proposeResearch` and `startResearch` are `@callable`, so the composer's
  **Chat → Deep research** toggle is the only door and `/dev/chat` cannot open it.
- **Check the thread's override after leaving the stub.** The catalogue is fetched fresh on every
  load, but a thread left on `stub-large` keeps sending that name once the Worker talks to
  OpenRouter, which has never heard of it. The meter is the tell: `/200k` is the stub's window,
  `/1049k` the real one.

Walked 2026-09-03 on `deepseek/deepseek-v4-flash`, four angles, `stopCause: 'time'` — the bound
meant to fire. What it settled, and none of it could be settled by a unit test:

```
stage: 'wave'   angles: 4, failed: 0, unread: 0, reads: 14, scoutSpent: 116
7 × stage: 'pruned'   201,083 characters, ~67,000 tokens
3 × read_tool_result  resultLen 38,616 / 21,850 / 16,387
stage: 'report-written'  8,272 chars from 4 rounds
0 × archive-failed, ungrounded-citations, unavailable
```

- **The pruner fired inside scouts, which had never once happened.** `shorten()` returns its input
  untouched without a ref, so before the scout archive landed every one of those 201,083 characters
  was re-sent whole each remaining round. One prune alone was 92,927. Read the `turnId` to see
  whose: a wave's scouts inherit the round's id, so four `tool-loop` records with `seq: 0` under one
  `turnId` are four concurrent scout loops, and that is where the prunes sit.
- **The scouts pulled their own pages back, three times, unprompted.** Nothing in the prompt
  mentions `read_tool_result`; the only affordance is the marker inside a pruned result. That was an
  open question — whether a model shortens a page and then never asks for the rest — and one run
  answered it.
- **`read_page` failed 14 times of 30, and the cause is a documented ceiling rather than a bug.**
  5 reads served by Browser Rendering, 11 by the Firecrawl fallback, 14 lost. The error is
  Cloudflare's own envelope (`code: 2001, Rate limit exceeded`), so the **primary** is what a wave
  of four concurrent scouts outruns. The ceiling is tighter than it looks: `/browser-rendering/markdown`
  is a **Quick Action**, capped on the Free plan at one request every ten seconds — not a Browser
  Session, whose 3-concurrent limit is the one this walkthrough first blamed.

  **Two of the four scouts then stopped on `no-progress`, and that was a bug this run found.** The
  repeat guard keyed on the tool name and its result, so four reads of four different pages behind
  one rate limit produced four identical `error:` strings and read as a model going in circles. The
  arguments are now part of the key: a different question is progress whatever comes back, and a
  model that truly loops repeats its arguments too. Fixed 2026-09-03; the run that found it is the
  one recorded above, which is the argument for walking this by hand.

### 8. The nightly pass, against a real model

The one scenario the stub cannot answer. The destructive-memory gate makes the model cite the user
turn that justifies archiving a memory, and whether a model can actually *produce* a citation this
code accepts is a question about the model, not about our mocks. Run it against the real provider —
a handful of calls, cents.

```bash
# a memory the conversation will contradict, and an index that points at it
printf -- '---\nname: Sam drinks tea\ndescription: prefers tea over coffee\ndate: 2026-07-01\n---\n\nGreen tea every morning.\n' > /tmp/m.md
printf '# Agent memory\n\n- sam-drinks-tea — prefers tea over coffee\n' > /tmp/i.md
npx wrangler r2 object put personal-agent-vault/agent/memory/sam-drinks-tea.md --file /tmp/m.md --local
npx wrangler r2 object put personal-agent-vault/agent/MEMORY.md --file /tmp/i.md --local

# The real provider, and local storage: `pnpm dev` is a remote proxy session whose R2 binding is
# the production vault, so the two `r2 object put` lines above would be seeding the real one.
npx wrangler dev --local
```

Seed a thread whose turns contradict the memory (`--scenario` has none for this; a short
`/dev/seed?thread=t-cite` payload with two messages is enough), then fire the cron by hand:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+4+*+*+*"
```

**`/__scheduled` does not work here** — it is not in `run_worker_first`, so the assets handler
answers it with the SPA shell and nothing runs. The `/cdn-cgi/handler/scheduled` path is the one.

What to look for, verified this way on 2026-08-18:

- the tool call carries the citation in the shape the transcript shows it: `"cited_turn": "[1]"` —
  a bracketed *label*, not a 36-char message id, which is why both the labels and the bracket
  stripping exist
- `delete_memory` answers `archived memory "sam-drinks-tea"`; the file is under
  `agent/memory/archive/` and gone from `MEMORY.md`
- the memory the pass writes instead carries `source_thread: reflection`
- the nightly record carries `citationsRefused` — if that number is not zero, the gate is refusing
  citations the model believes in, and memory curation is quietly stopping
- `skillsArchived` in the same record counts the **staleness sweep over skills** and never a
  memory. It was called `archived` until 2026-09-01, which read as a contradiction against a
  `sample` line saying a memory had just been archived

Verified again on 2026-09-01 against `deepseek/deepseek-v4-flash`, with **local** storage:
`npx wrangler dev --local` reads the same `.env` and calls the same provider while the seeded
memory stays on this machine, where `pnpm dev` would have seeded the production vault. What that run
produced:

- `cited_turn: "1"` — bare, not `"[1]"`. Both are accepted; the bracket stripping exists because a
  model may write either
- the archived file carries the provenance the gate demanded: `archived_because_thread: t-cite`,
  `archived_because_turn: c1`
- `citationsRefused: 0`, and `MEMORY.md` holds only the replacement memory

**Read the vault, not the report.** The model's own closing line said it had archived the memory,
and it had — but the way to know that is `wrangler r2 object get .../agent/memory/archive/<slug>.md`,
not the sentence in the log.

## Cleaning up

The seeded threads are real Durable Objects and stay in `agent/threads.json` until deleted. Delete
them from the sidebar when finished, or leave them: they are named `seed: t-…` and cost nothing.
