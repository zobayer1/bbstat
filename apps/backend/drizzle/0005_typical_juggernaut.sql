ALTER TABLE "sync_state" ADD COLUMN "deepen_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "deepen_last_run_at" timestamp with time zone;