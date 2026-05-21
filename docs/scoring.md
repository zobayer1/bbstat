# ShipShow Score — developer ranking metrics

Design + implementation plan for the per-developer "ShipShow Score" leaderboard.
Captures the decisions reached in the 2026-05-21 design discussion so the
implementation phases can proceed without re-litigating them.

Architectural fit: Postgres = truth, Redis caches the sorted leaderboard read,
Pinia mirrors it for the browser. All scoring is precomputed in a rollup;
nothing is computed on the request path (per `CLAUDE.md`).

## What we are ranking and why

Commit count, raw churn, and "most recent contribution" each fail in
predictable ways — they reward typists, lockfile-touchers, or whoever pushed
most recently. The Score aggregates **two independent dimensions** that
capture distinct things and refuses to blend them:

- **Trending volume** — a log-capped, time-decayed contribution score. The
  headline rank. Answers "who is shipping right now?".
- **Consistency (90d)** — how predictable a developer's working cadence is.
  Sortable alongside volume. Answers "what is their working style?".

Each gets its own sortable column. There is no fused score — Deep Dive Dev
(one architectural commit, two weeks of silence) outranks Steady Eddie on
volume, and vice versa on consistency. Both facts are true.

A **personality badge** is also derived from the same signals (Steady Eddie,
Batch Betty, Deep Diver, AI Alex, Cleanup Crew, Fresh Meat) and displayed in
the row. Decorative, not load-bearing for sorting.

## Per-commit scoring

For each commit that passes the eligibility filter (see below):

```
raw_churn       = additions + deletions
p95_dev         = 95th percentile of raw_churn over the dev's full history
cap             = max(p95_dev, FLOOR)         FLOOR = 500
capped_churn    = min(raw_churn, cap)
ratio           = capped_churn / raw_churn    (guard raw_churn == 0)
capped_adds     = additions * ratio
capped_dels     = deletions * ratio
score_commit    = ln(1 + capped_adds) + ALPHA * ln(1 + capped_dels)   ALPHA = 1.2
```

The split-log form is deliberate — log's concavity means a 100/100 commit
outscores a 200/0 one, naturally discounting "added a scaffolded file" relative
to a real edit. Do not "simplify" it back to a single log of total churn.

`ALPHA = 1.2` weights deletions slightly above additions so refactoring/
cleanup is rewarded without dominating.

### Eligibility

A commit contributes to a user's score iff **all** of:

- `is_merge = false` — merges are excluded from user-level metrics entirely
  (count and churn). Repo-level metrics still count merges separately via
  the new `merge_commit_count` column.
- `diff_stats_synced_at IS NOT NULL` — we have real numbers, not pending.
- `diff_stats_failure_count < 3` — gave-up commits have fake-zero churn and
  would depress the score.
- `author_user_id IS NOT NULL` — anonymous / unmatched commits cannot
  attribute to a user.

`additions + deletions = 0` (whitespace-only after BB processing) is not
explicitly filtered — `ln(1 + 0) = 0` means it contributes nothing.

### Floor calibration

`FLOOR = 500` was chosen against the live corpus on 2026-05-21:

- Org-wide commit churn p95 = 548 (52,251 eligible commits across 110 devs).
- Per-dev p95 distribution: p25 = 193, p50 = 310, p75 = 808.
- A floor of 500 lifts the cap for 67% of devs — high because the org has a
  small-commit culture (median commit = 20 lines). The 67% reflects "most
  devs' typical commits are smaller than the org-wide p95", not over-capping.

Interpretation: no dev's cap is below the org-wide typical-large-commit size.
Elite committers (p75 of per-dev-p95 = 808) keep their personal cap above the
floor — unaffected.

Re-evaluate when the org doubles in size or someone complains about cap
behaviour. Adaptive (MAD-based) floors are deferred.

## Aggregation: trending vs windows

Two distinct aggregations of the per-commit `score_commit`:

### Trending volume — decay only, no cutoff

The leaderboard headline. Exponentially weights recent commits over old ones:

```
weight(t_commit, t_now) = exp(-ln(2) * (t_now - t_commit) / HALF_LIFE)
                          HALF_LIFE = 30 days
score_trending(dev)    = Σ_commits score_commit * weight(t_commit, t_now)
```

A commit from 30 days ago counts half; from 60 days, a quarter; from a year,
~0.02%. There is no hard window — distant history fades naturally.

### Per-window volumes — hard cutoff, no decay

For tabular "what did this person do in the last N days":

```
volume_window(dev, N) = Σ_commits_in_last_N_days score_commit
```

Windows: **7d, 30d, 90d, 365d, all-time**. No decay applied — within a window
all commits count equally, outside it nothing counts. `all-time` is the
un-bounded sum.

Why not blend decay into the windows? Half-life 30d on a 7d window barely
fires (edge weight 0.85); on a 365d window it crushes everything past day 90.
The two mechanisms work cleanly on their own and confuse each other when
combined. Pick one per metric — done.

## Consistency (90d)

