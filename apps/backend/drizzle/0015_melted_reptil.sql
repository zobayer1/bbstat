ALTER TABLE "commits" ADD COLUMN "author_email" text;--> statement-breakpoint
ALTER TABLE "commits" ADD COLUMN "author_display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_workspace_member" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- One-shot backfill: every user that exists pre-migration was inserted by
-- syncWorkspaceMembers (the only writer before this migration), so they
-- are all current workspace members at this point in time. Mark them as
-- such; the default `false` is the right value for future auto-creates
-- via the commit-ingest path landing in this PR. Idempotent — re-running
-- is a no-op.
UPDATE "users" SET "is_workspace_member" = true;