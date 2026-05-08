-- Tighten commits(repository_id, sha) from a regular btree index to a UNIQUE
-- index, enabling idempotent bulk upserts via ON CONFLICT DO NOTHING in the
-- commit-ingest pipeline. Same column order, same lookup semantics — only
-- the uniqueness constraint changes.

DROP INDEX "commits_sha_repo_idx";

CREATE UNIQUE INDEX "commits_sha_repo_unique" ON "commits" USING btree ("repository_id", "sha");
