CREATE TABLE "bbstat"."people" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bbstat"."person_score" (
	"person_id" integer PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"commits_eligible" integer DEFAULT 0 NOT NULL,
	"commits_total" integer DEFAULT 0 NOT NULL,
	"coverage_pct" double precision DEFAULT 0 NOT NULL,
	"p95_churn_cap" integer DEFAULT 0 NOT NULL,
	"score_trending" double precision DEFAULT 0 NOT NULL,
	"volume_7d" double precision DEFAULT 0 NOT NULL,
	"volume_30d" double precision DEFAULT 0 NOT NULL,
	"volume_90d" double precision DEFAULT 0 NOT NULL,
	"volume_365d" double precision DEFAULT 0 NOT NULL,
	"volume_all" double precision DEFAULT 0 NOT NULL,
	"consistency_90d" double precision,
	"active_days_90d" integer DEFAULT 0 NOT NULL,
	"median_churn_90d" integer DEFAULT 0 NOT NULL,
	"p95_churn_90d" integer DEFAULT 0 NOT NULL,
	"badge" "bbstat"."user_badge",
	"badge_tier" "bbstat"."user_badge_tier",
	"is_dormant" boolean DEFAULT false NOT NULL,
	"days_since_first_commit" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bbstat"."users" ADD COLUMN "person_id" integer;--> statement-breakpoint
ALTER TABLE "bbstat"."users" ADD COLUMN "is_primary_for_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bbstat"."person_score" ADD CONSTRAINT "person_score_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "bbstat"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_score_trending_idx" ON "bbstat"."person_score" USING btree ("score_trending" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "person_score_volume_30d_idx" ON "bbstat"."person_score" USING btree ("volume_30d" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "bbstat"."users" ADD CONSTRAINT "users_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "bbstat"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_person_id_idx" ON "bbstat"."users" USING btree ("person_id") WHERE "bbstat"."users"."person_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_primary_per_person_idx" ON "bbstat"."users" USING btree ("person_id") WHERE "bbstat"."users"."is_primary_for_person" = true AND "bbstat"."users"."person_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "bbstat"."users" ADD CONSTRAINT "users_primary_requires_person" CHECK (NOT "is_primary_for_person" OR "person_id" IS NOT NULL);--> statement-breakpoint
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