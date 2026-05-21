import { describe, expect, it } from 'vitest';

import { classifyBadge, classifyBadgeTier } from '../src/scoring/badge.js';
import type { BadgeInput } from '../src/scoring/badge.js';
import { scoreCommit } from '../src/scoring/commit-score.js';
import { computeConsistency } from '../src/scoring/consistency.js';
import { ALPHA, FLOOR, HALF_LIFE_DAYS } from '../src/scoring/constants.js';
import { decayWeight } from '../src/scoring/decay.js';
import { aggregateUserScores, percentile } from '../src/scoring/rollup.js';
import type { EligibleCommit, UserTotals } from '../src/scoring/rollup.js';

const MS_PER_DAY = 86_400_000;

describe('scoreCommit', () => {
  it('returns 0 for an empty commit', () => {
    expect(scoreCommit(0, 0, 500)).toBe(0);
  });

  it('uses raw values when raw_churn ≤ cap', () => {
    const adds = 100;
    const dels = 50;
    const expected = Math.log1p(adds) + ALPHA * Math.log1p(dels);
    expect(scoreCommit(adds, dels, 1000)).toBeCloseTo(expected, 6);
  });

  it('caps adds and dels proportionally when raw_churn > cap', () => {
    // 600 adds + 400 dels = 1000 raw; cap 500 → ratio 0.5
    // → capped 300 adds + 200 dels
    const expected = Math.log1p(300) + ALPHA * Math.log1p(200);
    expect(scoreCommit(600, 400, 500)).toBeCloseTo(expected, 6);
  });

  it('100/100 outscores 200/0 (log concavity rewards balanced churn)', () => {
    expect(scoreCommit(100, 100, 1000)).toBeGreaterThan(scoreCommit(200, 0, 1000));
  });

  it('deletions outscore equivalent additions (ALPHA weight)', () => {
    expect(scoreCommit(0, 100, 1000)).toBeGreaterThan(scoreCommit(100, 0, 1000));
  });

  it('honors a custom alpha override', () => {
    const customAlpha = 2.0;
    const result = scoreCommit(0, 100, 1000, customAlpha);
    expect(result).toBeCloseTo(customAlpha * Math.log1p(100), 6);
  });
});

describe('decayWeight', () => {
  const now = new Date('2026-05-22T00:00:00Z');

  it('is 1.0 for a commit at the same instant as now', () => {
    expect(decayWeight(now, now)).toBeCloseTo(1, 6);
  });

  it('is 0.5 at exactly one half-life ago', () => {
    const t = new Date(now.getTime() - HALF_LIFE_DAYS * MS_PER_DAY);
    expect(decayWeight(t, now)).toBeCloseTo(0.5, 6);
  });

  it('is 0.25 at two half-lives ago', () => {
    const t = new Date(now.getTime() - 2 * HALF_LIFE_DAYS * MS_PER_DAY);
    expect(decayWeight(t, now)).toBeCloseTo(0.25, 6);
  });

  it('is effectively zero for a year-old commit (30d half-life)', () => {
    const t = new Date(now.getTime() - 365 * MS_PER_DAY);
    expect(decayWeight(t, now)).toBeLessThan(0.001);
  });

  it('clamps to 1.0 for a future-dated commit (clock skew guard)', () => {
    const t = new Date(now.getTime() + 5 * MS_PER_DAY);
    expect(decayWeight(t, now)).toBe(1);
  });
});

describe('computeConsistency', () => {
  const day = (offset: number) => new Date(Date.UTC(2026, 1, 1 + offset));

  it('returns null when fewer than 3 distinct active days', () => {
    expect(computeConsistency([])).toBeNull();
    expect(computeConsistency([day(0)])).toBeNull();
    expect(computeConsistency([day(0), day(1)])).toBeNull();
  });

  it('dedupes by calendar day before counting', () => {
    expect(computeConsistency([day(0), day(0), day(0)])).toBeNull(); // 1 unique
    expect(computeConsistency([day(0), day(0), day(1), day(2)])).not.toBeNull();
  });

  it('returns regularity = 1 for perfectly-spaced daily commits', () => {
    const days = Array.from({ length: 90 }, (_, i) => day(i));
    const r = computeConsistency(days);
    expect(r).not.toBeNull();
    expect(r!.regularity).toBeCloseTo(1, 6);
    expect(r!.paceFactor).toBeCloseTo(1, 6);
    expect(r!.consistency).toBeCloseTo(1, 6);
  });

  it('regular-but-bursty (every 10 days) keeps regularity=1, drops pace', () => {
    // 9 active days spaced exactly 10 apart in a 90d window
    const days = Array.from({ length: 9 }, (_, i) => day(i * 10));
    const r = computeConsistency(days);
    expect(r).not.toBeNull();
    expect(r!.regularity).toBeCloseTo(1, 6);
    // pace = (9/90)^0.25 ≈ 0.5623
    expect(r!.paceFactor).toBeCloseTo(0.5623, 3);
    expect(r!.consistency).toBeCloseTo(r!.paceFactor, 6);
  });

  it('erratic gaps yield lower regularity than steady ones', () => {
    const steady = computeConsistency(Array.from({ length: 10 }, (_, i) => day(i * 3)));
    const erratic = computeConsistency([0, 1, 15, 18, 40, 41, 60, 75, 76, 89].map(day));
    expect(steady!.regularity).toBeGreaterThan(erratic!.regularity);
  });
});

