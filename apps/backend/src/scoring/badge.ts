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
  FRESH_MEAT_MIN_TENURE_DAYS,
  STEADY_EDDIE_GOLD_MIN,
  STEADY_EDDIE_SILVER_MIN,
} from './constants.js';

// Matches the `bbstat.user_badge` enum in apps/backend/src/db/schema.ts.
// Cascade order in classifyBadge below mirrors the enum order — keep them
// in sync.
export type Badge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

// Within-persona tier. Matches the `bbstat.user_badge_tier` enum.
// Today only `steady_eddie` tiers; classifyBadgeTier returns null for
// every other persona.
export type BadgeTier = 'bronze' | 'silver' | 'gold';

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

// Cascade classifier — first match wins. **Exhaustive for active devs**:
// anyone with `active_days_90d > 0` gets a badge. Steady Eddie is the
// catch-all — every active dev who doesn't match a specialty falls
// into it (tiered bronze / silver / gold by consistency via
// classifyBadgeTier).
//
// Order matters: status badge (fresh_meat) first; outlier patterns
// (deep_diver, ai_alex) precede behaviour patterns (cleanup_crew,
// batch_betty); steady_eddie is last and absorbs the remainder.
//
// Returns null **only for dormant rows** (activeDays90d == 0). UI
// grays those via `is_dormant`. Non-workspace-member styling is a
// separate concern handled in the frontend via `isWorkspaceMember`.
export function classifyBadge(m: BadgeInput): Badge | null {
  // Dormant: no activity in the consistency window. UI grays the row
  // via `is_dormant`.
  if (m.activeDays90d === 0) {
    return null;
  }

  // Fresh Meat: actually a new joiner — tenure under the threshold AND
  // at least one active day in the window, so we know they're ramping
  // up rather than a long-dormant ex-contributor.
  if (m.daysSinceFirstCommit < FRESH_MEAT_MIN_TENURE_DAYS) {
    return 'fresh_meat';
  }

  // Cold-start consistency (null) reads as 0 — treating null as 0
  // lets cold-start devs fall into a specialty if their other signals
  // fit, and into steady_eddie bronze (catch-all) otherwise.
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

  // Cleanup Crew runs BEFORE Batch Betty / Steady Eddie so deletion-
  // heavy devs are tagged for the cleanup work rather than absorbed
  // into the catch-all.
  if (
    m.additions90d > 0 &&
    m.deletions90d / m.additions90d >= CLEANUP_CREW_DEL_ADD_RATIO &&
    m.commits90d >= CLEANUP_CREW_COMMITS_MIN
  ) {
    return 'cleanup_crew';
  }

  if (
    regularity >= BATCH_BETTY_REGULARITY_MIN &&
    m.activeDays90d >= BATCH_BETTY_ACTIVE_DAYS_MIN &&
    m.activeDays90d < BATCH_BETTY_ACTIVE_DAYS_MAX
  ) {
    return 'batch_betty';
  }

  // Catch-all: every active dev who didn't match above lands here.
  // Tier (bronze / silver / gold) is assigned by classifyBadgeTier
  // based on consistency.
  return 'steady_eddie';
}

// Within-persona tier classifier. Currently only steady_eddie tiers —
// returns null for every other badge. Cold-start (null consistency)
// collapses to bronze, since steady_eddie is the catch-all and we want
// every active dev to land at *some* tier.
export function classifyBadgeTier(badge: Badge | null, consistency: number | null): BadgeTier | null {
  if (badge !== 'steady_eddie') return null;
  const c = consistency ?? 0;
  if (c >= STEADY_EDDIE_GOLD_MIN) return 'gold';
  if (c >= STEADY_EDDIE_SILVER_MIN) return 'silver';
  return 'bronze';
}
