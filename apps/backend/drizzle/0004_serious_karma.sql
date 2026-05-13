ALTER TABLE "sync_state" ADD COLUMN "last_pr_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "last_pr_id" integer;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "pr_last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "pr_total_synced" integer DEFAULT 0 NOT NULL;