# Changelog

All notable changes to this project are documented here. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is not
strictly SemVer-versioned but releases are tagged in git and each tagged
release gets a section.

## [1.1.0] — 2026-05-24

ShipShow Score / leaderboard, member persona categorization, and a handful of
UI + operational polish landed on top of the v1.0 baseline. No breaking schema
changes for downstream consumers; the additive `bbstat.user_score` table and
the `commit_daily.merge_commit_count` split are picked up automatically by the
shipped migrations.

### Added

- **ShipShow Score engine** (`apps/backend/src/scoring/`) — pure-function scoring
  with split-log per-commit math (`ln(1+adds) + α·ln(1+dels)`, α=1.2),
  p95-capped churn floor (FLOOR=500), 30-day half-life decay for the trending
  score, un-decayed per-window volumes (7d / 30d / 90d / 365d / all-time), and
  90-day consistency from active-day gap CV. Fully unit-tested. See
  [`docs/scoring.md`](docs/scoring.md).
- **`user_score` rollup table** + `user_badge` and `user_badge_tier` enums.
  Recomputed at the tail of every commits-sync tick; sub-second at the live
  corpus (~110 devs, ~52k eligible commits).
- **Six personality badges** — `fresh_meat`, `deep_diver`, `ai_alex`,
  `cleanup_crew`, `batch_betty`, `steady_eddie` (catch-all). Cascade is
  exhaustive for active devs; only dormant rows go badge-less. Steady Eddie
  is tiered (bronze / silver / gold) by momentum rank within cohort —
  recency-aware where consistency-based tiering had been blind to it.
- **Members page = leaderboard** — default sort `scoreTrending` desc; new
  Momentum, 7d / 30d / 90d / 365d / all-time volume, and Badge columns sit on
  the right of the vertical separator. `BadgeIcon` component with tier-tinted
  circular backgrounds for Steady Eddie.
- **Methodology modal** (`apps/frontend/src/components/MethodologyModal.vue`)
  — KaTeX-rendered formulas reachable from the Members page header so the
  scoring math is legible to non-engineers.
- **Member persona surface** — three tiers visible on the Members page:
  active workspace members (`is_workspace_member && !is_dormant`), dormant
  workspace members (`is_workspace_member && is_dormant` — row grayed),
  ex-members / external contributors (`!is_workspace_member` — email line
  tinted red, auto-created during commit ingest when BB attributed a commit
  to a UUID we hadn't seen in member sync; flag flips back the next time
  they reappear in `/workspaces/{ws}/members`).
- **BitBucket token-expiry surface** — edge-triggered auth-state hook on the
  BB client flips a Redis `bbstat:bitbucket-auth-state` flag on 401/403 and
  clears it on the next 2xx. Dashboard `!!` and the global footer's
  last-sync label turn red with an explanatory tooltip while the flag is
  set; `/api/bitbucket/auth-state` lets the SPA read the current flag at
  boot. Fresh sync processes hydrate initial state from Redis so a stale
  flag from before a restart doesn't dedupe the first post-rotation 2xx.
- **`POST /api/admin/scores/recompute`** + `make recompute-user-scores` — manual
  rollup trigger for post-tuning backfills and the post-deploy smoke step.
- **`commit_daily.merge_commit_count`** column — merge commits now have their
  own tally so repo-level "all commits" reads stay correct without inflating
  user-level metrics from merge churn.
- **`docs/README.md`** — index across all docs so new readers have a single
  jumping-off point.

### Changed

- **`commit_daily.commit_count / additions / deletions` exclude merges**
  (`a67b5f5`). Previous rollups silently double-counted merge churn into
  user-level totals; merge contributions now flow only into the new
  `merge_commit_count` column. Existing rollups are recomputed automatically
  on the next commit-sync tick; run `make rebuild-rollups` to force-rebuild
  immediately.
- **`scoring.md` rewritten as a landed reference** (was the design plan).
  Algorithm and calibration content preserved; phase plan removed; operating
  notes (`recomputeUserScores` automatic vs manual, persona surface, deploy
  reminder) added. `docs/members.md` cross-links to it.
