ALTER TABLE "commits" ADD COLUMN "message_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', message)) STORED;--> statement-breakpoint
CREATE INDEX "commits_message_tsv_idx" ON "commits" USING gin ("message_tsv");--> statement-breakpoint
CREATE INDEX "commits_sha_prefix_idx" ON "commits" USING btree ("sha" text_pattern_ops);