// ShipShow Score rollup runner.
//
// Two layers:
//
//   1. `aggregateUserScores` — pure function. Takes the SQL pull results
//      (per-user totals + the eligible commit set) and returns the rows
//      ready to UPSERT. No DB. Easy to unit-test against synthetic inputs.
//
//   2. `recomputeUserScores` — thin glue. Runs the two SELECTs, calls
//      `aggregateUserScores`, UPSERTs into `user_score`, and invalidates
//      the leaderboard cache. Called from `runCommitsSync` after every
//      successful sync tick, and from the admin endpoint for manual
//      triggers.
//
// Architecture rationale (docs/scoring.md phase 3): at ~110 devs and
// ~52k eligible commits the full pull is ~4MB, so we skip the streaming-
// decay / incremental update complexity entirely and just recompute
// everything per tick. Sub-second on the live corpus today; revisit if
// it ever stops being.

import { sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { userScore } from '../db/schema.js';
import { CONSISTENCY_WINDOW_DAYS, FLOOR, WINDOW_30D, WINDOW_365D, WINDOW_7D, WINDOW_90D } from './constants.js';
import { classifyBadge, tierFromRank, type Badge } from './badge.js';
import { scoreCommit } from './commit-score.js';
import { computeConsistency } from './consistency.js';
import { decayWeight } from './decay.js';

const MS_PER_DAY = 86_400_000;

export interface UserTotals {
  authorUserId: number;
  commitsTotal: number;
  firstCommitAt: Date;
}

export interface EligibleCommit {
  authorUserId: number;
  additions: number;
  deletions: number;
  authoredAt: Date;
}

export type UserScoreRow = typeof userScore.$inferInsert;

export interface UserScoreRollupResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  devsProcessed: number;
}

export interface UserScoreRollupDeps {
  db: Database;
  // Pino-shaped logger. Omitted in tests that don't care about output.
  logger?: { info?: (obj: object, msg?: string) => void; warn?: (obj: object, msg?: string) => void };
  // Override for tests so decay and window cutoffs are deterministic.
  now?: Date;
}

// Pure aggregation. Given the two SQL pulls + a `now`, build one
// `user_score` row per user that appears in `totals`. Users with no
// eligible commits land as zero-everything rows with `isDormant = true`,
// which the UI grays out — they're still attributable contributors, just
// not currently active.
export function aggregateUserScores(
  totals: ReadonlyArray<UserTotals>,
  eligible: ReadonlyArray<EligibleCommit>,
  now: Date,
): UserScoreRow[] {
  const cutoff7 = now.getTime() - WINDOW_7D * MS_PER_DAY;
  const cutoff30 = now.getTime() - WINDOW_30D * MS_PER_DAY;
  const cutoff90 = now.getTime() - WINDOW_90D * MS_PER_DAY;
  const cutoff365 = now.getTime() - WINDOW_365D * MS_PER_DAY;
  const consistencyCutoff = now.getTime() - CONSISTENCY_WINDOW_DAYS * MS_PER_DAY;

  // Group eligible commits by author.
  const eligibleByUser = new Map<number, EligibleCommit[]>();
  for (const c of eligible) {
    let bag = eligibleByUser.get(c.authorUserId);
    if (!bag) {
      bag = [];
      eligibleByUser.set(c.authorUserId, bag);
    }
    bag.push(c);
  }

  const rows: UserScoreRow[] = [];
  for (const t of totals) {
    const bag = eligibleByUser.get(t.authorUserId) ?? [];
    const churns = bag.map((c) => c.additions + c.deletions);
    const p95 = percentile(churns, 0.95);
    const cap = Math.max(p95, FLOOR);

    // Decayed global + un-decayed window sums. Walk the bag once; per-
    // commit score depends on the cap, which is constant across the loop.
    let scoreTrending = 0;
    let v7 = 0;
    let v30 = 0;
    let v90 = 0;
    let v365 = 0;
    let vAll = 0;
    const churns90d: number[] = [];
    const activeDayKeys90d = new Set<string>();
    let adds90d = 0;
    let dels90d = 0;
    let commits90d = 0;

    for (const c of bag) {
      const score = scoreCommit(c.additions, c.deletions, cap);
      vAll += score;
      const ts = c.authoredAt.getTime();
      if (ts >= cutoff365) v365 += score;
      if (ts >= cutoff90) {
        v90 += score;
        commits90d += 1;
        adds90d += c.additions;
        dels90d += c.deletions;
        churns90d.push(c.additions + c.deletions);
      }
      if (ts >= cutoff30) v30 += score;
      if (ts >= cutoff7) v7 += score;
      if (ts >= consistencyCutoff) {
        activeDayKeys90d.add(c.authoredAt.toISOString().slice(0, 10));
      }
      scoreTrending += score * decayWeight(c.authoredAt, now);
    }

    churns90d.sort((a, b) => a - b);
    const medianChurn90d = percentile(churns90d, 0.5);
    const p95Churn90d = percentile(churns90d, 0.95);

    const activeDays90dArr = [...activeDayKeys90d].map((k) => new Date(`${k}T00:00:00Z`));
    const cons = computeConsistency(activeDays90dArr);

    const daysSinceFirstCommit = Math.max(0, Math.floor((now.getTime() - t.firstCommitAt.getTime()) / MS_PER_DAY));
    const activeDays90dCount = activeDayKeys90d.size;

    const badge: Badge | null = classifyBadge({
      daysSinceFirstCommit,
      activeDays90d: activeDays90dCount,
      medianChurn90d: Math.round(medianChurn90d),
      p95Churn90d: Math.round(p95Churn90d),
      consistency90d: cons?.consistency ?? null,
      regularity90d: cons?.regularity ?? null,
      commits90d,
      additions90d: adds90d,
      deletions90d: dels90d,
    });
    // Tier is assigned in a second pass below (after all rows are built)
    // because tier-by-momentum-rank needs the full steady_eddie cohort to
    // compute each row's rank.

    rows.push({
      userId: t.authorUserId,
      computedAt: now,
      commitsEligible: bag.length,
      commitsTotal: t.commitsTotal,
      coveragePct: t.commitsTotal > 0 ? bag.length / t.commitsTotal : 0,
      p95ChurnCap: Math.round(cap),
      scoreTrending,
      volume7d: v7,
      volume30d: v30,
      volume90d: v90,
      volume365d: v365,
      volumeAll: vAll,
      consistency90d: cons?.consistency ?? null,
      activeDays90d: activeDays90dCount,
      medianChurn90d: Math.round(medianChurn90d),
      p95Churn90d: Math.round(p95Churn90d),
      badge,
      badgeTier: null,
      isDormant: activeDays90dCount === 0,
      daysSinceFirstCommit,
    });
  }

  // Second pass: assign steady_eddie tiers by momentum rank.
  // Momentum (scoreTrending) already has 30d-half-life decay built in,
  // so devs who've gone quiet naturally fall in rank and demote out of
  // gold/silver — without this two-pass approach the tier signal would
  // lag recency.
  const steadyEddieRows = rows
    .filter((r) => r.badge === 'steady_eddie')
    .sort((a, b) => (b.scoreTrending ?? 0) - (a.scoreTrending ?? 0));
  steadyEddieRows.forEach((row, rank) => {
    row.badgeTier = tierFromRank(rank, steadyEddieRows.length);
  });

  return rows;
}

