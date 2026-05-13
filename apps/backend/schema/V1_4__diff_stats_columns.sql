-- Phase 4 T21 — opt-in per-commit diff-stat ingest.
--
-- `repositories.diff_stats_enabled` is the per-repo on/off switch. Authoritative
-- source for the flag is this column; tracked-repos.yaml writes through it on
-- every discovery sync so toggling the YAML knob re-applies at the next tick.
--
-- `commits.diff_stats_synced_at` is the resumability marker. NULL = "diff
-- stats not fetched yet" (the only state at commit insertion time). Set to
-- now() once /diffstat/:sha lands and additions / deletions are persisted.
-- The partial index makes the pickup query
-- (`WHERE repository_id = $1 AND diff_stats_synced_at IS NULL`) cheap
-- regardless of how large `commits` grows. Repos with
-- `diff_stats_enabled = false` simply never fetch — their rows stay at
-- additions=0, deletions=0, diff_stats_synced_at IS NULL.

-- Columns

ALTER TABLE "commits"
	ADD COLUMN "diff_stats_synced_at" timestamp with time zone;

ALTER TABLE "repositories"
	ADD COLUMN "diff_stats_enabled" boolean DEFAULT false NOT NULL;

-- Indexes

CREATE INDEX "commits_pending_diff_stats_idx"
	ON "commits" USING btree ("repository_id")
	WHERE "commits"."diff_stats_synced_at" IS NULL;