A separate signal capturing **regularity of activity spacing**, not volume.

```
active_days     = distinct dates in last 90d with ≥1 eligible commit
gaps[i]         = active_days[i+1] - active_days[i]    (i = 0 .. k-2)
cv_gap          = stddev_pop(gaps) / mean(gaps)
regularity      = 1 / (1 + cv_gap)                ∈ (0, 1]
pace_factor     = (active_days / 90) ^ BETA       BETA = 0.25
consistency     = regularity * pace_factor        ∈ [0, 1]
```

- `active_days < 3` → consistency = NULL (cold start, see below).
- `regularity` is high for both daily-committers and every-10-days bursters
  whose spacing is uniform. The `pace_factor` adds a small penalty for low
  activity rates (BETA=0.25 keeps it gentle — every-10-days burster lands at
  ~0.56, not crushed).

The window is **fixed at 90d** regardless of which volume window the user is
viewing. Consistency measures working style and shouldn't slide with the
volume sort. Labeled "Consistency (90d)" in the UI.

### Cold-start handling

The consistency **column** shows `—` (not 0, not 1) for any user with
`active_days_90d < 3`. When sorting by consistency, they drop to the
bottom of the table. They appear normally when sorting by volume.

The `Fresh Meat` **badge** is a separate (narrower) trigger and applies
only to genuine new joiners — see the cascade below. A long-tenured dev
with a quiet 90 days gets the `—` consistency column but no `Fresh Meat`
badge; they're either dormant (no badge, grayed row) or insufficient-data
Regular (no badge, normal row).

Rationale: a brand-new dev with 3 commits has no consistency signal —
setting it to 1.0 would rank them above veterans on noise; setting it to
0 punishes them. "Not enough data" is the honest answer.

## Badge cascade

First match wins. Computed nightly from the same per-dev signals.

The cascade is **exhaustive for active devs** — anyone with `active_days_90d > 0`
gets some badge. `steady_eddie` is the catch-all (tiered by consistency); the
other personas precede it in cascade order so deletion-heavy / bursty /
outlier patterns get their specialty label instead of being absorbed.

| Badge          | Trigger                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| _(dormant)_    | `active_days_90d == 0` → no badge (UI grays the row via `is_dormant`)        |
| `fresh_meat`   | `days_since_first_commit < 14` AND `active_days_90d ≥ 1`                     |
| `deep_diver`   | `median_churn_90d ≥ 200` AND `active_days_90d < 15` AND `consistency < 0.35` |
| `ai_alex`      | `p95_churn_90d / median_churn_90d ≥ 20` AND `p95_churn_90d ≥ 2000`           |
| `cleanup_crew` | `total_deletions_90d / total_additions_90d ≥ 1.2` AND `commits_90d ≥ 10`     |
| `batch_betty`  | `regularity ≥ 0.55` AND `3 ≤ active_days_90d < 15`                           |
| `steady_eddie` | catch-all — every active dev not matching above. Tier by consistency.        |

Dormancy is the **only** path to no badge for someone with at least one
commit ingested. Two earlier iterations both produced absurd results
against the live corpus and were retired:

1. `fresh_meat | OR active_days_90d < 3` surfaced 81% of the corpus
   as Fresh Meat (mostly dormant veterans being mistagged).
2. `steady_eddie | consistency ≥ 0.33 AND active_days_90d ≥ 25` left
   the org's #1-momentum dev with no badge (consistency `0.3296`, one
   point below threshold) while peers `0.0002` above were Steady Eddie.

The current cascade is exhaustive for active devs; the tier system
(below) carries the gradation signal that the threshold cuts used to
fail at.

### Within-persona tiers (Steady Eddie only, for now)

`steady_eddie` is the catch-all bucket and is further binned by consistency
into bronze / silver / gold, surfaced on the leaderboard as a tinted
circular background behind the badge icon:

| Tier   | Consistency     | Approximate share of active cohort        |
| ------ | --------------- | ----------------------------------------- |
| Bronze | `< 0.35`        | catch-all default (incl. cold-start null) |
| Silver | `0.35` – `0.41` | ~p50 → p90                                |
| Gold   | `≥ 0.41`        | top decile                                |

Tier classifier collapses null consistency (`active_days < 3`) to bronze
and returns `null` for every other persona; the column generalizes so
other personas can be tiered later without a schema change.

### Cascade order

Cascade order matters: `deep_diver` and `ai_alex` (outlier patterns) precede
the activity-shape badges so a one-time architectural commit doesn't mis-tag
someone as Batch Betty.

Thresholds were tuned against the live corpus (37 devs with sufficient 90d
data, 2026-05-21):

| Badge          | Devs | Pct   |
| -------------- | ---- | ----- |
| _none_         | 14   | 37.8% |
| `steady_eddie` | 8    | 21.6% |
| `fresh_meat`   | 5    | 13.5% |
| `batch_betty`  | 4    | 10.8% |
| `ai_alex`      | 3    | 8.1%  |
| `deep_diver`   | 3    | 8.1%  |
| `cleanup_crew` | 0    | 0.0%  |

