# The tool boundary

## One zod schema per tool

**Decision.** `defineTool` takes `params`; `toolSpec` derives the JSON Schema the model sees, and
`executeTool` parses the reply with the same object, returning `z.prettifyError` as a tool result.
Unknown keys are stripped. `set_reminder` and `set_scheduled_task` parse `when` in the schema, which
hands the handler the cron string or `Date` that `Agent.schedule` overloads on.
**Why.** A hand-written JSON Schema beside `handler(args: Record<string, unknown>)` drifted:
`delete_memory` advertised `cited_turn` and `thread` as required while the handler treated them as
optional. A wrong type is now a tool result the model can fix, not `[object Object]` in the vault.
**Cost.** Specs are generated per `runToolLoop`: 0.085 ms for nineteen tools.

## An MCP tool carries its server's schema instead

**Decision.** A `ToolDef` has either `params` (zod, every native tool) or `schema` (raw JSON
Schema, every MCP tool), and the type makes both or neither unrepresentable. `toolSpec` sends
`schema` verbatim; `executeTool` skips the parse for it and hands the model's JSON to the handler.
**Why.** The rule above exists so the schema shown and the schema parsed cannot drift. An MCP
server owns both halves already: it published the schema and it validates the call. A zod
round-trip over a third-party schema would add a translation between the two, which is the drift
the rule was written against. Results still pass `fileAndTrim` and every cap below.
**Rejected.** Converting `inputSchema` to zod for a local parse.

## What happens to a result after the handler returns

```
                      resultCap        PRUNE_OVER_CHARS     truncate      COMPACT_AT_FRACTION
                          │                   │                │          COMPACT_KEEP_FRACTION
                          ▼                   ▼                ▼               ▼
   handler  ─────►   fileAndTrim   ─────►   round   ─────►   state   ─────►  compaction
   cuts nothing           │                                                      │
        ARCHIVE_MIN_CHARS ▼                                                      ▼
                       archive   ◄──────────────────────────────────────────  archive
                          │
                          └──────►  read_tool_result        MAX_READBACK_CHARS
```

`fileAndTrim` cuts, the archive keeps the whole thing, and everything downstream may only shorten
what carries a ref. A handler that cuts for itself cuts the archive row too: `search_memory` once
filed 4,041 of 12,213 characters while handing the model a ref to the rest.

## Every cap that acts on one result

| Cap | Value | Acts in | What it decides |
| :--- | :--- | :--- | :--- |
| the tool's own `maxResultChars` | 100,000 `read_page` · 44,000 `read_tool_result` · 40,000 `read_research_report` · 20,000 `search_memory` · 10,000 `web_search` | `fileAndTrim` | how much of this tool's output is worth a first view |
| `DEFAULT_RESULT_CHARS` | 4,000 | `fileAndTrim`, for the fourteen tools naming no cap | the floor for a tool that never considered its size |
| `RESULT_SHARE_OF_WINDOW` | `0.10 × window` in estimated chars, `min()` with the two above | `fileAndTrim` | that one result cannot eat a small model's window |
| `ARCHIVE_MIN_CHARS` | 2,000 | `fileAndTrim` | whether a ref exists, not whether the result survives |
| `PROTECT_RECENT_RESULTS` | 1 | after a round completes | how long a result stays whole; the first cut is round `N + 3` |
| `PRUNE_OVER_CHARS` | 8,192 → 4,096 head + 1,024 tail | later rounds | shortening a result the model already answered; refuses without a ref |
| `truncate`'s hard cut | 8,192 | writing `state.messages` | reached only when filing threw |
| `MAX_READBACK_CHARS` | 44,000 = `WINDOW_CHARS` + 4,000 | `read_tool_result` | one window of the archive per call; nothing bounds what is stored |
| `COMPACT_AT_FRACTION` / `COMPACT_KEEP_FRACTION` | `0.80` / `0.25 × window` | compaction | the whole surface, never one result |

- **`ARCHIVE_MIN_CHARS` decides addressability, not survival.** Compaction archives everything it
  evicts. A ref goes on uncut results too, because "what did that page say about X" arrives a turn
  later. Raising it to 4,000 was rejected: a one-memory `search_memory` result would go
  unaddressable to save rows in a 10 GB database. The number is inherited and unmeasured.
- **`ARCHIVE_MIN_CHARS < DEFAULT_RESULT_CHARS` is load-bearing.** A result cut by the default is over
  4,000, hence filed, hence recoverable. `test/unit/tools.test.ts` holds the inequality. Only where
  an archive exists; a bare context gets the cut and no way to act on the marker.
- **`web_search`'s 10,000 never fires.** Ten results at 500-char snippets reach ~6,700 by
  construction. It is a tripwire for the connector's slice moving; deleting it drops the tool to
  the 4,000 default.
- **`read_tool_result` sizes its window from `resultCap`.** Computed from `WINDOW_CHARS` it
  advertised `more=` past text that never arrived: 40,234 characters against a 7,200 cap, on any
  model under ~134,000 tokens.
- **`RESULT_SHARE_OF_WINDOW` is the only cap acting before the first send.** The ref, the pruner
  and the readback act on re-sends. A scout has no overflow retry, so a first page carried whole is
  `scout-failed`. Arm B of `evals/results/inline-page-size-preregistration.md` (a small first view
  plus a ref) could retire it.

## What the literature says

Lindenbauer et al. (arXiv 2508.21433): observations are ~84% of an agent turn's tokens, and
replacing stale ones with a placeholder halves cost at the same solve rate. Zhang et al.
(arXiv 2606.00408): attention on observations is front-loaded, and agents re-open the newest page
or the first, rarely the middle. Hence a head, a tail and a ref. Neither measured head-plus-tail
against removal, so the constants above are defaults, not results.

`test/unit/tools.test.ts` wraps every handler in its own schema, so a test cannot pass arguments the
loop would refuse; the refusal shape itself is covered in `tool-loop.test.ts`.
