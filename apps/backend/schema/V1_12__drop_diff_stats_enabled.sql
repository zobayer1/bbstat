-- Drop per-repo opt-in for diff-stat ingest. Diff-stat backfill now uses
-- a freshness-first global pickup across every non-archived
-- non-excluded repo, so per-repo opt-in adds no value — every tracked
-- repo participates automatically. Operator opt-out paths that remain:
--
--   * `archived = true`  — full retirement, no sync work, no dashboard
--                          surface (admin POST /archive).
--   * `sync_excluded = true` — auto-trip when BB returns 404 /
--                          empty / history-rewritten, recoverable
--                          via admin POST /include or /rename.
--   * `diff_stats_exclude_patterns` — per-file glob list to skip
--                          binary blobs / lockfiles / generated bundles
--                          inside an otherwise-participating repo.
--
-- The auto-opt-in machinery (`findNextDiffStatsCandidate` query +
-- the runner's drained-cleanly check) is removed in the same change,
-- along with the YAML `diffStats: true|false` flag parsing.

ALTER TABLE "repositories"
	DROP COLUMN "diff_stats_enabled";