`cleanup_crew` is zero today because nobody currently matches — not a
threshold problem. The badge will start firing when someone does.

Auto-adjusting (percentile-based) thresholds are deferred — static for v1.

## Schema delta — Phase 1

### `commit_daily` — new column

```sql
ALTER TABLE bbstat.commit_daily
  ADD COLUMN merge_commit_count integer NOT NULL DEFAULT 0;
```

- `commit_count` keeps its meaning ("non-merge commits") for user-level reads.
- `merge_commit_count` is summed alongside for repo-level reads.
- One-time backfill from `bbstat.commits` (Phase 6 step 2) — not part of the
  migration; the `DEFAULT 0` keeps existing rows valid until backfilled.

### `user_score` — new table

One row per user; nightly-rebuilt rollup.

| Column                     | Type        | Notes                                             |
| -------------------------- | ----------- | ------------------------------------------------- |
| `user_id`                  | int PK FK   | → `users.id` ON DELETE CASCADE                    |
| `computed_at`              | timestamptz | when this row was last recomputed                 |
| `commits_eligible`         | int         | filtered count (drives the score)                 |
| `commits_total`            | int         | including pending/merges; drives coverage warning |
| `coverage_pct`             | double      | `commits_eligible / commits_total`                |
| `p95_churn_cap`            | int         | `max(per_dev_p95, FLOOR)`                         |
| `score_trending`           | double      | decayed global; default sort                      |
| `volume_7d` … `volume_all` | double (×5) | per-window un-decayed sums                        |
| `consistency_90d`          | double NULL | NULL for cold-start                               |
| `active_days_90d`          | int         |                                                   |
| `median_churn_90d`         | int         | drives `deep_diver`                               |
| `p95_churn_90d`            | int         | drives `ai_alex`                                  |
| `badge`                    | enum NULL   | `user_badge` enum (see below)                     |
| `is_dormant`               | bool        | `active_days_90d = 0` — UI grays the row          |
| `days_since_first_commit`  | int         | drives `fresh_meat` plus UI tenure display        |

New enum: `user_badge` with values `fresh_meat`, `deep_diver`, `ai_alex`,
`steady_eddie`, `batch_betty`, `cleanup_crew`. Nullable column → "Regular" /
"Dormant" display.

Indexes:

- `user_score_trending_idx` — btree on `(score_trending DESC NULLS LAST)`.
- `user_score_volume_30d_idx` — btree on `(volume_30d DESC NULLS LAST)`.

Skip the rest; 110 rows fits in cache, full-scan is free.

## Phase plan

Each phase is its own commit (migrations especially — separate commit per
the standing convention).

| Phase | Scope                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| **1** | Schema: `commit_daily.merge_commit_count` + `user_score` table. Drizzle migration + Flyway mirror.                        |
| **2** | Pure-function scoring engine in `apps/backend/src/scoring/`: `commit-score`, `decay`, `consistency`, `badge`. Unit tests. |
| **3** | Rollup runner `recomputeUserScores()`. Wire into `runSync`. Admin endpoint for manual triggers. Redis invalidation.       |
| **4** | Read API: `GET /api/stats/leaderboard?sort=…`, `GET /api/stats/leaderboard/:userId/breakdown`. Redis cached.              |
| **5** | Frontend: Pinia store (bump `CACHE_VERSION`), Leaderboard page, UserBadge component, MethodologyModal.                    |
| **6** | Rollout: migrate → backfill `merge_commit_count` → first manual recompute → smoke through `make up`.                      |

### Phase 6 post-deploy

`docker compose exec redis redis-cli FLUSHDB` after the deploy — we are
adding `bbstat:leaderboard:*` keys and the existing per-deploy bust
convention covers them.

## Things deliberately out of scope for v1

- **Auto-adjusting thresholds** (percentile-based badge cutoffs). Static is
  simpler to reason about; revisit when the org doubles.
- **Streaming/incremental score updates** (the `exp(λ·t)` reference-epoch
  trick). Full nightly recompute is sub-second at 52k commits / 110 devs.
- **Per-repo weighting** (vendor forks vs primary repos). All tracked repos
  count equally. Add a `repositories.scoring_weight` later if needed.
- **Committer vs author attribution split.** We attribute to author. The
  forthcoming aliasing system will unify a single person's multiple emails.
- **Webhook-driven recompute.** Sync-tick-driven is fine for the rollup.

## Open implementation details

Decisions deferred to the relevant phase:

1. Methodology modal rendering — plain text + monospace, or KaTeX for the
   formulas? Lean: plain text, no math-rendering dep.
2. Badge display label — keep the playful names (`Batch Betty`) or use
   neutral labels (`Batch Worker`)?
3. Leaderboard nav placement — top-level or under an existing page?
4. Rollup cadence — every sync tick (cheap) or once a day?
5. Coverage-warning threshold — at what `coverage_pct` does the UI flag
   "diff stats pending" on a user's row? Lean: < 0.90.
