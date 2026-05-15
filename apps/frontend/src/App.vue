<script setup lang="ts">
// Root component. Mounts the live-updates EventSource (one per browser
// tab) and renders a small reconnect indicator that's hidden while the
// stream is healthy. The actual route content sits inside <RouterView>.
import { RouterView } from 'vue-router';
import LiveStatusPill from '@/components/LiveStatusPill.vue';
import { useLiveStream } from '@/lib/live';

const { connectionState } = useLiveStream();
</script>

<template>
  <RouterView />
  <!-- Fixed in the bottom-right so it doesn't reflow page content
       when it appears/disappears. Hidden entirely when state==='open',
       which is the steady state. -->
  <div class="pointer-events-none fixed bottom-3 right-3 z-40">
    <LiveStatusPill :state="connectionState" />
  </div>
</template>
