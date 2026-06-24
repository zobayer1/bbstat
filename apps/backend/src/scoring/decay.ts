import { HALF_LIFE_DAYS } from './constants.js';

const MS_PER_DAY = 86_400_000;

// Exponential decay weight for trending-volume: exp(-ln(2) * age_days / half_life).
// 1.0 at age=0, 0.5 at halfLife, 0.25 at 2x halfLife.
// Future-dated commits clamp to 1 — guards against clock skew producing
// weights > 1 that would poison the rollup.
export function decayWeight(authoredAt: Date, now: Date, halfLifeDays: number = HALF_LIFE_DAYS): number {
  const ageMs = now.getTime() - authoredAt.getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / MS_PER_DAY;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}
