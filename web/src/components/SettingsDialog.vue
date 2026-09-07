<script setup lang="ts">
import { computed, ref } from 'vue'
import { LoaderCircleIcon, PlugIcon, SettingsIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useMcpServers } from '@/useMcpServers'
import type { McpServer } from '@/types/mcp'

const { servers, busy, error, refresh, add, connect, remove } = useMcpServers()
const open = ref(false)

const name = ref('')
const url = ref('')
const bearer = ref('')

async function submit(): Promise<void> {
  if (!name.value.trim() || !url.value.trim()) {
    return
  }
  const server = await add(name.value, url.value, bearer.value)
  if (server) {
    name.value = ''
    url.value = ''
    bearer.value = ''
  }
}

function stateLabel(server: McpServer): string {
  switch (server.state) {
    case 'ready':
      return 'Ready'
    case 'authenticating':
      return 'Waiting for sign-in…'
    case 'failed':
      return 'Failed'
    default:
      return server.state[0].toUpperCase() + server.state.slice(1)
  }
}

const stateClass = (server: McpServer) =>
  server.state === 'ready'
    ? 'text-green-600 dark:text-green-500'
    : server.state === 'failed'
      ? 'text-destructive'
      : server.state === 'authenticating'
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-muted-foreground'

const sorted = computed(() => [...servers.value].sort((a, b) => a.name.localeCompare(b.name)))
</script>

<template>
  <Dialog v-model:open="open" @update:open="refresh">
    <DialogTrigger as-child>
      <Button variant="ghost" class="size-7 p-0" :aria-label="'Settings'">
        <SettingsIcon class="size-4" />
      </Button>
    </DialogTrigger>
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>MCP servers</DialogTitle>
        <DialogDescription>
          Connect external MCP servers so the agent can call their tools in any chat.
        </DialogDescription>
      </DialogHeader>

      <div class="grid gap-4">
        <form class="grid gap-2" @submit.prevent="submit">
          <Input v-model="name" placeholder="Name, for example GitHub" aria-label="Server name" autocomplete="off" />
          <Input
            v-model="url"
            placeholder="Server URL, for example https://mcp.github.com/mcp"
            aria-label="Server URL"
            autocomplete="off"
          />
          <Input
            v-model="bearer"
            type="password"
            placeholder="Bearer token (only for key-authenticated servers)"
            aria-label="Bearer token"
            autocomplete="off"
          />
          <div class="flex items-center justify-end gap-2">
            <p v-if="error" class="text-muted-foreground mr-auto text-xs">{{ error }}</p>
            <Button type="submit" size="sm" :disabled="busy || !name.trim() || !url.trim()">
              <LoaderCircleIcon v-if="busy" class="size-3.5 animate-spin" />
              Add server
            </Button>
          </div>
        </form>

        <div class="max-h-72 space-y-2 overflow-y-auto pr-1">
          <p v-if="!sorted.length" class="text-muted-foreground px-1 text-sm">
            Nothing connected yet. Add a server above. A server that needs OAuth opens a sign-in window once it is
            added.
          </p>
          <div v-for="server in sorted" :key="server.id" class="flex items-center gap-2 rounded-md border px-3 py-2">
            <PlugIcon class="text-muted-foreground size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="flex items-baseline gap-2 text-sm">
                <span class="font-medium">{{ server.name }}</span>
                <span class="text-muted-foreground truncate text-xs">{{ server.url }}</span>
              </p>
              <p class="text-xs" :class="stateClass(server)">
                {{ stateLabel(server) }}
                <span v-if="server.state === 'failed' && server.error" class="text-muted-foreground">
                  ({{ server.error }})
                </span>
              </p>
            </div>
            <Button
              v-if="server.state === 'authenticating'"
              size="sm"
              variant="outline"
              :disabled="busy"
              @click="connect(server.id)"
            >
              Sign in
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              :aria-label="`Remove ${server.name}`"
              :disabled="busy"
              @click="remove(server.id)"
            >
              <Trash2Icon class="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" class="mr-auto" @click="refresh"> Refresh </Button>
        <Button variant="outline" size="sm" @click="open = false"> Done </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
