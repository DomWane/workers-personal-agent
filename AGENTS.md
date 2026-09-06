# Personal Agent

A personal agent on Cloudflare Workers, reachable from a web chat. A Durable Object holds one
conversation and runs a tool loop against an OpenAI-compatible API; long-term memory is markdown in
R2; `evals/` is a separate Node-side harness for measuring it.

**[ARCHITECTURE.md](ARCHITECTURE.md) is the map**: the platform limits and which of them were
measured, every ceiling this agent runs into and whether it fails loudly, the invariants that caused
outages when broken, the vault layout, and what a deploy cannot provision. Read it before changing
anything under `src/`. The reasoning per subsystem is in `docs/decisions/`, indexed there.

This file is the working part: commands, how the tests are shaped, what must stay out of the
repository, and how to work here.

## Commands

```bash
pnpm test          # agent tests — Workers pool, excludes evals/
pnpm test:evals    # eval tests — Node pool
pnpm check         # tsc --noEmit for src/ and test/
pnpm check:web     # vue-tsc for web/ — a separate tsconfig, not covered by pnpm check
pnpm check:evals   # tsc for evals/ — its own tsconfig too, Node types rather than Workers
pnpm lint          # oxlint, --deny-warnings — reads .vue script blocks too
pnpm format        # oxfmt in place; format:check is the read-only form
pnpm build:web     # vite build web → ./public (gitignored; wrangler serves it)
pnpm dev           # wrangler dev — needs `cloudflared` once Access is on the account, see below
pnpm dev:web       # vite with hot reload, proxying /agents and /api to :8787
pnpm run deploy    # wrangler deploy — User runs this, not the agent; bare `pnpm deploy` is pnpm's builtin
```

`./public` is build output and gitignored. `wrangler.jsonc` names `pnpm build:web` as the custom
build, so `pnpm dev` and `pnpm run deploy` both produce it; run it by hand only outside wrangler.

**`pnpm dev` needs `cloudflared` and a terminal once Cloudflare Access is on the account**
(2026-08-23). The `ai` binding has no local simulator, so dev opens a remote proxy session against
the deployed Worker, which Access gates. `brew install cloudflared` once, and then wrangler sends
you to the Access login.

The second half is the one that costs an hour: **it must be interactive.** Piping dev through `tee`
is enough to make it non-interactive, and it then fails with *"no Access Service Token credentials
were found and the current environment is non-interactive"*, which reads as a credentials problem
and is a TTY problem. `script -q /tmp/dev.log pnpm dev` keeps both. For a genuinely non-interactive
run, an Access **service token** in `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`
is the supported path.

`pnpm test` and `pnpm test:evals` are **two different pools and neither runs the other's tests**.
Running only one and declaring the suite green is a mistake that has happened.

**Lint and format decisions live in [docs/decisions/linting-and-formatting.md](docs/decisions/linting-and-formatting.md)**:
which rules are on, which were counted and refused, and why type-aware linting does *not* need the
TypeScript 7 upgrade that would break `vue-tsc`. One thing to know without reading it: `pnpm lint`
runs type-aware rules with no extra flag.

Eval scripts are `eval:*` in `package.json` and run raw TypeScript through Node with no build
step (`node evals/run-retrieval.ts`). Anything under `evals/` may use `fs`, `process`, and the
network; anything under `src/` may not.

## Tests

The agent suite runs in `@cloudflare/vitest-pool-workers` with isolated storage. Two traps:

- **`fs` and `process` do not exist in the Workers pool.** That is why `evals/` has its own config.
- **An alarm scheduled by a test can fire after teardown**, producing
  `Isolated storage failed ... Application called abortAllDurableObjects()`. If a test causes code
  to `schedule()`, assert the schedule exists, cancel it, and invoke the callback directly rather
  than waiting for it.

Outbound HTTP is intercepted with `fetchMock`; `assertNoPendingInterceptors()` catches mocks that
stopped matching after a change. When a change alters call *counts*, for example an index
reconcile that now reads fewer files, the interceptor counts must be updated, not the assertion
removed.

The vault is **not** mocked over HTTP. Miniflare simulates R2 locally, so tests seed the real
binding through [test/helpers/vault.ts](test/helpers/vault.ts) and assert on what the bucket
holds. A file that is simply absent is the not-found case and needs no setup at all.

