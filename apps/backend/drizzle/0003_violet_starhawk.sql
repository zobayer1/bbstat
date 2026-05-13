ALTER TABLE "commits" ADD COLUMN "diff_stats_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "diff_stats_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "commits_pending_diff_stats_idx" ON "commits" USING btree ("repository_id") WHERE "commits"."diff_stats_synced_at" IS NULL;