// Storage interface for commit-ingest operations. Mirrors discovery-store:
// domain logic in commits.ts injects a CommitStore (real or fake) so it stays
// testable without spinning up Postgres.
//
// Idempotency: insertCommits uses ON CONFLICT DO NOTHING on the
// commits_sha_repo_unique constraint — re-running a sync that races another
// trigger never errors and never duplicates. The cursor helpers
// (getSyncState, markSync{Running,Success,Failed}) own the sync_state row
// lifecycle for a single repository.

import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commitDaily, commits, repositories, syncState, users } from '../db/schema.js';

export type SyncStatus = 'idle' | 'running' | 'success' | 'failed';

// Per-commit failure budget threshold for `/diffstat/<sha>` fetches.
// Cross this many cumulative failures and the orchestrator stops re-
// queueing the commit. Exported so both the orchestrator (deciding
// when to stamp-as-done) and the pickup queries (defending against
// stamp-then-counter-drift) agree on the same number.
//
// Weight scheme used by `incrementDiffStatsFailure`: generic 5xx adds
// 1 per failed tick, HTTP 555 adds 3 (one strike is enough — that
// class of failure is persistent for the commit shape). So a 555
// crosses the threshold immediately; a flaky 500/502/503 gets three
// chances spread across however many ticks it takes the global
// pickup to re-attempt this commit.
export const DIFF_STATS_FAILURE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommitInsertInput {
  repositoryId: number;
  authorUserId: number | null;
  sha: string;
  message: string;
  isMerge: boolean;
  authoredAt: Date;
}

export interface CommitInsertResult {
  inserted: number;
  // Rows that actually won the ON CONFLICT race (i.e. landed in the table
  // on this call). Consumed by the inline-eager diff-stats path so the
  // per-repo commit sync can fetch /diffstat for just-inserted shas
  // without going back to the DB. Empty when `inserted === 0`.
  insertedRows: InsertedCommitRow[];
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
  // null leaves the cursor untouched — used when a clean run produced no new
  // commits (idle repo) and we still want to record a successful tick.
  lastSeenSha: string | null;
  commitsAdded: number;
}

export interface PendingDiffStatCommit {
  id: number;
  sha: string;
  authoredAt: Date;
}

// Same shape as PendingDiffStatCommit plus the repo identity needed
// for the BB call. Returned by the global newest-first pickup the
// diff-stats backfill tick consumes; the per-repo pickup
// (`listPendingDiffStatCommits`) is used only by the inline-eager
// path inside commit-sync where the repo is already known.
export interface PendingDiffStatCommitWithRepo extends PendingDiffStatCommit {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  excludePatterns: string[];
}

export interface CommitStore {
  // Resolve a batch of BitBucket user UUIDs to local users.id values. Missing
  // UUIDs (anonymous commits, users not yet synced) are absent from the
  // result map; callers translate that absence into author_user_id = null.
  resolveUserIdsByUuid(uuids: string[]): Promise<Map<string, number>>;

  // Write-once email capture from commits.author.raw. For each (uuid, email)
  // entry, sets users.email = email only when the current value IS NULL —
  // the "first observed wins" policy keeps things stable for developers who
  // commit from multiple machines with different addresses. UUIDs not in the
  // users table are silently skipped (no rows match the predicate). No-op
  // on empty input. Parsing + noreply filtering happens upstream in the
  // sync layer (see src/sync/author-email.ts).
  setUserEmailsIfMissing(entries: Array<{ bitbucketUuid: string; email: string }>): Promise<void>;

  // One-shot email backfill seed list. Returns every user whose email IS NULL
  // alongside the (workspace, slug, sha) of their most recently authored
  // ingested commit, capped by `limit`. The caller hits BB's commit endpoint
  // for each row, parses author.raw, and writes via setUserEmailsIfMissing.
  // Archived / sync-excluded repos are filtered out — fetching against them
  // is unreliable (404s / drift), and the user's NEXT live commit in a
  // healthy repo will capture their email anyway. Users with no ingested
  // commits at all (theoretically unreachable today; defensively filtered)
  // are absent.
  listUsersMissingEmailWithLastCommit(limit: number): Promise<
    Array<{
      userId: number;
      bitbucketUuid: string;
      workspace: string;
      slug: string;
      sha: string;
    }>
  >;

  // Bulk insert commits. Conflicts on (repository_id, sha) are skipped — commits
  // are immutable, so re-runs converge. Returns the count of newly inserted rows.
  insertCommits(input: CommitInsertInput[]): Promise<CommitInsertResult>;

