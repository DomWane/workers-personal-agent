# Providers and models

## The model catalogue is proxied

`GET /api/models` reads `${LLM_BASE_URL}/models` (the OpenAI convention, verified against
OpenRouter) or, with no base URL, Cloudflare's `/ai/models/search`. Measured 2026-08-12: Cloudflare
serves OpenAI-compatible chat at `/ai/v1/chat/completions` but has no `/ai/v1/models` (405), which is
why `llm-config.ts` resolves the two together instead of a second env var. Prices are normalised to
per million tokens: Cloudflare publishes per million, OpenRouter per token. `require_workers_paid`
is what makes "paid plan" honest, measured on `@cf/zai-org/glm-5.2`, which answers "not available
on the Workers Free plan".

## One Cloudflare token does everything

`CF_API_TOKEN` needs Workers AI: Read (catalogue, and chat on the default provider), Browser
Rendering: Edit (`read_page`) and Billing: Read (the hourly plan lookup, per the API reference for
`GET /accounts/{id}/subscriptions`, checked 2026-09-05). `evals/ingest/traces.ts` adds Account
Analytics: Read. It replaced two scoped tokens: measured 2026-08-12, the AI token returned 401 on
browser rendering and the browser token 403 on the catalogue, and one token carrying both answers
200 to both.
