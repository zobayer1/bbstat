-- BBSTAT initial schema.
--
-- Mirrors apps/backend/drizzle/0000_spicy_star_brand.sql but in
-- Flyway-style naming and tool-agnostic SQL (no Drizzle migrator
-- markers). See apps/backend/schema/README.md for the convention.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."pull_request_state" AS ENUM ('OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED');

CREATE TYPE "public"."sync_status" AS ENUM ('idle', 'running', 'success', 'failed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"bitbucket_uuid" text NOT NULL,
	"display_name" text NOT NULL,
	"username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_bitbucket_uuid_unique" UNIQUE ("bitbucket_uuid")
);

-- `repositories` represents the curated tracked set — only repos in this
-- table are ingested by sync workers. Untracked repos in the workspace are
-- simply absent.
CREATE TABLE "repositories" (
	"id" serial PRIMARY KEY NOT NULL,
	"bitbucket_uuid" text NOT NULL,
	"workspace" text NOT NULL,
	"project" text,
	"slug" text NOT NULL,
	"full_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_bitbucket_uuid_unique" UNIQUE ("bitbucket_uuid")
);

CREATE TABLE "commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"author_user_id" integer,
	"sha" text NOT NULL,
	"message" text NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"authored_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"name" text NOT NULL,
	"target_sha" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_id" integer NOT NULL,
	"bitbucket_pr_id" integer NOT NULL,
	"title" text NOT NULL,
	"state" "pull_request_state" NOT NULL,
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

-- One row per tracked repository. Holds the commit-pull cursor and the
-- outcome of the last sync attempt. Manual, cron, and webhook triggers all
-- converge on the same row.
CREATE TABLE "sync_state" (
	"repository_id" integer PRIMARY KEY NOT NULL,
	"last_seen_sha" text,
	"last_synced_at" timestamp with time zone,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_status" "sync_status" DEFAULT 'idle' NOT NULL,
	"last_sync_error" text,
	"total_commits_synced" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "commits"
	ADD CONSTRAINT "commits_repository_id_repositories_id_fk"
	FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
	ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "commits"
	ADD CONSTRAINT "commits_author_user_id_users_id_fk"
	FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id")
	ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "branches"
	ADD CONSTRAINT "branches_repository_id_repositories_id_fk"
	FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
	ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "pull_requests"
	ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk"
	FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
	ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "pull_requests"
	ADD CONSTRAINT "pull_requests_author_user_id_users_id_fk"
	FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id")
	ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "sync_state"
	ADD CONSTRAINT "sync_state_repository_id_repositories_id_fk"
	FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id")
	ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX "commits_sha_repo_idx" ON "commits" USING btree ("repository_id", "sha");

CREATE INDEX "commits_author_authored_idx" ON "commits" USING btree ("author_user_id", "authored_at");

CREATE UNIQUE INDEX "branches_repo_name_unique" ON "branches" USING btree ("repository_id", "name");

CREATE UNIQUE INDEX "pull_requests_repo_pr_unique" ON "pull_requests" USING btree ("repository_id", "bitbucket_pr_id");

CREATE INDEX "pull_requests_repo_state_idx" ON "pull_requests" USING btree ("repository_id", "state");

CREATE INDEX "pull_requests_author_updated_idx" ON "pull_requests" USING btree ("author_user_id", "bitbucket_updated_at");
