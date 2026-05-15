-- Per-repo blacklist of file-path globs for diff-stat aggregation.
--
-- Picomatch / gitignore-style patterns (e.g. '*.png', '**/pnpm-lock.yaml',
-- 'Assets/**'). The diff-stat aggregator in bitbucket/diff-stats.ts
-- skips matching entries — they don't contribute to
-- commits.additions / deletions / files_changed.
--
-- Patterns are purely additive per repo; no global defaults are layered
-- on, so the canonical "what counts" view lives entirely in this column.
-- Empty array (the default for existing + new rows) = unfiltered.
--
-- Editing this column is cheap (just an UPDATE). Applying the new filter
-- to already-ingested commits requires the explicit recount endpoint
-- (POST /api/admin/repositories/:ws/:slug/diff-stats/reset), which
-- clears the diff_stats_synced_at stamps and zeros the affected
-- commit_daily aggregates so the next backfill ticks re-fetch with the
-- new filter.

ALTER TABLE "repositories"
	ADD COLUMN "diff_stats_exclude_patterns" text[] DEFAULT '{}' NOT NULL;
