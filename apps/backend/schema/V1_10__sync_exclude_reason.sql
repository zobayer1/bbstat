-- Auto-exclusion reason for repositories.sync_excluded.
--
-- NULL when the row is not excluded (or excluded with no reason recorded).
-- Populated string when set by the sync layer's auto-trip paths. Allowed
-- values today (extend as new trip causes are added):
--
--   'repo-404'           — BB 404 on the /commits endpoint; repo was
--                          renamed or deleted upstream. Operator
--                          recovers via POST /repositories/:ws/:slug/rename
--                          (which re-resolves UUID and clears the flag)
--                          or DELETE /repositories/:ws/:slug.
--   'empty-on-bitbucket' — cold-mode + deepen converged with zero
--                          commits. BB has the repo but it's empty.
--                          Recovers via /include when commits eventually
--                          appear.
--   'history-rewritten'  — delta sync walked BB's full main-branch
--                          history without finding our last_seen_sha
--                          (force-push). Recovers via /include, which
--                          also resets the cursor for a clean cold sync.
--
-- Existing rows default to NULL (none are excluded yet).

ALTER TABLE "repositories"
	ADD COLUMN "sync_exclude_reason" text;