- **ROADMAP renumbered.** Webhook trigger moved from Phase 5 to Phase 7 since
  it shares a public-URL dependency with the planned auth flow. New phases
  added: Phase 5 — User alias merge (planning TBD); Phase 6 — Org-email auth
  and BitBucket account linking (planning TBD); Phase 8 — Admin dashboard
  (planning TBD). Phase 4.5 (ShipShow Score) marked landed inline.
- **`VITE_CONTACT_EMAIL` plumbed into the frontend Docker build** (`239bffa`).
  The footer's `mailto:` placeholder now resolves correctly in the
  containerized image; previously it was empty in any non-host build.

### Fixed

- **Stale store-test fixtures** (`3383a46`) — fixtures in
  `apps/frontend/tests/` were out of sync with the live `WorkspaceMember`
  shape (missing `scoreTrending`, badge fields). Repaired the `typecheck`
  script while we were there.
- **Steady Eddie tiers no longer use consistency** (`d66dc89`). A dev who had
  been prolific 60 days ago but had gone silent in week 12 kept a high
  consistency score (the 90d window has no recency weighting) and ranked
  gold; momentum (which has 30d-half-life decay) naturally demotes them. The
  2026-05-22 smoke caught it; the tier classifier now ranks within cohort by
  momentum.
- **Exhaustive badge cascade** (`087fe21`) — earlier cascades surfaced 81% of
  the corpus as Fresh Meat (mostly dormant veterans being mistagged) or left
  the org's top-momentum dev badge-less because their consistency was one
  basis point below the Steady Eddie threshold. Steady Eddie is now a true
  catch-all for active devs; only dormant rows have no badge. Non-workspace
  styling decoupled from dormant styling so the UI no longer conflates "left
  the workspace" with "quiet lately."

### Removed

- **Dormant leaderboard cache code** (`be739f9`) — the Redis leaderboard
  cache layer drafted during scoring Phase 3 was never wired up. The live
  corpus reads the rollup table directly in sub-millisecond time, so the
  cache hop was dead weight. `bbstat:leaderboard:*` keys are not produced
  by any current code path.

### Operator notes

- **No FLUSHDB required for this deploy.** The Redis-cached payload set is
  unchanged — `UserSummary` shape is untouched, the leaderboard isn't
  cached. The new `bbstat:bitbucket-auth-state` key lives in its own
  namespace and survives across deploys intentionally.
- **No `CACHE_VERSION` bump.** `WorkspaceMember` gained `scoreTrending` /
  `consistency90d` / `badge` / `badgeTier` fields, but those landed
  alongside the matching frontend code; the additive nature plus
  always-fresh sort defaults mean stale persisted rows still render
  correctly. (If you see odd behavior after upgrade, a
  `localStorage.clear()` from the console resolves it.)
- **First post-deploy step:** `make stack-migrate` (Drizzle picks up
  `0001_overrated_james_howlett.sql` + `0002_sleepy_betty_ross.sql`). Then
  either wait one commits-sync tick for `user_score` to populate
  automatically, or kick it manually with `make recompute-user-scores`.

## [1.0.0] — 2026-05-21

First tagged release. Foundations through Phase 4 follow-ups: BitBucket
ingest pipeline (commits, PRs, diff-stats, deepen-backfill, is-merge
backfill, adaptive backpressure), `commit_daily` rollup + Redis user-summary
cache, dashboard (overview / top contributors / activity feed / heatmap /
sparklines), Projects / Repositories / Members / Activity pages with
filter interlock, SSE live-updates with polling fallback, full
containerized deploy (compose split + distroless backend + nginx-unprivileged
frontend + Traefik dev overlay), production tarball distribution, off-disk
secret interpolation, `bbstat` Postgres schema namespace. See git history
prior to v1.0.0 for the full commit set, and [`docs/ROADMAP.md`](docs/ROADMAP.md)
for the phase-by-phase landed summary.

[1.1.0]: https://github.com/tigerit/bbstat/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tigerit/bbstat/releases/tag/v1.0.0
