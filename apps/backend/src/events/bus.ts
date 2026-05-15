// In-process pub/sub for live updates. Backend modules (sync runner,
// auto-trip sites, admin endpoints) publish typed events; the SSE route
// at `/api/live` subscribes and forwards to connected browsers.
//
// Strictly in-process and stateless: events fire-and-forget, no replay,
// no persistence. If we ever run multi-instance the bus becomes a Redis
// pub/sub wrapper instead — but for single-instance deploys this is the
// right shape: zero deps, sub-millisecond publish, no infrastructure
// to manage.

import type { SyncTrigger } from '../sync/runner.js';

// One discriminated union for every event the backend can emit. The
// frontend mirrors this shape over the SSE wire (`event: <name>` +
// `data: <json>`). Adding a new event = add a variant here and a
// publish() call somewhere upstream.
//
// Payloads are intentionally slim. The runner's internal result types
// (CommitsSyncResult, PrsSyncResult) carry per-repo arrays that can
// inflate to hundreds of KB on busy ticks — too large for SSE
// transport without triggering backpressure / TLS connection death.
// Publishers transform their full result into the summary shape
// below before calling `bus.publish`.
export type LiveEvent =
  | { event: 'tick.commits.complete'; payload: TickCommitsCompletePayload }
  | { event: 'tick.prs.complete'; payload: TickPrsCompletePayload }
  | { event: 'repository.sync-excluded'; payload: RepositoryExcludedPayload }
  | { event: 'repository.included'; payload: RepositoryIncludedPayload }
  | { event: 'repository.deleted'; payload: RepositoryDeletedPayload };

// Slim summary published at the end of `runCommitsSync`. Frontend
// consumers use this to invalidate cached aggregates ("re-fetch
// yourself"); they don't need per-repo detail, which is available
// via the regular dashboard read endpoints anyway.
export interface TickCommitsCompletePayload {
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string;
  attempted: number;
  deferred: number;
  errors: number;
  totalCommitsInserted: number;
  budgetRemainingAtEnd: number;
  stoppedEarly: boolean;
  // Inner-tick stop reasons — null when the step wasn't wired or
  // drained cleanly. Frontend uses these to surface health: rate-
  // limited / budget-gated states warrant a small banner.
  deepenStoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete' | null;
  isMergeBackfillStoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete' | null;
  diffStatsBackfillStopReason: 'budget' | 'rate-limited' | null;
  diffStatsBackfillTotalUpdated: number;
}

export interface TickPrsCompletePayload {
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string;
  attempted: number;
  deferred: number;
  errors: number;
  totalPrsInserted: number;
  totalPrsUpdated: number;
  budgetRemainingAtEnd: number;
  stoppedEarly: boolean;
}

export type LiveEventName = LiveEvent['event'];

export interface RepositoryExcludedPayload {
  repositoryId: number;
  fullName: string;
  reason: 'repo-404' | 'history-rewritten' | 'empty-on-bitbucket';
}

export interface RepositoryIncludedPayload {
  repositoryId: number;
  fullName: string;
  // What changed: re-included from exclusion, or a rename also happened.
  // Frontend uses this to decide whether to re-fetch repo metadata or
  // just patch the sync-state badge.
  source: 'include' | 'rename';
}

export interface RepositoryDeletedPayload {
  repositoryId: number;
  fullName: string;
}

export type Subscriber = (event: LiveEvent) => void;

export interface EventBus {
  subscribe(subscriber: Subscriber): () => void;
  publish(event: LiveEvent): void;
  // Test / observability helper — does NOT include subscribers added by
  // long-running connections in production; the value is observational.
  subscriberCount(): number;
}

export function createEventBus(): EventBus {
  const subscribers = new Set<Subscriber>();
  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    publish(event) {
      // Snapshot the set before iterating so an unsubscribe inside one
      // handler (e.g., a connection that closes on event receive) doesn't
      // mutate the iteration. Cheap — set sizes are bounded by active
      // browser tabs.
      for (const s of [...subscribers]) {
        try {
          s(event);
        } catch {
          // A subscriber throwing must never block the publish loop for
          // other subscribers. SSE route impls swallow their own errors
          // internally; this catch is a last-resort safety net.
        }
      }
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}
