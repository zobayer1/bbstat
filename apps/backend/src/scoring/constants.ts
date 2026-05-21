// Constants for the ShipShow Score engine. Single source of truth — every
// scoring module imports from here so a tweak (e.g. half-life, badge
// threshold) lands in one place. Design rationale + calibration notes
// live in docs/scoring.md; don't edit a constant without updating that
// doc when the change is policy (not refactor).

// Per-commit scoring -------------------------------------------------------

// Deletion weight in score_commit = ln(1+adds) + ALPHA * ln(1+dels).
// 1.2 rewards refactoring/cleanup slightly above pure additions without
// letting deletion-only commits dominate.
export const ALPHA = 1.2;

// Floor for the per-dev p95 churn cap. Anchored to the org-wide p95 of
// single commits (~548 on 2026-05-21) so no dev's cap drops below the
// "typical large commit" size — see docs/scoring.md "Floor calibration".
export const FLOOR = 500;

// Trending volume decay ----------------------------------------------------

// Decay half-life for score_trending. At 30 days a commit weighs half;
// at 60 days a quarter; at a year ~0.02% — effectively zero.
export const HALF_LIFE_DAYS = 30;

// Consistency --------------------------------------------------------------

// Fixed window for consistency_90d. Decoupled from the volume window the
// user is viewing; working style doesn't slide with the recency dial.
export const CONSISTENCY_WINDOW_DAYS = 90;

// Pace-factor exponent in consistency = regularity * (active_days/window)^BETA.
// 0.25 makes the pace factor gentle — an every-10-days burster with
// perfect spacing lands ~0.56, not crushed to near-zero.
export const BETA = 0.25;

// Minimum active days required to estimate cv_gap. Below this we return
// null (cold-start) instead of a fabricated number.
export const CONSISTENCY_MIN_ACTIVE_DAYS = 3;

// Per-window volume cutoffs ------------------------------------------------

export const WINDOW_7D = 7;
export const WINDOW_30D = 30;
export const WINDOW_90D = 90;
export const WINDOW_365D = 365;

// Badge cascade thresholds -------------------------------------------------

export const FRESH_MEAT_MIN_TENURE_DAYS = 14;
export const FRESH_MEAT_MIN_ACTIVE_DAYS = 3;

export const DEEP_DIVER_MEDIAN_CHURN = 200;
export const DEEP_DIVER_ACTIVE_DAYS_MAX = 15;
export const DEEP_DIVER_CONSISTENCY_MAX = 0.35;

export const AI_ALEX_P95_MEDIAN_RATIO = 20;
export const AI_ALEX_P95_MIN = 2000;

// Steady Eddie is the **catch-all** persona for any active dev (commits
// in the last 90 days) who doesn't match a specialty (fresh_meat,
// deep_diver, ai_alex, cleanup_crew, batch_betty). There are no entry
// minimums — every active contributor lands here at least at bronze.
// Tier cutoffs spread the population by consistency:
//
//   Bronze: any active dev not at silver/gold (including cold-start
//           with active_days < 3 where consistency is null)
//   Silver: consistency ≥ STEADY_EDDIE_SILVER_MIN (p50 of active cohort)
//   Gold:   consistency ≥ STEADY_EDDIE_GOLD_MIN   (p90 of active cohort)
//
// Tiering applies via classifyBadgeTier; non-steady-eddie badges have
// no tier today (badge_tier column is null for them).
//
// Earlier iterations had a minimum consistency cutoff for entry; that
// produced absurd inversions (the org's #1 momentum getting no badge
// while peers 0.0002 cents below threshold also missed). The catch-all
// approach makes the cascade exhaustive for active devs and lets the
// tier carry the gradation signal.
export const STEADY_EDDIE_SILVER_MIN = 0.35;
export const STEADY_EDDIE_GOLD_MIN = 0.41;

export const BATCH_BETTY_REGULARITY_MIN = 0.55;
export const BATCH_BETTY_ACTIVE_DAYS_MIN = 3;
export const BATCH_BETTY_ACTIVE_DAYS_MAX = 15;

export const CLEANUP_CREW_DEL_ADD_RATIO = 1.2;
export const CLEANUP_CREW_COMMITS_MIN = 10;
