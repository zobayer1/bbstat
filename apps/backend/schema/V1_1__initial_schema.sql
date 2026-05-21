-- BBSTAT initial schema (post-rename to `bbstat`).
--
-- Mirrors apps/backend/drizzle/0000_old_power_pack.sql in Flyway-style
-- naming and tool-agnostic SQL (no Drizzle migrator markers). See
-- apps/backend/schema/README.md for the convention. The V1_1..V1_17
-- chain that lived here before is collapsed into this single file —
-- those incremental migrations were never applied in production (the
-- rename rebases the lineage), and the Drizzle migrator already only
-- ships the current 0000_*.sql in the runtime image. If a future
-- change needs an incremental migration on top of this base, add it as
-- V1_2__<desc>.sql alongside the Drizzle output for that change.

CREATE SCHEMA "bbstat";

CREATE TYPE "bbstat"."pull_request_state" AS ENUM('OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED');
CREATE TYPE "bbstat"."sync_status" AS ENUM('idle', 'running', 'success', 'failed');
CREATE TABLE "bbstat"."branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"name" text NOT NULL,
	"target_sha" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "bbstat"."commit_daily" (
	"day" date NOT NULL,
	"repository_id" integer NOT NULL,
	"author_user_id" integer,
	"commit_count" integer DEFAULT 0 NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_daily_day_repo_user_unique" UNIQUE NULLS NOT DISTINCT("day","repository_id","author_user_id")
);

CREATE TABLE "bbstat"."commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"author_user_id" integer,
	"sha" text NOT NULL,
	"message" text NOT NULL,
	"is_merge" boolean DEFAULT false NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"files_changed" integer DEFAULT 0 NOT NULL,
	"diff_stats_failure_count" integer DEFAULT 0 NOT NULL,
	"diff_stats_synced_at" timestamp with time zone,
	"author_email" text,
	"author_display_name" text,
	"authored_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', message)) STORED
);

CREATE TABLE "bbstat"."pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"bitbucket_pr_id" integer NOT NULL,
	"title" text NOT NULL,
	"state" "bbstat"."pull_request_state" NOT NULL,
	"author_user_id" integer,
	"source_branch" text NOT NULL,
	"destination_branch" text NOT NULL,
	"source_sha" text,
	"destination_sha" text,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"task_count" integer DEFAULT 0 NOT NULL,
	"bitbucket_created_at" timestamp with time zone NOT NULL,
	"bitbucket_updated_at" timestamp with time zone NOT NULL,
	"bitbucket_closed_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "bbstat"."repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"bitbucket_uuid" text NOT NULL,
	"workspace" text NOT NULL,
	"project" text,
	"slug" text NOT NULL,
	"full_name" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sync_excluded" boolean DEFAULT false NOT NULL,
	"sync_exclude_reason" text,
	"diff_stats_exclude_patterns" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_bitbucket_uuid_unique" UNIQUE("bitbucket_uuid")
);

CREATE TABLE "bbstat"."sync_state" (
	"repository_id" integer PRIMARY KEY NOT NULL,
	"last_seen_sha" text,
	"last_synced_at" timestamp with time zone,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_status" "bbstat"."sync_status" DEFAULT 'idle' NOT NULL,
	"last_sync_error" text,
	"total_commits_synced" integer DEFAULT 0 NOT NULL,
	"last_pr_updated_at" timestamp with time zone,
	"last_pr_id" integer,
	"pr_last_synced_at" timestamp with time zone,
	"pr_total_synced" integer DEFAULT 0 NOT NULL,
	"deepen_complete" boolean DEFAULT false NOT NULL,
	"deepen_last_run_at" timestamp with time zone,
	"is_merge_backfill_complete" boolean DEFAULT false NOT NULL,
	"is_merge_backfill_cursor_sha" text,
	"is_merge_last_run_at" timestamp with time zone,
	"anonymous_sweep_complete" boolean DEFAULT false NOT NULL,
	"anonymous_sweep_last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "bbstat"."users" (
	"id" serial PRIMARY KEY NOT NULL,
	"bitbucket_uuid" text NOT NULL,
	"display_name" text NOT NULL,
	"username" text,
	"email" text,
	"is_workspace_member" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_bitbucket_uuid_unique" UNIQUE("bitbucket_uuid")
);

ALTER TABLE "bbstat"."branches" ADD CONSTRAINT "branches_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "bbstat"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "bbstat"."commit_daily" ADD CONSTRAINT "commit_daily_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "bbstat"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "bbstat"."commit_daily" ADD CONSTRAINT "commit_daily_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "bbstat"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "bbstat"."commits" ADD CONSTRAINT "commits_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "bbstat"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "bbstat"."commits" ADD CONSTRAINT "commits_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "bbstat"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "bbstat"."pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "bbstat"."repositories"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "bbstat"."pull_requests" ADD CONSTRAINT "pull_requests_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "bbstat"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "bbstat"."sync_state" ADD CONSTRAINT "sync_state_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "bbstat"."repositories"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "branches_repo_name_unique" ON "bbstat"."branches" USING btree ("repository_id","name");
CREATE INDEX "commit_daily_repo_day_idx" ON "bbstat"."commit_daily" USING btree ("repository_id","day");
CREATE INDEX "commit_daily_user_day_idx" ON "bbstat"."commit_daily" USING btree ("author_user_id","day");
CREATE UNIQUE INDEX "commits_sha_repo_unique" ON "bbstat"."commits" USING btree ("repository_id","sha");
CREATE INDEX "commits_author_authored_idx" ON "bbstat"."commits" USING btree ("author_user_id","authored_at");
CREATE INDEX "commits_pending_diff_stats_idx" ON "bbstat"."commits" USING btree ("repository_id") WHERE "bbstat"."commits"."diff_stats_synced_at" IS NULL;
CREATE INDEX "commits_message_tsv_idx" ON "bbstat"."commits" USING gin ("message_tsv");
CREATE INDEX "commits_sha_prefix_idx" ON "bbstat"."commits" USING btree ("sha" text_pattern_ops);
CREATE UNIQUE INDEX "pull_requests_repo_pr_unique" ON "bbstat"."pull_requests" USING btree ("repository_id","bitbucket_pr_id");
CREATE INDEX "pull_requests_repo_state_idx" ON "bbstat"."pull_requests" USING btree ("repository_id","state");
CREATE INDEX "pull_requests_author_updated_idx" ON "bbstat"."pull_requests" USING btree ("author_user_id","bitbucket_updated_at");