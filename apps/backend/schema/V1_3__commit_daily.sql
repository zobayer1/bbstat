-- Per-day per-(repo, user) commit rollup. Populated incrementally by the
-- sync runner (apps/backend/src/dashboard/rollup-store.ts) after each
-- successful per-repo commit tick; the dashboard reads from here instead
-- of re-scanning `commits` per request.
--
-- author_user_id is nullable (anonymous / unmatched authors). NULLS NOT
-- DISTINCT on the unique constraint collapses every (day, repo, NULL) row
-- to a single bucket — without it, NULL would compare unequal and we'd
-- accumulate one duplicate per anonymous commit. Requires Postgres ≥ 15.
--
-- The closing INSERT seeds the rollup from existing `commits` data so the
-- table is correct immediately after applying this migration. Idempotent:
-- ON CONFLICT DO NOTHING skips rows on re-runs (e.g. fresh-db restores).

-- Tables

CREATE TABLE "commit_daily" (
	"day" date NOT NULL,
	"repository_id" integer NOT NULL,
	"author_user_id" integer,
	"commit_count" integer DEFAULT 0 NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_daily_day_repo_user_unique"
		UNIQUE NULLS NOT DISTINCT ("day", "repository_id", "author_user_id")
);

-- Foreign keys

ALTER TABLE "commit_daily"
	ADD CONSTRAINT "commit_daily_repository_id_repositories_id_fk"
	FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "commit_daily"
	ADD CONSTRAINT "commit_daily_author_user_id_users_id_fk"
	FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id")
	ON DELETE set null ON UPDATE no action;

-- Indexes

CREATE INDEX "commit_daily_repo_day_idx"
	ON "commit_daily" USING btree ("repository_id", "day");

CREATE INDEX "commit_daily_user_day_idx"
	ON "commit_daily" USING btree ("author_user_id", "day");

-- One-shot backfill from existing commits. Day buckets are UTC-aligned so
-- the boundary is stable regardless of the server's local TZ. Cast count /
-- sum back to int because Postgres widens them to bigint by default.

INSERT INTO "commit_daily" ("day", "repository_id", "author_user_id", "commit_count", "additions", "deletions")
SELECT
	(date_trunc('day', "authored_at" AT TIME ZONE 'UTC'))::date,
	"repository_id",
	"author_user_id",
	count(*)::int,
	sum("additions")::int,
	sum("deletions")::int
FROM "commits"
GROUP BY 1, 2, 3
ON CONFLICT ON CONSTRAINT "commit_daily_day_repo_user_unique" DO NOTHING;
