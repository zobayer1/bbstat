-- ShipShow Score — per-user ranking rollup table + badge enum, plus
-- the `merge_commit_count` split on `commit_daily` so user-level and
-- repo-level aggregations can both read from the same rollup table.
--
-- Mirrors apps/backend/drizzle/0001_overrated_james_howlett.sql with
-- the `--> statement-breakpoint` markers stripped and statements
-- regrouped into the enums → tables → alters → foreign keys → indexes
-- order. See apps/backend/schema/README.md for the convention and
-- docs/scoring.md for the design rationale + thresholds.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "bbstat"."user_badge" AS ENUM (
  'fresh_meat',
  'deep_diver',
  'ai_alex',
  'steady_eddie',
  'batch_betty',
  'cleanup_crew'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "bbstat"."user_score" (
  "user_id"                 integer PRIMARY KEY NOT NULL,
  "computed_at"             timestamp with time zone DEFAULT now() NOT NULL,
  "commits_eligible"        integer DEFAULT 0 NOT NULL,
  "commits_total"           integer DEFAULT 0 NOT NULL,
  "coverage_pct"            double precision DEFAULT 0 NOT NULL,
  "p95_churn_cap"           integer DEFAULT 0 NOT NULL,
  "score_trending"          double precision DEFAULT 0 NOT NULL,
  "volume_7d"               double precision DEFAULT 0 NOT NULL,
  "volume_30d"              double precision DEFAULT 0 NOT NULL,
  "volume_90d"              double precision DEFAULT 0 NOT NULL,
  "volume_365d"             double precision DEFAULT 0 NOT NULL,
  "volume_all"              double precision DEFAULT 0 NOT NULL,
  "consistency_90d"         double precision,
  "active_days_90d"         integer DEFAULT 0 NOT NULL,
  "median_churn_90d"        integer DEFAULT 0 NOT NULL,
  "p95_churn_90d"           integer DEFAULT 0 NOT NULL,
  "badge"                   "bbstat"."user_badge",
  "is_dormant"              boolean DEFAULT false NOT NULL,
  "days_since_first_commit" integer DEFAULT 0 NOT NULL
);

-- ---------------------------------------------------------------------------
-- Alters
-- ---------------------------------------------------------------------------

-- Splits `commit_count` (non-merge) from merges so the scoring rollup
-- can ignore merges at the user level while repo-level activity views
-- still include them. Backfill from `bbstat.commits` is a separate
-- one-off step (docs/scoring.md Phase 6); DEFAULT 0 keeps existing
-- rows valid until then.
ALTER TABLE "bbstat"."commit_daily"
  ADD COLUMN "merge_commit_count" integer DEFAULT 0 NOT NULL;

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "bbstat"."user_score"
  ADD CONSTRAINT "user_score_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "bbstat"."users"("id")
  ON DELETE cascade ON UPDATE no action;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Default leaderboard sort.
CREATE INDEX "user_score_trending_idx"
  ON "bbstat"."user_score" USING btree ("score_trending" DESC NULLS LAST);

-- Surfaced as the default tabular window in the UI; other windows
-- (7d/90d/365d/all) full-scan at the current row count.
CREATE INDEX "user_score_volume_30d_idx"
  ON "bbstat"."user_score" USING btree ("volume_30d" DESC NULLS LAST);
