-- Person layer (Phase 5 alias merge) — the identity layer above `users`.
-- One `people` row represents one canonical human; multiple `users` rows
-- (each a distinct BB UUID) attach to one person via `users.person_id`.
-- Operator-curated through the `/api/admin/people` endpoints — no
-- auto-detection. The new `person_score` rollup parallels `user_score`
-- column-for-column, populated by the scoring rollup's person-aware
-- pass against the unioned commit set per person. The
-- `leaderboard_entries` view UNION ALLs per-person rows with
-- per-(unattached-)user rows so the leaderboard read path is a single
-- SELECT.
--
-- This migration is intentionally **empty-shipping**: every existing
-- `users` row keeps `person_id = NULL` and reads identically to today.
-- `people` and `person_score` are created empty; the scoring rollup's
-- new pass is a no-op until the first POST /api/admin/people lands.
--
-- The "primary alias" designation lives on the `users` side as
-- `is_primary_for_person boolean` rather than as `people.primary_user_id`.
-- The latter direction was tried in an earlier draft and created a
-- circular FK with `users.person_id`, which trips pg_dump --data-only
-- restores. The boolean + partial unique index gives the same operator
-- curation ("≤1 primary alias per person") without the cycle.
--
-- Rollback is a clean drop:
--   DROP VIEW "bbstat"."leaderboard_entries";
--   DROP TABLE "bbstat"."person_score";
--   ALTER TABLE "bbstat"."users" DROP CONSTRAINT "users_primary_requires_person";
--   ALTER TABLE "bbstat"."users" DROP COLUMN "is_primary_for_person";
--   ALTER TABLE "bbstat"."users" DROP COLUMN "person_id";
--   DROP TABLE "bbstat"."people";
-- No existing row was modified, so the database returns to its pre-V1_4
-- state.
--
-- Mirrors apps/backend/drizzle/0003_cuddly_network.sql with the
-- `--> statement-breakpoint` markers stripped and statements regrouped
-- into the standard tables → alters → foreign keys → indexes → checks
-- → views order. See apps/backend/schema/README.md for the convention
-- and docs/ROADMAP.md (Phase 5) for the design rationale.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "bbstat"."people" (
  "id"           serial PRIMARY KEY NOT NULL,
  "display_name" text,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"   timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "bbstat"."person_score" (
  "person_id"               integer PRIMARY KEY NOT NULL,
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
  "badge_tier"              "bbstat"."user_badge_tier",
  "is_dormant"              boolean DEFAULT false NOT NULL,
  "days_since_first_commit" integer DEFAULT 0 NOT NULL
);

-- ---------------------------------------------------------------------------
-- Alters
-- ---------------------------------------------------------------------------

-- NULL = unattached (the user is their own person). NOT NULL = this row is
-- one alias of the canonical person identified by `people.id`. Multiple
-- rows can share one `person_id`. Default-NULL on the column add is
-- intentional: every existing row stays unattached on deploy.
ALTER TABLE "bbstat"."users"
  ADD COLUMN "person_id" integer;

-- Marks this alias as the canonical one supplying UI defaults (display
-- name fallback, username, email-mailto, BB avatar URL) for its
-- `person_id`. At most one alias per person can carry the flag
-- (enforced by `users_one_primary_per_person_idx` below); a CHECK pins
-- the flag to false whenever `person_id` is NULL. Default false on the
-- column add — no existing row is marked primary, since no person
-- relationships exist yet.
ALTER TABLE "bbstat"."users"
  ADD COLUMN "is_primary_for_person" boolean DEFAULT false NOT NULL;

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

-- ON DELETE CASCADE — dropping a person row removes its rollup. The
-- attached `users` rows survive (their `person_id` FK is SET NULL below).
ALTER TABLE "bbstat"."person_score"
  ADD CONSTRAINT "person_score_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "bbstat"."people"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ON DELETE SET NULL — dissolving a person leaves the alias rows intact
-- and unattached. The admin DELETE endpoint flips them to NULL explicitly
-- before deleting the person; this FK is the safety net.
ALTER TABLE "bbstat"."users"
  ADD CONSTRAINT "users_person_id_people_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "bbstat"."people"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Default sort key on the person-side of the leaderboard view. NULLS LAST
-- so any future never-scored person sinks to the bottom rather than
-- floating to the top.
CREATE INDEX "person_score_trending_idx"
  ON "bbstat"."person_score"
  USING btree ("score_trending" DESC NULLS LAST);

-- Mirrors `user_score_volume_30d_idx` — the 30d window is what the
-- Members table surfaces by default; the other windows fit in cache
-- and don't need their own index.
CREATE INDEX "person_score_volume_30d_idx"
  ON "bbstat"."person_score"
  USING btree ("volume_30d" DESC NULLS LAST);

