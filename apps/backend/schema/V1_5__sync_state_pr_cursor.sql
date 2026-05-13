-- Phase 4 T22 — PR-sync cursor + counter on sync_state.
--
-- Commit and PR ingest write disjoint columns on the same row, so they don't
-- stomp on each other. PRs are walked newest-first by `updated_on`; the
-- cursor stores the most-recent updated_on we've ingested + the BB-side
-- numeric PR id for tie-break when multiple PRs share the same second. NULL
-- on both = cold mode (no prior PR sync).
--
-- `pr_last_synced_at` records when the PR sync last ran for this repo —
-- purely observational. Unlike the commit sync, PR runs don't persist a
-- status enum or last error; errors land in the tick-result `errors[]`
-- array + structured logs.

ALTER TABLE "sync_state"
	ADD COLUMN "last_pr_updated_at" timestamp with time zone;

ALTER TABLE "sync_state"
	ADD COLUMN "last_pr_id" integer;

ALTER TABLE "sync_state"
	ADD COLUMN "pr_last_synced_at" timestamp with time zone;

ALTER TABLE "sync_state"
	ADD COLUMN "pr_total_synced" integer DEFAULT 0 NOT NULL;
