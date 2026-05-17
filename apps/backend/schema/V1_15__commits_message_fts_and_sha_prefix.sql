-- Mirrors apps/backend/drizzle/0014_outstanding_sue_storm.sql.
--
-- Two related additions to the `commits` table that power the dedicated
-- Activity page's free-text + hash-prefix search:
--
--   1. `message_tsv` — Postgres tsvector generated from `message` via the
--      `simple` dictionary (no stemming, no stopword removal — predictable
--      across the multilingual / acronym-heavy commit corpus). GENERATED
--      STORED so it backfills automatically on ADD and stays in lockstep
--      with `message` on every write. Paired with a GIN index for cheap
--      `@@ plainto_tsquery(…)` lookups.
--
--   2. `commits_sha_prefix_idx` — B-tree on `sha` with `text_pattern_ops`
--      so `sha LIKE 'abc%'` can index-scan. The existing unique index on
--      (repository_id, sha) can't serve a SHA-only prefix lookup, and the
--      activity feed needs to find a commit by hash across all repos.

ALTER TABLE "commits"
  ADD COLUMN "message_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', message)) STORED;

CREATE INDEX "commits_message_tsv_idx" ON "commits" USING gin ("message_tsv");

CREATE INDEX "commits_sha_prefix_idx" ON "commits" USING btree ("sha" text_pattern_ops);