describe('classifyBadge', () => {
  // A "Regular" baseline — matches no badge. Each test perturbs one or two
  // fields to trip a single branch of the cascade.
  const baseline: BadgeInput = {
    daysSinceFirstCommit: 200,
    activeDays90d: 20,
    medianChurn90d: 30,
    p95Churn90d: 200,
    consistency90d: 0.3,
    regularity90d: 0.5,
    commits90d: 50,
    additions90d: 1000,
    deletions90d: 500,
  };

  it('returns steady_eddie (catch-all) for a baseline Regular contributor', () => {
    // The cascade is exhaustive for active devs — anyone who doesn't
    // match a specialty lands in steady_eddie. The tier (assigned
    // separately by classifyBadgeTier) is what reflects within-cohort
    // strength.
    expect(classifyBadge(baseline)).toBe('steady_eddie');
  });

  it('fresh_meat — too few days since first commit', () => {
    expect(classifyBadge({ ...baseline, daysSinceFirstCommit: 10 })).toBe('fresh_meat');
  });

  it('returns null for dormant rows even if other persona signals are present', () => {
    // active_days_90d=0 → dormant. UI grays the row; the badge is
    // suppressed so a long-quiet veteran doesn't get tagged Steady
    // Eddie just because the cascade is otherwise exhaustive.
    expect(
      classifyBadge({
        ...baseline,
        activeDays90d: 0,
        consistency90d: null,
        regularity90d: null,
        medianChurn90d: 500,
      }),
    ).toBeNull();
  });

  it('1–2 active days (cold-start) lands in steady_eddie (catch-all)', () => {
    // Previously these returned null ("insufficient data"). Under the
    // exhaustive cascade they get steady_eddie; tier classifier
    // collapses null/low consistency to bronze.
    expect(classifyBadge({ ...baseline, activeDays90d: 2, consistency90d: null, regularity90d: null })).toBe(
      'steady_eddie',
    );
    expect(classifyBadge({ ...baseline, activeDays90d: 1, consistency90d: null, regularity90d: null })).toBe(
      'steady_eddie',
    );
  });

  it('fresh_meat overrides every other badge', () => {
    // These signals would otherwise be steady_eddie
    expect(
      classifyBadge({
        ...baseline,
        daysSinceFirstCommit: 5,
        consistency90d: 0.4,
        activeDays90d: 30,
      }),
    ).toBe('fresh_meat');
  });

  it('deep_diver — large median commit + few active days + low consistency', () => {
    expect(
      classifyBadge({
        ...baseline,
        medianChurn90d: 500,
        activeDays90d: 10,
        consistency90d: 0.2,
      }),
    ).toBe('deep_diver');
  });

  it('ai_alex — bimodal commit-size distribution (p95/median ≥ 20)', () => {
    expect(
      classifyBadge({
        ...baseline,
        medianChurn90d: 50,
        p95Churn90d: 5000,
      }),
    ).toBe('ai_alex');
  });

  it('ai_alex — does not fire when p95 itself is below the floor (falls through to steady_eddie)', () => {
    expect(
      classifyBadge({
        ...baseline,
        medianChurn90d: 1,
        p95Churn90d: 100, // ratio 100 ≥ 20, but absolute p95 < 2000
      }),
    ).toBe('steady_eddie');
  });

  it('steady_eddie — the catch-all has no consistency / active-days minimum', () => {
    // Used to require consistency ≥ 0.33 AND active_days ≥ 25. Now anyone
    // active in the window lands in steady_eddie; the tier reflects
    // where they sit on consistency.
    expect(classifyBadge({ ...baseline, consistency90d: 0.4, activeDays90d: 30 })).toBe('steady_eddie');
    expect(classifyBadge({ ...baseline, consistency90d: 0.05, activeDays90d: 4 })).toBe('steady_eddie');
  });

  it('batch_betty — regular spacing but few active days', () => {
    expect(
      classifyBadge({
        ...baseline,
        regularity90d: 0.7,
        activeDays90d: 5,
        consistency90d: 0.3, // below steady_eddie threshold so it doesn't win first
      }),
    ).toBe('batch_betty');
  });

  it('cleanup_crew — net negative-line contributor', () => {
    expect(
      classifyBadge({
        ...baseline,
        additions90d: 100,
        deletions90d: 200,
        commits90d: 20,
      }),
    ).toBe('cleanup_crew');
  });

  it('cleanup_crew — does not fire below the commits floor (falls through to steady_eddie)', () => {
    expect(
      classifyBadge({
        ...baseline,
        additions90d: 100,
        deletions90d: 200,
        commits90d: 5,
      }),
    ).toBe('steady_eddie');
  });

  it('null consistency lands in steady_eddie (catch-all) without crashing the cascade', () => {
    expect(
      classifyBadge({
        ...baseline,
        consistency90d: null,
        regularity90d: null,
        activeDays90d: 4,
      }),
    ).toBe('steady_eddie');
  });
});

