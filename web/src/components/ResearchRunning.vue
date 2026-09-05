<script setup lang="ts">
import { computed } from 'vue'
import { useNow } from '@vueuse/core'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader } from '@/components/ai-elements/loader'
import { Button } from '@/components/ui/button'
import { pageCounts } from '@/lib/research'
import type { ResearchState } from '@/types'

const props = defineProps<{ research: ResearchState }>()
const emit = defineEmits<{ (e: 'stop'): void }>()

// A run is bounded by a five-minute clock, so the elapsed time is the number that says how much
// of the run is left — it has to move on its own, not only when state arrives.
const now = useNow({ interval: 1000 })

const pages = computed(() => pageCounts(props.research))

const elapsed = computed(() => {
  const s = Math.max(0, Math.floor((now.value.getTime() - props.research.startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
</script>

<template>
  <Card class="w-full">
    <CardHeader>
      <CardTitle class="flex items-center gap-2 text-base">
        <Loader :size="16" />
        Researching
      </CardTitle>
      <CardDescription>{{ props.research.topic }}</CardDescription>
    </CardHeader>
    <CardContent class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
      <span>Round {{ props.research.round }}</span>
      <span>{{ pages.label }}</span>
      <!-- Named while the run is still going, because a wave losing pages to a rate limit can still
           be stopped — after the report it is only an explanation. -->
      <span v-if="pages.lost">{{ pages.lost }} unreachable</span>
      <span>{{ props.research.openQuestions.length }} open questions</span>
      <span>{{ elapsed }} elapsed</span>
      <Button class="ml-auto" size="sm" variant="ghost" @click="emit('stop')"> Stop </Button>
    </CardContent>
  </Card>
</template>
