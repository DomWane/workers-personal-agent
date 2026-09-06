<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { Loader } from '@/components/ai-elements/loader'
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai-elements/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useMediaQuery, useStorage } from '@vueuse/core'
import { ChevronDownIcon } from '@lucide/vue'
import ContextMeter from '@/components/ContextMeter.vue'
import MessageFeedback from '@/components/MessageFeedback.vue'
import ModelPicker from '@/components/ModelPicker.vue'
import ModePicker from '@/components/ModePicker.vue'
import ThemePicker from '@/components/ThemePicker.vue'
import ThreadSidebar from '@/components/ThreadSidebar.vue'
import Toaster from '@/components/Toaster.vue'
import ResearchProposal from '@/components/ResearchProposal.vue'
import ResearchRunning from '@/components/ResearchRunning.vue'
import ResearchReport from '@/components/ResearchReport.vue'
import { contextUsage, formatTokens, spoken, wouldCompact } from '@/lib/context'
import { toolSummary } from '@/lib/tools'
import { useAgent } from '@/useAgent'
import { LANDING, useThreads } from '@/useThreads'
import type { ChatMode, ModelRow } from '@/types'

const { threads, current, closed, open, create, refresh } = useThreads()
const {
  state,
  connected,
  say,
  setModel,
  research: run,
  deleteThread,
  renameThread,
  compactNow,
  rateMessage,
} = useAgent(current, closed)

async function rename(title: string): Promise<void> {
  if (await renameThread(title)) {
    await refresh()
  }
}

/** Deleting is the one irreversible thing in this UI — the history goes and the vault row with it —
 *  and it sits under a hover-revealed icon, which is exactly where a misclick happens. */
const confirming = ref(false)
const currentTitle = computed(() => threads.value.find((t) => t.id === current.value)?.title || current.value)

/** Only the open thread can be deleted — the RPC runs on its own instance — so this needs no
 *  cross-thread case, and cannot race the socket swap that switching one would start. Navigating
 *  away is conditional: a delete that failed leaves a thread that still has something to show. */
async function remove(): Promise<void> {
  confirming.value = false
  if (!(await deleteThread())) {
    return
  }
  await refresh()
  open(threads.value[0]?.id ?? LANDING)
}

const catalogue = ref<ModelRow[]>([])
const deploymentModel = ref('')

const currentModel = computed(() => state.value.modelOverride ?? deploymentModel.value)
const windowOf = (id: string) => catalogue.value.find((m) => m.id === id)?.context
const currentWindow = computed(() => windowOf(currentModel.value))

/**
 * A model is picked, and switching to a smaller window can put an already-fine conversation over
 * the new one. Asked here rather than left to the server, because only the browser holds the
 * catalogue and so only it knows the window of a model the server has never run.
 *
 * Cancelling leaves the model alone: the alternative — switch now, compact at the next message —
 * only moves the same compaction one message later, without asking.
 */
const pendingModel = ref<string | null>(null)

function pickModel(id: string): void {
  if (wouldCompact(contextUsage(state.value).tokens, windowOf(id))) {
    pendingModel.value = id
    return
  }
  void switchModel(id)
}

/** `compact` is what the dialog was answered with. The switch alone would schedule a compaction
 *  only when the conversation is over the *conservative default* window — the new model's own is
 *  not known server-side yet — so a small-window model needs the compaction asked for outright,
 *  or the dialog promises a fold that does not happen until the next message overflows. */
async function switchModel(id: string, compact = false): Promise<void> {
  pendingModel.value = null
  await setModel(id === deploymentModel.value ? null : id)
  if (compact) {
    await compactNow()
  }
}

void fetch('/api/models')
  .then((res) => res.json() as Promise<{ current: string; models: ModelRow[] }>)
  .then((payload) => {
    deploymentModel.value = payload.current
    catalogue.value = payload.models
  })
  .catch(() => {})

const mode = ref<ChatMode>('chat')

/**
 * Research mode proposes a plan rather than starting a run — a run costs minutes and hundreds of
 * requests, so it stays behind a confirmation even when the mode says the user meant it. The mode
 * then falls back, because the proposal's own buttons carry the conversation from there.
 *
 * Sending from the landing starts a chat rather than talking to it: `main` is where you are when no
 * thread is open, and a message has to belong to one. `create()` is synchronous, so the call below
 * already goes to the new thread's instance — and it is that call which writes the registry row,
 * which is why the list is re-read after it rather than after a timer long enough to usually be right.
 */
