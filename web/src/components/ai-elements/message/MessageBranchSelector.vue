<script setup lang="ts">
import type { MessageRole } from '@/components/ai-elements/ai-types'
import { ButtonGroup } from '@/components/ui/button-group'
import { useMessageBranchContext } from './context'

interface Props {
  from: MessageRole
}
defineProps<Props>()

const { totalBranches } = useMessageBranchContext()
</script>

<template>
  <ButtonGroup
    v-if="totalBranches > 1"
    class="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
    orientation="horizontal"
    v-bind="$attrs"
  >
    <slot />
  </ButtonGroup>
</template>
