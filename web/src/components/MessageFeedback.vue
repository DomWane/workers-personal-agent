<script setup lang="ts">
import { ref } from 'vue'
import { ThumbsDownIcon, ThumbsUpIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * `rate` is a prop rather than an emit because the answer matters: the icon is drawn the moment it
 * is clicked, so a refused call has to be able to take it back. `false` is that refusal — the toast
 * has already said why.
 */
const props = defineProps<{
  messageId: string
  rate: (id: string, rating: 'up' | 'down' | 'none', note?: string) => Promise<boolean>
}>()

/**
 * Kept here rather than read back from the server: the rating lands in the thread's archive, which
 * is deliberately not part of broadcast state, so the only thing the UI can honestly show is what
 * this session did. A reload forgetting the icon is better than state that pretends to be the record.
 */
const chosen = ref<'up' | 'down' | null>(null)
/** A thumbs-down without a note tells the nightly pass that something was wrong but not what, so
 *  the note is offered — and only on the rating that has something to explain. */
const noting = ref(false)
const note = ref('')

/** Draws the choice first and undraws it if the server refuses — the toast says why. */
async function send(rating: 'up' | 'down' | 'none', note?: string): Promise<void> {
  const previous = chosen.value
  chosen.value = rating === 'none' ? null : rating
  if (!(await props.rate(props.messageId, rating, note))) {
    chosen.value = previous
  }
}

function pick(rating: 'up' | 'down'): void {
  if (chosen.value) {
    return
  }
  if (rating === 'down') {
    noting.value = true
    return
  }
  void send('up')
}

/** Sent on the way out whatever happens — blur included — so clicking away records the judgement
 *  rather than losing it. The note is the optional half; the rating is not. */
function commit(): void {
  if (!noting.value) {
    return
  }
  noting.value = false
  void send('down', note.value.trim() || undefined)
}

/** Withdrawing is a rating of its own, not an erasure: the archive is append-only, so this appends
 *  `none` and a reader takes the last row for the message. */
const undo = () => void send('none')
</script>

<template>
  <div
    class="mt-1 flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
    :class="(chosen || noting) && 'opacity-100'"
  >
    <!-- Once rated, only the choice is left. Keeping both as disabled buttons halves their contrast
         and the two icons read as one greyed pair: the answer to "what did I say" disappears. -->
    <Button
      v-if="chosen"
      type="button"
      size="sm"
      variant="ghost"
      class="size-7 p-0 text-foreground"
      :aria-label="chosen === 'up' ? 'Undo good answer' : 'Undo bad answer'"
      :title="`You marked this ${chosen === 'up' ? 'a good' : 'a bad'} answer. Click to take it back.`"
      @click="undo"
    >
      <component :is="chosen === 'up' ? ThumbsUpIcon : ThumbsDownIcon" class="size-3.5" />
    </Button>

    <template v-else-if="!noting">
      <Button
        v-for="r in ['up', 'down'] as const"
        :key="r"
        type="button"
        size="sm"
        variant="ghost"
        class="size-7 p-0 text-muted-foreground"
        :aria-label="r === 'up' ? 'Good answer' : 'Bad answer'"
        :title="r === 'up' ? 'Good answer' : 'Bad answer. The nightly pass may use this as evidence.'"
        @click="pick(r)"
      >
        <component :is="r === 'up' ? ThumbsUpIcon : ThumbsDownIcon" class="size-3.5" />
      </Button>
    </template>

    <!-- `autofocus` rather than a ref: this lives inside a v-for over messages, where a template
         ref collects into an array and would point at the component, not the input. -->
    <Input
      v-else
      v-model="note"
      autofocus
      class="h-7 max-w-80 text-xs"
      placeholder="What was wrong? Optional, Enter saves"
      aria-label="What was wrong with this answer"
      @blur="commit"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="commit"
    />
  </div>
</template>