Bindings are pinned in `vitest.config.ts` (`LLM_BASE_URL`, `LOG_CONTENT: ''`) so the suite never
depends on the real values in `wrangler.jsonc`. `LOG_CONTENT` is the one this caught: the
deployment opts in, and an inherited binding made a test assert content logging was off while it
was on.

Two more, both found the hard way:

- **`SELF.fetch` cannot see a mutated `env`.** The pool hands the test a copy, so a test that needs
  a different binding (the Cloudflare provider branch, where `LLM_BASE_URL` is *absent* while the
  suite pins it) must call `worker.fetch(request, {...env, LLM_BASE_URL: undefined}, ctx)` directly.
- **The Cache API outlives a test's mocks.** `/api/models` cached in it once, and one test's
  payload answered the next test's request; it no longer caches at all, because an hour of cache
  also outlived a change of `LLM_BASE_URL` and read as the switch not working. Varying the URL
  per test was rejected: test scaffolding does not belong in a URL contract.
- **A fake standing in for the seam under test empties the test silently.** Every scout test handed
  the loop a `Map` for its archive, so when the scout gained a real one on 2026-09-02 the code that
  builds it, `sqlTag(this.ctx.storage.sql)` inside a class declared under `new_sqlite_classes`,
  had never executed anywhere, and its failure mode is quiet (`archive-failed`, findings still
  returned, the pruner mute for the run). `runInDurableObject` on the real namespace is what covers
  it. Note that a Durable Object doing I/O in `blockConcurrencyWhile` (the subrequest-plan lookup)
  throws under `disableNetConnect`, is caught, and logs `assumed: 50`; that is the expected shape,
  not a broken test.

`emit` is where a reply becomes visible, so a test that wants the text without asserting on the
thread spies on it and **calls through**; `test/unit/research-commands.test.ts` does. Replacing it
would take the history with it, and half those tests assert on what a run did as well as on what it
said.

**Every new guard gets a mutation check**: the test names what to break in the code and fails when
it is broken. A guard only guards if the regression actually fails it.

## Evals

`evals/lib/` holds pure functions with no I/O so they are unit-testable against literal fixtures;
runners at `evals/` root do the I/O. Tests are colocated (`foo.ts` next to `foo.test.ts`).
Write-ups go in `evals/results/*.md`.

**`evals/data/` is gitignored and the corpus is never committed, shared, or quoted.** It contains
673 Claude Code exchanges from real work. What is tracked is the half of the harness that *scores* a
corpus; the step that builds one from local transcripts lives under `internal/`, outside the
repository, and `Chunk` lives in `evals/lib/corpus.ts` so the tracked half stands alone.

## Docs

`docs/` holds only what is meant to be read outside this repo: the two write-ups, the walkthrough,
the screenshot, and `docs/decisions/`. Working material (plans, notes, anything not for a reader)
goes under `internal/`, which is gitignored as a whole; a note that lands in `docs/` is published.

**`docs/decisions/` is where the architecture's reasoning went when it outgrew one document**:
every pointer in `ARCHITECTURE.md` lands there, so it is committed as a whole.

The two write-ups share a house style: a claim or question as the title, numbered sections, and a
section listing what was measured wrong before it was measured right; that section is the point,
not an appendix.

`docs/manual-e2e.md` is a different genre and is committed for a different reason: it is the
walkthrough for the seams no suite covers (the DOM, and the socket between the built client and a
live Worker), and without it the `scripts/stub-llm.mjs` and `--scenario` machinery beside it would
be committed with nothing saying what they are for. It opens with the three bugs found by hand that
no unit test could have failed, because that is its argument for existing.

## Style

Comments explain a constraint or a trade-off that the code cannot state; the surviving comments in
`vitest.config.ts` and `embedding-index.ts` are the model. Default to none.

## Working with me here

Each of these is here because it was violated on 2026-08-03/04, not because it sounds good.

- **Non-obvious decisions name the rejected alternative and why.** Not a menu of options with an
  obvious winner: the one that was seriously in play and lost, and what it lost on.
- **Separate verified from inferred.** Claims about production state, deployed code, or platform
  limits cite the command or doc that produced them. "Probably" is fine; a confident tone over an
  unchecked assumption is not.
- **When a measurement comes back empty, suspect the measurement first.** An empty result is
  evidence about the query until proven otherwise.
- **Re-check a document against the principles it states before handing it over.**
