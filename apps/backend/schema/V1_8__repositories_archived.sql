-- Soft-retire flag for repositories.
--
-- `archived = true` keeps the row + all its historical data
-- (commits, sync_state, branches, pull_requests) but excludes the
-- repo from sync work. `listTrackedRepositories()` filters
-- `WHERE archived = false`, so commit / deepen / diff-stats ticks
-- skip archived repos entirely — no BB calls, no log noise from
-- 404s on repos that were renamed or deprecated upstream.
--
-- Toggled at runtime via POST /repositories/:ws/:slug/archive (and
-- /unarchive). Seeded from `{ name, archived: true }` in
-- `tracked-repos.yaml` on initial insert only — once a row exists
-- the DB is canonical and subsequent discovery syncs do NOT
-- overwrite the flag from YAML.
--
-- Existing rows default to archived=false (still tracked).

ALTER TABLE "repositories"
	ADD COLUMN "archived" boolean DEFAULT false NOT NULL;
