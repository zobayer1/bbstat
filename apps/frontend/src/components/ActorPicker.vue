<script setup lang="ts">
// Phase 5 — shared activity-actor picker. A searchable combobox backed
// by the Members store (the full person-aware roster: merged persons +
// unattached users, persisted in Pinia and rarely changing). Shows the
// top-N entities by default; typing fuzzy-searches the whole roster so a
// contributor outside the top-N is still reachable. Emits an
// ActivityActor — selecting a person filters the activity feed across
// all its aliases (resolved server-side). Used by the Dashboard,
// Activity, Projects, Project-detail, and Repo-detail actor filters in
// place of the old per-page <select> dropdowns.
import { computed, onMounted, ref, watch } from 'vue';
import Fuse from 'fuse.js';
import { useMembersStore } from '@/stores/members';
import type { ActivityActor, WorkspaceMember } from '@/api/client';

const props = defineProps<{
  modelValue?: ActivityActor;
  // Forwarded to the input for <label for> association.
  id?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: ActivityActor | undefined] }>();

const members = useMembersStore();
onMounted(() => {
  // The roster rarely changes and is persisted, so this is usually a
  // no-op; fetch only when the store is cold (deep-linked into a page
  // that didn't already hydrate it).
  if (members.members.length === 0) void members.fetch();
});

const TOP_N = 10;
// `query` is the literal text in the input. It doubles as the display
// value: when a selection is active and the user isn't mid-edit it holds
// the selected entity's name (real, editable text — not a placeholder),
// and while searching it holds whatever they've typed.
const query = ref('');
const open = ref(false);
const focused = ref(false);

// Tighter than the Members-page table search (which is 0.4): a dropdown
// surfaces fewer rows, so loose matches read as noise (`Zob` shouldn't
// rank Apu / Sazibul). Lower threshold + minMatchCharLength prunes the
// long tail; weighting displayName above username and email far above
// it keeps a name query from being outranked by an incidental
// email-substring hit.
const fuse = computed(
  () =>
    new Fuse(members.members, {
      keys: [
        { name: 'displayName', weight: 3 },
        { name: 'username', weight: 1 },
        { name: 'email', weight: 0.3 },
        // Every linked alias's name/username/email so a merged person is
        // findable by a non-primary account too (low weight — the
        // displayed identity should still rank first).
        { name: 'aliasSearch', weight: 0.5 },
      ],
      threshold: 0.3,
      ignoreLocation: true,
      minMatchCharLength: 2,
    }),
);

// Label for the current selection — resolved from the roster so a person
// shows its canonical display name. Falls back if the roster hasn't
// loaded yet or the entity dropped out (e.g. dissolved while selected).
const selectedLabel = computed(() => {
  const v = props.modelValue;
  if (v === undefined) return '';
  const m = members.members.find((x) => x.entityKind === v.kind && x.entityId === v.id);
  return m?.displayName ?? `${v.kind} #${v.id}`;
});

// Mirror the selection into the input whenever it changes externally
// (initial deep-link, URL navigation, roster finishing its async load).
// Skip while the user is mid-edit so we don't clobber their typing.
watch(
  selectedLabel,
  (label) => {
    if (!focused.value) query.value = label;
  },
  { immediate: true },
);

const options = computed<WorkspaceMember[]>(() => {
  const q = query.value.trim();
  // Empty box → browse the top-N. Otherwise always fuzzy-match the
  // current text, including when it still holds the selected name — so
  // clicking into a filled box filters consistently with editing it
  // (no top-N-vs-fuzzy split between click and the first backspace).
  if (q.length === 0) return members.members.slice(0, TOP_N);
  return fuse.value
    .search(q)
    .slice(0, 25)
    .map((r) => r.item);
});

function select(m: WorkspaceMember): void {
  emit('update:modelValue', { kind: m.entityKind, id: m.entityId });
  // Show the picked name immediately (the watcher is skipped while the
  // input still holds focus after a mousedown-select).
  query.value = m.displayName;
  open.value = false;
}

function clear(): void {
  emit('update:modelValue', undefined);
  query.value = '';
  open.value = false;
}

// Delay close so a mousedown on an option registers before blur fires.
let blurTimer: ReturnType<typeof setTimeout> | null = null;
function onBlur(): void {
  blurTimer = setTimeout(() => {
    focused.value = false;
    open.value = false;
    // Revert a half-typed, unselected search back to the current
    // selection so the box never shows orphan text.
    query.value = selectedLabel.value;
  }, 120);
}
function onFocus(): void {
  if (blurTimer !== null) clearTimeout(blurTimer);
  focused.value = true;
  open.value = true;
}
// Clicking an already-focused input doesn't refire @focus, so open here
// too — this is the case the user hit (re-click → dropdown didn't show).
function onClick(): void {
  open.value = true;
}
</script>

<template>
  <div class="relative inline-block">
    <!-- No inline clear button by design — the dropdown's "All
         contributors" row resets the filter, and the surrounding pages
         carry their own Clear control. -->
    <input
      :id="id"
      v-model="query"
      type="text"
      role="combobox"
      :aria-expanded="open"
      aria-autocomplete="list"
      autocomplete="off"
      placeholder="All"
      :class="[
        'w-44 rounded border border-slate-200 bg-white px-2 py-1 text-slate-900',
        modelValue && !focused ? 'font-medium' : '',
      ]"
      @focus="onFocus"
      @blur="onBlur"
      @click="onClick"
      @input="open = true"
    />

    <ul
      v-if="open"
      class="absolute z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
      role="listbox"
    >
      <li>
        <button
          type="button"
          class="block w-full px-3 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-50"
          @mousedown.prevent="clear"
        >
          All contributors
        </button>
      </li>
      <li v-for="m in options" :key="`${m.entityKind}:${m.entityId}`">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
          :class="
            modelValue && modelValue.kind === m.entityKind && modelValue.id === m.entityId
              ? 'bg-slate-50 font-medium text-slate-900'
              : 'text-slate-700'
          "
          @mousedown.prevent="select(m)"
        >
          <span class="truncate">{{ m.displayName }}</span>
          <span
            v-if="m.entityKind === 'person' && m.attachedUserIds.length > 1"
            class="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
            :title="`Merged from ${m.attachedUserIds.length} accounts — filters all of them`"
          >
            ×{{ m.attachedUserIds.length }}
          </span>
        </button>
      </li>
      <li v-if="options.length === 0" class="px-3 py-2 text-sm text-slate-400">No matches.</li>
    </ul>
  </div>
</template>
