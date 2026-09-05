import { ref } from 'vue'

/**
 * Where a failed RPC becomes something a person sees; before this one it left a console line and a
 * UI still claiming the rename, delete or rating had landed. Module-level because the socket layer
 * raises and the shell renders — a provider between those two is ceremony for one array.
 */
export const toasts = ref<{ id: number; text: string }[]>([])

/** Long enough to read a sentence. */
const DISMISS_MS = 10000
let next = 1

export function toast(text: string): void {
  const id = next++
  toasts.value.push({ id, text })
  setTimeout(() => dismiss(id), DISMISS_MS)
}

export function dismiss(id: number): void {
  const i = toasts.value.findIndex((t) => t.id === id)
  if (i >= 0) {
    toasts.value.splice(i, 1)
  }
}
