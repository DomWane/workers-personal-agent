# MCP servers

The client is the Agents SDK's `this.mcp` (`agents@0.16.2`). This repo decides where it lives, how
its tools reach the loop, and what bounds it.

## One Durable Object per server, a registry for the catalog

**Decision.** `McpClient`, one instance per server, holds one connection. `McpRegistry`, a
plain `DurableObject` with `servers` and `tools` tables, holds what each server last reported: state
and tools. A turn reads the registry, one internal RPC, and wakes no server; a server wakes only
when the model calls one of its tools, once per hibernation, from its own budget of fifty.
**Why.** Turn cost is independent of the number of servers, so there is no cap on it.
**Rejected.** One hub `Agent` holding every connection: its cold wake reconnected all servers in
one uncounted invocation, which forced a cap of six, and every wake waited for the slowest server.
Fanning out to the clients per turn: every turn after idle waited for N handshakes.

## The registry is a table, not a file in the vault

**Why.** N + 1 writers (settings, every server on every state change) and a payload of JSON
schemas. `agent/threads.json` shows what a file costs under that shape: whole-file rewrites under
an etag and an unretried race ([web-and-channels.md](web-and-channels.md)).

## The catalog is read every turn, never cached in the thread

A server added or removed in settings shows up on the next message. The turn event carries
`mcpTools`. No cap on tools per turn: none has been measured, and the field is there so a cap
would get a number.

## MCP traffic is bounded per Durable Object, not counted by the budget

**Decision.** A client's outbound calls bypass `SubrequestBudget`, the one exception to the
invariant in [ARCHITECTURE.md](../../ARCHITECTURE.md#invariants-that-cause-outages-when-broken).
**Why.** The SDK transport accepts a custom `fetch`, but a connection restored after hibernation is
rebuilt from JSON, where a function cannot live, so a wrapped fetch would stop counting at the
first wake. One connection per agent bounds the spend instead.
**Evidence, 2026-09-07, pinned in `test/helpers/mcp-server.ts`.** Connect to a tools-only server:
3 POSTs (`initialize`, `notifications/initialized`, `tools/list`) and 1 GET probing for SSE, sent
even when the server answers 405; 7 with resources and prompts; `tools/call` 1; close 1; a warm
instance reuses its connection at 1 per call; a cold one pays the connect again in `onStart`.

## Tools are named by the server's name, native names win

`<server>_<tool>`, sanitised to `[A-Za-z0-9_]`, cut at 64. Native names seed the dedupe set, so a
server called `web` cannot replace `web_search`; the loser is logged as `tool-name-taken`. The
registry derives the id from the name, so names are unique and the prefix with them.
**Rejected.** A nanoid prefix: a model reads `github_create_issue`, not `Xk3aB9qz_create_issue`.

## Servers are registered from settings

Add, remove and connect go through `/api/mcp/*`; the OAuth callback is
`/agents/mcp-client/<id>/callback`, the SDK's own convention, riding the user's browser
session through Access. A bearer token is optional and stored as the SDK stores it, plaintext in DO
SQL. Env-seeded servers were rejected: an OAuth server cannot be validated at deploy time.
**Not built.** Servers managed from chat, per-thread switches, MCP tools in research, elicitation,
an MCP server exposing this agent's tools.
