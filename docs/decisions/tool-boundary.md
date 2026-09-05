# The tool boundary: one schema, validated before the handler

**A tool's schema is one object, and the loop validates against it before the handler runs.**
`defineTool` takes a zod schema as `params`; `toolSpec` generates the JSON Schema the model is shown
from that same object, and `executeTool` parses the model's arguments with it and hands the failure
back as a tool result — `z.prettifyError`, which already names the field and what it expected. What
this replaced was a hand-written JSON Schema beside a `handler(args: Record<string, unknown>)` that
read every field as `String(args.x ?? '')` — two descriptions of the same contract that could drift,
and did.

The drift it exposed on the first run is the argument for it: **`delete_memory` advertised
`cited_turn` and `thread` as required while the handler treated them as optional**, which is the
behaviour the tests pin and [the gate's own notes](memory-and-the-gate.md) document. One of the two
had to be wrong; the schema was.

A wrong type is now a **tool result, not a coercion** — the model is told which field and can fix it
next round, where before it wrote `[object Object]` into the vault. Unknown keys are **stripped, not
refused**, which is zod's default. `set_reminder` and `set_scheduled_task` parse `when` **in the
schema**, so the handlers no longer carry `parseWhen` or the identical "invalid time" string twice —
the transform hands them the cron string or `Date` that `Agent.schedule` overloads on.

Generating the specs per `runToolLoop` is per-turn work and was measured rather than waved through:
**0.085 ms** for all nineteen. Against a Durable Object's 30 s, hoisting it would be a cache to keep
correct in exchange for nothing.

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

**`fileAndTrim` cuts; the archive keeps the whole thing; everything downstream may only shorten what
carries a ref.** Each later stage cuts less and can, because the ref reaches back.

That rule is the point of the picture. A handler that cuts for itself cuts the archive row too,
since the row is filed from what the handler returned — which is how `search_memory` once filed
4,041 of 12,213 characters while handing the model a ref to the rest.

## Every cap that acts on one tool result

Nine of them, which is why they get a table. The column that matters is the last one: two caps that
sound alike decide different things, and the pair that decides the *same* thing is the bug.

| Cap | Value | Acts in | What it decides |
| :--- | :--- | :--- | :--- |
| the tool's own `maxResultChars` | 100,000 `read_page` · 44,000 `read_tool_result` · 40,000 `read_research_report` · 20,000 `search_memory` · 10,000 `web_search` | `fileAndTrim` | how much of *this* tool's output is worth a first view |
| `DEFAULT_RESULT_CHARS` | 4,000 | `fileAndTrim`, for the fourteen tools of nineteen naming no cap | the floor for every tool that never considered its own size |
| `RESULT_SHARE_OF_WINDOW` | `0.10 × window`, in estimated chars; `min()` with the two above | `fileAndTrim` | that one result cannot eat a small model's window |
| `ARCHIVE_MIN_CHARS` | 2,000 | `fileAndTrim` | whether a **ref** exists — not whether the result survives, which is compaction's job |
| `PROTECT_RECENT_RESULTS` | 1 | after a round completes | how many rounds a result stays whole; the first cut is round `N + 3` |
| `PRUNE_OVER_CHARS` | 8,192 → 4,096 head + 1,024 tail | later rounds | shortening a result the model already answered. Refuses without a ref |
| `truncate`'s hard cut | 8,192 | writing `state.messages` | only reached when filing threw, so nothing can recover the middle |
| `MAX_READBACK_CHARS` | 44,000 = `WINDOW_CHARS` + 4,000 | `read_tool_result` | one window of the archive per call, header included; nothing bounds what is stored |
| `COMPACT_AT_FRACTION` / `COMPACT_KEEP_FRACTION` | `0.80` / `0.25 × window` | compaction | the whole surface, never one result |

Five notes the table cannot hold:

- **`ARCHIVE_MIN_CHARS` decides addressability, not survival.** Compaction archives **everything**
  it evicts, tool traffic included, so a result under 2,000 characters is preserved too — later, and
  as part of a `compaction` row. What 2,000 buys is an **address**: a ref goes on uncut results as
  well, because "what did that page say about X" arrives a turn later, by which time the result has
  left the surface whether it was cut or not. So the question the constant answers is *is this worth
  re-reading next turn*, and the band it protects — 2,000 to 4,000 — is the one that is **never cut
  at all**. Raising it to `DEFAULT_RESULT_CHARS` was considered and rejected for that: the invariant
  below would still hold, but a one-memory `search_memory` result or a skills listing would go
  unaddressable the moment it scrolled off, to save rows in a 10 GB database. The number itself is
  inherited; what defends it is only that the ~93-character footer is 5% of a result that size and
  19% of a 500-character one. Nothing has measured it.
- **`ARCHIVE_MIN_CHARS < DEFAULT_RESULT_CHARS` is load-bearing, and undeclared.** A result cut by the
  4,000 default is by definition over 4,000, hence over 2,000, hence filed — so the footer that
  names the cut always carries a ref that undoes it. Invert the two constants and the default cut
  becomes unrecoverable; `test/unit/tools.test.ts` holds the inequality across the two files it
  spans. **This holds only where an archive exists** — a thread's, or the scout's own — and a bare
  context without one gets the same cut as a marker with no way to act on it.
- **`web_search`'s 10,000 can never fire.** Ten results at a 500-char snippet reach ~6,700 by
  construction. It is not policy, it is a tripwire: raise the connector's snippet slice and the
  structural ceiling moves under it. Deleting it is not the neutral act it looks like — the tool
  then inherits `DEFAULT_RESULT_CHARS` and every search is cut to 4,000.
- **A cap on a window makes the window lie, and that is worse than making it small.**
  `read_tool_result` computes `chars=` and `more=` from `WINDOW_CHARS`, then the loop trims the
  reply to `resultCap` — which falls under a rendered window on **any model below ~134,000 tokens**,
  so every picker model but the default. Measured by mutating the fix out: 40,234 characters of
  reply against a 7,200 cap, advertising `more="read_tool_result(N, 40000)"` for text that never
  arrived. A model following that offset skips the gap for good. The window is therefore sized from
  the cap the loop is about to apply, so the two numbers the model steers by are true.
- **`RESULT_SHARE_OF_WINDOW` is the only cap that acts before the first send, and that is why it
  stays even now that scouts have an archive.** A ref, the pruner and `read_tool_result` all act
  from round `N + 1` and only on *re-sends*. The round that first carries a 100,000-character page
  carries it whole — ~33,000 tokens against a 24k scout — and there is no overflow retry outside
  `PersonalAgent`, so that request is not compacted and retried, it is `scout-failed`. The archive
  fixed **recoverability of a cut**, which is a different property from **not overflowing**. What
  could retire the fraction is arm B of `evals/results/inline-page-size-preregistration.md` — a
  small first view plus a ref — which the scout's archive makes possible.

**What the literature says about the shape, checked against the papers.** Two results bear on the
pruner and both were read at the source. Lindenbauer et al. (arXiv 2508.21433, SWE-agent on
SWE-bench Verified) measure observations at ~84% of an agent turn's tokens and find that replacing
stale observations with a placeholder halves cost while matching LLM summarization on solve rate —
masking beat the unmanaged agent in three of five model configurations. Zhang et al. (arXiv
2606.00408, search agents over an append-only page pool the model can re-open) map where that gain
lives: +6 to +12 points while the model is the bottleneck, zero or negative once it is strong enough
not to need the room. Their mechanism finding is the one this design leans on — attention on
observations is front-loaded, and agents re-open the newest page or the very first, rarely the
middle — which is why the pruner keeps a head and a tail and drops the middle, and why every cut
carries a ref back. Neither paper measured head-plus-tail against removing the observation outright;
that comparison is open, and the constants above are defaults, not results.

`test/unit/tools.test.ts` wraps every handler in its own schema, so a test cannot call one with
arguments the loop would have refused. It throws where `executeTool` returns a tool result; the
production shape of a refusal is covered in `tool-loop.test.ts` instead.
