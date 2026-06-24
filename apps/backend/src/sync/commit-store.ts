// Storage interface for commit-ingest operations. commits.ts injects a
// CommitStore (real or fake) so it stays testable without Postgres.
//
// Idempotency: insertCommits uses ON CONFLICT … DO UPDATE with a narrow
// `commits.author_user_id IS NULL AND EXCLUDED.author_user_id IS NOT NULL`
// guard — re-running a racing sync never errors, duplicates, or overwrites
// an established attribution, but DOES fill attribution for rows that were
// previously anonymous (e.g. BB later linked the author's email to a member).

import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commitDaily, commits, repositories, syncState, users } from '../db/schema.js';

export type SyncStatus = 'idle' | 'running' | 'success' | 'failed';

// Per-commit failure budget for `/diffstat/<sha>` fetches. Cross this many
// cumulative failures and the orchestrator stops re-queueing the commit.
// Exported so the orchestrator and the pickup queries agree on one number.
//
// Weight scheme (`incrementDiffStatsFailure`): generic 5xx adds 1 per failed
// tick, HTTP 555 adds 3 — a 555 crosses immediately because that class of
// failure is persistent for the commit shape; a flaky 500/502/503 gets three
// chances.
export const DIFF_STATS_FAILURE_THRESHOLD = 3;

export interface CommitInsertInput {
  repositoryId: number;
  authorUserId: number | null;
  sha: string;
  message: string;
  isMerge: boolean;
  authoredAt: Date;
  // Snapshot columns from BB's `author.raw`. Both may be NULL when BB
  // lacks metadata or the email is synthetic/noreply-filtered. Captured
  // at first ingest only — the ON CONFLICT path leaves them alone so the
  // value reflects what was pushed at the time, not what BB returns now.
  authorEmail: string | null;
  authorDisplayName: string | null;
}

export interface CommitInsertResult {
  inserted: number;
  // Rows that landed in the table on this call. The inline-eager
  // diff-stats path fetches /diffstat for these without re-querying.
  insertedRows: InsertedCommitRow[];
  // Rows whose `author_user_id` transitioned NULL → known on this call.
  // Separate from `insertedRows` so the inline-eager diff-stats path
  // stays scoped to new commits, and the rollup hook can refresh
  // commit_daily so the stale `(day, repo, NULL)` row gives way to
  // `(day, repo, user)`.
  reattributedRows: InsertedCommitRow[];
}

export interface InsertedCommitRow {
  id: number;
  sha: string;
  authoredAt: Date;
}

export interface SyncStateRow {
  repositoryId: number;
  lastSeenSha: string | null;
  lastSyncedAt: Date | null;
  lastSyncStartedAt: Date | null;
  lastSyncStatus: SyncStatus;
  lastSyncError: string | null;
  totalCommitsSynced: number;
}

export interface SyncSuccessUpdate {
  // null leaves the cursor untouched — a clean run that produced no new
  // commits still records a successful tick.
  lastSeenSha: string | null;
  commitsAdded: number;
}

export interface PendingDiffStatCommit {
  id: number;
  sha: string;
  authoredAt: Date;
}

// PendingDiffStatCommit plus repo identity for the BB call. Returned by
// the global newest-first pickup the diff-stats backfill tick consumes;
// the per-repo pickup is used only by commit-sync's inline-eager path.
export interface PendingDiffStatCommitWithRepo extends PendingDiffStatCommit {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  excludePatterns: string[];
}

export interface CommitStore {
  // Resolve BB user UUIDs to local users.id. Missing UUIDs (anonymous
  // commits, users not yet synced) are absent from the map; callers
  // translate that to author_user_id = null, or hand the unresolved UUIDs
  // to `upsertAuthorUsers`.
  resolveUserIdsByUuid(uuids: string[]): Promise<Map<string, number>>;

  // Bulk auto-create user rows for BB UUIDs not in our `users` table —
  // ex-employees, never-members, external pushers. INSERTed rows land
  // with `is_workspace_member = false`; existing rows are never touched
  // (keeps member-sync's TRUE intact, preserves write-once email). Each
  // entry MUST carry a parseable email (caller enforces): no auto-create
  // without a real email. Returns bitbucket_uuid → users.id for every
  // input so the caller resolves attribution without a follow-up SELECT.
  upsertAuthorUsers(
    inputs: Array<{ bitbucketUuid: string; displayName: string; email: string }>,
  ): Promise<Map<string, number>>;

  // Write-once email capture from commits.author.raw: sets users.email
  // only when currently NULL ("first observed wins"), keeping things
  // stable for developers committing from multiple machines. UUIDs not in
  // the table are silently skipped. Parsing + noreply filtering happens
  // upstream (src/sync/author-email.ts).
  setUserEmailsIfMissing(entries: Array<{ bitbucketUuid: string; email: string }>): Promise<void>;

