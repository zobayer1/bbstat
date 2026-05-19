-- Mirrors apps/backend/drizzle/0015_melted_reptil.sql.
--
-- Three related additions that enable full historical attribution for
-- contributors who weren't workspace members at commit-ingest time
-- (ex-employees, never-members, external pushers to public repos):
--
--   1. `commits.author_email` + `commits.author_display_name` — snapshot
--      columns populated at ingest from BB's `author.raw` and
--      `author.user.display_name`. Both nullable: NULL when BB doesn't
--      carry enough metadata or `parseAuthorEmail` filters the address
--      out (e.g. noreply). Lives on the commit (not just on `users`)
--      so it survives user-row drift and so anonymous rows still
--      carry the email/name they were pushed with — leaves a hook for
--      future reprocessing.
--
--   2. `users.is_workspace_member` — distinguishes member-sync-discovered
--      rows (TRUE — currently in `/workspaces/{ws}/members`) from
--      commit-ingest-auto-created rows (FALSE — ex-employees, externals).
--      Member sync flips this back to TRUE whenever a previously
--      auto-created user rejoins the workspace.
--
--   3. One-shot UPDATE seeding existing users as TRUE. Every row in the
--      table at migration time was inserted by `syncWorkspaceMembers`
--      (the only writer before this migration), so they're all current
--      members at the moment we cut over. The default `false` is then
--      the right value for future auto-creates via the new commit-
--      ingest path. Idempotent — re-running is a no-op.

ALTER TABLE "commits"
  ADD COLUMN "author_email" text;

ALTER TABLE "commits"
  ADD COLUMN "author_display_name" text;

ALTER TABLE "users"
  ADD COLUMN "is_workspace_member" boolean DEFAULT false NOT NULL;

UPDATE "users" SET "is_workspace_member" = true;
