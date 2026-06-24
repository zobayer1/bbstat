// In-process pub/sub for live updates. Backend modules publish typed events;
// the SSE route at `/api/live` forwards them to connected browsers.
//
// Strictly in-process and stateless: fire-and-forget, no replay/persistence.
// If we ever run multi-instance this becomes a Redis pub/sub wrapper.

import type { SyncTrigger } from '../sync/runner.js';

// Discriminated union of every event the backend emits; the frontend mirrors
// this over the SSE wire (`event: <name>` + `data: <json>`).
//
// Payloads are intentionally slim. The runner's internal result types carry
// per-repo arrays that inflate to hundreds of KB on busy ticks — too large for
// SSE without triggering backpressure / TLS connection death. Publishers
// transform their full result into the summary shape below before publishing.
export type LiveEvent =
  | { event: 'tick.commits.complete'; payload: TickCommitsCompletePayload }
  | { event: 'tick.prs.complete'; payload: TickPrsCompletePayload }
  | { event: 'repository.sync-excluded'; payload: RepositoryExcludedPayload }
  | { event: 'repository.included'; payload: RepositoryIncludedPayload }
  | { event: 'repository.deleted'; payload: RepositoryDeletedPayload }
  | { event: 'bitbucket.auth-state'; payload: BitbucketAuthStatePayload }
  | { event: 'person.created'; payload: PersonCreatedPayload }
  | { event: 'person.updated'; payload: PersonUpdatedPayload }
  | { event: 'person.attached'; payload: PersonAttachedPayload }
  | { event: 'person.detached'; payload: PersonDetachedPayload }
  | { event: 'person.primary-changed'; payload: PersonPrimaryChangedPayload }
  | { event: 'person.dissolved'; payload: PersonDissolvedPayload };

// Published at the end of `runCommitsSync` — a "re-fetch yourself" signal for
// frontend cache invalidation; per-repo detail comes from the read endpoints.
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
  // Inner-tick stop reasons — null when the step wasn't wired or drained
  // cleanly. Frontend surfaces rate-limited / budget-gated states as a banner.
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
  // 'rename' means repo metadata changed (re-fetch); 'include' just flips the
  // sync-state badge.
  source: 'include' | 'rename';
}

export interface RepositoryDeletedPayload {
  repositoryId: number;
  fullName: string;
}

// Edge transition from BitbucketClient — 401/403 flips to 'unauthorized', the
// next 2xx flips back to 'ok'. Only edges fire; steady state emits nothing.
export interface BitbucketAuthStatePayload {
  state: 'ok' | 'unauthorized';
}

// Person layer (alias merge) events. Slim "re-fetch yourself" signals;
// larger detail is pulled via dashboard endpoints after the event fires.

// `primaryUserId` set only when creation also did a first-attach.
export interface PersonCreatedPayload {
  personId: number;
  primaryUserId: number | null;
}

// Pure display-name edit. Does NOT fire for primary swaps or attach/detach.
export interface PersonUpdatedPayload {
  personId: number;
}

// `becamePrimary` true iff this attach also set the alias as primary (caller
// passed makePrimary, or the person had no primary and auto-elected this one).
export interface PersonAttachedPayload {
  personId: number;
  userId: number;
  becamePrimary: boolean;
}

// `wasPrimary` true iff the detached alias was primary — the person then has
// no primary until the operator picks one or a later attach auto-elects.
export interface PersonDetachedPayload {
  personId: number;
  userId: number;
  wasPrimary: boolean;
}

// Carries previous + new primary ids so the frontend patches its roster in
// place without re-fetching.
export interface PersonPrimaryChangedPayload {
  personId: number;
  // Null when the person had no primary before the swap.
  previousPrimaryUserId: number | null;
  newPrimaryUserId: number;
}

// `detachedUserIds` lists every alias whose person_id was cleared on dissolve
// — the frontend refreshes those rows back to `kind: 'user'`.
export interface PersonDissolvedPayload {
  personId: number;
  detachedUserIds: number[];
}

export type Subscriber = (event: LiveEvent) => void;

export interface EventBus {
  subscribe(subscriber: Subscriber): () => void;
  publish(event: LiveEvent): void;
  // Observational helper for tests; the value is not authoritative.
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
      // Snapshot before iterating so an unsubscribe inside a handler doesn't
      // mutate the iteration.
      for (const s of [...subscribers]) {
        try {
          s(event);
        } catch {
          // A throwing subscriber must never block the publish loop. Last-
          // resort net; SSE routes swallow their own errors internally.
        }
      }
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}
