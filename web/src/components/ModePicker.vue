<script setup lang="ts">
import { ChevronDownIcon, MicroscopeIcon, MessageSquareIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ChatMode } from '@/types'

const mode = defineModel<ChatMode>({ required: true })

const MODES: Array<{ id: ChatMode; label: string; hint: string }> = [
  { id: 'chat', label: 'Chat', hint: 'One turn, tools as needed' },
  { id: 'research', label: 'Deep research', hint: 'Plan, then rounds of scouts — minutes, not seconds' },
]
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[11px]">
        <component :is="mode === 'research' ? MicroscopeIcon : MessageSquareIcon" class="size-3.5" />
        {{ mode === 'research' ? 'Deep research' : 'Chat' }}
        <ChevronDownIcon class="size-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-64">
      <DropdownMenuItem v-for="m in MODES" :key="m.id" class="flex-col items-start gap-0.5" @select="mode = m.id">
        <span class="font-medium text-sm">{{ m.label }}</span>
        <span class="text-muted-foreground text-xs">{{ m.hint }}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
