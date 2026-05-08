DROP INDEX "commits_sha_repo_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "commits_sha_repo_unique" ON "commits" USING btree ("repository_id","sha");