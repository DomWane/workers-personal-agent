import type { PersonalAgent } from '@/agent/personal-agent'
import type { MaintenanceAgent } from '@/agent/maintenance-agent'
import type { ResearchScout } from '@/agent/research/scout'
import type { McpRegistry } from '@/agent/mcp/registry'
import type { McpClient } from '@/agent/mcp/client'

export interface Env {
  PERSONAL_AGENT: DurableObjectNamespace<PersonalAgent>
  RESEARCH_SCOUT: DurableObjectNamespace<ResearchScout>
  MAINTENANCE: DurableObjectNamespace<MaintenanceAgent>
  MCP_REGISTRY: DurableObjectNamespace<McpRegistry>
  MCP_CLIENT: DurableObjectNamespace<McpClient>
  LLM_API_KEY?: string
  CF_API_TOKEN: string
  FIRECRAWL_API_KEY?: string
  TAVILY_API_KEY?: string
  AI: Ai
  VAULT: R2Bucket
  ASSETS: Fetcher
  LLM_BASE_URL?: string
  LLM_MODEL: string
  ENVIRONMENT: string
  VAULT_AGENT_DIR: string
  LOG_CONTENT?: string
  ALLOW_UNPROTECTED?: string
  CF_ACCOUNT_ID: string
  REFLECTION_MODEL?: string
  SCOUT_MODEL?: string
}
