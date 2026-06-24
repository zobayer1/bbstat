// Live updates: EventSource wrapper + typed event bus + low-cadence polling
// fallback. One EventSource per browser tab, mounted at App.vue. Subscriptions
// register via `liveBus.on(...)` and persist for the app lifetime.
//
// Backend protocol: GET /api/live (SSE), frames `event: <name>\ndata: <json>\n\n`.
// See apps/backend/src/routes/live.ts (wire format) + events/bus.ts (catalog).
//
// Polling fallback: when no event arrives in POLL_FALLBACK_MS, the bus emits a
// synthetic fallback signal so stores re-fetch as if a tick landed. Fires on
// stale push regardless of connection state — covers SSE drops, NAT idle
// timeouts, and proxy disconnects without per-store retry logic.

import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import type { LiveEventMap, LiveEventName } from '@/api/client';

// Matches the backend commits cron cadence, so a healthy push emits
// tick.commits.complete before this fires — polling stays idle when SSE works.
const POLL_FALLBACK_MS = 5 * 60 * 1000;
// Check more often than the threshold to bound fallback latency (cheap).
const POLL_CHECK_MS = 30 * 1000;

export type LiveConnectionState = 'connecting' | 'open' | 'closed';

// Typed pub/sub for live events. The extra fallback channel fires
// synthetically when SSE has been stale beyond POLL_FALLBACK_MS.
type Handler<P> = (payload: P) => void;
type FallbackHandler = () => void;

class LiveEventBus {
  private handlers = new Map<LiveEventName, Set<Handler<unknown>>>();
  private fallbackHandlers = new Set<FallbackHandler>();

  on<E extends LiveEventName>(event: E, handler: Handler<LiveEventMap[E]>): () => void {
    let bucket = this.handlers.get(event);
    if (bucket === undefined) {
      bucket = new Set();
      this.handlers.set(event, bucket);
    }
    bucket.add(handler as Handler<unknown>);
    return () => {
      bucket?.delete(handler as Handler<unknown>);
    };
  }

  onFallback(handler: FallbackHandler): () => void {
    this.fallbackHandlers.add(handler);
    return () => {
      this.fallbackHandlers.delete(handler);
    };
  }

  emit<E extends LiveEventName>(event: E, payload: LiveEventMap[E]): void {
    const bucket = this.handlers.get(event);
    if (bucket === undefined) return;
    // Snapshot before iterating: handlers may unsubscribe during dispatch
    // (e.g., a one-shot handler) and we don't want to mutate the live set.
    for (const h of [...bucket]) {
      try {
        h(payload);
      } catch (err) {
        // Isolate: a broken handler must not block the rest.
        console.warn('liveBus: handler threw', err);
      }
    }
  }

  emitFallback(): void {
    for (const h of [...this.fallbackHandlers]) {
      try {
        h();
      } catch (err) {
        console.warn('liveBus: fallback handler threw', err);
      }
    }
  }

  // Test-only: tear down every handler. Each fresh Pinia re-runs the store
  // setup factory and would otherwise pile up dangling handlers across test
  // cases. Call in beforeEach.
  clear(): void {
    this.handlers.clear();
    this.fallbackHandlers.clear();
  }
}

// Single global instance — one per browser tab.
export const liveBus = new LiveEventBus();

// All event names the backend emits. Keep in sync with LiveEventMap in
// api/client.ts.
const EVENT_NAMES: readonly LiveEventName[] = [
  'tick.commits.complete',
  'tick.prs.complete',
  'repository.sync-excluded',
  'repository.included',
  'repository.deleted',
  'bitbucket.auth-state',
  'person.created',
  'person.updated',
  'person.attached',
  'person.detached',
  'person.primary-changed',
  'person.dissolved',
] as const;

export interface LiveStreamHandle {
  connectionState: Ref<LiveConnectionState>;
}

// Mount at App.vue level. Opens the EventSource, wires the polling fallback,
// exposes `connectionState` for any UI surface (e.g. the reconnect pill).
export function useLiveStream(): LiveStreamHandle {
  const connectionState = ref<LiveConnectionState>('connecting');
  let eventSource: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Wall-clock of the last activity (event arrival OR open); the poll-check
  // loop uses it to decide when push has gone stale.
  let lastActivityMs = Date.now();

  function recordActivity(): void {
    lastActivityMs = Date.now();
  }

  function open(): void {
    // Dev runs the frontend (:5173) cross-origin to the backend (:8443), so
    // VITE_API_BASE_URL (baked at build time) gives the absolute URL.
    // Production leaves it empty so the EventSource hits the same origin.
    const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
    eventSource = new EventSource(`${baseUrl}/api/live`);
    eventSource.onopen = () => {
      connectionState.value = 'open';
      recordActivity();
    };
    eventSource.onerror = () => {
      // EventSource auto-reconnects per the backend's `retry: 5000` — just
      // surface the in-flight state.
      connectionState.value = 'connecting';
    };
    // One listener per event name: EventSource dispatch is keyed by the
    // `event:` line, so without explicit listeners frames land on the
    // default 'message' channel instead.
    for (const name of EVENT_NAMES) {
      eventSource.addEventListener(name, ((e: Event) => {
        const msg = e as MessageEvent;
        recordActivity();
        try {
          const payload = JSON.parse(msg.data) as LiveEventMap[typeof name];
          liveBus.emit(name, payload);
        } catch (err) {
          console.warn('liveBus: malformed event frame', name, err);
        }
      }) as EventListener);
    }
  }

  function close(): void {
    eventSource?.close();
    eventSource = null;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    connectionState.value = 'closed';
  }

  function startPolling(): void {
    pollTimer = setInterval(() => {
      if (Date.now() - lastActivityMs >= POLL_FALLBACK_MS) {
        liveBus.emitFallback();
        recordActivity();
      }
    }, POLL_CHECK_MS);
  }

  onMounted(() => {
    open();
    startPolling();
  });
  onUnmounted(close);

  return { connectionState };
}
