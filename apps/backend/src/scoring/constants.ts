// Single source of truth for the ShipShow Score engine. Calibration notes
// live in docs/scoring.md; update it when a change is policy, not refactor.

// Per-commit scoring -------------------------------------------------------

// Deletion weight in score_commit = ln(1+adds) + ALPHA * ln(1+dels).
// 1.2 rewards cleanup slightly above pure additions without letting
// deletion-only commits dominate.
export const ALPHA = 1.2;

// Floor for the per-dev p95 churn cap. Anchored to the org-wide p95 of
// single commits (~548 on 2026-05-21) so no dev's cap drops below the
// "typical large commit" size — see docs/scoring.md "Floor calibration".
export const FLOOR = 500;

// Trending volume decay ----------------------------------------------------

// Half-life for score_trending: half weight at 30d, a quarter at 60d,
// ~0.02% at a year.
export const HALF_LIFE_DAYS = 30;

// Consistency --------------------------------------------------------------

// Fixed window for consistency_90d. Decoupled from the volume window the
// user is viewing; working style shouldn't slide with the recency dial.
export const CONSISTENCY_WINDOW_DAYS = 90;

// Pace-factor exponent in consistency = regularity * (active_days/window)^BETA.
// 0.25 keeps the pace factor gentle — a perfectly-spaced every-10-days
// burster lands ~0.56, not crushed to near-zero.
export const BETA = 0.25;

// Below this, return null (cold-start) rather than a fabricated cv_gap.
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

// Steady Eddie tiers are assigned by momentum rank within the cohort, not
// consistency: momentum carries 30d-half-life decay, so a dev who goes quiet
// for 2 weeks falls in rank. The 90d consistency window has no recency
// weighting, so consistency-based tiers kept gold for devs prolific 60 days
// ago but now silent.
export const STEADY_EDDIE_GOLD_PERCENTILE = 0.1; // top 10%
export const STEADY_EDDIE_SILVER_PERCENTILE = 0.5; // top 50%

export const BATCH_BETTY_REGULARITY_MIN = 0.55;
export const BATCH_BETTY_ACTIVE_DAYS_MIN = 3;
export const BATCH_BETTY_ACTIVE_DAYS_MAX = 15;

export const CLEANUP_CREW_DEL_ADD_RATIO = 1.2;
export const CLEANUP_CREW_COMMITS_MIN = 10;
