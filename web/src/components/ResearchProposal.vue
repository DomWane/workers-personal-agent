<script setup lang="ts">
import { ref } from 'vue'
import {
  Plan,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from '@/components/ai-elements/plan'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ResearchPreset, ResearchState } from '@/types'

const props = defineProps<{ research: ResearchState }>()
const emit = defineEmits<{
  (e: 'stop'): void
  (e: 'start', preset: ResearchPreset): void
  (e: 'revise', note: string): void
}>()

/** The numbers mirror `RESEARCH_PRESETS` in the Worker; the cost lines are what the Free plan
 *  runs into first, said here because this is where the run is approved. */
const PRESETS: Array<{ id: ResearchPreset; label: string; hint: string }> = [
  // "for up to N minutes, then the report": the clock bounds the reading, and the report takes
  // one to four more minutes on a slow provider. "Up to 2 minutes" read as the whole run, and was not.
  {
    id: 'quick',
    label: 'Quick',
    hint: 'One scout per angle reads for up to 2 minutes, then the report is written. Fits the Free plan best.',
  },
  {
    id: 'normal',
    label: 'Normal',
    hint: 'One scout per angle, then narrower rounds on what stays open, for up to 5 minutes before the report.',
  },
  {
    id: 'deep',
    label: 'Deep',
    hint: 'Like Normal, for up to 10 minutes. On Workers AI Free this can spend most of the daily neurons; search spends credits, or meets the keyless rate limits.',
  },
]

const preset = ref<ResearchPreset>('normal')
const revision = ref('')

function revise() {
  const text = revision.value.trim()
  if (!text) {
    return
  }
  emit('revise', text)
  revision.value = ''
}
</script>

<template>
  <!-- default-open: the plan is the thing being approved, so it cannot start behind a chevron. -->
  <Plan class="w-full" default-open>
    <PlanHeader>
      <div class="space-y-1">
        <PlanTitle>Research proposal</PlanTitle>
        <PlanDescription>{{ props.research.topic }}</PlanDescription>
      </div>
      <PlanTrigger />
    </PlanHeader>
    <PlanContent class="space-y-4">
      <ol class="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li v-for="(step, i) in props.research.plan" :key="i">
          {{ step }}
        </li>
      </ol>

      <!-- Under the plan and above the decision: revising changes what is approved, so it sits
           with the plan rather than with the buttons that approve it. -->
      <form class="space-y-1" @submit.prevent="revise">
        <div class="flex gap-2">
          <Input v-model="revision" placeholder="What should change?" class="h-8" />
          <Button type="submit" size="sm" variant="secondary"> Revise </Button>
        </div>
        <!-- `MAX_PLAN_LINES` truncates silently and the agent does not know the number, so it has
             told people there is no limit. Said here because this is where they ask for a fifth. -->
        <p class="text-xs text-muted-foreground">A run covers at most four angles.</p>
      </form>
    </PlanContent>
    <PlanFooter class="flex-col items-stretch gap-3 border-t pt-4">
      <div class="space-y-1.5">
        <ButtonGroup>
          <Button
            v-for="p in PRESETS"
            :key="p.id"
            size="sm"
            :variant="preset === p.id ? 'default' : 'outline'"
            :aria-pressed="preset === p.id"
            @click="preset = p.id"
          >
            {{ p.label }}
          </Button>
        </ButtonGroup>
        <p class="text-xs text-muted-foreground">{{ PRESETS.find((p) => p.id === preset)?.hint }}</p>
      </div>
      <!-- The decision is the last thing on the card: no `Confirmation` element, because a bordered
           box asking a question inside the card reads as a chat message. The card *is* the confirmation. -->
      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" @click="emit('stop')"> Drop </Button>
        <Button size="sm" @click="emit('start', preset)"> Start </Button>
      </div>
    </PlanFooter>
  </Plan>
</template>
