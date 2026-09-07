# Skills

A skill is one markdown file under `agent/skills/` that the agent writes for itself: frontmatter
(`name`, `description`, `date`, `use_count`, `last_used`, `pinned`) over a procedure. The model
saves them with `save_skill`, the user or the model invokes them, and the nightly reflection
curates them.

## The index rides in the system prompt, the body stays behind read_skill

Every system prompt carries one `- slug — description` line per skill inside `<skills>`. The body is
loaded only by `read_skill` or by `/<slug>` in the message. Until 2026-09-07 the model saw nothing
and was told to call `list_skills` before a workflow-shaped task, which it could not know it had:
the choice was a blind tool call every turn or never using a skill.

The index is read from the vault on every turn, not frozen per session like `USER.md` and
`AGENT.md`. A snapshot would go stale in a way nothing in the thread can notice: the nightly
reflection archives and merges skills from another Durable Object, and a thread open for a week
would keep offering a slug that `read_skill` no longer finds. Reading it each turn costs one R2
`list`: every skill write stores its frontmatter as the object's custom metadata, and `list` returns
that without a `get` per file. A skill file dropped into the vault by hand carries no metadata and
is opened the old way, so it still shows up. A description is capped at 120 characters on save and
`listSkills` already stops at 30 files, so the block is bounded at a few kilobytes.

## Use is what keeps a skill alive

`read_skill` and `/<slug>` stamp `last_used` and `use_count`; appearing in the index does not. The
nightly sweep archives an unpinned skill 90 days after its last use, or after its creation if it was
never used. Nothing is deleted, and reflection may merge near-duplicates but never touches a pinned
skill.

Not built: a skill directory with scripts or reference files, a shared hub, an approval step before
a save. The first two need a filesystem the Worker does not have; the third guards a multi-user
deployment this is not.
