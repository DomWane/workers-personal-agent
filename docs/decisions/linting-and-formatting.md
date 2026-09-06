# oxlint and oxfmt

Every rule was counted against this repo before being switched on or left off. A rule refused
without a number gets re-litigated every six months.

## oxfmt describes the style the repo already had

No semicolons, single quotes, 120 columns. The width is the only real choice: p99 of the repo is
122, and under 120 oxfmt breaks the tagged-template generics every DO SQLite query is written as.

## Three rules are configured because they fire on correct code

`no-control-regex` off (`sanitize()` matches control characters on purpose),
`no-unused-expressions` allows tagged templates (every `sql\`CREATE TABLE …\``), and
`vitest/require-mock-type-parameters` off (typing 21 `vi.fn()` calls buys nothing).

## Plugins and categories, by count

`import`, `promise`, `node`, `jsdoc` and `vue` report zero findings and are on as a net. `vitest`
reported four, two real (a test with no assertion, a bare `.rejects.toThrow()`). Refused: `style`
8,133, `restriction` 2,082, `pedantic` 682, `perf` 73 × `no-await-in-loop` in code that awaits in
loops to stay under the subrequest cap. `suspicious` is worth revisiting: 81, of which
`preserve-caught-error` (2) was real and is on.

oxlint reads `.vue` script blocks, except that `no-unused-vars` does not fire there, so `vue-tsc`
remains the only thing finding unused code in `web/`. `noUnusedLocals` is on for `src/`, `test/` and
`evals/` only, because vue-tsc does not count a template's `ref="name"` as a use.

## Type-aware rules run on TypeScript 5.9

`oxlint-tsgolint` produced byte-identical findings under 5.9 and 7.0 in a throwaway worktree. The
upgrade is blocked on the Vue side: `vue-tsc` loads `typescript/lib/tsc`, which 7.0 no longer
exports, and `vite build web` fails with 61 `@vue/compiler-sfc` errors. `tsc --noEmit` over `src/`,
`test/` and `evals/` passes on 7.0.

`options.typeAware` in `.oxlintrc.json` means `pnpm lint` runs them with no flag, in 0.6 s. The
reference set is typescript-eslint's `strict-type-checked`: 68 rules, 48 report zero here and all 48
are on, including `no-floating-promises`, which found nothing because the `void` discipline was
already there.

**Refused, with counts:** `no-unnecessary-condition` 41, `require-await` 82,
`no-confusing-void-expression` 66, `no-non-null-assertion` 42, `no-unnecessary-type-assertion` 41,
`no-explicit-any` 7, `no-empty-object-type` 8 (the last four are the only part of
`strict-type-checked` not taken). `unbound-method` is off in `test/**` only: all five hits are
`expect(mock.method)`. `strict-boolean-expressions` is in no recommended config and would cost 116
sites. `no-array-sort` would migrate 29 sites that sort an array just built.

**The `no-unsafe-*` family is the one real gap**, 186 sites pointing at one seam: values arriving as
`unknown` from a model, a JSON parse or a mocked fetch. Only 44 are in `src/`; the rest are `.mjs`
scripts and test plumbing, so it is a config question before a code question. `no-base-to-string`
and `restrict-template-expressions` are on and `src/` reports zero.

`lib` is `ES2023` in all three tsconfigs: a probe in the Workers pool ran `toSorted`, `findLast`
and `Object.groupBy`.

## `curly` is on because oxfmt cannot express it

`curly: ["error", "all"]` is the one rule here for a stated preference: a branch and its body do
not share a line. oxfmt's options (checked against `configuration_schema.json` at 0.64.0) say
nothing about what follows an `if`, and Prettier never had such an option, so the linter adds the
braces and the formatter splits the block. Applied to 452 sites in one revision; scoping to `src/`
and `web/` was dropped because `evals/` is the largest share.
