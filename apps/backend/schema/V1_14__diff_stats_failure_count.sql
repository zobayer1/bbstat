-- Per-commit failure budget for BB `/diffstat/<sha>` fetches. The
-- diff-stats orchestrator increments this on every caught BB error:
-- generic 5xx adds 1, HTTP 555 adds 3 (heavier weight because 555 means
-- "compute timeout on this commit's diff" — a persistent property of
-- the commit shape, not transient load; one strike is enough to give up
-- on the commit-specific case). When the count reaches the threshold
-- (DIFF_STATS_FAILURE_THRESHOLD = 3 in apps/backend/src/sync/diff-stats-
-- tick.ts) the orchestrator also stamps `diff_stats_synced_at = NOW()`
-- with zeros via the existing `updateCommitDiffStats` path, which
-- drops the commit out of the backfill pickup query. The counter
-- value survives the stamp so downstream readers can distinguish "we
-- tried and gave up" (count >= threshold) from "this commit really
-- has zero diff" (count = 0, synced_at IS NOT NULL).
--
-- Surfaced through the activity feed: `getActivity` derives
-- `diff_stats_unavailable = (count >= threshold)` and the frontend
-- swaps the +/-/files row for an exclamation icon when true.
--
-- DEFAULT 0 NOT NULL — every existing row gets 0 on the ADD COLUMN
-- pass; only commits that subsequently fail the diffstat fetch will
-- see a non-zero count. No retroactive seeding pass needed.

ALTER TABLE "commits"
	ADD COLUMN "diff_stats_failure_count" integer NOT NULL DEFAULT 0;
