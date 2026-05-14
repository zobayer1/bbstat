ALTER TABLE "commits" ADD COLUMN "is_merge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commits" ADD COLUMN "files_changed" integer DEFAULT 0 NOT NULL;