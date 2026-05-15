-- Auto-excluded repos + retroactive is_merge backfill state.
--
-- `repositories.sync_excluded` — same effect as `archived` (the repo
-- is filtered out of every sync tick) but written by the sync layer
-- itself when it detects a permanently-broken state: a 404 on the
-- commits endpoint (rename / delete upstream) or an empty repo whose
-- `deepen_complete = true` arrived with `total_commits_synced = 0`.
-- Kept distinct from `archived` so the UI can surface
-- "needs attention" separately from operator-initiated retirement,
-- and so a future admin recovery action has its own lifecycle.
-- Existing rows default to sync_excluded=false (still tracked).
--
-- `sync_state.is_merge_backfill_complete` / `is_merge_backfill_cursor_sha`
-- / `is_merge_last_run_at` — drain state for the retroactive `is_merge`
-- backfill tick. The `commits.is_merge` column was added in V1_7 with
-- DEFAULT false, so rows inserted before that migration are stuck at
-- false regardless of BB's actual `parents.length`. Newly-ingested
-- commits land with the correct value (both forward sync and
-- deepen-backfill read parents at insert time), so this state exists
-- purely to drain the pre-V1_7 backlog. The tick walks BB /commits
-- newest-first, resuming from the cursor sha (NULL = start from
-- newest), bulk-UPDATEs is_merge by sha, and flips
-- is_merge_backfill_complete=true when the paginator exhausts
-- without hitting the per-tick page cap. Round-robin rotation via
-- is_merge_last_run_at mirrors the deepen worker. Existing rows
-- default to is_merge_backfill_complete=false (enters the backfill
-- queue on the next tick).

ALTER TABLE "repositories"
	ADD COLUMN "sync_excluded" boolean DEFAULT false NOT NULL;

ALTER TABLE "sync_state"
	ADD COLUMN "is_merge_backfill_complete" boolean DEFAULT false NOT NULL;

ALTER TABLE "sync_state"
	ADD COLUMN "is_merge_backfill_cursor_sha" text;

ALTER TABLE "sync_state"
	ADD COLUMN "is_merge_last_run_at" timestamp with time zone;
