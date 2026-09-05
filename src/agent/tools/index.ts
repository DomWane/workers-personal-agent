import { agentNotesTools } from './agent-notes.tools'
import { browserTools } from './browser.tools'
import { memoryTools } from './memory.tools'
import { profileTools } from './profile.tools'
import { researchTools } from './research.tools'
import type { ToolDef } from './registry'
import { scheduleTools } from './schedule.tools'
import { searchTools } from './search.tools'
import { skillTools } from './skills.tools'
import { toolArchiveTools } from './tool-archive.tools'

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