  getSyncState(repositoryId: number): Promise<SyncStateRow | null>;
  markSyncRunning(repositoryId: number): Promise<void>;
  markSyncSuccess(repositoryId: number, update: SyncSuccessUpdate): Promise<void>;
  markSyncFailed(repositoryId: number, error: string): Promise<void>;

  // Per-repo pickup. Returns commits in this repo whose
  // `diff_stats_synced_at IS NULL`, ordered newest-authored first,
  // capped at `limit`. Used only by the inline-eager forward path
  // inside commit-sync — the global backfill tick uses
  // `listPendingDiffStatCommitsGlobal` instead.
  listPendingDiffStatCommits(repositoryId: number, limit: number): Promise<PendingDiffStatCommit[]>;

  // Global newest-first pickup across every non-archived non-excluded
  // repo. Returns the `limit` newest-authored commits whose
  // `diff_stats_synced_at IS NULL`, with each row carrying repo
  // identity (workspace, slug, exclude patterns) so the diff-stat
  // walker can fan out BB calls without further lookups. Powers the
  // "freshness-first round-robin" backfill: a repo with 5000 pending
  // commits no longer monopolizes a tick — its 50 most recent
  // commits land in the global pool alongside every other repo's
  // recent commits.
  listPendingDiffStatCommitsGlobal(limit: number): Promise<PendingDiffStatCommitWithRepo[]>;

  // Phase 4 T21: persist BB-derived additions / deletions / files_changed
  // for one commit and stamp diff_stats_synced_at = now() so it's filtered
  // out of the next pickup. Idempotent — safe to call repeatedly with the
  // same values.
  updateCommitDiffStats(
    commitId: number,
    input: { additions: number; deletions: number; filesChanged: number },
  ): Promise<void>;

  // Increment the per-commit `diff_stats_failure_count` by `weight`. The
  // diff-stats orchestrator calls this from its catch block on every
  // /diffstat fetch failure surfaced through the BB client (after its
  // in-tick retry budget has already been exhausted). Generic 5xx uses
  // weight=1; HTTP 555 (BB compute timeout for this commit's diff) uses
  // weight=3 so a single 555 strike crosses the threshold immediately —
  // that class of failure is persistent for the commit shape and
  // retrying buys nothing. Returns the post-increment count so the
  // caller can decide whether to also stamp the commit as done (with
  // zeros) to remove it from future pickups.
  incrementDiffStatsFailure(commitId: number, weight: number): Promise<number>;

  // Oldest known commit (by authored_at ASC) for the repo, used as the
  // seed sha for deepen-backfill's `include=<sha>` walk. Null when no
  // commits have been ingested yet (cold mode hasn't run).
  getOldestCommitSha(repositoryId: number): Promise<string | null>;

  // Deepen-backfill queue pick: ORDER BY deepen_last_run_at NULLS FIRST so
  // never-attempted repos go first, then round-robin across the rest by
  // staleness. Returns null when every tracked repo has deepen_complete = true.
  pickRepoForDeepening(): Promise<DeepenCandidate | null>;

  // Stamps deepen_last_run_at = now() without changing deepen_complete.
  // Called even on no-op runs (e.g., budget gate fired mid-page) so the
  // round-robin advances and we don't repeatedly hammer the same repo.
  markDeepenAttempt(repositoryId: number): Promise<void>;

  // Flips deepen_complete = true. Called once BB returns no `next` URL on
  // the deepen pagination (we've reached the repo's first commit) or on
  // an unrecoverable 404 against the seed sha (force-pushed history).
  markDeepenComplete(repositoryId: number): Promise<void>;

  // One-shot retroactive backfill of the `is_merge` column on already-
  // ingested commits. Used by the admin backfill endpoint after walking
  // BB's /commits and reading each commit's `parents.length`. Bulk
  // UPDATE keyed by sha — rows whose sha isn't found are silently
  // skipped (the caller's list may include not-yet-ingested commits if
  // BB returned a page past our deepen boundary). Returns rows actually
  // updated. Idempotent — re-running with the same input is a no-op.
  updateIsMergeBatch(
    repositoryId: number,
    entries: Array<{ sha: string; isMerge: boolean }>,
  ): Promise<{ updated: number }>;

  // Retroactive is_merge backfill queue. Picks the next incomplete repo
  // (`is_merge_backfill_complete = false`), round-robin by
  // `is_merge_last_run_at ASC NULLS FIRST`. Returns the resume cursor
  // alongside repo identity. Null when every tracked non-archived
  // non-excluded repo is complete.
  pickRepoForIsMergeBackfill(): Promise<IsMergeBackfillCandidate | null>;

