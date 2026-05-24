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
  | { event: 'repository.deleted'; payload: RepositoryDeletedPayload }
  | { event: 'bitbucket.auth-state'; payload: BitbucketAuthStatePayload }
  | { event: 'person.created'; payload: PersonCreatedPayload }
  | { event: 'person.updated'; payload: PersonUpdatedPayload }
  | { event: 'person.attached'; payload: PersonAttachedPayload }
  | { event: 'person.detached'; payload: PersonDetachedPayload }
  | { event: 'person.primary-changed'; payload: PersonPrimaryChangedPayload }
  | { event: 'person.dissolved'; payload: PersonDissolvedPayload };

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

// Surfaces an edge transition observed by the BitbucketClient — 401/403
// from BB flips to 'unauthorized', the next 2xx flips back to 'ok'. The
// SSE consumer turns the dashboard `!!` glyph red while in 'unauthorized'.
// Only edges land here; steady-state stable streams emit nothing.
export interface BitbucketAuthStatePayload {
  state: 'ok' | 'unauthorized';
}

// ---------------------------------------------------------------------------
// Phase 5 — person layer (alias merge)
// ---------------------------------------------------------------------------
//
// Slim event payloads — the frontend uses these as "re-fetch yourself"
// signals on the Members / leaderboard surface, so the wire shape stays
// the entity-level identifiers needed to address a cache key and nothing
// more. Larger detail (display name updates, full attached-user
// rosters) is pulled via the dashboard endpoints after the event fires.

// Person row created via POST /api/admin/people. `primaryUserId` is set
// only when the creation also did a first-attach (the operator passed
// `primaryUserId` in the request body).
export interface PersonCreatedPayload {
  personId: number;
  primaryUserId: number | null;
}

// Display-name change on an existing person via PATCH /api/admin/people/:id.
// Does NOT fire for primary-alias swaps (those have their own event) or
// attach/detach (ditto). Pure metadata edit.
export interface PersonUpdatedPayload {
  personId: number;
}

// Attach event — one user joined the person. `becamePrimary` is true
// iff this attach also set the new alias as primary (either because the
// caller passed `makePrimary: true` or because the person had no primary
// yet and the attach auto-elected this alias).
export interface PersonAttachedPayload {
  personId: number;
  userId: number;
  becamePrimary: boolean;
}

// Detach event — one user left the person. `wasPrimary` is true iff
// the detached alias was the primary; consumers may want to highlight
// that the person now has no primary alias (until the operator picks
// one or auto-election kicks in via a later attach).
export interface PersonDetachedPayload {
  personId: number;
  userId: number;
  wasPrimary: boolean;
}

// Primary swap via POST /api/admin/people/:id/primary. Carries both
// previous and new primary ids so the frontend can patch its cached
// roster in place without re-fetching.
export interface PersonPrimaryChangedPayload {
  personId: number;
  // Null when the person had no primary set before the swap (e.g.,
  // detach cleared it, then the operator picks one).
  previousPrimaryUserId: number | null;
  newPrimaryUserId: number;
}

// Person row deleted via DELETE /api/admin/people/:id. `detachedUserIds`
// lists every alias whose `person_id` was cleared as part of the
// dissolve — used by the frontend to refresh those users' rows back to
// `kind: 'user'` on the leaderboard.
export interface PersonDissolvedPayload {
  personId: number;
  detachedUserIds: number[];
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
