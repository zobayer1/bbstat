-- Mirrors apps/backend/drizzle/0016_lyrical_black_widow.sql.
--
-- State columns for the standalone anonymous-commit sweep runner
-- (`apps/backend/src/anonymous-sweep-main.ts`, `make dev-resync`).
-- The runner walks BB `/commits` per repo to attribute commits whose
-- `author_user_id IS NULL` — typically ex-employees / never-members
-- whose UUIDs weren't in `users` at original ingest.
--
--   1. `anonymous_sweep_complete` — flips to TRUE once a sweep pass
--      for a repo attributes zero rows (everything attributable has
--      been attributed; the residual is structurally anonymous, e.g.
--      BB lacks a UUID or the email is unparseable). The picker uses
--      this to drop completed repos from rotation.
--
--   2. `anonymous_sweep_last_run_at` — round-robin rotation cursor.
--      NULLS FIRST so brand-new repos enter the queue immediately
--      then rotate by staleness, same shape as deepen_last_run_at
--      and is_merge_last_run_at.
--
-- Independent of the main commit-sync cron: `dev-sync` doesn't touch
-- these columns. To re-arm a repo (e.g. after adding ex-employees
-- back to the workspace and wanting to re-attempt), manually UPDATE
-- the flag back to FALSE.

ALTER TABLE "sync_state"
  ADD COLUMN "anonymous_sweep_complete" boolean DEFAULT false NOT NULL;

ALTER TABLE "sync_state"
  ADD COLUMN "anonymous_sweep_last_run_at" timestamp with time zone;
