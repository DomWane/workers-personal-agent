# The model catalogue, and the one token that does everything

**The model catalogue is proxied, not fetched from the browser.** `GET /api/models` reads
`${LLM_BASE_URL}/models` (the OpenAI convention, verified against OpenRouter) or, when no base URL is
set, Cloudflare's `/ai/models/search` — measured 2026-08-12: Cloudflare serves OpenAI-compatible
*chat* at `/ai/v1/chat/completions` but has no `/ai/v1/models` (405, "GET not supported"). That
asymmetry is why `llm-config.ts` exists instead of a second env var. Rows carry `tools`, `paid`,
`context` and price per million tokens, normalised from each vendor's unit — Cloudflare publishes per
million, OpenRouter per token, so an un-normalised picker would be off by a factor of a million.
`require_workers_paid` in the Cloudflare catalogue is what makes "paid plan" honest: measured on
`@cf/zai-org/glm-5.2`, which answers *not available on the Workers Free plan*.

**One Cloudflare token does everything.** `CF_API_TOKEN` needs **Workers AI: Read** (catalogue, and
chat when Cloudflare is the provider — the AI REST reference names it as the one permission every
`/accounts/{id}/ai/*` endpoint requires), **Browser Rendering: Edit** (`read_page`) and **Billing: Read**
(the hourly plan lookup in `workers-plan.ts` — the API reference for `GET /accounts/{id}/subscriptions`
lists Billing Read or Billing Write as the token permission, checked 2026-09-05); `evals/ingest/traces.ts`
additionally wants Account Analytics: Read. It replaced `CF_AI_TOKEN` and `CF_BROWSER_API_TOKEN`,
which were separately scoped — measured 2026-08-12: the AI token returned 401 on browser rendering
and the browser token 403 on the AI catalogue, and one token carrying both permissions answers 200
to both.
