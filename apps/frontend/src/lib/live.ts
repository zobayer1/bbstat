// Live updates: EventSource wrapper + typed event bus + low-cadence
// polling fallback. One EventSource per browser tab, mounted at
// App.vue. Per-store handlers register via `liveBus.on(...)` at first
// store use; subscriptions persist for the app lifetime.
//
// Backend protocol: GET /api/live (Server-Sent Events). Each frame is
// `event: <name>\ndata: <json>\n\n`. See apps/backend/src/routes/live.ts
// for the wire format and apps/backend/src/events/bus.ts for the event
// catalog. Frontend mirrors the slim payloads in api/client.ts.
//
// Polling fallback: when no event has arrived in `POLL_FALLBACK_MS`
// (default 5 min), the bus emits a synthetic 'fallback.poll' signal so
// stores can re-fetch as if a tick had landed. Fires whenever push is
// stale regardless of connection state — covers SSE drops, NAT idle
// timeouts, and proxy disconnects without needing per-store retry logic.

import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import type { LiveEventMap, LiveEventName } from '@/api/client';

// 5 minutes — matches the commits cron cadence on the backend, so a
// healthy push pipeline emits tick.commits.complete before the poll
// timer fires. When SSE works, polling is effectively idle.
const POLL_FALLBACK_MS = 5 * 60 * 1000;
// Tick the poll-check loop more often than the threshold so the
// fallback latency is bounded. Cheap: a single Date.now() compare.
const POLL_CHECK_MS = 30 * 1000;

export type LiveConnectionState = 'connecting' | 'open' | 'closed';

// Typed pub/sub for live events. Stores register handlers via `on()`;
// the EventSource pumps received frames in via internal `emit()`. The
// extra 'fallback.poll' channel fires synthetically when SSE has been
// stale beyond POLL_FALLBACK_MS — stores listen on it the same way
// they would for any backend event.
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

  // Test-only: tear down every registered handler. Pinia setup-style
  // stores register handlers on first use; in tests, each fresh Pinia
  // re-runs the setup factory and would otherwise pile up dangling
  // handlers from prior test cases. Call in beforeEach to reset.
  clear(): void {
    this.handlers.clear();
    this.fallbackHandlers.clear();
  }
}

// Single global instance — one per browser tab, shared across every
// store that wants to listen.
export const liveBus = new LiveEventBus();

// All event names the backend emits. Keep in sync with
// LiveEventMap in api/client.ts.
const EVENT_NAMES: readonly LiveEventName[] = [
  'tick.commits.complete',
  'tick.prs.complete',
  'repository.sync-excluded',
  'repository.included',
  'repository.deleted',
] as const;

export interface LiveStreamHandle {
  connectionState: Ref<LiveConnectionState>;
}

// Mount at App.vue level. Opens the EventSource, wires the polling
// fallback, exposes `connectionState` for any UI surface (e.g., the
// "reconnecting…" pill in the header) that wants to react.
export function useLiveStream(): LiveStreamHandle {
  const connectionState = ref<LiveConnectionState>('connecting');
  let eventSource: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Wall-clock of the last activity (event arrival OR open). Used by
  // the poll-check loop to decide when push has gone stale.
  let lastActivityMs = Date.now();

  function recordActivity(): void {
    lastActivityMs = Date.now();
  }

  function open(): void {
    // Mirror api/client.ts: dev environment runs the frontend at
    // :5173 and the backend at :8443, so we need the absolute URL.
    // VITE_API_BASE_URL is set in .env at the repo root and resolved
    // at build time. Production builds typically leave it empty so
    // the EventSource hits the same origin as the deployed app.
    const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';
    eventSource = new EventSource(`${baseUrl}/api/live`);
    eventSource.onopen = () => {
      connectionState.value = 'open';
      recordActivity();
    };
    eventSource.onerror = () => {
      // EventSource auto-reconnects per the backend's `retry: 5000`
      // directive — we just surface the in-flight state to any UI
      // that's watching.
      connectionState.value = 'connecting';
    };
    // Register one listener per known event name. EventSource dispatch
    // is keyed by the `event:` line in each frame; without explicit
    // listeners, frames land on the generic onmessage which is keyed
    // to the default 'message' event.
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
