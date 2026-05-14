-- Per-commit merge flag + diff-stat file count.
--
-- `is_merge` mirrors BitBucket's `parents.length > 1` and is populated at
-- commit-insert time. User-facing aggregates over additions / deletions /
-- files_changed default-exclude merges, since a single merge inflates
-- per-file stats by the full delta of the merged branch and skews
-- authorship totals. Captured for every commit regardless of the
-- per-repo diff-stat opt-in.
--
-- `files_changed` is the count of file entries in /diffstat/:sha. Filled
-- alongside additions / deletions by the diff-stats sync step. Stays at
-- the default (0) on rows that never get the fetch (diff_stats_enabled=
-- false on the repo, or the pending pickup hasn't run yet).
--
-- Existing rows default to is_merge=false, files_changed=0. The
-- backfill for is_merge on already-ingested commits happens lazily as
-- deepen re-walks history.

ALTER TABLE "commits"
	ADD COLUMN "is_merge" boolean DEFAULT false NOT NULL;

ALTER TABLE "commits"
	ADD COLUMN "files_changed" integer DEFAULT 0 NOT NULL;
