<script setup lang="ts">
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { dismiss, toasts } from '@/useToasts'
</script>

<template>
  <!-- Top right, not above the composer: the composer grows with what is typed into it, so any
       offset from the bottom is a guess that fails the moment someone writes three lines. -->
  <div
    class="pointer-events-none fixed top-16 right-4 z-50 flex flex-col items-end gap-2"
    role="status"
    aria-live="polite"
  >
    <div
      v-for="t in toasts"
      :key="t.id"
      class="pointer-events-auto flex max-w-md items-start gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg"
    >
      <span class="flex-1">{{ t.text }}</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        class="size-6 shrink-0 p-0"
        aria-label="Dismiss"
        @click="dismiss(t.id)"
      >
        <XIcon class="size-3.5" />
      </Button>
    </div>
  </div>
</template>
