CREATE TYPE "bbstat"."user_badge" AS ENUM('fresh_meat', 'deep_diver', 'ai_alex', 'steady_eddie', 'batch_betty', 'cleanup_crew');--> statement-breakpoint
CREATE TABLE "bbstat"."user_score" (
	"user_id" integer PRIMARY KEY NOT NULL,
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
	"is_dormant" boolean DEFAULT false NOT NULL,
	"days_since_first_commit" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bbstat"."commit_daily" ADD COLUMN "merge_commit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bbstat"."user_score" ADD CONSTRAINT "user_score_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bbstat"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_score_trending_idx" ON "bbstat"."user_score" USING btree ("score_trending" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_score_volume_30d_idx" ON "bbstat"."user_score" USING btree ("volume_30d" DESC NULLS LAST);