  // Email backfill seed list: every user whose email IS NULL with the
  // (workspace, slug, sha) of their most recent ingested commit, capped
  // by `limit`. Archived / sync-excluded repos are filtered out —
  // fetching against them is unreliable, and the user's next live commit
  // in a healthy repo captures their email anyway.
  listUsersMissingEmailWithLastCommit(limit: number): Promise<
    Array<{
      userId: number;
      bitbucketUuid: string;
      workspace: string;
      slug: string;
      sha: string;
    }>
  >;

  // Reattribution backfill seed list: anonymous commits
  // (`author_user_id IS NULL`) in non-archived / non-excluded repos,
  // newest-authored first, capped by `limit`, with repo identity for the
  // BB lookup. `opts.workspace` + `opts.slug` must both be set (scopes to
  // one repo) or both omitted (caller enforces).
  listAnonymousCommits(opts: { workspace?: string; slug?: string; limit: number }): Promise<
    Array<{
      commitId: number;
      sha: string;
      repositoryId: number;
      workspace: string;
      slug: string;
      fullName: string;
      authoredAt: Date;
    }>
  >;

  // Bulk reattribute previously-anonymous commits to a user. Each entry
  // is a BB-confirmed (commitId, userId) pair. Guarded by `author_user_id
  // IS NULL` so an established attribution (or a concurrent commit-sync
  // landing first) is never overwritten — race-safe. Only touches
  // `author_user_id`, so diff-stats columns are untouched and this costs
  // zero `/diffstat` calls. Returns updated rows so the caller can scope
  // the `commit_daily` recompute.
  reattributeAnonymousCommits(
    entries: Array<{ commitId: number; userId: number }>,
  ): Promise<Array<{ id: number; repositoryId: number; authoredAt: Date }>>;

  // One-shot SQL backfill of `commits.author_email` +
  // `commits.author_display_name` for attributed rows whose snapshot
  // columns are NULL (typically pre-V1_16 commits). Pulls from the linked
  // `users` row, no BB call. COALESCE fills each column independently so
  // partial pre-existing data isn't clobbered. Idempotent. Anonymous rows
  // are skipped — they need the BB-walk path. Returns the row count.
  backfillAuthorSnapshotsFromUsers(): Promise<{ updated: number }>;

  // Bulk upsert commits. Conflicts on (repository_id, sha) trigger a
  // narrow DO UPDATE that fills `author_user_id` only when stored IS NULL
  // and incoming IS NOT NULL — never overwrites established attribution.
  // Everything else is immutable, so re-runs converge. `xmax = 0` splits
  // truly-inserted rows from reattributed ones in the RETURNING tuple.
  insertCommits(input: CommitInsertInput[]): Promise<CommitInsertResult>;

  getSyncState(repositoryId: number): Promise<SyncStateRow | null>;
  markSyncRunning(repositoryId: number): Promise<void>;
  markSyncSuccess(repositoryId: number, update: SyncSuccessUpdate): Promise<void>;
  markSyncFailed(repositoryId: number, error: string): Promise<void>;

  // History-rewrite reconciliation support (see src/sync/reconcile.ts).
  //
  // Newest-authored-first window of `{ sha, authoredAt }`, capped at
  // `limit`. reconcile diffs this against BB's current head window to
  // locate the common ancestor and orphaned (rewritten-away) shas —
  // bounded so a deep force-push doesn't pull the whole table.
  listRecentCommitShas(repositoryId: number, limit: number): Promise<Array<{ sha: string; authoredAt: Date }>>;
  // Hard-delete the named shas; returns the row count. Used only by
  // reconcile to prune orphans no longer reachable on BB.
  deleteCommitsByShas(repositoryId: number, shas: string[]): Promise<number>;
  // Re-anchor `last_seen_sha` to a known-good ancestor WITHOUT marking a
  // sync success — reconcile sets the delta cursor here, then re-runs the
  // normal commit sync to ingest only the commits above the ancestor.
  setLastSeenSha(repositoryId: number, sha: string): Promise<void>;

  // Per-repo pickup of `diff_stats_synced_at IS NULL` commits, newest
  // first, capped at `limit`. Used only by commit-sync's inline-eager
  // path; the global backfill tick uses listPendingDiffStatCommitsGlobal.
  listPendingDiffStatCommits(repositoryId: number, limit: number): Promise<PendingDiffStatCommit[]>;

  // Global newest-first pickup across non-archived non-excluded repos,
  // each row carrying repo identity so the diff-stat walker can fan out
  // without further lookups. Powers "freshness-first round-robin": a repo
  // with 5000 pending commits no longer monopolizes a tick.
  listPendingDiffStatCommitsGlobal(limit: number): Promise<PendingDiffStatCommitWithRepo[]>;

  // Persist BB-derived additions / deletions / files_changed for one
  // commit and stamp diff_stats_synced_at so it drops out of the next
  // pickup. Idempotent.
  updateCommitDiffStats(
    commitId: number,
    input: { additions: number; deletions: number; filesChanged: number },
  ): Promise<void>;

  // Increment the per-commit `diff_stats_failure_count` by `weight`,
  // called from the orchestrator's catch block after its in-tick retry
  // budget is exhausted. Generic 5xx uses weight=1; HTTP 555 (BB compute
  // timeout) uses weight=3 so a single strike crosses the threshold —
  // that failure class is persistent for the commit shape. Returns the
  // post-increment count.
  incrementDiffStatsFailure(commitId: number, weight: number): Promise<number>;

