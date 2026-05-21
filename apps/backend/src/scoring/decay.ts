import { HALF_LIFE_DAYS } from './constants.js';

const MS_PER_DAY = 86_400_000;

// Exponential decay weight for the trending-volume score.
//
//   weight = exp(-ln(2) * age_days / half_life)
//
// Returns 1.0 at age=0, 0.5 at age=halfLife, 0.25 at 2x halfLife, etc.
// Future-dated commits (now < authoredAt) clamp to weight=1 — they
// shouldn't exist in practice, but guarding here avoids weights > 1
// poisoning the rollup if a clock skews.
export function decayWeight(authoredAt: Date, now: Date, halfLifeDays: number = HALF_LIFE_DAYS): number {
  const ageMs = now.getTime() - authoredAt.getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / MS_PER_DAY;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}
