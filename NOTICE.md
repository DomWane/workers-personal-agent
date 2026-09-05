# Third-party components

This project is MIT-licensed — see [LICENSE](LICENSE). The files below came from elsewhere and keep
the licence they arrived under; MIT covers everything else.

`web/src/components/` holds source copied from two component registries. Both are copy-paste
registries rather than runtime packages: their CLI writes the source into the project, where it is
edited and maintained like the rest of the code. That is why the attribution belongs here rather
than in `package.json` — nothing in `node_modules` records it.

## shadcn-vue — MIT

`web/src/components/ui/`

Copyright (c) 2023 unovue. Licensed under the MIT License.
<https://github.com/unovue/shadcn-vue>

## ai-elements-vue — Apache License 2.0

`web/src/components/ai-elements/`

Copyright 2025 cwandev. Licensed under the Apache License, Version 2.0; you may not use these files
except in compliance with the License, a copy of which is at
<http://www.apache.org/licenses/LICENSE-2.0>. Distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied.
<https://github.com/vuepont/ai-elements-vue>

**Modified.** The copied components import a handful of types from Vercel's `ai` package. This
project does not use the Vercel AI SDK — the Worker talks to its provider through `openai` — so
those imports were repointed at `web/src/components/ai-elements/ai-types.ts`, which declares the
same shapes locally and narrows `MessageRole` to the two roles this agent persists. Individual
components carry further edits where the UI needed them.