  // Oldest known commit (authored_at ASC), the seed sha for
  // deepen-backfill's `include=<sha>` walk. Null when no commits ingested.
  getOldestCommitSha(repositoryId: number): Promise<string | null>;

  // Deepen-backfill queue pick: ORDER BY deepen_last_run_at NULLS FIRST
  // (never-attempted first, then round-robin by staleness). Null when
  // every repo has deepen_complete = true.
  pickRepoForDeepening(): Promise<DeepenCandidate | null>;

  // Stamps deepen_last_run_at without changing deepen_complete. Called
  // even on no-op runs so the round-robin advances.
  markDeepenAttempt(repositoryId: number): Promise<void>;

  // Flips deepen_complete = true. Called once BB returns no `next` URL
  // (reached the first commit) or on a 404 against the seed sha
  // (force-pushed history).
  markDeepenComplete(repositoryId: number): Promise<void>;

  // One-shot retroactive backfill of the `is_merge` column. Bulk UPDATE
  // keyed by sha — shas not found are silently skipped (the caller's list
  // may include not-yet-ingested commits past our deepen boundary).
  // Returns updated rows. Idempotent.
  updateIsMergeBatch(
    repositoryId: number,
    entries: Array<{ sha: string; isMerge: boolean }>,
  ): Promise<{ updated: number }>;

  // is_merge backfill queue pick: next incomplete repo, round-robin by
  // `is_merge_last_run_at ASC NULLS FIRST`, with the resume cursor. Null
  // when every non-archived non-excluded repo is complete.
  pickRepoForIsMergeBackfill(): Promise<IsMergeBackfillCandidate | null>;

  // Bumps `is_merge_last_run_at` without touching cursor or complete flag,
  // so the round-robin advances even on a no-op tick.
  markIsMergeBackfillAttempt(repositoryId: number): Promise<void>;

  // Advances `is_merge_backfill_cursor_sha` to the oldest sha verified on
  // this tick (page cap fired, more history remains). Leaves complete alone.
  advanceIsMergeBackfillCursor(repositoryId: number, cursorSha: string): Promise<void>;

  // Flips `is_merge_backfill_complete = true`. Called when the paginator
  // exhausted without hitting the page cap, or when the cursor sha 404's
  // (force-pushed history — give up, mirrors deepen seedMissing).
  markIsMergeBackfillComplete(repositoryId: number): Promise<void>;

  // Total anonymous commits across non-archived non-excluded repos. The
  // anonymous-sweep runner exits when this hits zero.
  countAnonymousCommits(): Promise<number>;

  // Anonymous-sweep queue pick: next repo with at least one anonymous
  // commit AND `anonymous_sweep_complete = false`, round-robin by
  // `anonymous_sweep_last_run_at ASC NULLS FIRST`. Null when every
  // eligible repo is complete or has zero anonymous commits.
  pickRepoForAnonymousSweep(): Promise<AnonymousSweepCandidate | null>;

  // Bumps `anonymous_sweep_last_run_at` without changing complete, so the
  // round-robin advances even on a no-op (e.g. BB rate-limited mid-walk).
  markAnonymousSweepAttempt(repositoryId: number): Promise<void>;

  // Flips `anonymous_sweep_complete = true`. Called when a sweep pass
  // attributed zero rows (residual is structurally anonymous) or BB 404'd.
  // Operator can UPDATE back to FALSE to re-arm.
  markAnonymousSweepComplete(repositoryId: number): Promise<void>;

  // Bulk apply attribution + snapshot updates from a sweep pass.
  // `author_user_id` is overwritten only where the row is still anonymous
  // (WHERE author_user_id IS NULL) so a concurrent commit-sync that lands
  // first wins — race-safe. Snapshot columns use COALESCE to preserve
  // pre-existing values. Returns visited rows with a post-UPDATE
  // `attributed` flag so the caller scopes the commit_daily recompute to
  // rows that transitioned NULL → known.
  bulkUpdateAnonymousAttribution(
    entries: Array<{
      commitId: number;
      userId: number | null;
      email: string | null;
      displayName: string | null;
    }>,
  ): Promise<Array<{ id: number; repositoryId: number; authoredAt: Date; attributed: boolean }>>;

  // Reset the commit-sync cursor + deepen state to cold-mode defaults.
  // Used after a sync_excluded recovery so the next tick starts fresh — a
  // stale last_seen_sha would just re-trip the history-rewritten exclusion.
  // Clears last_seen_sha, deepen_complete, is_merge_backfill_complete,
  // is_merge_backfill_cursor_sha. Does NOT touch commits or
  // total_commits_synced (monotonic / observational).
  resetSyncCursors(repositoryId: number): Promise<void>;

