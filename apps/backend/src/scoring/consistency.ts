import { BETA, CONSISTENCY_MIN_ACTIVE_DAYS, CONSISTENCY_WINDOW_DAYS } from './constants.js';

const MS_PER_DAY = 86_400_000;

export interface ConsistencyResult {
  // regularity * paceFactor; the value displayed in the leaderboard column.
  consistency: number;
  // 1 / (1 + cv_gap). High for both daily committers and uniformly-spaced
  // every-10-days bursters; batch_betty reads this directly (ignores pace).
  regularity: number;
  paceFactor: number;
}

// Consistency over a fixed window — `null` on cold-start (<3 active days,
// not enough gaps to estimate cv).
//
//   gaps         = days between consecutive distinct active days
//   regularity   = 1 / (1 + stddev(gaps) / mean(gaps))    ∈ (0, 1]
//   pace_factor  = (active_days / window) ^ beta          ∈ [0, 1]
//   consistency  = regularity * pace_factor
//
// Inputs are interpreted at UTC-day granularity (toISOString().slice(0, 10)
// keys), so two Dates on the same calendar day collapse to one active day;
// dedup + sort happen here so the function is total.
export function computeConsistency(
  activeDays: ReadonlyArray<Date>,
  windowDays: number = CONSISTENCY_WINDOW_DAYS,
  beta: number = BETA,
): ConsistencyResult | null {
  const uniqueDayKeys = new Set<string>();
  for (const d of activeDays) uniqueDayKeys.add(d.toISOString().slice(0, 10));
  if (uniqueDayKeys.size < CONSISTENCY_MIN_ACTIVE_DAYS) return null;

  const sortedMs = [...uniqueDayKeys].map((k) => Date.parse(`${k}T00:00:00Z`)).sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < sortedMs.length; i++) {
    gaps.push((sortedMs[i]! - sortedMs[i - 1]!) / MS_PER_DAY);
  }

  const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (meanGap === 0) return null;

  // Population stddev (matches Postgres `stddev_pop`, which is what the
  // exploratory queries in docs/scoring.md used to calibrate thresholds).
  const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / gaps.length;
  const cvGap = Math.sqrt(variance) / meanGap;

  const regularity = 1 / (1 + cvGap);
  const paceFactor = Math.pow(uniqueDayKeys.size / windowDays, beta);
  return { consistency: regularity * paceFactor, regularity, paceFactor };
}
