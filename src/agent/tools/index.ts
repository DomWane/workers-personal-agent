import { agentNotesTools } from '@/agent/tools/agent-notes.tools'
import { browserTools } from '@/agent/tools/browser.tools'
import { memoryTools } from '@/agent/tools/memory.tools'
import { profileTools } from '@/agent/tools/profile.tools'
import { researchTools } from '@/agent/tools/research.tools'
import type { ToolDef } from '@/agent/tools/registry'
import { scheduleTools } from '@/agent/tools/schedule.tools'
import { searchTools } from '@/agent/tools/search.tools'
import { skillTools } from '@/agent/tools/skills.tools'
import { toolArchiveTools } from '@/agent/tools/tool-archive.tools'

export function buildTools(): ToolDef[] {
  return [
    ...searchTools,
    ...browserTools,
    ...memoryTools,
    ...profileTools,
    ...agentNotesTools,
    ...skillTools,
    ...scheduleTools,
    ...researchTools,
    ...toolArchiveTools,
  ]
}
