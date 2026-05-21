import {
  AI_ALEX_P95_MEDIAN_RATIO,
  AI_ALEX_P95_MIN,
  BATCH_BETTY_ACTIVE_DAYS_MAX,
  BATCH_BETTY_ACTIVE_DAYS_MIN,
  BATCH_BETTY_REGULARITY_MIN,
  CLEANUP_CREW_COMMITS_MIN,
  CLEANUP_CREW_DEL_ADD_RATIO,
  DEEP_DIVER_ACTIVE_DAYS_MAX,
  DEEP_DIVER_CONSISTENCY_MAX,
  DEEP_DIVER_MEDIAN_CHURN,
  FRESH_MEAT_MIN_ACTIVE_DAYS,
  FRESH_MEAT_MIN_TENURE_DAYS,
  STEADY_EDDIE_ACTIVE_DAYS_MIN,
  STEADY_EDDIE_CONSISTENCY_MIN,
} from './constants.js';

// Matches the `bbstat.user_badge` enum in apps/backend/src/db/schema.ts.
// Cascade order in classifyBadge below mirrors the enum order — keep them
// in sync.
export type Badge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

export interface BadgeInput {
  daysSinceFirstCommit: number;
  activeDays90d: number;
  medianChurn90d: number;
  p95Churn90d: number;
  // From ConsistencyResult.consistency; null = cold-start.
  consistency90d: number | null;
  // From ConsistencyResult.regularity; null = cold-start.
  // Read directly by batch_betty (which doesn't care about pace).
  regularity90d: number | null;
  commits90d: number;
  additions90d: number;
  deletions90d: number;
}

// Cascade classifier — first match wins. Order matters; gates filter
// "not really a persona candidate" cases up front before the activity-
// shape personas, so a one-time architectural commit doesn't mis-tag
// someone as Batch Betty and a dormant veteran doesn't get tagged as
// Fresh Meat just because they're not currently active.
//
// Returns null for "Regular" (no persona matched). The caller
// distinguishes Regular from Dormant via `is_dormant` (set when
// activeDays90d == 0); the first early-exit below ensures dormant rows
// always land here as null.
export function classifyBadge(m: BadgeInput): Badge | null {
  // Dormant: no activity in the consistency window. Even a brand-new
  // joiner with zero commits in 90d isn't really Fresh Meat — they're
  // just not yet a contributor by any meaningful signal. The UI grays
  // the row via `is_dormant`.
  if (m.activeDays90d === 0) {
    return null;
  }

  // Fresh Meat: actually a new joiner — tenure under the threshold AND
  // at least one active day in the window, so we know they're ramping
  // up rather than a long-dormant ex-contributor.
  if (m.daysSinceFirstCommit < FRESH_MEAT_MIN_TENURE_DAYS) {
    return 'fresh_meat';
  }

  // Insufficient data for the activity-shape personas. A long-tenured
  // dev with 1–2 active days in 90d has just enough signal to NOT be
  // dormant, but not enough for Deep Diver / Steady Eddie / Batch Betty
  // (consistency is null below 3 active days). No badge — Regular until
  // they accrue more data.
  if (m.activeDays90d < FRESH_MEAT_MIN_ACTIVE_DAYS) {
    return null;
  }

  // Cold-start consistency (null) reads as 0 for the threshold checks —
  // a dev who passed the fresh_meat gate but still has a null consistency
  // is functionally inconsistent, and treating null as 0 lets them fall
  // into deep_diver / batch_betty if their other signals fit.
  const consistency = m.consistency90d ?? 0;
  const regularity = m.regularity90d ?? 0;

  if (
    m.medianChurn90d >= DEEP_DIVER_MEDIAN_CHURN &&
    m.activeDays90d < DEEP_DIVER_ACTIVE_DAYS_MAX &&
    consistency < DEEP_DIVER_CONSISTENCY_MAX
  ) {
    return 'deep_diver';
  }

  if (
    m.medianChurn90d > 0 &&
    m.p95Churn90d / m.medianChurn90d >= AI_ALEX_P95_MEDIAN_RATIO &&
    m.p95Churn90d >= AI_ALEX_P95_MIN
  ) {
    return 'ai_alex';
  }

  if (consistency >= STEADY_EDDIE_CONSISTENCY_MIN && m.activeDays90d >= STEADY_EDDIE_ACTIVE_DAYS_MIN) {
    return 'steady_eddie';
  }

  if (
    regularity >= BATCH_BETTY_REGULARITY_MIN &&
    m.activeDays90d >= BATCH_BETTY_ACTIVE_DAYS_MIN &&
    m.activeDays90d < BATCH_BETTY_ACTIVE_DAYS_MAX
  ) {
    return 'batch_betty';
  }

  if (
    m.additions90d > 0 &&
    m.deletions90d / m.additions90d >= CLEANUP_CREW_DEL_ADD_RATIO &&
    m.commits90d >= CLEANUP_CREW_COMMITS_MIN
  ) {
    return 'cleanup_crew';
  }

  return null;
}