  // Bumps `is_merge_last_run_at = now()` without touching cursor or
  // complete flag. Mirrors `markDeepenAttempt` — called once per pick
  // so the round-robin advances even when the tick is a no-op (e.g.,
  // budget gate fires before any walking).
  markIsMergeBackfillAttempt(repositoryId: number): Promise<void>;

  // Advances `is_merge_backfill_cursor_sha` to the oldest sha we
  // verified on this tick (the per-tick page cap fired and more
  // history remains). Doesn't touch the complete flag.
  advanceIsMergeBackfillCursor(repositoryId: number, cursorSha: string): Promise<void>;

  // Flips `is_merge_backfill_complete = true`. Called when the
  // paginator exhausted without hitting the page cap (verified every
  // commit BB has) or when the cursor sha 404's (force-pushed history
  // — give up, mirrors deepen seedMissing).
  markIsMergeBackfillComplete(repositoryId: number): Promise<void>;

  // Reset the commit-sync cursor + deepen state to cold-mode defaults.
  // Used by POST /repositories/:ws/:slug/include after a sync_excluded
  // recovery so the next tick starts fresh — a stale or invalid
  // last_seen_sha would just re-trip the history-rewritten exclusion.
  // Clears: last_seen_sha → NULL, deepen_complete → false,
  // is_merge_backfill_complete → false, is_merge_backfill_cursor_sha
  // → NULL. Does NOT touch commits (history stays in the DB) or
  // total_commits_synced (counter is monotonic / observational).
  resetSyncCursors(repositoryId: number): Promise<void>;

  // Re-arm diff-stat backfill for a repo. Zeros the line counts on
  // every commit, clears `diff_stats_synced_at`, **resets the
  // per-commit `diff_stats_failure_count` to zero**, AND zeros the
  // `commit_daily` aggregates for the repo so the dashboard shows
  // clearly-wrong (zero) rather than subtly-wrong (mixed) during the
  // drain. The next diff-stats backfill ticks re-fetch /diffstat with
  // whatever filter is now configured in
  // `repositories.diff_stats_exclude_patterns`, and the rollup hook
  // refills `commit_daily` as commits drain.
  //
  // The failure-count reset is what makes the admin "reset" operation
  // actually re-arm previously gave-up'd commits — otherwise the
  // pickup queries' `failure_count < 3` predicate would still filter
  // them out and the operator's reset would silently do nothing on
  // those rows. If BB has since recovered on a heavy commit (rare but
  // possible — BB-side caching artifact, GC'd parent restored, etc.),
  // this gives them another shot. Commits that are still genuinely
  // too heavy will fail again on the next attempt and re-cross the
  // threshold; cost is one round of BB calls per stuck commit.
  //
  // Single transaction so the dashboard never observes a partial
  // state. Returns the count of commits whose stamp was cleared
  // (i.e., re-queued for backfill).
  resetDiffStatsForRepo(repositoryId: number): Promise<{ resetCount: number }>;
}

export interface DeepenCandidate {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  // Seed sha for the deepen walk (oldest known commit). Null only when
  // the repo has zero commits ingested — caller treats as
  // "nothing to deepen yet; cold mode hasn't run".
  oldestSha: string | null;
}

export interface IsMergeBackfillCandidate {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  // Resume cursor: oldest sha previously verified by this backfill.
  // NULL = cold (start from newest, no `include` filter on the walk).
  // Set = `include=<cursorSha>` on the next walk, then skip the seed
  // sha (we've already verified it).
  cursorSha: string | null;
}

