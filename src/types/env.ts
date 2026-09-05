import type { PersonalAgent } from '../agent/personal-agent'
import type { MaintenanceAgent } from '../agent/maintenance-agent'
import type { ResearchScout } from '../agent/research-scout'

export interface Env {
  PERSONAL_AGENT: DurableObjectNamespace<PersonalAgent>
  RESEARCH_SCOUT: DurableObjectNamespace<ResearchScout>
  MAINTENANCE: DurableObjectNamespace<MaintenanceAgent>
  // secrets (.env locally, wrangler secret put in prod)
  /** Optional: with no LLM_BASE_URL set, CF_API_TOKEN authenticates the Cloudflare default. */
  LLM_API_KEY?: string
  CF_API_TOKEN: string
  FIRECRAWL_API_KEY?: string
  /** Preferred search vendor: 1 credit a search against Firecrawl's 2, and 100/min against 10. */
  TAVILY_API_KEY?: string
  // bindings
  AI: Ai
  VAULT: R2Bucket
  /** The Worker never calls this today: the platform serves matching paths before the Worker runs.
   *  It exists so the SPA fallthrough resolves and so a handler could serve an asset if needed. */
  ASSETS: Fetcher
  // vars
  /** Unset means Cloudflare Workers AI, derived from CF_ACCOUNT_ID — see llm-config.ts. */
  LLM_BASE_URL?: string
  LLM_MODEL: string
  ENVIRONMENT: string
  VAULT_AGENT_DIR: string
  /** "true" or "1" puts message bodies in the logs. Off unless set; the committed `wrangler.jsonc`
   *  sets it. */
  LOG_CONTENT?: string
  /** "true" runs the agent with no Cloudflare Access in front of it. Absent means closed: the
   *  default has to be the one that is wrong quietly, not the one that leaks quietly. */
  ALLOW_UNPROTECTED?: string
  CF_ACCOUNT_ID: string
  /** Optional cheaper model for the nightly reflection job. */
  REFLECTION_MODEL?: string
  /** Optional separate model for research scouts. A wave is where the tokens go, and a scout reads
   *  and reports rather than writing the report, so it is the part worth trading down first. */
  SCOUT_MODEL?: string
}