// Linear-interpolation percentile, matches Postgres `percentile_cont` so
// the threshold calibration in docs/scoring.md transfers to runtime.
// Returns 0 on an empty array.
export function percentile(sortedAscOrEmpty: ReadonlyArray<number>, q: number): number {
  const n = sortedAscOrEmpty.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAscOrEmpty[0]!;
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscOrEmpty[lo]!;
  return sortedAscOrEmpty[lo]! + (sortedAscOrEmpty[hi]! - sortedAscOrEmpty[lo]!) * (idx - lo);
}

export async function recomputeUserScores(deps: UserScoreRollupDeps): Promise<UserScoreRollupResult> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const now = deps.now ?? new Date();

  // Per-user totals (every author, eligible or not). Drives the row set
  // and supplies the coverage-warning denominator + tenure.
  const totalsResult = await deps.db.execute<{
    author_user_id: number;
    commits_total: number;
    first_commit_at: Date;
  }>(sql`
    SELECT author_user_id,
           COUNT(*)::int AS commits_total,
           MIN(authored_at) AS first_commit_at
    FROM commits
    WHERE author_user_id IS NOT NULL
    GROUP BY author_user_id
  `);
  const totals: UserTotals[] = totalsResult.rows.map((r) => ({
    authorUserId: r.author_user_id,
    commitsTotal: r.commits_total,
    firstCommitAt: new Date(r.first_commit_at),
  }));

  // Eligible commits across full history. Scoring + consistency both
  // operate on this set; the p95 cap is global-per-dev (not windowed)
  // so we need the whole history, not just the last 90 / 365 days.
  const eligibleResult = await deps.db.execute<{
    author_user_id: number;
    additions: number;
    deletions: number;
    authored_at: Date;
  }>(sql`
    SELECT author_user_id, additions, deletions, authored_at
    FROM commits
    WHERE is_merge = false
      AND diff_stats_synced_at IS NOT NULL
      AND diff_stats_failure_count < 3
      AND author_user_id IS NOT NULL
  `);
  const eligible: EligibleCommit[] = eligibleResult.rows.map((r) => ({
    authorUserId: r.author_user_id,
    additions: r.additions,
    deletions: r.deletions,
    authoredAt: new Date(r.authored_at),
  }));

  const rows = aggregateUserScores(totals, eligible, now);

  if (rows.length > 0) {
    await deps.db
      .insert(userScore)
      .values(rows)
      .onConflictDoUpdate({
        target: userScore.userId,
        set: {
          computedAt: sql`EXCLUDED.computed_at`,
          commitsEligible: sql`EXCLUDED.commits_eligible`,
          commitsTotal: sql`EXCLUDED.commits_total`,
          coveragePct: sql`EXCLUDED.coverage_pct`,
          p95ChurnCap: sql`EXCLUDED.p95_churn_cap`,
          scoreTrending: sql`EXCLUDED.score_trending`,
          volume7d: sql`EXCLUDED.volume_7d`,
          volume30d: sql`EXCLUDED.volume_30d`,
          volume90d: sql`EXCLUDED.volume_90d`,
          volume365d: sql`EXCLUDED.volume_365d`,
          volumeAll: sql`EXCLUDED.volume_all`,
          consistency90d: sql`EXCLUDED.consistency_90d`,
          activeDays90d: sql`EXCLUDED.active_days_90d`,
          medianChurn90d: sql`EXCLUDED.median_churn_90d`,
          p95Churn90d: sql`EXCLUDED.p95_churn_90d`,
          badge: sql`EXCLUDED.badge`,
          badgeTier: sql`EXCLUDED.badge_tier`,
          isDormant: sql`EXCLUDED.is_dormant`,
          daysSinceFirstCommit: sql`EXCLUDED.days_since_first_commit`,
        },
      });
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  deps.logger?.info?.({ devsProcessed: rows.length, durationMs }, 'user score rollup complete');

  return { startedAt, finishedAt, durationMs, devsProcessed: rows.length };
}