  // Re-arm diff-stat backfill: zeros line counts, clears
  // `diff_stats_synced_at`, resets `diff_stats_failure_count` to zero, and
  // zeros the `commit_daily` aggregates so the dashboard shows
  // clearly-wrong (zero) rather than subtly-wrong (mixed) during the drain.
  //
  // The failure-count reset is what re-arms previously gave-up'd commits —
  // otherwise the pickup's `failure_count < 3` predicate would still
  // filter them out and the reset would silently no-op on those rows.
  //
  // Single transaction so the dashboard never observes a partial state.
  // Returns the count of commits re-queued for backfill.
  resetDiffStatsForRepo(repositoryId: number): Promise<{ resetCount: number }>;
}

export interface DeepenCandidate {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  // Seed sha for the deepen walk (oldest known commit). Null only when
  // the repo has zero commits ingested (cold mode hasn't run).
  oldestSha: string | null;
  // repositories.created_at. Anchors the empty-repo exclusion grace
  // period: a freshly-added repo still empty on BB stays in active sync
  // until this is older than the grace window, so a repo created moments
  // before its first push isn't excluded in the gap. Optional because the
  // explicit-repo admin path (forced deepen) doesn't carry it.
  createdAt?: Date;
}

export interface AnonymousSweepCandidate {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
}

export interface IsMergeBackfillCandidate {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  // Resume cursor: oldest sha previously verified. NULL = cold (start
  // newest, no `include`). Set = `include=<cursorSha>`, then skip the
  // seed sha (already verified).
  cursorSha: string | null;
}

