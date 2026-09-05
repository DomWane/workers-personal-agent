<script setup lang="ts">
import { useDark } from '@vueuse/core'
import { MoonIcon, SunIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'

/** Storage key shared with the inline script in index.html, which applies the theme before the
 *  first paint — Vue mounts too late to prevent a flash. */
const isDark = useDark({ storageKey: 'theme' })
</script>

<template>
  <Button
    variant="ghost"
    class="size-7 p-0"
    :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'"
    @click="isDark = !isDark"
  >
    <component :is="isDark ? SunIcon : MoonIcon" class="size-4" />
  </Button>
</template>