describe('classifyBadgeTier', () => {
  it('returns null when the badge is not steady_eddie', () => {
    expect(classifyBadgeTier('batch_betty', 0.5)).toBeNull();
    expect(classifyBadgeTier('deep_diver', 0.5)).toBeNull();
    expect(classifyBadgeTier('ai_alex', 0.5)).toBeNull();
    expect(classifyBadgeTier('cleanup_crew', 0.5)).toBeNull();
    expect(classifyBadgeTier('fresh_meat', 0.5)).toBeNull();
    expect(classifyBadgeTier(null, 0.5)).toBeNull();
  });

  it('collapses null consistency (cold-start) to bronze for steady_eddie', () => {
    expect(classifyBadgeTier('steady_eddie', null)).toBe('bronze');
  });

  it('tiers steady_eddie by consistency', () => {
    expect(classifyBadgeTier('steady_eddie', 0.0)).toBe('bronze');
    expect(classifyBadgeTier('steady_eddie', 0.34)).toBe('bronze');
    expect(classifyBadgeTier('steady_eddie', 0.35)).toBe('silver');
    expect(classifyBadgeTier('steady_eddie', 0.4)).toBe('silver');
    expect(classifyBadgeTier('steady_eddie', 0.41)).toBe('gold');
    expect(classifyBadgeTier('steady_eddie', 0.5)).toBe('gold');
  });
});

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('returns the single value regardless of quantile for a length-1 input', () => {
    expect(percentile([42], 0.05)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('matches the linear-interpolation shape of Postgres percentile_cont', () => {
    // [10, 20, 30, 40, 50]
    // p=0.5 → idx = 2.0 → exact 30
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    // p=0.25 → idx = 1.0 → exact 20
    expect(percentile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    // p=0.95 → idx = 3.8 → 40 + 0.8 * 10 = 48
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48, 6);
  });
});

describe('aggregateUserScores', () => {
  const NOW = new Date('2026-05-22T00:00:00Z');
  const MS_PER_DAY = 86_400_000;
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY);

  it('returns an empty array for empty inputs', () => {
    expect(aggregateUserScores([], [], NOW)).toEqual([]);
  });

  it('writes a dormant row for a user with totals but no eligible commits', () => {
    const totals: UserTotals[] = [{ authorUserId: 1, commitsTotal: 5, firstCommitAt: daysAgo(100) }];
    const rows = aggregateUserScores(totals, [], NOW);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe(1);
    expect(row.commitsEligible).toBe(0);
    expect(row.commitsTotal).toBe(5);
    expect(row.coveragePct).toBe(0);
    expect(row.scoreTrending).toBe(0);
    expect(row.volume30d).toBe(0);
    expect(row.volumeAll).toBe(0);
    expect(row.isDormant).toBe(true);
    expect(row.consistency90d).toBeNull();
    expect(row.activeDays90d).toBe(0);
    expect(row.p95ChurnCap).toBe(FLOOR); // empty p95 → 0; max(0, FLOOR) = FLOOR
    expect(row.daysSinceFirstCommit).toBe(100);
  });

  it('windows commits correctly by cutoff', () => {
    const totals: UserTotals[] = [{ authorUserId: 1, commitsTotal: 4, firstCommitAt: daysAgo(400) }];
    const eligible: EligibleCommit[] = [
      { authorUserId: 1, additions: 100, deletions: 100, authoredAt: daysAgo(3) }, // 7d window
      { authorUserId: 1, additions: 100, deletions: 100, authoredAt: daysAgo(20) }, // 30d window
      { authorUserId: 1, additions: 100, deletions: 100, authoredAt: daysAgo(60) }, // 90d window
      { authorUserId: 1, additions: 100, deletions: 100, authoredAt: daysAgo(200) }, // 365d window
    ];
    const [row] = aggregateUserScores(totals, eligible, NOW);
    const oneScore = row!.volume7d!;
    expect(row!.volume7d).toBeCloseTo(oneScore, 6);
    expect(row!.volume30d).toBeCloseTo(2 * oneScore, 6);
    expect(row!.volume90d).toBeCloseTo(3 * oneScore, 6);
    expect(row!.volume365d).toBeCloseTo(4 * oneScore, 6);
    expect(row!.volumeAll).toBeCloseTo(4 * oneScore, 6);
  });

  it('decay attenuates older commits in scoreTrending', () => {
    const totals: UserTotals[] = [{ authorUserId: 1, commitsTotal: 2, firstCommitAt: daysAgo(365) }];
    const eligible: EligibleCommit[] = [
      { authorUserId: 1, additions: 100, deletions: 100, authoredAt: NOW }, // weight ≈ 1
      { authorUserId: 1, additions: 100, deletions: 100, authoredAt: daysAgo(365) }, // weight ≈ 2e-4
    ];
    const [row] = aggregateUserScores(totals, eligible, NOW);
    const vAll = row!.volumeAll!;
    const sTrending = row!.scoreTrending!;
    expect(vAll).toBeGreaterThan(sTrending);
    // ~half the un-decayed sum (1 + tiny) / 2 ≈ 0.5 of the un-decayed sum
    expect(sTrending).toBeGreaterThan(vAll * 0.49);
    expect(sTrending).toBeLessThan(vAll * 0.51);
  });

  it('honors the per-dev p95 cap and applies FLOOR when p95 is small', () => {
    // 97 small commits + 3 huge commits — p95 of (100*97, 10000*3) lands
    // at 100 (the small-commit value), so FLOOR (500) wins and the cap
    // is 500. The huge commits get capped — their per-commit score is
    // well below the un-capped value.
    const totals: UserTotals[] = [{ authorUserId: 1, commitsTotal: 100, firstCommitAt: daysAgo(100) }];
    const small: EligibleCommit[] = Array.from({ length: 97 }, (_, i) => ({
      authorUserId: 1,
      additions: 50,
      deletions: 50,
      authoredAt: daysAgo(i + 1),
    }));
    const huge: EligibleCommit[] = Array.from({ length: 3 }, (_, i) => ({
      authorUserId: 1,
      additions: 5000,
      deletions: 5000,
      authoredAt: daysAgo(i + 100),
    }));
    const [row] = aggregateUserScores(totals, [...small, ...huge], NOW);
    expect(row!.p95ChurnCap).toBe(FLOOR);
    // A small commit (adds=50, dels=50; total churn 100) is uncapped at
    // cap=500 — score = ln(1+50) + ALPHA*ln(1+50).
    // A huge commit (adds=5000, dels=5000; total churn 10000) capped at
    // 500 → ratio=0.05 → adds/dels become 250/250 →
    // score = ln(1+250) + ALPHA*ln(1+250).
    const smallScore = Math.log1p(50) + ALPHA * Math.log1p(50);
    const cappedHugeScore = Math.log1p(250) + ALPHA * Math.log1p(250);
    const uncappedHugeScore = Math.log1p(5000) + ALPHA * Math.log1p(5000);
    expect(row!.volumeAll).toBeCloseTo(97 * smallScore + 3 * cappedHugeScore, 4);
    // And well below what it would be without the cap.
    expect(row!.volumeAll).toBeLessThan(97 * smallScore + 3 * uncappedHugeScore);
  });

  it('groups eligible commits by author and ignores users not in totals', () => {
    const totals: UserTotals[] = [{ authorUserId: 1, commitsTotal: 1, firstCommitAt: daysAgo(50) }];
    const eligible: EligibleCommit[] = [
      { authorUserId: 1, additions: 100, deletions: 50, authoredAt: daysAgo(1) },
      // user 2 is in the eligible set but not in totals — dropped
      { authorUserId: 2, additions: 999, deletions: 999, authoredAt: daysAgo(1) },
    ];
    const rows = aggregateUserScores(totals, eligible, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(1);
  });

  it('marks a recent first-commit user as fresh_meat', () => {
    const totals: UserTotals[] = [{ authorUserId: 1, commitsTotal: 5, firstCommitAt: daysAgo(5) }];
    const eligible: EligibleCommit[] = Array.from({ length: 5 }, (_, i) => ({
      authorUserId: 1,
      additions: 50,
      deletions: 50,
      authoredAt: daysAgo(i),
    }));
    const [row] = aggregateUserScores(totals, eligible, NOW);
    expect(row!.daysSinceFirstCommit).toBe(5);
    expect(row!.badge).toBe('fresh_meat');
  });
});

// Touch HALF_LIFE_DAYS so the import isn't lint-flagged when the
// pure-function tests at the top of the file are removed/edited.
void HALF_LIFE_DAYS;
