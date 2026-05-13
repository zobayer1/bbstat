-- Self-queueing deepen-backfill state on sync_state.
--
-- `deepen_complete` flips true once a repo's history has been walked back
-- to its first commit (BB returns no `next` URL on the deepen pagination).
-- The per-tick deepen worker SELECTs the next candidate by
-- `deepen_last_run_at NULLS FIRST` so every incomplete repo gets a fair
-- round-robin share of the budget. `deepen_last_run_at` is bumped on every
-- attempt — including budget-gated no-ops — so we don't repeatedly pick
-- the same repo without making progress.
--
-- Existing rows default to `deepen_complete = false`, queuing them up for
-- a one-time deepen pass.

ALTER TABLE "sync_state"
	ADD COLUMN "deepen_complete" boolean DEFAULT false NOT NULL;

ALTER TABLE "sync_state"
	ADD COLUMN "deepen_last_run_at" timestamp with time zone;
