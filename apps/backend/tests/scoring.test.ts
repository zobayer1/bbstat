import { describe, expect, it } from 'vitest';

import { classifyBadge } from '../src/scoring/badge.js';
import type { BadgeInput } from '../src/scoring/badge.js';
import { scoreCommit } from '../src/scoring/commit-score.js';
import { computeConsistency } from '../src/scoring/consistency.js';
import { ALPHA, HALF_LIFE_DAYS } from '../src/scoring/constants.js';
import { decayWeight } from '../src/scoring/decay.js';

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

  it('returns null for a Regular contributor', () => {
    expect(classifyBadge(baseline)).toBeNull();
  });

  it('fresh_meat — too few days since first commit', () => {
    expect(classifyBadge({ ...baseline, daysSinceFirstCommit: 10 })).toBe('fresh_meat');
  });

  it('fresh_meat — too few active days in window', () => {
    expect(classifyBadge({ ...baseline, activeDays90d: 2 })).toBe('fresh_meat');
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

  it('ai_alex — does not fire when p95 itself is below the floor', () => {
    expect(
      classifyBadge({
        ...baseline,
        medianChurn90d: 1,
        p95Churn90d: 100, // ratio 100 ≥ 20, but absolute p95 < 2000
      }),
    ).toBeNull();
  });

  it('steady_eddie — high consistency and high active-day count', () => {
    expect(
      classifyBadge({
        ...baseline,
        consistency90d: 0.4,
        activeDays90d: 30,
      }),
    ).toBe('steady_eddie');
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

  it('cleanup_crew — does not fire below the commits floor (noise guard)', () => {
    expect(
      classifyBadge({
        ...baseline,
        additions90d: 100,
        deletions90d: 200,
        commits90d: 5,
      }),
    ).toBeNull();
  });

  it('null consistency does not crash the cascade', () => {
    // dev passed fresh_meat but consistency couldn't be computed
    expect(
      classifyBadge({
        ...baseline,
        consistency90d: null,
        regularity90d: null,
        activeDays90d: 4,
      }),
    ).toBeNull();
  });
});
