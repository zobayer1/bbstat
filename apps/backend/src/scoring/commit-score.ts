import { ALPHA } from './constants.js';

// Per-commit score: ln(1 + capped_adds) + alpha * ln(1 + capped_dels),
// where ratio = min(1, cap/raw_churn) caps churn (raw_churn == 0 → 0).
//
// The split-log form (not a single ln(1 + capped_churn)) is deliberate:
// log concavity means a 100/100 commit outscores a 200/0 commit, which
// discounts "added a scaffolded file" relative to a real edit. Don't
// simplify back to a single log.
export function scoreCommit(adds: number, dels: number, cap: number, alpha: number = ALPHA): number {
  const rawChurn = adds + dels;
  if (rawChurn === 0) return 0;
  const ratio = Math.min(1, cap / rawChurn);
  const cappedAdds = adds * ratio;
  const cappedDels = dels * ratio;
  return Math.log1p(cappedAdds) + alpha * Math.log1p(cappedDels);
}