async function onSubmit(message: PromptInputMessage): Promise<void> {
  const text = message.text.trim()
  if (!text) {
    return
  }
  // A slash word still names a skill, and a skill is asked for in a turn, not proposed as a run.
  const asResearch = mode.value === 'research' && !text.startsWith('/')
  if (asResearch) {
    mode.value = 'chat'
  }
  // The landing is its own Durable Object, so a model picked there was written to it and not to
  // the thread this message is about to create. Carried over by hand, or the first turn runs on
  // the deployment default and the pick reads as ignored.
  const picked = current.value === LANDING ? state.value.modelOverride : undefined
  if (current.value === LANDING) {
    create()
  }
  if (picked) {
    await setModel(picked)
  }
  await (asResearch ? run.propose(text) : say(text))
  await refresh()
}

/** The split is only a split on a wide screen; below that the report goes under the thread, where
 *  dragging a vertical divider would fight the page's own scrolling. */
const wide = useMediaQuery('(min-width: 1024px)')

/** Remembered across reloads: a report is read over several sittings, and re-dragging the divider
 *  every time is the kind of small friction that makes a panel feel disposable. */
const split = useStorage('report-split', 60)

function rememberSplit(sizes: number[]) {
  if (wide.value && showReport.value && sizes.length > 1) {
    split.value = Math.round(sizes[0])
  }
}

const thread = computed(() => spoken(state.value.messages))

const research = computed(() => state.value.research)
/** A turn being answered, a plan being written, or a run working through its rounds — all of it is
 *  this thread doing something the user did not have to wait in front of. */
const busy = computed(() => !!state.value.status || research.value?.phase === 'running')
const showReport = computed(() => research.value?.phase === 'done' && !!research.value.report)
</script>