export function createDrizzleCommitStore(db: Database): CommitStore {
  return {
    async resolveUserIdsByUuid(uuids) {
      if (uuids.length === 0) return new Map();
      const rows = await db
        .select({ id: users.id, uuid: users.bitbucketUuid })
        .from(users)
        .where(inArray(users.bitbucketUuid, uuids));
      return new Map(rows.map((r) => [r.uuid, r.id]));
    },

    async upsertAuthorUsers(inputs) {
      if (inputs.length === 0) return new Map();
      // `SET bitbucket_uuid = EXCLUDED.bitbucket_uuid` is the PG trick for
      // DO-NOTHING-but-still-RETURNING: it touches no mutable column, so
      // display_name / username / email / is_workspace_member on an
      // existing row are never overwritten — keeps member-sync's TRUE
      // intact and preserves write-once email.
      //
      // Dedupe by UUID first: duplicate VALUES rows for one uuid trip ON
      // CONFLICT's "command cannot affect row a second time" rule. All
      // values for one uuid carry equivalent data, so first-wins is fine.
      const byUuid = new Map<string, { displayName: string; email: string }>();
      for (const e of inputs) {
        if (!byUuid.has(e.bitbucketUuid)) {
          byUuid.set(e.bitbucketUuid, { displayName: e.displayName, email: e.email });
        }
      }
      const tuples = sql.join(
        Array.from(
          byUuid,
          ([uuid, v]) => sql`(${uuid}::text, ${v.displayName}::text, ${v.email}::text, false::boolean)`,
        ),
        sql`, `,
      );
      const result = await db.execute<{ id: number; bitbucket_uuid: string }>(sql`
        INSERT INTO users (bitbucket_uuid, display_name, email, is_workspace_member)
        VALUES ${tuples}
        ON CONFLICT (bitbucket_uuid) DO UPDATE
          SET bitbucket_uuid = EXCLUDED.bitbucket_uuid
        RETURNING id, bitbucket_uuid
      `);
      return new Map(result.rows.map((r) => [r.bitbucket_uuid, r.id]));
    },

    async listUsersMissingEmailWithLastCommit(limit) {
      // DISTINCT ON (author_user_id) picks the newest commit per user in
      // one pass, backed by commits_author_authored_idx — the planner
      // short-circuits per user on the first row.
      const rows = await db.execute<{
        user_id: number;
        bitbucket_uuid: string;
        workspace: string;
        slug: string;
        sha: string;
      }>(sql`
        SELECT DISTINCT ON (c.author_user_id)
          u.id           AS user_id,
          u.bitbucket_uuid,
          r.workspace,
          r.slug,
          c.sha
        FROM users u
        JOIN commits c       ON c.author_user_id = u.id
        JOIN repositories r  ON r.id = c.repository_id
        WHERE u.email IS NULL
          AND r.archived = false
          AND r.sync_excluded = false
        ORDER BY c.author_user_id, c.authored_at DESC
        LIMIT ${limit}::int
      `);
      return rows.rows.map((r) => ({
        userId: r.user_id,
        bitbucketUuid: r.bitbucket_uuid,
        workspace: r.workspace,
        slug: r.slug,
        sha: r.sha,
      }));
    },

    async listAnonymousCommits({ workspace, slug, limit }) {
      // ORDER BY authored_at DESC: a partial run (hit `limit`) leaves the
      // older tail for the next call rather than stranding fresh activity.
      // INNER JOIN to repositories filters archived + sync_excluded and
      // pulls repo identity in one round-trip.
      const scopeBoth = workspace !== undefined && slug !== undefined;
      const rows = await db.execute<{
        commit_id: number;
        sha: string;
        repository_id: number;
        workspace: string;
        slug: string;
        full_name: string;
        authored_at: Date;
      }>(sql`
        SELECT
          c.id           AS commit_id,
          c.sha,
          r.id           AS repository_id,
          r.workspace,
          r.slug,
          r.full_name,
          c.authored_at
        FROM commits c
        JOIN repositories r ON r.id = c.repository_id
        WHERE c.author_user_id IS NULL
          AND r.archived = false
          AND r.sync_excluded = false
          ${scopeBoth ? sql`AND r.workspace = ${workspace} AND r.slug = ${slug}` : sql``}
        ORDER BY c.authored_at DESC
        LIMIT ${limit}::int
      `);
      return rows.rows.map((r) => ({
        commitId: r.commit_id,
        sha: r.sha,
        repositoryId: r.repository_id,
        workspace: r.workspace,
        slug: r.slug,
        fullName: r.full_name,
        authoredAt: r.authored_at instanceof Date ? r.authored_at : new Date(r.authored_at),
      }));
    },

    async backfillAuthorSnapshotsFromUsers() {
      // COALESCE updates each column only if currently NULL. The WHERE
      // filters to rows with at least one NULL column AND a fill available
      // (users.email IS NOT NULL; users.display_name is NOT NULL by schema).
      const result = await db.execute(sql`
        UPDATE commits c
        SET
          author_email = COALESCE(c.author_email, u.email),
          author_display_name = COALESCE(c.author_display_name, u.display_name)
        FROM users u
        WHERE c.author_user_id = u.id
          AND (
            (c.author_email IS NULL AND u.email IS NOT NULL)
            OR c.author_display_name IS NULL
          )
      `);
      return { updated: result.rowCount ?? 0 };
    },

    async reattributeAnonymousCommits(entries) {
      if (entries.length === 0) return [];
      // Per-parameter casts: pg-node sends parameters untyped and Postgres
      // infers VALUES column types from the first row only.
      // `commits.author_user_id IS NULL` is load-bearing — established
      // attribution is never overwritten, and a concurrent commit-sync
      // landing first wins. SET touches only author_user_id, so diff-stats
      // columns stay untouched (no /diffstat re-fetch).
      const tuples = sql.join(
        entries.map((e) => sql`(${e.commitId}::int, ${e.userId}::int)`),
        sql`, `,
      );
      const result = await db.execute<{
        id: number;
        repository_id: number;
        authored_at: Date;
      }>(sql`
        UPDATE commits
        SET author_user_id = data.user_id
        FROM (VALUES ${tuples}) AS data(commit_id, user_id)
        WHERE commits.id = data.commit_id
          AND commits.author_user_id IS NULL
        RETURNING commits.id, commits.repository_id, commits.authored_at
      `);
      return result.rows.map((r) => ({
        id: r.id,
        repositoryId: r.repository_id,
        authoredAt: r.authored_at instanceof Date ? r.authored_at : new Date(r.authored_at),
      }));
    },

    async setUserEmailsIfMissing(entries) {
      if (entries.length === 0) return;
      // Dedupe by uuid — duplicate VALUES rows for one uuid are wasted work.
      const byUuid = new Map<string, string>();
      for (const e of entries) {
        if (!byUuid.has(e.bitbucketUuid)) byUuid.set(e.bitbucketUuid, e.email);
      }
      // Per-parameter casts: pg-node sends parameters untyped and Postgres
      // infers VALUES column types from the first row only. `WHERE
      // users.email IS NULL` enforces write-once.
      const tuples = sql.join(
        Array.from(byUuid, ([uuid, email]) => sql`(${uuid}::text, ${email}::text)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE users
        SET email = data.email
        FROM (VALUES ${tuples}) AS data(uuid, email)
        WHERE users.bitbucket_uuid = data.uuid
          AND users.email IS NULL
      `);
    },

    async insertCommits(input) {
      if (input.length === 0) return { inserted: 0, insertedRows: [], reattributedRows: [] };
      // The DO UPDATE WHERE is load-bearing: it fires only when the stored
      // row is anonymous and the incoming row carries a known author, so
      // established attribution is preserved. `(xmax = 0)` distinguishes
      // truly-inserted from updated rows; filtered-out rows don't appear
      // in RETURNING. Per-column casts: pg-node sends parameters untyped
      // and Postgres infers VALUES types from row 0, so an all-NULL
      // author_user_id there would poison the column to text.
      const tuples = sql.join(
        input.map(
          (c) => sql`(
            ${c.repositoryId}::int,
            ${c.authorUserId}::int,
            ${c.sha}::text,
            ${c.message}::text,
            ${c.isMerge}::boolean,
            ${c.authoredAt}::timestamptz,
            ${c.authorEmail}::text,
            ${c.authorDisplayName}::text
          )`,
        ),
        sql`, `,
      );
      // Snapshot columns are captured at first ingest only — the ON
      // CONFLICT path leaves them intact so they reflect what was pushed
      // at the time, not whatever BB returns later.
      const result = await db.execute<{
        id: number;
        sha: string;
        authored_at: Date;
        was_inserted: boolean;
      }>(sql`
        INSERT INTO commits (
          repository_id, author_user_id, sha, message, is_merge, authored_at,
          author_email, author_display_name
        )
        VALUES ${tuples}
        ON CONFLICT (repository_id, sha) DO UPDATE
          SET author_user_id = EXCLUDED.author_user_id
        WHERE commits.author_user_id IS NULL
          AND EXCLUDED.author_user_id IS NOT NULL
        RETURNING id, sha, authored_at, (xmax = 0) AS was_inserted
      `);
      const insertedRows: InsertedCommitRow[] = [];
      const reattributedRows: InsertedCommitRow[] = [];
      for (const r of result.rows) {
        const row: InsertedCommitRow = {
          id: r.id,
          sha: r.sha,
          authoredAt: r.authored_at instanceof Date ? r.authored_at : new Date(r.authored_at),
        };
        if (r.was_inserted) insertedRows.push(row);
        else reattributedRows.push(row);
      }
      return { inserted: insertedRows.length, insertedRows, reattributedRows };
    },

    async getSyncState(repositoryId) {
      const rows = await db
        .select({
          repositoryId: syncState.repositoryId,
          lastSeenSha: syncState.lastSeenSha,
          lastSyncedAt: syncState.lastSyncedAt,
          lastSyncStartedAt: syncState.lastSyncStartedAt,
          lastSyncStatus: syncState.lastSyncStatus,
          lastSyncError: syncState.lastSyncError,
          totalCommitsSynced: syncState.totalCommitsSynced,
        })
        .from(syncState)
        .where(eq(syncState.repositoryId, repositoryId))
        .limit(1);
      return rows[0] ?? null;
    },

    async markSyncRunning(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({
          lastSyncStartedAt: now,
          lastSyncStatus: 'running',
          updatedAt: now,
        })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async markSyncSuccess(repositoryId, update) {
      const now = new Date();
      // Atomic SQL increment — concurrent cron + manual ticks both succeed
      // without losing count to a read-modify-write race.
      const set = {
        lastSyncedAt: now,
        lastSyncStatus: 'success' as const,
        lastSyncError: null,
        updatedAt: now,
        ...(update.lastSeenSha !== null ? { lastSeenSha: update.lastSeenSha } : {}),
        ...(update.commitsAdded > 0
          ? { totalCommitsSynced: sql`${syncState.totalCommitsSynced} + ${update.commitsAdded}` }
          : {}),
      };
      await db.update(syncState).set(set).where(eq(syncState.repositoryId, repositoryId));
    },

    async markSyncFailed(repositoryId, error) {
      const now = new Date();
      await db
        .update(syncState)
        .set({
          lastSyncStatus: 'failed',
          lastSyncError: error,
          updatedAt: now,
        })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async listRecentCommitShas(repositoryId, limit) {
      const rows = await db
        .select({ sha: commits.sha, authoredAt: commits.authoredAt })
        .from(commits)
        .where(eq(commits.repositoryId, repositoryId))
        .orderBy(desc(commits.authoredAt))
        .limit(limit);
      return rows.map((r) => ({
        sha: r.sha,
        authoredAt: r.authoredAt instanceof Date ? r.authoredAt : new Date(r.authoredAt),
      }));
    },

    async deleteCommitsByShas(repositoryId, shas) {
      if (shas.length === 0) return 0;
      // RETURNING shas instead of relying on rowCount keeps the count
      // portable across pg client versions.
      const deleted = await db
        .delete(commits)
        .where(and(eq(commits.repositoryId, repositoryId), inArray(commits.sha, shas)))
        .returning({ sha: commits.sha });
      return deleted.length;
    },

    async setLastSeenSha(repositoryId, sha) {
      await db
        .update(syncState)
        .set({ lastSeenSha: sha, updatedAt: new Date() })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async listPendingDiffStatCommits(repositoryId, limit) {
      const rows = await db
        .select({ id: commits.id, sha: commits.sha, authoredAt: commits.authoredAt })
        .from(commits)
        .where(
          and(
            eq(commits.repositoryId, repositoryId),
            isNull(commits.diffStatsSyncedAt),
            // Belt-and-suspenders alongside the IS NULL check: a manual
            // operator un-stamp still skips give-up'd commits until the
            // counter is reset.
            lt(commits.diffStatsFailureCount, DIFF_STATS_FAILURE_THRESHOLD),
          ),
        )
        .orderBy(desc(commits.authoredAt))
        .limit(limit);
      return rows;
    },

    async listPendingDiffStatCommitsGlobal(limit) {
      // ORDER BY authored_at DESC across the whole pool gives
      // "freshness first": a repo's recent commits jump ahead of any
      // repo's old commits. Backed by the partial index
      // commits_pending_diff_stats_idx (diff_stats_synced_at IS NULL).
      const rows = await db
        .select({
          id: commits.id,
          sha: commits.sha,
          authoredAt: commits.authoredAt,
          repositoryId: repositories.id,
          workspace: repositories.workspace,
          slug: repositories.slug,
          fullName: repositories.fullName,
          excludePatterns: repositories.diffStatsExcludePatterns,
        })
        .from(commits)
        .innerJoin(repositories, eq(repositories.id, commits.repositoryId))
        .where(
          and(
            isNull(commits.diffStatsSyncedAt),
            // Belt-and-suspenders — see listPendingDiffStatCommits.
            lt(commits.diffStatsFailureCount, DIFF_STATS_FAILURE_THRESHOLD),
            eq(repositories.archived, false),
            eq(repositories.syncExcluded, false),
          ),
        )
        .orderBy(desc(commits.authoredAt))
        .limit(limit);
      return rows;
    },

    async updateCommitDiffStats(commitId, input) {
      await db
        .update(commits)
        .set({
          additions: input.additions,
          deletions: input.deletions,
          filesChanged: input.filesChanged,
          diffStatsSyncedAt: new Date(),
        })
        .where(eq(commits.id, commitId));
    },

    async incrementDiffStatsFailure(commitId, weight) {
      // RETURNING the post-increment count lets the caller branch on the
      // threshold without a follow-up SELECT.
      const result = await db.execute<{ diff_stats_failure_count: number }>(sql`
        UPDATE commits
        SET diff_stats_failure_count = diff_stats_failure_count + ${weight}::int
        WHERE id = ${commitId}
        RETURNING diff_stats_failure_count
      `);
      return result.rows[0]?.diff_stats_failure_count ?? 0;
    },

    async getOldestCommitSha(repositoryId) {
      const rows = await db
        .select({ sha: commits.sha })
        .from(commits)
        .where(eq(commits.repositoryId, repositoryId))
        .orderBy(asc(commits.authoredAt))
        .limit(1);
      return rows[0]?.sha ?? null;
    },

    async pickRepoForDeepening() {
      // ORDER BY deepen_last_run_at NULLS FIRST (brand-new entries jump
      // the queue once, then round-robin by staleness). Oldest commit sha
      // pulled in the same shot via a correlated subquery.
      const rows = await db.execute<{
        repository_id: number;
        workspace: string;
        slug: string;
        full_name: string;
        oldest_sha: string | null;
        created_at: string | Date;
      }>(sql`
        SELECT
          s.repository_id,
          r.workspace,
          r.slug,
          r.full_name,
          r.created_at,
          (SELECT sha FROM commits WHERE repository_id = s.repository_id ORDER BY authored_at ASC LIMIT 1) AS oldest_sha
        FROM sync_state s
        JOIN repositories r ON r.id = s.repository_id
        WHERE s.deepen_complete = false
        ORDER BY s.deepen_last_run_at ASC NULLS FIRST
        LIMIT 1
      `);
      const row = rows.rows[0];
      if (row === undefined) return null;
      return {
        repositoryId: row.repository_id,
        workspace: row.workspace,
        slug: row.slug,
        fullName: row.full_name,
        oldestSha: row.oldest_sha,
        createdAt: new Date(row.created_at),
      };
    },

    async markDeepenAttempt(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ deepenLastRunAt: now, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async markDeepenComplete(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ deepenComplete: true, deepenLastRunAt: now, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async pickRepoForIsMergeBackfill() {
      // Mirrors pickRepoForDeepening: round-robin by last_run_at NULLS
      // FIRST, filters archived + sync_excluded.
      const rows = await db.execute<{
        repository_id: number;
        workspace: string;
        slug: string;
        full_name: string;
        cursor_sha: string | null;
      }>(sql`
        SELECT
          s.repository_id,
          r.workspace,
          r.slug,
          r.full_name,
          s.is_merge_backfill_cursor_sha AS cursor_sha
        FROM sync_state s
        JOIN repositories r ON r.id = s.repository_id
        WHERE s.is_merge_backfill_complete = false
          AND r.archived = false
          AND r.sync_excluded = false
        ORDER BY s.is_merge_last_run_at ASC NULLS FIRST, s.repository_id ASC
        LIMIT 1
      `);
      const row = rows.rows[0];
      if (row === undefined) return null;
      return {
        repositoryId: row.repository_id,
        workspace: row.workspace,
        slug: row.slug,
        fullName: row.full_name,
        cursorSha: row.cursor_sha,
      };
    },

    async markIsMergeBackfillAttempt(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ isMergeLastRunAt: now, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async advanceIsMergeBackfillCursor(repositoryId, cursorSha) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ isMergeBackfillCursorSha: cursorSha, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async markIsMergeBackfillComplete(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ isMergeBackfillComplete: true, isMergeLastRunAt: now, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async countAnonymousCommits() {
      // Filters archived + sync_excluded so the count matches what the
      // picker would actually walk.
      const rows = await db.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total
        FROM commits c
        JOIN repositories r ON r.id = c.repository_id
        WHERE c.author_user_id IS NULL
          AND r.archived = false
          AND r.sync_excluded = false
      `);
      return rows.rows[0]?.total ?? 0;
    },

    async pickRepoForAnonymousSweep() {
      // EXISTS short-circuits per repo on the first anonymous row — much
      // cheaper than `count(*) > 0`, and uses commits_author_authored_idx
      // via the author_user_id IS NULL predicate.
      const rows = await db.execute<{
        repository_id: number;
        workspace: string;
        slug: string;
        full_name: string;
      }>(sql`
        SELECT
          s.repository_id,
          r.workspace,
          r.slug,
          r.full_name
        FROM sync_state s
        JOIN repositories r ON r.id = s.repository_id
        WHERE s.anonymous_sweep_complete = false
          AND r.archived = false
          AND r.sync_excluded = false
          AND EXISTS (
            SELECT 1 FROM commits c
            WHERE c.repository_id = s.repository_id
              AND c.author_user_id IS NULL
          )
        ORDER BY s.anonymous_sweep_last_run_at ASC NULLS FIRST, s.repository_id ASC
        LIMIT 1
      `);
      const row = rows.rows[0];
      if (row === undefined) return null;
      return {
        repositoryId: row.repository_id,
        workspace: row.workspace,
        slug: row.slug,
        fullName: row.full_name,
      };
    },

    async markAnonymousSweepAttempt(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ anonymousSweepLastRunAt: now, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async markAnonymousSweepComplete(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({ anonymousSweepComplete: true, anonymousSweepLastRunAt: now, updatedAt: now })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async bulkUpdateAnonymousAttribution(entries) {
      if (entries.length === 0) return [];
      // Per-column casts: pg-node sends parameters untyped and Postgres
      // infers VALUES types from row 0, so an all-NULL first row would
      // poison the inferred type.
      //
      // WHERE commits.author_user_id IS NULL is load-bearing — a
      // concurrent commit-sync landing attribution first wins; never
      // overwrites an established attribution. COALESCE on snapshot
      // columns preserves pre-existing values.
      //
      // RETURNING reads the POST-update row, so `author_user_id IS NOT
      // NULL` means "transitioned NULL → known on this call".
      // Snapshot-only changes come back attributed=false; the caller
      // skips them for commit_daily recompute.
      const tuples = sql.join(
        entries.map(
          (e) => sql`(
            ${e.commitId}::int,
            ${e.userId}::int,
            ${e.email}::text,
            ${e.displayName}::text
          )`,
        ),
        sql`, `,
      );
      const result = await db.execute<{
        id: number;
        repository_id: number;
        authored_at: Date;
        attributed: boolean;
      }>(sql`
        UPDATE commits c
        SET
          author_user_id = data.user_id,
          author_email = COALESCE(c.author_email, data.email),
          author_display_name = COALESCE(c.author_display_name, data.display_name)
        FROM (VALUES ${tuples}) AS data(commit_id, user_id, email, display_name)
        WHERE c.id = data.commit_id
          AND c.author_user_id IS NULL
        RETURNING
          c.id,
          c.repository_id,
          c.authored_at,
          (c.author_user_id IS NOT NULL) AS attributed
      `);
      return result.rows.map((r) => ({
        id: r.id,
        repositoryId: r.repository_id,
        authoredAt: r.authored_at instanceof Date ? r.authored_at : new Date(r.authored_at),
        attributed: r.attributed,
      }));
    },

    async resetSyncCursors(repositoryId) {
      const now = new Date();
      await db
        .update(syncState)
        .set({
          lastSeenSha: null,
          deepenComplete: false,
          isMergeBackfillComplete: false,
          isMergeBackfillCursorSha: null,
          updatedAt: now,
        })
        .where(eq(syncState.repositoryId, repositoryId));
    },

    async resetDiffStatsForRepo(repositoryId) {
      // One transaction so the dashboard never sees commits.* cleared
      // while commit_daily still holds the old sums (or vice versa).
      // diffStatsFailureCount is zeroed so gave-up'd commits re-enter the
      // pickup — otherwise `failure_count < 3` filters them out and the
      // reset no-ops on those rows.
      return await db.transaction(async (tx) => {
        const commitResult = await tx
          .update(commits)
          .set({ additions: 0, deletions: 0, filesChanged: 0, diffStatsSyncedAt: null, diffStatsFailureCount: 0 })
          .where(eq(commits.repositoryId, repositoryId));
        await tx
          .update(commitDaily)
          .set({ additions: 0, deletions: 0 })
          .where(eq(commitDaily.repositoryId, repositoryId));
        return { resetCount: commitResult.rowCount ?? 0 };
      });
    },

    async updateIsMergeBatch(repositoryId, entries) {
      if (entries.length === 0) return { updated: 0 };
      // Per-parameter casts are required: pg-node sends parameters untyped
      // and Postgres infers VALUES types from row 0 — without the casts
      // booleans arrive as text and the `is_merge = data.is_merge`
      // comparison fails with "operator does not exist: boolean = text".
      const tuples = sql.join(
        entries.map((e) => sql`(${e.sha}::text, ${e.isMerge}::boolean)`),
        sql`, `,
      );
      const result = await db.execute(sql`
        UPDATE commits
        SET is_merge = data.is_merge
        FROM (VALUES ${tuples}) AS data(sha, is_merge)
        WHERE commits.repository_id = ${repositoryId}
          AND commits.sha = data.sha
          AND commits.is_merge IS DISTINCT FROM data.is_merge
      `);
      return { updated: result.rowCount ?? 0 };
    },
  };
}
