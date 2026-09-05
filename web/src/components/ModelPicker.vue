<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ModelRow } from '@/types'

const props = defineProps<{
  catalogue: ModelRow[]
  /** The model this deployment runs when nothing overrides it. */
  deploymentModel: string
  override?: string
  /** The composer's copy sits in a toolbar and has to be smaller than the header's. */
  compact?: boolean
}>()
/** The id, not the command: switching may have to be confirmed first, and only the caller knows
 *  what the current conversation would cost the new model. */
const emit = defineEmits<{ (e: 'select', id: string): void }>()

const open = ref(false)

/** Never "default": the picker must always name the model that will answer. */
const current = computed(() => props.override ?? (props.deploymentModel || 'loading…'))

/** A model absent from the catalogue is assumed usable: the deployment is already running it, and
 *  the catalogue can be stale or empty when the provider refused the list. */
function row(id: string): ModelRow {
  return props.catalogue.find((m) => m.id === id) ?? { id, tools: true, paid: false }
}

/** The deployment's own model leads the list, so returning to it is one click rather than a
 *  command the user has to know. */
const models = computed(() => {
  const rest = props.catalogue.filter((m) => m.id !== props.deploymentModel)
  return props.deploymentModel ? [row(props.deploymentModel), ...rest] : rest
})

/** Listed rather than hidden, and unselectable rather than silently failing: a model this
 *  deployment cannot call is worth knowing about, and picking one would only fail at answer time. */
function unusable(m: ModelRow): string | undefined {
  if (m.paid) {
    return 'Paid plan'
  }
  if (!m.tools) {
    return 'No tools'
  }
  return undefined
}

function contextLabel(m: ModelRow): string {
  return m.context ? `${Math.round(m.context / 1000)}k` : ''
}

/** In/out per million tokens. Two numbers rather than one because the gap between them is what
 *  decides the bill: an agent that reads pages pays mostly input, a report writer mostly output. */
function priceLabel(m: ModelRow): string {
  if (m.priceIn === undefined && m.priceOut === undefined) {
    return ''
  }
  const one = (n?: number) => (n === undefined ? '?' : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`)
  return `${one(m.priceIn)}/${one(m.priceOut)}`
}

function pick(id: unknown) {
  open.value = false
  if (typeof id !== 'string') {
    return
  }
  if (unusable(row(id))) {
    return
  }
  emit('select', id)
}
</script>

<template>
  <ModelSelector v-model:open="open">
    <ModelSelectorTrigger as-child>
      <Button
        size="sm"
        variant="outline"
        class="max-w-56 justify-start truncate font-mono"
        :class="props.compact ? 'h-7 px-2 text-[11px]' : 'text-xs'"
      >
        {{ current }}
      </Button>
    </ModelSelectorTrigger>
    <ModelSelectorContent title="Choose a model" @update:model-value="pick">
      <ModelSelectorInput placeholder="Search models…" />
      <ModelSelectorList>
        <ModelSelectorEmpty>No model matches.</ModelSelectorEmpty>
        <ModelSelectorGroup heading="Models">
          <ModelSelectorItem v-for="model in models" :key="model.id" :value="model.id" :disabled="!!unusable(model)">
            <ModelSelectorName>{{ model.id }}</ModelSelectorName>
            <span class="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
              <span v-if="priceLabel(model)" class="tabular-nums">{{ priceLabel(model) }}</span>
              <span v-if="contextLabel(model)" class="tabular-nums">{{ contextLabel(model) }}</span>
              <Badge v-if="unusable(model)" variant="outline" class="text-[10px]">
                {{ unusable(model) }}
              </Badge>
            </span>
          </ModelSelectorItem>
        </ModelSelectorGroup>
      </ModelSelectorList>
    </ModelSelectorContent>
  </ModelSelector>
</template>
