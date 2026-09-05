<script setup lang="ts">
import { ref } from 'vue'
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader } from '@/components/ai-elements/loader'
import type { Thread } from '@/types'

/** `busy` can only describe the open thread: one socket, and `state` belongs to it. A run continues
 *  in a thread switched away from — alarms do not care — and nothing here can see that. */
const props = defineProps<{ threads: Thread[]; current: string; busy?: boolean }>()
const emit = defineEmits<{ open: [id: string]; create: []; remove: []; rename: [title: string] }>()

/**
 * Renaming and deleting are RPCs on the thread's own instance — that is what stops a client
 * touching a conversation it is not in — so a row that is not open is opened first. Both happen on
 * the one click: the switch is synchronous, so by the time the rename or the confirm is answered,
 * the socket already belongs to the row that was pointed at.
 */
const editing = ref(false)
const draft = ref('')

function startEditing(t: Thread): void {
  if (t.id !== props.current) {
    emit('open', t.id)
  }
  draft.value = t.title || t.id
  editing.value = true
}

function askRemove(t: Thread): void {
  if (t.id !== props.current) {
    emit('open', t.id)
  }
  emit('remove')
}

function commit(): void {
  if (!editing.value) {
    return
  }
  editing.value = false
  if (draft.value.trim()) {
    emit('rename', draft.value)
  }
}
</script>

<template>
  <aside class="flex w-56 shrink-0 flex-col border-r">
    <div class="p-2">
      <Button variant="outline" class="w-full justify-start gap-2" @click="emit('create')">
        <PlusIcon class="size-4" />
        New chat
      </Button>
    </div>

    <ScrollArea class="min-h-0 flex-1">
      <ul class="space-y-0.5 p-2 pt-0">
        <!-- Exactly the registry: a chat started but not yet sent to is absent because it does not
             exist on the server either, and a row that vanishes if abandoned is worse than none. -->
        <li v-for="t in threads" :key="t.id" class="group relative">
          <div v-if="editing && t.id === current" class="flex items-center gap-1">
            <!-- `autofocus` rather than a ref and nextTick: a template ref inside v-for is
                 collected into an array, and this one would point at the component, not the
                 input. -->
            <Input
              v-model="draft"
              autofocus
              class="h-8 text-sm"
              @focus="($event.target as HTMLInputElement).select()"
              @blur="commit"
              @keydown.enter.prevent="commit"
              @keydown.esc.prevent="editing = false"
            />
            <!-- `mousedown.prevent` because the input's own blur would otherwise commit and unmount
                 the row before this button's click could land on anything. -->
            <Button variant="ghost" class="size-8 shrink-0 p-0" aria-label="Save name" @mousedown.prevent="commit">
              <CheckIcon class="size-4" />
            </Button>
          </div>
          <button
            v-else
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-14 text-left text-sm hover:bg-accent"
            :class="t.id === current && 'bg-accent font-medium'"
            :title="t.title || t.id"
            @click="emit('open', t.id)"
            @dblclick="startEditing(t)"
          >
            <Loader v-if="busy && t.id === current" class="size-3 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ t.title || t.id }}</span>
          </button>
          <!-- Both stay out of reach until the row is deliberately pointed at — deleting clears a
               conversation for good; focus-visible keeps them reachable without a mouse. -->
          <div
            v-if="!(editing && t.id === current)"
            class="-translate-y-1/2 absolute top-1/2 right-1 flex opacity-0 focus-within:opacity-100 group-hover:opacity-100"
          >
            <Button
              variant="ghost"
              class="size-6 p-0"
              :aria-label="`Rename ${t.title || t.id}`"
              @click="startEditing(t)"
            >
              <PencilIcon class="size-3.5" />
            </Button>
            <Button variant="ghost" class="size-6 p-0" :aria-label="`Delete ${t.title || t.id}`" @click="askRemove(t)">
              <Trash2Icon class="size-3.5" />
            </Button>
          </div>
        </li>
      </ul>
    </ScrollArea>
  </aside>
</template>
