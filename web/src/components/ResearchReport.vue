<script setup lang="ts">
import { computed } from 'vue'
import { ChevronsRightIcon, DownloadIcon } from '@lucide/vue'
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from '@/components/ai-elements/artifact'
import { MessageResponse } from '@/components/ai-elements/message'
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { Button } from '@/components/ui/button'
import { formatTokens } from '@/lib/context'
import { pageCounts } from '@/lib/research'
import type { ResearchState } from '@/types'

const props = defineProps<{ research: ResearchState }>()
const emit = defineEmits<{ (e: 'save' | 'stop' | 'collapse'): void }>()

const pages = computed(() => pageCounts(props.research))

/** `stopCause` is a wire value, and "stopped on no-new-ground" is not a sentence. Phrased without
 *  the server's numbers so the caps can move without this drifting from them. */
const WHY: Record<string, string> = {
  time: 'hit the time limit',
  budget: 'hit the request budget',
  'max-rounds': 'hit the round limit',
  'no-new-ground': 'found nothing new to read',
  'model-done': 'covered the topic',
  'not-running': 'stopped',
}
const why = computed(() => (props.research.stopCause ? WHY[props.research.stopCause] : undefined))

/** Client-side so the report never has to travel a second time: it is already in state. */
function download() {
  const blob = new Blob([props.research.report ?? ''], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${
    props.research.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'research'
  }.md`
  a.click()
  URL.revokeObjectURL(url)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
</script>

<template>
  <Artifact class="h-full">
    <ArtifactHeader>
      <div class="min-w-0 space-y-0.5">
        <ArtifactTitle class="truncate">
          {{ props.research.topic }}
        </ArtifactTitle>
        <ArtifactDescription>
          {{ pages.label }}
          <template v-if="pages.lost"> · {{ pages.lost }} could not be opened</template>
          <template v-if="why"> · {{ why }}</template>
          <template v-if="props.research.tokens"> · {{ formatTokens(props.research.tokens) }} tokens</template>
        </ArtifactDescription>
      </div>
      <ArtifactActions>
        <ArtifactAction :icon="DownloadIcon" tooltip="Download .md" @click="download" />
        <!-- Collapse, not close: the run keeps running the moment this is not the point. -->
        <ArtifactAction :icon="ChevronsRightIcon" tooltip="Collapse" @click="emit('collapse')" />
      </ArtifactActions>
    </ArtifactHeader>
    <ArtifactContent>
      <MessageResponse :content="props.research.report ?? ''" />
    </ArtifactContent>
    <!-- Below the report, not inside it: deciding what to do with one should not need scrolling to
         its end. Plain buttons, because `Suggestions` wraps a `ScrollArea` whose viewport collapses
         to nothing in a column with no height — the chips painted over the text. -->
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t p-4">
      <Sources v-if="props.research.visited.length">
        <SourcesTrigger :count="props.research.visited.length" />
        <SourcesContent>
          <Source v-for="url in props.research.visited" :key="url" :href="url" :title="hostOf(url)" />
        </SourcesContent>
      </Sources>
      <div class="ml-auto flex gap-2">
        <Button variant="outline" size="sm" @click="emit('stop')"> Drop it </Button>
        <Button size="sm" @click="emit('save')"> Save to vault </Button>
      </div>
    </div>
  </Artifact>
</template>
