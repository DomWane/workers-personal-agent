# The web channel, and how a client talks to a thread

Read this when touching `emit`, the Agents SDK socket, or the composer. Everything here is a
decision with a reason, not a description of the code — the code says what it does.

**There is one channel, and delivery is a `setState`.** Assistant-authored text lands in
`state.messages`, which the SDK both persists *and* broadcasts to every connected client. `emit` is
the whole of it: no connector interface, no delivery abstraction, and nothing to send. The research
status card and the finished report need *zero* delivery code, because being in state is already
being delivered.

Telegram was the first channel and was removed once Cloudflare Access became the gate: Access
authenticates every path to the Worker and a webhook cannot sign in, so keeping both meant scoping
Access to paths and trusting that scoping forever. Everything the channel needed — a typing
indicator refreshed every 4.5 s, a status message edited once a round, `sendDocument` for the
report, 4096-character splitting, update-id dedupe — existed to paper over a limit a broadcast state
does not have.

The web instance name is rewritten in `src/index.ts` from whatever the client asked for, so a client
cannot address someone else's conversation; the identity is a constant, and stays one.

**Cloudflare Access is the gate, and it runs before any code here.** An unauthenticated request
never reaches this Worker, so the Worker's own check is a second line: `accessRefusal` requires the
`Cf-Access-Jwt-Assertion` header Cloudflare stamps on what it forwards and answers 503 without it.
That is what makes a fresh deploy — one with no Access application yet — refuse rather than serve,
which is the failure this design is built around: a refusal is recoverable in a minute and an open
deployment is not, and from inside the Worker an ungated deployment looks exactly like a gated one.
The next step, if the presence check ever needs to stand on its own, is verifying the JWT against
Cloudflare's JWKS — one function, and the seam for it is `accessRefusal`. `ALLOW_UNPROTECTED=true`
is the deliberate way to run open, and it logs on every request that uses it.

**It has to be the hostname-based kind, and that is not a preference.**
[The Workers Access docs](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
say it outright: *"Worker-level Access policies do not currently support WebSocket connections.
WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a
`403` error."* This client is nothing but a WebSocket. The same page rules out reading the identity
from the runtime — *"the router does not pass `ctx.access` to the user Worker"* — for a Worker with
Static Assets configured, which this is. So the header is the only signal available.

**Both directions were measured on 2026-08-23.** With a policy live and no opt-out, the chat
connects and answers, which it could not do if the header were missing — so the header does reach a
Worker and a WebSocket survives the hop. With the policy off for a minute, the workers.dev URL
answers `503 {"error":"closed",…}` and the log carries `at: 'access', stage: 'refused'`, which says
the refusal came from here and not from something on the way. The second test is safe *because* the
gate is fail-closed: nothing is exposed while Access is down. A policy created from Zero Trust →
Applications → Self-hosted with the **Workers** destination covers `*.workers.dev` as well as any
custom domain: with it on, a `curl` to the workers.dev URL is answered by Access's own 302 to its
login before the Worker runs at all.

**The identity does not become the signed-in email.** Taking it would rename every Durable Object,
and an instance's name cannot change without stranding its history. Access answers who may reach the
agent, not whose agent it is; a single-user agent stays single-user, and `threads.json` needs no
identity column.

**A client never writes state.** The Agents SDK makes connections read-only; everything the UI does
goes through `@callable` RPCs — `enqueueWebMessage`, `setModel`, `proposeResearch`, `revisePlan`,
`startResearch`, `stopResearch`, `saveResearch` — and the components emit named events rather than
strings. A plain public method is *not* reachable: `client.call` checks for the decorator's metadata
and throws otherwise. Slash commands parsed server-side were the earlier shape, right while a
webhook and a browser had to agree on what counted as a command; with one client it was a Vue
component serialising to text so the server could regex it open again. The one slash form left is
`/<skill-slug>`, because it is the one action with no button, and the turn resolves it rather than a
parser.

**A finished report is on the user's screen and has never been in the conversation**, so the model
has not seen it. `read_research_report` closes that on demand rather than by injecting the report
into every prompt: a report is ~20k characters, ~6.5k tokens a turn against a 24k default window,
for something most turns never ask about, and it would start moving the compaction threshold on its
own account. Its `ctx.pendingReport` is a closure rather than the text, so a turn that never calls
it never holds it. The window this covers is narrow: between a run finishing and the user saving or
dropping it. Save files it under `agent/research/`, which `indexManifest()` sweeps, so
`search_memory` takes over from there.

**The context meter and the Compact button shipped ahead of any settings dialog**, and the model
picker sits in the composer beside them. Compaction folds a conversation on a threshold the user
cannot see, so shipping it without a number and a manual override would mean the feature happens
*to* them. The meter says whether its number is the provider's count or our estimate, because a
meter that cannot say which invites trust in a guess. The threshold's fractions are duplicated into
`web/src/lib/context.ts` — the switch dialog has to answer "would this compact?" about a model the
server has never run, whose window only the browser's catalogue knows.

**A turn finds its own user message by id, never by position.** The web enqueue writes the user
message into state and schedules an alarm to answer it, so a second message sent while the first is
still answering leaves *two* queued, and the newest is no longer the one this turn is about. Taking
`messages.at(-1)` made turn 1 rewrite turn 2's text with its own and made turn 2 read turn 1's
question as an *assistant* line — a conversation neither party had. The id rides in the payload, and
each turn rebuilds the outgoing history as it happened: everything before its own message, the
answers that landed since, then its question last. The status is likewise cleared only when no
`processWebMessage` schedule is left, or the first turn to finish would report "done" with a
question still waiting.

**Every `@callable` RPC failure surfaces as a toast**, raised in `useAgent`'s `rpc` rather than at
each of the nine call sites, because rename, delete, compact and rate otherwise fail into a console
line while the UI goes on showing the change as done. `rpc` answers `false` rather than throwing:
every one of those sites is a click, and a click that raises an unhandled rejection is a console line
again; the callers that have something to undo read the answer — `remove()` skips its navigation,
`MessageFeedback` takes back the thumb it drew before the server agreed. The disconnected case is
checked rather than timed out: with the Worker stopped, `socket.call` waits for a reconnection that
never comes, and a timeout short enough to catch that would fire on a legitimate compaction.
