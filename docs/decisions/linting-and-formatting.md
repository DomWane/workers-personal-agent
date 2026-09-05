# oxlint and oxfmt: what is on, what was refused, and the numbers behind both

Every rule below was counted against this repo before being switched on or left off, so the
refusals are as much the point as the acceptances — a rule refused without a number gets
re-litigated every six months.

**oxfmt's config describes the style the repo already had** rather than imposing one: no
semicolons, single quotes, 120 columns. The width is the only real choice — p99 of the repo is 122,
and under 120 oxfmt breaks the tagged-template generics that every DO SQLite query is written as.

Three oxlint rules are configured rather than obeyed, and each would otherwise fire on code that is
correct: `no-control-regex` is off because `sanitize()` matches control characters on purpose,
`no-unused-expressions` allows tagged templates or every `sql\`CREATE TABLE …\`` reads as a mistake,
and `vitest/require-mock-type-parameters` is off because typing 21 `vi.fn()` calls buys nothing the
compiler does not already know.

**Which plugins are on was decided by measuring.** `import`, `promise`, `node`, `jsdoc` and `vue`
each report **zero** findings on this repo, so they cost nothing and are on as a net for later;
`vitest` reported four, of which two were real (a test with no assertion, a bare
`.rejects.toThrow()` that would have passed on any error at all). The categories beyond
`correctness` were measured and refused: `style` is 8,133 findings, `restriction` 2,082, `pedantic`
682, and `perf` is 73 × `no-await-in-loop` in a codebase that awaits in loops deliberately, to keep
from bursting the subrequest cap. `suspicious` is the only one worth revisiting — 81 findings, of
which `preserve-caught-error` (2) was real and is now on.

oxlint reads `.vue` script blocks, with one measured exception: `no-unused-vars` does not fire
there, so `vue-tsc` stays the only thing that finds unused code in `web/`. `noUnusedLocals` is on
only for `src/`, `test/` and `evals/`, because vue-tsc does not count a template's `ref="name"` as a
use.

**Type-aware linting runs on TypeScript 5.9, not the 7 the oxc docs name.** `oxlint-tsgolint` was
measured in a throwaway worktree under both versions and produced byte-identical findings. That
matters because the upgrade is **blocked** on the Vue side: `vue-tsc` loads `typescript/lib/tsc`,
which 7.0 no longer exports, and `vite build web` fails with 61 `@vue/compiler-sfc` errors. `tsc
--noEmit` over `src/`, `test/` and `evals/` passes on 7.0, so the Worker side is ready and the Vue
toolchain is not.

**The type-aware rules were chosen by counting.** `options.typeAware` in `.oxlintrc.json` means
`pnpm lint` alone runs them — no flag — and the whole pass takes 0.6 s. The reference set is
typescript-eslint's **`strict-type-checked`**, read from its generated source: 68 rules, of which
**48 report zero on this repo**, and all 48 are on. `await-thenable`, `no-floating-promises`,
`no-for-in-array`, `no-implied-eval`, `only-throw-error`, `switch-exhaustiveness-check` and
`no-deprecated` are a net for what has not been written yet — the same argument the zero-finding
plugins ship on, and the only honest reason to enable a rule that finds nothing. The rule this was
all wanted for is among the zeros: `no-floating-promises` reports none, so the `void` discipline was
already there.

Measured and **refused**: `no-unnecessary-condition` (41), `require-await` (82),
`no-confusing-void-expression` (66), `no-non-null-assertion` (42), `no-unnecessary-type-assertion`
(41), `no-explicit-any` (7) and `no-empty-object-type` (8) — the last four are in
`strict-type-checked` and are the only part of it this repo does not take. `unbound-method` is off
**in `test/**` only** — all five hits are `expect(mock.method)`, the known false positive.
`strict-boolean-expressions` is not in any of typescript-eslint's recommended or strict configs,
only in `all`, and would cost 116 sites. `no-array-sort` would be a blanket migration to `toSorted`
across 29 sites that all sort an array just built by `[...]`, `.map()` or `.filter()`.

**The `no-unsafe-*` family is the one real gap**, and it is one gap rather than five:
`no-unsafe-member-access` (73), `no-unsafe-assignment` (45), `no-unsafe-call` (42),
`no-unsafe-argument` (15) and `no-unsafe-return` (11) all point at the same seam — values that
arrive as `unknown` from a model, a JSON parse or a mocked fetch and are used without being narrowed.
Only **44 of 186 sites are in `src/`**; the rest are the untyped `.mjs` files in `scripts/` and test
plumbing, so this is a config question about where the rules apply before it is a code question.
`no-base-to-string` and `restrict-template-expressions` are on and `src/` reports zero under both;
they were the 39 findings that made [the tool boundary](tool-boundary.md) worth validating.

`lib` is `ES2023` in all three tsconfigs: a probe inside the Workers pool ran `toSorted`, `findLast`
and `Object.groupBy`, so the older setting only hid methods workerd already has.

## `curly`, and the formatter question it answers

`curly` is **on** as `["error", "all"]`, and it is the one rule here that exists for a stated
preference rather than for a defect it prevents: a branch and its body do not share a line, because
a repo where `if (!f) return null` and a braced block both appear reads as two styles.

**oxfmt cannot express this.** Its options — checked against `configuration_schema.json` at 0.64.0 —
are width, quoting, semicolons, trailing commas, import sorting and a handful of JSX and Vue
switches. There is nothing about what follows an `if`, and Prettier, whose behaviour it matches, has
never had such an option either. So the shape comes from the linter: `curly` adds the braces and
oxfmt then splits the block. The two tools are doing one job in sequence, which is worth knowing
before someone looks for the missing oxfmt setting again. It cost **452 sites**, applied by
`oxlint --fix` and `oxfmt` in one revision; scoping it to `src/` and `web/` was considered and
dropped, because `evals/` is the largest share and the place a second style would be least noticed.
