// ShipShow Score rollup runner. Two passes (per-alias user_score, per-person
// person_score) share one pure aggregator `aggregateUserScores`.
//
// Architecture rationale (docs/scoring.md phase 3): at ~110 devs and
// ~52k eligible commits the full pull is ~4MB, so we skip streaming-decay /
// incremental-update complexity and just recompute everything per tick.
// Sub-second on the live corpus today; revisit if it stops being. The person
// pass adds a partial-index-backed JOIN-to-users on `person_id` and stays
// cheap as long as attached aliases are a small minority of the user base.

import { sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { personScore, userScore } from '../db/schema.js';
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
  logger?: { info?: (obj: object, msg?: string) => void; warn?: (obj: object, msg?: string) => void };
  // Override for tests so decay and window cutoffs are deterministic.
  now?: Date;
}

// Pure aggregation: one user_score row per user in `totals`. Users with no
// eligible commits land as zero rows with isDormant = true (still
// attributable contributors, just not currently active).
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

    // Decayed global + un-decayed window sums in one pass; the cap is
    // constant across the loop.
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
    // Tier is assigned in the second pass below — tier-by-momentum-rank
    // needs the full steady_eddie cohort to compute each row's rank.
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

  // Second pass: steady_eddie tiers by momentum rank. scoreTrending carries
  // 30d-half-life decay, so quiet devs fall in rank and demote out of
  // gold/silver — without this the tier signal would lag recency.
  const steadyEddieRows = rows
    .filter((r) => r.badge === 'steady_eddie')
    .sort((a, b) => (b.scoreTrending ?? 0) - (a.scoreTrending ?? 0));
  steadyEddieRows.forEach((row, rank) => {
    row.badgeTier = tierFromRank(rank, steadyEddieRows.length);
  });

  return rows;
}

// Linear-interpolation percentile matching Postgres `percentile_cont`, so the
// threshold calibration in docs/scoring.md transfers to runtime. 0 on empty.
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

  // Per-user totals (every author, eligible or not) — drives the row set and
  // supplies the coverage denominator + tenure.
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

  // Eligible commits across full history — the p95 cap is global-per-dev
  // (not windowed), so we need the whole history, not just 90/365 days.
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

// ---------------------------------------------------------------------------
// Person-aware (alias-union) pass — Phase 5
// ---------------------------------------------------------------------------

// Per-person counterparts to UserTotals / EligibleCommit; the integer field
// is a `people.id` (the SQL pull JOINs commits → users and projects person_id).
export interface PersonTotals {
  personId: number;
  commitsTotal: number;
  firstCommitAt: Date;
}

export interface PersonEligibleCommit {
  personId: number;
  additions: number;
  deletions: number;
  authoredAt: Date;
}

export type PersonScoreRow = typeof personScore.$inferInsert;

export interface PersonScoreRollupResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  peopleProcessed: number;
}

export interface AllScoresRollupResult {
  user: UserScoreRollupResult;
  person: PersonScoreRollupResult;
}

// Pure aggregation for the person pass. Reuses `aggregateUserScores` by
// relabeling the integer key as person_id in/out. The scoring math sums
// linearly within a key group, so the union of Alice's aliases produces the
// same totals as if she'd pushed everything from one account. Percentiles
// (p95/median churn) are computed over the unioned churn bag — NOT summed
// per-alias — which the aggregator gets right because it sees one bag.
export function aggregatePersonScores(
  totals: ReadonlyArray<PersonTotals>,
  eligible: ReadonlyArray<PersonEligibleCommit>,
  now: Date,
): PersonScoreRow[] {
  const userTotals: UserTotals[] = totals.map((t) => ({
    authorUserId: t.personId,
    commitsTotal: t.commitsTotal,
    firstCommitAt: t.firstCommitAt,
  }));
  const userEligible: EligibleCommit[] = eligible.map((e) => ({
    authorUserId: e.personId,
    additions: e.additions,
    deletions: e.deletions,
    authoredAt: e.authoredAt,
  }));
  const userRows = aggregateUserScores(userTotals, userEligible, now);
  return userRows.map((row) => {
    const { userId, ...rest } = row;
    return { ...rest, personId: userId };
  });
}

export async function recomputePersonScores(deps: UserScoreRollupDeps): Promise<PersonScoreRollupResult> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const now = deps.now ?? new Date();

  // Per-person totals — every person with ≥1 attached alias that has ≥1
  // commit. People with no commits never appear here, so never get a
  // person_score row (the prune DELETE below clears any stale prior row).
  const totalsResult = await deps.db.execute<{
    person_id: number;
    commits_total: number;
    first_commit_at: Date;
  }>(sql`
    SELECT u.person_id AS person_id,
           COUNT(*)::int AS commits_total,
           MIN(c.authored_at) AS first_commit_at
    FROM commits c
    JOIN users u ON u.id = c.author_user_id
    WHERE u.person_id IS NOT NULL
    GROUP BY u.person_id
  `);
  const totals: PersonTotals[] = totalsResult.rows.map((r) => ({
    personId: r.person_id,
    commitsTotal: r.commits_total,
    firstCommitAt: new Date(r.first_commit_at),
  }));

  // Eligible commits across the alias-union — same filter as the user pass,
  // plus the JOIN relabeling each commit's key to its person. The partial
  // index users_person_id_idx (V1_4) covers the JOIN.
  const eligibleResult = await deps.db.execute<{
    person_id: number;
    additions: number;
    deletions: number;
    authored_at: Date;
  }>(sql`
    SELECT u.person_id AS person_id,
           c.additions,
           c.deletions,
           c.authored_at
    FROM commits c
    JOIN users u ON u.id = c.author_user_id
    WHERE u.person_id IS NOT NULL
      AND c.is_merge = false
      AND c.diff_stats_synced_at IS NOT NULL
      AND c.diff_stats_failure_count < 3
  `);
  const eligible: PersonEligibleCommit[] = eligibleResult.rows.map((r) => ({
    personId: r.person_id,
    additions: r.additions,
    deletions: r.deletions,
    authoredAt: new Date(r.authored_at),
  }));

  const rows = aggregatePersonScores(totals, eligible, now);

  // Prune person_score rows whose person no longer has any attached alias.
  // Without this, a detach that empties a person leaves a stale person_score
  // row — invisible to the leaderboard view but visible to a direct
  // /api/stats/people/:id reader. FK ON DELETE CASCADE covers actual person
  // deletion; this catches the orphan-stats case where the person row remains.
  await deps.db.execute(sql`
    DELETE FROM person_score
    WHERE person_id NOT IN (
      SELECT DISTINCT person_id FROM users WHERE person_id IS NOT NULL
    )
  `);

  if (rows.length > 0) {
    await deps.db
      .insert(personScore)
      .values(rows)
      .onConflictDoUpdate({
        target: personScore.personId,
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
  deps.logger?.info?.({ peopleProcessed: rows.length, durationMs }, 'person score rollup complete');

  return { startedAt, finishedAt, durationMs, peopleProcessed: rows.length };
}

// Single entry point for both passes (sync tick, admin endpoint, CLI). Runs
// sequentially against one `now` so both tables' `computed_at` are coherent.
// No wrapping transaction: both passes are idempotent UPSERTs, and we'd
// rather the user pass land even if the person pass throws (one bug
// shouldn't blank the leaderboard).
export async function recomputeAllScores(deps: UserScoreRollupDeps): Promise<AllScoresRollupResult> {
  const now = deps.now ?? new Date();
  const user = await recomputeUserScores({ ...deps, now });
  const person = await recomputePersonScores({ ...deps, now });
  return { user, person };
}
