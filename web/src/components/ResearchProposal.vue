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
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { ResearchState } from '@/types'

const props = defineProps<{ research: ResearchState }>()
const emit = defineEmits<{
  (e: 'start' | 'stop'): void
  (e: 'revise', note: string): void
}>()

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
    <PlanContent>
      <ol class="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li v-for="(step, i) in props.research.plan" :key="i">
          {{ step }}
        </li>
      </ol>
    </PlanContent>
    <PlanFooter class="flex-col items-stretch gap-3">
      <!-- No `Confirmation` element here: it renders an Alert, and a bordered box asking a question
           inside the card reads as a chat message rather than as this card's own decision. The card
           *is* the confirmation. -->
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-muted-foreground">Reads the web for up to five minutes.</p>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" @click="emit('stop')"> Drop </Button>
          <Button size="sm" @click="emit('start')"> Start </Button>
        </div>
      </div>

      <!-- Always open, but under the decision and in a lighter weight: revising is the rarer answer,
           so it gives way to Start and Drop by position rather than by hiding behind a click. -->
      <form class="space-y-1 border-t pt-3" @submit.prevent="revise">
        <div class="flex gap-2">
          <Input v-model="revision" placeholder="What should change?" class="h-8" />
          <Button type="submit" size="sm" variant="secondary"> Revise </Button>
        </div>
        <!-- `MAX_PLAN_LINES` truncates silently and the agent does not know the number, so it has
             told people there is no limit. Said here because this is where they ask for a fifth. -->
        <p class="text-xs text-muted-foreground">A run covers at most four angles.</p>
      </form>
    </PlanFooter>
  </Plan>
</template>
