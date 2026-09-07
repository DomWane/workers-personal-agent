# The web channel

## Delivery is a `setState`

`emit` appends to `state.messages`; the Agents SDK persists it and broadcasts it to every connected
client. No connector, no delivery layer, nothing to send: the research card and the finished report
are delivered by being in state.
**Rejected.** Telegram, the first channel. Cloudflare Access authenticates every path and a webhook
cannot sign in, and its typing refresh, edited status line, `sendDocument`, 4096-character
splitting and update-id dedupe all papered over limits broadcast state does not have.

## Cloudflare Access is the gate; the Worker checks presence only

`accessRefusal` requires the `Cf-Access-Jwt-Assertion` header Cloudflare stamps on forwarded
requests and answers 503 without it, so a fresh deploy refuses rather than serves. A refusal is
recoverable in a minute; an open deployment is not, and from inside the Worker the two look alike.
`ALLOW_UNPROTECTED=true` runs open and logs on every request. If presence ever has to stand alone,
the next step is JWKS verification in the same function.
**Docs against measurement.** The Workers Access docs say a worker-level policy fails WebSocket
upgrades with 403, and the application here is exactly that kind (`destinations: [{type: "worker"}]`,
the one the Deploy flow's switch creates). Measured 2026-08-23 and 2026-09-05: the upgrade passes
and the chat runs over it. Fallback if it ever fails: a hostname-based application listing every
hostname. `ctx.access` is not passed to a Worker with static assets, so the header is the only
signal. Both directions measured 2026-08-23: policy on, the chat answers; policy off, 503 with
`stage: 'refused'`.

## The identity stays a constant

Taking the signed-in email would rename every Durable Object and strand its history. Access decides
who may reach the agent, not whose agent it is.

## The thread registry is a file in the vault

**Decision.** `agent/threads.json` holds `{ id, title, at }` per thread. Written by
`touchThread` on every message, `renameThread` and `removeThread`, each a read-modify-write under
an R2 etag; read by the Worker for `/api/threads`, by the nightly cron and by the citation check.
**Why.** A Durable Object namespace cannot be enumerated, so the list has to live somewhere, and
`localStorage` was rejected as silent data loss: a cleared browser leaves every thread alive and
unreachable. Four readers with no single owner made the vault the cheapest place: it already
existed, R2 through a binding spends no subrequest (measured 2026-08-06), and D1 would be a binding
for one file.
**Limits, recorded 2026-09-07.** Every write rewrites the whole file and every read reads it, so
thousands of threads are fine and tens of thousands are not. An etag conflict throws and is not
retried: two first messages in the same instant leave one thread registered by its next message,
without a title. There is no query, only the list.
**Alternatives, in order of change.** A retry loop on the conflict plus one file per folder;
rows in a Durable Object (the `index` instance every thread already calls, or a registry of its
own, which is the shape the MCP registry takes); D1, the answer once there is more than one user;
KV, rejected because `list()` is eventually consistent and a new thread would lag in the sidebar.
Nothing moves until there is a second user or a folder, and then it moves by one import of this
file.

## Clients call RPCs and never write state

SDK connections are read-only, and `client.call` requires the `@callable` decorator. Slash commands
parsed server-side were dropped with the second channel; `/<skill-slug>` stays because it is the
one action with no button.

## The report is fetched on demand

`read_research_report` reads `ctx.pendingReport()`, a closure, so a turn that never asks never holds
it. Injecting ~6.5k tokens into every turn against a 24k window was rejected. After a save,
`search_memory` takes over.

## The context meter and Compact button shipped before any settings dialog

Compaction on a threshold the user cannot see would happen to them. The meter says whether its
number is measured or estimated. The fractions are duplicated in `web/src/lib/context.ts` because
the switch dialog asks about a model the server has never run.

## A turn finds its own message by id

Two queued messages made `messages.at(-1)` rewrite turn 2's text with turn 1's and read turn 1's
question as an assistant line. The id rides in the payload, each turn rebuilds the outgoing history
as it happened, and the status clears only when no `processWebMessage` schedule is left.

## RPC failures surface as toasts

Raised in `useAgent`'s `rpc`, which returns `false` rather than throwing: every caller is a click,
and callers with something to undo read the answer. Disconnection is checked, not timed out, since a
timeout short enough to catch it would fire on a real compaction.