-- Partial index targeting the scoring rollup's per-tick lookup
-- "find every alias of person X". Rows with `person_id = NULL` (most
-- of the table at first) stay out of the index.
CREATE INDEX "users_person_id_idx"
  ON "bbstat"."users"
  USING btree ("person_id")
  WHERE "person_id" IS NOT NULL;

-- Partial unique index — enforces "≤1 primary alias per person". Only
-- constrains rows where the flag is set AND the user is actually
-- attached; NULL-person rows stay out of the index entirely.
CREATE UNIQUE INDEX "users_one_primary_per_person_idx"
  ON "bbstat"."users"
  USING btree ("person_id")
  WHERE "is_primary_for_person" = true AND "person_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Checks
-- ---------------------------------------------------------------------------

-- A user can only be primary if they're attached to a person — the
-- primary designation is meaningless for unattached aliases. Pairs with
-- the partial unique index above to make the "≤1 primary per person"
-- invariant complete.
ALTER TABLE "bbstat"."users"
  ADD CONSTRAINT "users_primary_requires_person"
  CHECK (NOT "is_primary_for_person" OR "person_id" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Unified leaderboard read shape. The person branch carries the
-- recomputed aggregates from `person_score` with COALESCE'd display_name
-- (operator override → primary alias's display_name) and OR'd
-- workspace-member status across attached aliases. The primary alias is
-- identified by `users.is_primary_for_person = true` for the person_id;
-- if no alias is flagged primary (operator hasn't designated one),
-- primary_user columns come through as NULL and the COALESCE falls
-- back accordingly. The user branch carries unattached `user_score`
-- rows as-is. `entity_kind` discriminates between the two; `entity_id`
-- is a person_id or user_id depending on `entity_kind`.
--
-- Drizzle-kit does NOT track views, so this DDL lives only in the SQL
-- migration files (here and in apps/backend/drizzle/0003_cuddly_network.sql)
-- and not in src/db/schema.ts. If the underlying column shapes of
-- `user_score` / `person_score` / `users` / `people` change, a future
-- migration must DROP VIEW + CREATE VIEW (CREATE OR REPLACE only works
-- for additive column changes that match position + type).
CREATE VIEW "bbstat"."leaderboard_entries" AS
SELECT
  'person'::text AS entity_kind,
  ps.person_id AS entity_id,
  COALESCE(p.display_name, primary_user.display_name) AS display_name,
  primary_user.username AS username,
  primary_user.email AS email,
  primary_user.bitbucket_uuid AS bitbucket_uuid,
  ps.computed_at,
  ps.commits_eligible,
  ps.commits_total,
  ps.coverage_pct,
  ps.p95_churn_cap,
  ps.score_trending,
  ps.volume_7d,
  ps.volume_30d,
  ps.volume_90d,
  ps.volume_365d,
  ps.volume_all,
  ps.consistency_90d,
  ps.active_days_90d,
  ps.median_churn_90d,
  ps.p95_churn_90d,
  ps.badge,
  ps.badge_tier,
  ps.is_dormant,
  ps.days_since_first_commit,
  COALESCE(
    (SELECT bool_or(u.is_workspace_member) FROM "bbstat"."users" u WHERE u.person_id = ps.person_id),
    false
  ) AS is_workspace_member,
  (SELECT count(*)::int FROM "bbstat"."users" u WHERE u.person_id = ps.person_id) AS attached_user_count
FROM "bbstat"."person_score" ps
JOIN "bbstat"."people" p ON p.id = ps.person_id
LEFT JOIN "bbstat"."users" primary_user
  ON primary_user.person_id = ps.person_id
  AND primary_user.is_primary_for_person = true
UNION ALL
SELECT
  'user'::text AS entity_kind,
  us.user_id AS entity_id,
  u.display_name,
  u.username,
  u.email,
  u.bitbucket_uuid,
  us.computed_at,
  us.commits_eligible,
  us.commits_total,
  us.coverage_pct,
  us.p95_churn_cap,
  us.score_trending,
  us.volume_7d,
  us.volume_30d,
  us.volume_90d,
  us.volume_365d,
  us.volume_all,
  us.consistency_90d,
  us.active_days_90d,
  us.median_churn_90d,
  us.p95_churn_90d,
  us.badge,
  us.badge_tier,
  us.is_dormant,
  us.days_since_first_commit,
  u.is_workspace_member,
  1 AS attached_user_count
FROM "bbstat"."user_score" us
JOIN "bbstat"."users" u ON u.id = us.user_id
WHERE u.person_id IS NULL;