// ---------------------------------------------------------------------------
// Drizzle-backed implementation
// ---------------------------------------------------------------------------

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

    async listUsersMissingEmailWithLastCommit(limit) {
      // DISTINCT ON (author_user_id) picks the newest commit per user in
      // one pass, backed by the `commits_author_authored_idx` index on
      // (author_user_id, authored_at). Cheap even at hundreds of
      // thousands of commits — the planner short-circuits per user as
      // soon as it sees the first row.
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

    async setUserEmailsIfMissing(entries) {
      if (entries.length === 0) return;
      // Dedupe by uuid before the SQL build — multiple commits in the same
      // batch can carry the same author, and emitting duplicate VALUES
      // rows for one uuid would be wasted work (the COALESCE still
      // converges, just with redundant evaluations).
      const byUuid = new Map<string, string>();
      for (const e of entries) {
        if (!byUuid.has(e.bitbucketUuid)) byUuid.set(e.bitbucketUuid, e.email);
      }
      // Single UPDATE ... FROM (VALUES ...) — one round-trip regardless of
      // batch size. Casts on each parameter are load-bearing for the same
      // reason as updateIsMergeBatch: pg-node sends parameters untyped and
      // Postgres infers VALUES column types from the first row only.
      // `WHERE users.email IS NULL` enforces write-once; a non-NULL
      // value already on the row blocks the update, no overwrite.
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
      if (input.length === 0) return { inserted: 0, insertedRows: [] };
      const result = await db
        .insert(commits)
        .values(input)
        .onConflictDoNothing({ target: [commits.repositoryId, commits.sha] })
        .returning({ id: commits.id, sha: commits.sha, authoredAt: commits.authoredAt });
      return { inserted: result.length, insertedRows: result };
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
      // Atomic increment via SQL expression — concurrent ticks (cron + manual)
      // can both succeed without losing count to a read-modify-write race.
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

    async listPendingDiffStatCommits(repositoryId, limit) {
      const rows = await db
        .select({ id: commits.id, sha: commits.sha, authoredAt: commits.authoredAt })
        .from(commits)
        .where(
          and(
            eq(commits.repositoryId, repositoryId),
            isNull(commits.diffStatsSyncedAt),
            // Belt-and-suspenders alongside the IS NULL check above —
            // once a commit crosses the failure threshold the
            // orchestrator stamps it with zeros so it drops out of the
            // IS NULL predicate naturally, but this guard means a
            // future stamp-without-counter-increment (or a manual
            // operator NULL of the stamp) still skips give-up'd
            // commits until the counter is reset.
            lt(commits.diffStatsFailureCount, DIFF_STATS_FAILURE_THRESHOLD),
          ),
        )
        .orderBy(desc(commits.authoredAt))
        .limit(limit);
      return rows;
    },

    async listPendingDiffStatCommitsGlobal(limit) {
      // JOIN to repositories filters out archived + sync_excluded
      // repos in one round-trip and includes the per-repo identity
      // the diff-stat walker needs. ORDER BY authored_at DESC across
      // the whole pool gives the "freshness first" semantics: a
      // repo's recent commits all jump ahead of any repo's old
      // commits, regardless of which repo is "next" by some other
      // ordering. Backed by commits_pending_diff_stats_idx (partial
      // index on diff_stats_synced_at IS NULL) so the scan stays
      // sub-millisecond even at hundreds of thousands of commits.
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
            // Same belt-and-suspenders as listPendingDiffStatCommits —
            // commits that crossed the failure threshold are stamped
            // with zeros + NOW() so the IS NULL check above already
            // skips them, but the explicit guard means manual operator
            // un-stamps still skip until the counter is reset.
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
      // Single UPDATE ... RETURNING — one round-trip, atomic, returns the
      // post-increment count so the caller can branch on threshold
      // crossing without a follow-up SELECT.
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
      // Single query that joins sync_state to repositories, filters to
      // incomplete repos, orders by deepen_last_run_at NULLS FIRST (so
      // brand-new entries jump the queue once, then round-robin by
      // staleness), and pulls the oldest commit sha in the same shot via
      // a correlated subquery. One DB roundtrip per tick.
      const rows = await db.execute<{
        repository_id: number;
        workspace: string;
        slug: string;
        full_name: string;
        oldest_sha: string | null;
      }>(sql`
        SELECT
          s.repository_id,
          r.workspace,
          r.slug,
          r.full_name,
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
      // Mirrors pickRepoForDeepening shape: one round-trip, JOIN
      // repositories so the orchestrator gets workspace/slug for the BB
      // walk, ORDER BY last_run_at NULLS FIRST for round-robin. Filters
      // archived + sync_excluded so retired/broken repos don't keep
      // surfacing.
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
      // Run both UPDATEs in one transaction so the dashboard never sees
      // commits.* cleared while commit_daily still has the old (inflated)
      // sums — or vice versa. The backfill tick repopulates upward as
      // it drains. diffStatsFailureCount is also zeroed so previously
      // gave-up'd commits re-enter the pickup queue — without that the
      // `failure_count < 3` predicate would silently filter them out
      // and the operator's reset would be a no-op for those rows.
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
      // Single UPDATE ... FROM (VALUES ...) — one round-trip for any
      // batch size. Drizzle's `sql` template lets us inline the
      // tuples while still parameterizing every value. Explicit casts
      // on each parameter are required: pg-node sends parameters
      // untyped, and Postgres infers VALUES column types from the
      // first row — without the casts, booleans arrive as text and
      // the `commits.is_merge = data.is_merge` comparison fails with
      // "operator does not exist: boolean = text".
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
