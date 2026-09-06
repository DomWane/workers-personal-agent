# Provenance and the destructive-write gate

The gate exists because unaided self-correction makes reasoning worse (Huang et al., ICLR 2024,
arXiv 2310.01798), and "newest wins" is that judgement. What it enforces today is narrower than the
design, and the gap is recorded here.

## The gate covers the two writes that destroy something

`delete_memory` and `op=replace` or `remove` on the profile need a cited user turn, verified against
the thread that holds it. Appending is free, and so is `save_memory` under an existing name:
gating updates would refuse most of what the assistant learns. The previous text of an overwritten
memory is lost, the one hole in "compaction is the only thing that destroys history". The profile
was nearly missed and matters most: it is the write the nightly prompt steers toward first, and a
line deleted there leaves the only memory the model always sees.

## In a chat the gate satisfies itself

With no `cited_turn` the tool falls back to the turn being answered, which always verifies: the
user is present and has just spoken, and the history the model sees carries no ids anyway. The
unattended nightly pass has no fallback and is the case the gate was built for. `REFLECTION_PROMPT`
tells it to send a `thread`; without one the citation resolves against `reflection`, which is never
in the registry, and the model is told its thread was deleted, the one refusal that is false. This
is why `delete_memory` advertises both fields as optional; the drift that forced the question is in
[tool-boundary.md](tool-boundary.md).

## Citations name a position, not an id

The nightly transcript labels turns `[n]` per thread and `citationLabels()` maps `thread#label` back
to the id. A model copying a 36-character UUID slips a character, which arrives as a refusal
indistinguishable from a fabricated citation. deepseek-v4-flash cited `"[1]"` with brackets on
2026-08-18, so the tool strips them. `transcript` and `citationLabels` must agree; a test says so.

## Every memory records its source

`save()` requires `source: { thread, turn?, at }`, written as flat `source_*` frontmatter keys
because the parser reads one `key: value` a line. A memory from before this existed has none: old,
not suspect. Archiving files its grounds as `archived_because_*` for the same reason a log line
three days later cannot: a fact destroyed for a reason nobody can find looks like a whim. Not built:
resolving a memory's own pointer back to its turn, so the "source deleted" case cannot arise yet.

## Ratings are collected and nothing reads them yet

Of the three signals in the design only the cited turn is built. A thumbs-down goes to the archive
as a `feedback` row (`none` withdraws; the table is append-only and a reader takes the last row per
message); tool errors and contradictions between two archived turns are not implemented. The ratings
are kept anyway because a judge calibrated only on failures has no false-positive rate, and unlike
code this data cannot be added retroactively (~100 bytes a click). The ratio is not a quality
metric, and nothing exports the archive, so `evals/` cannot reach it.