<template>
  <!-- Instead of the chat, not over it: with the Worker refusing there is nothing behind this to
       go back to, and a dismissable overlay would leave a dead app underneath. -->
  <div v-if="closed" class="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
    <div class="max-w-md space-y-3 text-center">
      <h1 class="text-lg font-medium">This agent is closed</h1>
      <p class="whitespace-pre-line text-left text-sm text-muted-foreground">{{ closed }}</p>
      <Button variant="outline" size="sm" @click="refresh"> Try again </Button>
    </div>
  </div>

  <div v-else class="flex h-dvh bg-background text-foreground">
    <Toaster />
    <ThreadSidebar
      :threads="threads"
      :busy="busy"
      :current="current"
      class="hidden md:flex"
      @open="open"
      @create="create"
      @remove="confirming = true"
      @rename="rename"
    />

    <Dialog v-model:open="confirming">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription> “{{ currentTitle }}” and everything in it goes for good. </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirming = false"> Cancel </Button>
          <Button variant="destructive" @click="remove"> Delete </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="pendingModel !== null" @update:open="pendingModel = null">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Compact this chat to switch?</DialogTitle>
          <DialogDescription>
            This conversation is {{ formatTokens(contextUsage(state).tokens) }} tokens and {{ pendingModel }} holds
            {{ formatTokens(windowOf(pendingModel ?? '') ?? 0) }}. The earlier turns become a summary; they stay
            readable in full.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="pendingModel = null"> Cancel </Button>
          <Button @click="switchModel(pendingModel ?? '', true)"> Switch and compact </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b px-4 py-3">
        <h1 class="font-semibold text-sm">Personal Agent</h1>
        <span
          class="size-2 rounded-full"
          :class="connected ? 'bg-green-500' : 'bg-muted-foreground'"
          :title="connected ? 'Connected' : 'Disconnected'"
        />
        <div class="ml-auto flex items-center gap-2">
          <ThemePicker />
        </div>
      </header>

      <ResizablePanelGroup
        :key="wide && showReport ? 'split' : 'stacked'"
        :direction="wide && showReport ? 'horizontal' : 'vertical'"
        class="min-h-0 flex-1 gap-0 p-4"
        @layout="rememberSplit"
      >
        <ResizablePanel :default-size="wide && showReport ? split : 100" :min-size="25" class="flex min-h-0 flex-col">
          <Conversation class="min-h-0 flex-1">
            <ConversationContent>
              <Collapsible v-if="state.historySummary" class="rounded-md border px-3 py-2 text-xs">
                <CollapsibleTrigger class="flex w-full items-center justify-between gap-2 text-muted-foreground">
                  Earlier conversation
                  <ChevronDownIcon class="size-3.5" />
                </CollapsibleTrigger>
                <CollapsibleContent class="pt-2 text-muted-foreground">
                  {{ state.historySummary }}
                </CollapsibleContent>
              </Collapsible>

              <ConversationEmptyState
                v-if="!thread.length"
                title="Nothing here yet"
                description="Ask anything. Switch the composer to Deep research for a multi-round run."
              />

              <Message v-for="(m, i) in thread" :key="m.id ?? i" :from="m.role" class="group">
                <MessageContent>
                  <MessageResponse :content="m.content" />
                  <Tool v-if="m.role === 'assistant' && m.tools?.length">
                    <ToolHeader
                      type="dynamic-tool"
                      :tool-name="'tools'"
                      state="output-available"
                      :title="`used ${toolSummary(m.tools)}`"
                    />
                    <ToolContent>
                      <ToolOutput :output="m.tools.join('\n')" :error-text="undefined" />
                    </ToolContent>
                  </Tool>
                  <!-- What the answer cost, where the answer is — the meter above it prices the
                     next request instead, and the two are different questions. Absent rather than
                     zero when the provider reported no usage: see `stage: 'unmetered'`. -->
                  <span
                    v-if="m.role === 'assistant' && m.tokens"
                    class="text-muted-foreground text-xs tabular-nums"
                    :title="`${m.tokens.toLocaleString()} tokens in and out, counted by the provider`"
                  >
                    {{ formatTokens(m.tokens) }} tokens
                  </span>
                  <!-- Only on answers that can be pointed at: a rating is evidence for the nightly
                     pass, and one that names no message is not evidence at all. -->
                  <MessageFeedback v-if="m.role === 'assistant' && m.id" :message-id="m.id" :rate="rateMessage" />
                </MessageContent>
              </Message>

              <div v-if="state.status" class="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader :size="16" />
                {{ state.status === 'compacting' ? 'Folding the earlier turns into a summary…' : 'Thinking…' }}
              </div>

              <ResearchProposal
                v-if="research?.phase === 'proposed'"
                :research="research"
                @start="run.start"
                @stop="run.stop"
                @revise="run.revise"
              />
              <ResearchRunning v-else-if="research?.phase === 'running'" :research="research" @stop="run.stop" />
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <!-- No PromptInputBody: it wraps its children in a `display:contents` div, and InputGroup
             switches to a column with `has-[>[data-align=block-end]]`, a direct-child selector the
             wrapper defeats — the textarea ends up one character wide. -->
          <PromptInput class="mt-3" @submit="onSubmit">
            <PromptInputTextarea :placeholder="mode === 'research' ? 'What should I research?' : 'Message the agent'" />
            <PromptInputFooter>
              <PromptInputTools class="ml-auto">
                <ContextMeter :state="state" :window="currentWindow" @compact="compactNow" />
                <ModePicker v-model="mode" />
                <ModelPicker
                  :catalogue="catalogue"
                  :deployment-model="deploymentModel"
                  :override="state.modelOverride"
                  compact
                  @select="pickModel"
                />
              </PromptInputTools>
              <PromptInputSubmit :status="state.status === 'thinking' ? 'submitted' : undefined" />
            </PromptInputFooter>
          </PromptInput>
        </ResizablePanel>

        <template v-if="showReport && research">
          <ResizableHandle
            with-handle
            class="mx-3 my-0 data-[orientation=vertical]:mx-0 data-[orientation=vertical]:my-3"
          />
          <!-- Collapsible rather than closable: dismissing the report and ending the run were one
               gesture, so "I do not want this on screen" destroyed it. Dragging past `min-size`
               folds it to a rail, and the rail is what opens it again — no button anywhere else,
               and nothing that can disagree with the state. -->
          <ResizablePanel
            v-slot="{ isCollapsed, collapse, expand }"
            :default-size="100 - split"
            :min-size="20"
            collapsible
            :collapsed-size="3"
            class="flex min-h-0"
          >
            <button
              v-if="isCollapsed"
              class="flex h-full w-full items-center justify-center text-muted-foreground hover:text-foreground"
              :title="`Open the report on ${research.topic}`"
              @click="expand()"
            >
              <!-- Sideways only where the rail is a column. Below `lg` the group stacks, so the
                   collapsed panel is a thin horizontal band and vertical text would not fit it. -->
              <span class="text-xs lg:[writing-mode:vertical-rl] lg:rotate-180">Report</span>
            </button>
            <ResearchReport
              v-else
              :research="research"
              class="min-h-0 flex-1"
              @save="run.save"
              @stop="run.stop"
              @collapse="collapse()"
            />
          </ResizablePanel>
        </template>
      </ResizablePanelGroup>
    </div>
  </div>
</template>
