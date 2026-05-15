ALTER TABLE "repositories" ADD COLUMN "sync_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "is_merge_backfill_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "is_merge_backfill_cursor_sha" text;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "is_merge_last_run_at" timestamp with time zone;