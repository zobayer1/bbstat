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
  STEADY_EDDIE_GOLD_PERCENTILE,
  STEADY_EDDIE_SILVER_PERCENTILE,
} from './constants.js';

// Matches the `bbstat.user_badge` enum in apps/backend/src/db/schema.ts —
// keep in sync.
export type Badge = 'fresh_meat' | 'deep_diver' | 'ai_alex' | 'steady_eddie' | 'batch_betty' | 'cleanup_crew';

// Matches the `bbstat.user_badge_tier` enum. Today only steady_eddie tiers;
// classifyBadgeTier returns null for every other persona.
export type BadgeTier = 'bronze' | 'silver' | 'gold';

export interface BadgeInput {
  daysSinceFirstCommit: number;
  activeDays90d: number;
  medianChurn90d: number;
  p95Churn90d: number;
  // From ConsistencyResult.consistency; null = cold-start.
  consistency90d: number | null;
  // From ConsistencyResult.regularity; null = cold-start. batch_betty reads
  // this directly (ignores pace).
  regularity90d: number | null;
  commits90d: number;
  additions90d: number;
  deletions90d: number;
}

// Cascade classifier — first match wins, exhaustive for active devs (anyone
// with active_days_90d > 0). Order matters: fresh_meat first; outlier
// patterns (deep_diver, ai_alex) before behaviour patterns (cleanup_crew,
// batch_betty); steady_eddie last, absorbing the remainder.
//
// Returns null only for dormant rows (activeDays90d == 0); UI grays those
// via `is_dormant`.
export function classifyBadge(m: BadgeInput): Badge | null {
  if (m.activeDays90d === 0) {
    return null;
  }

  // Tenure under the threshold with ≥1 active day = a ramping new joiner,
  // not a long-dormant ex-contributor.
  if (m.daysSinceFirstCommit < FRESH_MEAT_MIN_TENURE_DAYS) {
    return 'fresh_meat';
  }

  // null consistency reads as 0 so cold-start devs still fall into a
  // specialty if other signals fit, else steady_eddie bronze.
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

  // Before batch_betty / steady_eddie so deletion-heavy devs get tagged for
  // cleanup rather than absorbed into the catch-all.
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

  return 'steady_eddie';
}

// Rank-based tier helper. rank is 0-indexed (0 = top by momentum): gold for
// the top decile, silver for the top half (excluding gold), bronze for the
// rest. The rollup computes rank by sorting steady_eddie rows by momentum
// DESC, then calls this per row.
export function tierFromRank(rank: number, total: number): BadgeTier {
  if (total === 0) return 'bronze';
  const goldEnd = Math.ceil(total * STEADY_EDDIE_GOLD_PERCENTILE);
  const silverEnd = Math.ceil(total * STEADY_EDDIE_SILVER_PERCENTILE);
  if (rank < goldEnd) return 'gold';
  if (rank < silverEnd) return 'silver';
  return 'bronze';
}

// Within-persona tier classifier — only steady_eddie tiers today, null for
// every other badge.
export function classifyBadgeTier(
  badge: Badge | null,
  rankWithinSteadyEddie: number,
  totalSteadyEddies: number,
): BadgeTier | null {
  if (badge !== 'steady_eddie') return null;
  return tierFromRank(rankWithinSteadyEddie, totalSteadyEddies);
}
