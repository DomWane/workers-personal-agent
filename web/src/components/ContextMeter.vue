<script setup lang="ts">
import { computed } from 'vue'
import { FoldVerticalIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ai-elements/loader'
import { contextUsage, formatTokens, spoken, wouldCompact } from '@/lib/context'
import type { AgentState } from '@/types'

const props = defineProps<{ state: AgentState; window?: number }>()
const emit = defineEmits<{ compact: [] }>()

const usage = computed(() => contextUsage(props.state))
const running = computed(() => props.state.status === 'compacting')
/** Compaction always keeps the last exchange, so a shorter thread has nothing to fold. Counted over
 *  what was said: one exchange plus its tool traffic is four messages and still nothing to fold. */
const canCompact = computed(() => spoken(props.state.messages).length > 2 && !running.value)
const due = computed(() => wouldCompact(usage.value.tokens, props.window))

/** The number alone is not the useful part: a meter that cannot say whether it is measured or
 *  guessed asks the reader to trust a guess. */
const title = computed(() =>
  [
    `${usage.value.tokens.toLocaleString()} tokens`,
    props.window ? `of ${props.window.toLocaleString()}` : '(model window unknown)',
    usage.value.measured ? '— counted by the provider' : '— estimated, no turn has reported yet',
    due.value ? '· over the compaction threshold' : '',
  ].join(' '),
)
</script>

<template>
  <div class="flex items-center gap-1">
    <span
      class="tabular-nums text-[11px]"
      :class="due ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'"
      :title="title"
    >
      {{ formatTokens(usage.tokens) }}<span v-if="window">/{{ formatTokens(window) }}</span>
      <span v-if="!usage.measured">~</span>
    </span>
    <!-- The meter lives inside the composer's form, and a bare <button> there submits it: the
         click sent an empty message instead of compacting. -->
    <Button
      type="button"
      size="sm"
      variant="ghost"
      class="h-7 px-2 text-[11px]"
      :disabled="!canCompact"
      title="Fold the earlier turns into a summary now"
      @click="emit('compact')"
    >
      <Loader v-if="running" :size="14" />
      <FoldVerticalIcon v-else class="size-3.5" />
      {{ running ? 'Compacting…' : 'Compact' }}
    </Button>
  </div>
</template>
