<script setup lang="ts">
// Root component. Mounts the live-updates EventSource and renders the global
// footer (contact + last-sync) + reconnect indicator below every route.
import { computed, onMounted } from 'vue';
import { RouterView } from 'vue-router';
import LiveStatusPill from '@/components/LiveStatusPill.vue';
import { useLiveStream } from '@/lib/live';
import { useStatsStore } from '@/stores/stats';

const { connectionState } = useLiveStream();
const stats = useStatsStore();

// Baked at build time by Vite.
const contactEmail = import.meta.env.VITE_CONTACT_EMAIL ?? '';

const lastSyncLabel = computed(() => {
  if (stats.loading) return 'Refreshing…';
  if (!stats.lastSyncedAt) return 'Last synced: never';
  return `Last synced: ${new Date(stats.lastSyncedAt).toLocaleString()}`;
});

// Fetch the BB auth flag once per page-load so the footer indicator is correct
// on every route, not just Dashboard. SSE pushes subsequent transitions.
onMounted(() => {
  void stats.fetchBitbucketAuthState();
});
</script>

<template>
  <RouterView />
  <!-- Mirrors the route pages' max-w-6xl + px-6 so it aligns with their
       main column. -->
  <footer class="mx-auto max-w-6xl px-6 pb-6">
    <div
      class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 text-xs text-slate-400"
    >
      <a v-if="contactEmail" :href="`mailto:${contactEmail}`" class="transition hover:text-slate-600">
        Contact: {{ contactEmail }}
      </a>
      <span v-else aria-hidden="true" />
      <span
        :class="stats.bitbucketAuthState === 'unauthorized' ? 'text-red-600' : ''"
        :title="
          stats.bitbucketAuthState === 'unauthorized'
            ? 'BitBucket auth failed — sync is not progressing. The next successful call clears this.'
            : undefined
        "
        >{{ lastSyncLabel }}</span
      >
    </div>
  </footer>
  <!-- Fixed so it doesn't reflow page content as it appears/disappears.
       Hidden entirely in the steady state (state==='open'). -->
  <div class="pointer-events-none fixed bottom-3 right-3 z-40">
    <LiveStatusPill :state="connectionState" />
  </div>
</template>
