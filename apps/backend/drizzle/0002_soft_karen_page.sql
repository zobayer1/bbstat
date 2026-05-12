CREATE TABLE "commit_daily" (
	"day" date NOT NULL,
	"repository_id" integer NOT NULL,
	"author_user_id" integer,
	"commit_count" integer DEFAULT 0 NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commit_daily_day_repo_user_unique" UNIQUE NULLS NOT DISTINCT("day","repository_id","author_user_id")
);
--> statement-breakpoint
ALTER TABLE "commit_daily" ADD CONSTRAINT "commit_daily_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commit_daily" ADD CONSTRAINT "commit_daily_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commit_daily_repo_day_idx" ON "commit_daily" USING btree ("repository_id","day");--> statement-breakpoint
CREATE INDEX "commit_daily_user_day_idx" ON "commit_daily" USING btree ("author_user_id","day");--> statement-breakpoint
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