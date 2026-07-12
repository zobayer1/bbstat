// Storage interface for discovery operations, so discovery.ts stays
// testable with a fake store without pulling in Drizzle / pg.

import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { repositories, syncState, users } from '../db/schema.js';

export interface UserUpsertInput {
  bitbucketUuid: string;
  displayName: string;
  username: string | null;
}

export interface UserUpsertResult {
  inserted: boolean;
}

export interface RepositoryRow {
  id: number;
  bitbucketUuid: string;
  workspace: string;
  project: string | null;
  slug: string;
  fullName: string;
  archived: boolean;
  // Set when an auto-trip detected a permanently-broken state and pulled
  // the repo out of sync. See schema.ts for allowed `syncExcludeReason`.
  syncExcluded: boolean;
  syncExcludeReason: string | null;
  // File-path globs (picomatch) the diff-stat aggregator skips. Empty = no
  // filtering. POST /diff-stats/reset re-applies the filter to already-
  // ingested commits.
  diffStatsExcludePatterns: string[];
}

// Richer row used by sync runners to decide which repos are due this tick.
// Carries the timestamps the backoff formula needs (src/sync/backoff.ts).
export interface RepositoryForSyncRow extends RepositoryRow {
  // From sync_state. Null = never synced (always due).
  lastSyncedAt: Date | null;
  prLastSyncedAt: Date | null;
  // MAX(commits.authored_at) / MAX(pull_requests.bitbucket_updated_at).
  // Null = nothing ever ingested.
  latestCommitAt: Date | null;
  latestPrAt: Date | null;
  // Activity-floor when the MAX(...) timestamps are null, so empty repos
  // back off by how long they've been tracked.
  createdAt: Date;
}

export interface RepositoryInsertInput {
  bitbucketUuid: string;
  workspace: string;
  project: string | null;
  slug: string;
  fullName: string;
  // Soft-retire flag, seed-only at insert. Flipped at runtime via the
  // admin archive / unarchive endpoints, never reconciled from YAML.
  archived: boolean;
}

export interface InsertRepositoryResult {
  row: RepositoryRow;
  // False when the input's bitbucket_uuid already existed (a YAML alias
  // resolved to the same canonical repo, or a concurrent-trigger race); in
  // that case `row` is the existing row.
  inserted: boolean;
}

export interface DiscoveryStore {
  upsertUser(input: UserUpsertInput): Promise<UserUpsertResult>;

  // Roster reconciliation, the sibling of upsertUser. Flips
  // `is_workspace_member` FALSE for every currently-member row whose
  // bitbucket_uuid is NOT in `seenUuids` — i.e. members who dropped out of
  // `/workspaces/{ws}/members` since the last pull (departed the org). This
  // is the only writer that demotes an existing member; the rejoin path
  // (upsertUser) forces the flag back TRUE. Returns the count demoted.
  //
  // MUST NOT be called with an empty `seenUuids`: a failed / rate-limited
  // roster pull returns zero members, and demoting on that would wipe the
  // whole workspace. The store no-ops on empty as a backstop, but the caller
  // (syncWorkspaceMembers) is the real guard.
  //
  // Single-workspace assumption: every `is_workspace_member = true` row was
  // written by the one configured BITBUCKET_WORKSPACE, so reconciling against
  // that single roster is safe. Multi-workspace tracking would need a
  // workspace scope on `users` before this could stay correct.
  markDepartedMembers(seenUuids: string[]): Promise<number>;
  // Returns the row regardless of archived state — callers must inspect
  // `archived` explicitly. The tick paths use listTrackedRepositories()
  // instead, which filters archived rows out.
  findRepositoryByFullName(fullName: string): Promise<RepositoryRow | null>;
  // Inserts the repository row and its sync_state row in one transaction.
  // Idempotent against UUID conflicts: an existing bitbucket_uuid returns
  // the existing row with `inserted: false`.
  insertRepositoryWithSyncState(input: RepositoryInsertInput): Promise<InsertRepositoryResult>;
  // Replace (not merge) the exclude-pattern list. Does NOT recount; the
  // operator runs POST /diff-stats/reset to apply it to ingested commits.
  updateRepositoryExcludePatterns(repositoryId: number, patterns: string[]): Promise<void>;
  updateRepositoryArchived(repositoryId: number, archived: boolean): Promise<void>;

  // Auto-trip helper. Called by the sync paths (commits.ts 404 /
  // history-rewrite, deepen-backfill.ts empty-on-bb) and the admin
  // /include endpoint. Reason MUST be non-null when excluded=true so the
  // UI can render the cause; pass null when clearing.
  updateRepositorySyncExcluded(repositoryId: number, excluded: boolean, reason: string | null): Promise<void>;

  // Operator-driven rename. NEVER touches bitbucket_uuid — that's the
  // load-bearing identity. Idempotent.
  updateRepositoryRename(
    repositoryId: number,
    input: { workspace: string; slug: string; fullName: string; project: string | null },
  ): Promise<void>;

  // Hard delete; FK cascade removes commits / sync_state / branches /
  // pull_requests. Returns rows deleted (0 or 1).
  deleteRepository(repositoryId: number): Promise<number>;
  // The curated tracked set: every non-archived non-excluded row. Used by
  // the commit-sync cron / admin trigger to build the tick's repo list.
  listTrackedRepositories(): Promise<RepositoryRow[]>;

  // Richer variant for the cron runners: adds per-repo activity + last-sync
  // timestamps so the runner can apply the adaptive backoff formula
  // (src/sync/backoff.ts). Archived repos filtered out.
  listRepositoriesForSync(): Promise<RepositoryForSyncRow[]>;

  // Candidate set for the empty-revival sweep: repos auto-excluded with
  // reason 'empty-on-bitbucket' that are NOT archived (archived is a
  // deliberate retire and must not auto-revive).
  listEmptyExcludedRepos(): Promise<RepositoryRow[]>;
}

export function createDrizzleDiscoveryStore(db: Database): DiscoveryStore {
  return {
    async upsertUser(input) {
      // `is_workspace_member` is set TRUE on every member-sync upsert. This
      // is the rejoin-flip seam: a previously-auto-created ex-employee row
      // (FALSE) flips back to TRUE the moment they reappear in
      // /workspaces/{ws}/members. The auto-create path is the only other
      // writer and INSERTs FALSE / does nothing on conflict, so the two
      // can't fight.
      const result = await db
        .insert(users)
        .values({
          bitbucketUuid: input.bitbucketUuid,
          displayName: input.displayName,
          username: input.username,
          isWorkspaceMember: true,
        })
        .onConflictDoUpdate({
          target: users.bitbucketUuid,
          set: { displayName: input.displayName, username: input.username, isWorkspaceMember: true },
        })
        .returning({ id: users.id, createdAt: users.createdAt });
      // ON CONFLICT doesn't expose "was it new?", so approximate by checking
      // whether createdAt is within the last few seconds — good enough for
      // sync stats.
      const row = result[0];
      const inserted = row !== undefined && Date.now() - row.createdAt.getTime() < 5_000;
      return { inserted };
    },

    async markDepartedMembers(seenUuids) {
      // Backstop against the empty-roster foot-gun (the caller guards too):
      // never demote when the pull returned nobody.
      if (seenUuids.length === 0) return 0;
      const demoted = await db
        .update(users)
        .set({ isWorkspaceMember: false })
        .where(and(eq(users.isWorkspaceMember, true), notInArray(users.bitbucketUuid, seenUuids)))
        .returning({ id: users.id });
      return demoted.length;
    },

    async findRepositoryByFullName(fullName) {
      const rows = await db
        .select({
          id: repositories.id,
          bitbucketUuid: repositories.bitbucketUuid,
          workspace: repositories.workspace,
          project: repositories.project,
          slug: repositories.slug,
          fullName: repositories.fullName,
          archived: repositories.archived,
          syncExcluded: repositories.syncExcluded,
          syncExcludeReason: repositories.syncExcludeReason,
          diffStatsExcludePatterns: repositories.diffStatsExcludePatterns,
        })
        .from(repositories)
        .where(eq(repositories.fullName, fullName))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertRepositoryWithSyncState(input) {
      return await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(repositories)
          .values(input)
          .onConflictDoNothing({ target: repositories.bitbucketUuid })
          .returning({
            id: repositories.id,
            bitbucketUuid: repositories.bitbucketUuid,
            workspace: repositories.workspace,
            project: repositories.project,
            slug: repositories.slug,
            fullName: repositories.fullName,
            archived: repositories.archived,
            syncExcluded: repositories.syncExcluded,
            syncExcludeReason: repositories.syncExcludeReason,
            diffStatsExcludePatterns: repositories.diffStatsExcludePatterns,
          });
        if (inserted.length > 0) {
          const row = inserted[0]!;
          // DO NOTHING guards against a concurrent bootstrap landing the
          // sync_state row between these inserts.
          await tx.insert(syncState).values({ repositoryId: row.id }).onConflictDoNothing();
          return { row, inserted: true };
        }
        // bitbucket_uuid collision — fetch the canonical row so the caller
        // can report its full_name (may differ from the input alias).
        const existing = await tx
          .select({
            id: repositories.id,
            bitbucketUuid: repositories.bitbucketUuid,
            workspace: repositories.workspace,
            project: repositories.project,
            slug: repositories.slug,
            fullName: repositories.fullName,
            archived: repositories.archived,
            syncExcluded: repositories.syncExcluded,
            syncExcludeReason: repositories.syncExcludeReason,
            diffStatsExcludePatterns: repositories.diffStatsExcludePatterns,
          })
          .from(repositories)
          .where(eq(repositories.bitbucketUuid, input.bitbucketUuid))
          .limit(1);
        const row = existing[0]!;
        await tx.insert(syncState).values({ repositoryId: row.id }).onConflictDoNothing();
        return { row, inserted: false };
      });
    },

    async updateRepositoryExcludePatterns(repositoryId, patterns) {
      await db
        .update(repositories)
        .set({ diffStatsExcludePatterns: patterns })
        .where(eq(repositories.id, repositoryId));
    },

    async updateRepositoryArchived(repositoryId, archived) {
      await db.update(repositories).set({ archived }).where(eq(repositories.id, repositoryId));
    },

    async updateRepositorySyncExcluded(repositoryId, excluded, reason) {
      await db
        .update(repositories)
        .set({ syncExcluded: excluded, syncExcludeReason: reason })
        .where(eq(repositories.id, repositoryId));
    },

    async updateRepositoryRename(repositoryId, input) {
      await db
        .update(repositories)
        .set({
          workspace: input.workspace,
          slug: input.slug,
          fullName: input.fullName,
          project: input.project,
        })
        .where(eq(repositories.id, repositoryId));
    },

    async deleteRepository(repositoryId) {
      const result = await db.delete(repositories).where(eq(repositories.id, repositoryId));
      return result.rowCount ?? 0;
    },

    async listEmptyExcludedRepos() {
      return await db
        .select({
          id: repositories.id,
          bitbucketUuid: repositories.bitbucketUuid,
          workspace: repositories.workspace,
          project: repositories.project,
          slug: repositories.slug,
          fullName: repositories.fullName,
          archived: repositories.archived,
          syncExcluded: repositories.syncExcluded,
          syncExcludeReason: repositories.syncExcludeReason,
          diffStatsExcludePatterns: repositories.diffStatsExcludePatterns,
        })
        .from(repositories)
        .where(
          and(
            eq(repositories.archived, false),
            eq(repositories.syncExcluded, true),
            eq(repositories.syncExcludeReason, 'empty-on-bitbucket'),
          ),
        );
    },

    async listRepositoriesForSync() {
      // One round-trip: every non-archived repo plus the two activity
      // aggregates via LEFT JOIN subqueries. If this ever stops being cheap,
      // materialize the aggregates onto sync_state.
      const rows = await db.execute<{
        id: number;
        bitbucket_uuid: string;
        workspace: string;
        project: string | null;
        slug: string;
        full_name: string;
        archived: boolean;
        sync_excluded: boolean;
        sync_exclude_reason: string | null;
        diff_stats_exclude_patterns: string[];
        last_synced_at: Date | string | null;
        pr_last_synced_at: Date | string | null;
        latest_commit_at: Date | string | null;
        latest_pr_at: Date | string | null;
        created_at: Date | string;
      }>(sql`
        SELECT
          r.id,
          r.bitbucket_uuid,
          r.workspace,
          r.project,
          r.slug,
          r.full_name,
          r.archived,
          r.sync_excluded,
          r.sync_exclude_reason,
          r.diff_stats_exclude_patterns,
          r.created_at,
          s.last_synced_at,
          s.pr_last_synced_at,
          latest_commit.authored_at AS latest_commit_at,
          latest_pr.updated_at AS latest_pr_at
        FROM repositories r
        LEFT JOIN sync_state s ON s.repository_id = r.id
        LEFT JOIN (
          SELECT repository_id, MAX(authored_at) AS authored_at
          FROM commits GROUP BY repository_id
        ) latest_commit ON latest_commit.repository_id = r.id
        LEFT JOIN (
          SELECT repository_id, MAX(bitbucket_updated_at) AS updated_at
          FROM pull_requests GROUP BY repository_id
        ) latest_pr ON latest_pr.repository_id = r.id
        WHERE r.archived = false AND r.sync_excluded = false
        ORDER BY s.last_synced_at ASC NULLS FIRST, r.id ASC
      `);
      const toDate = (v: Date | string | null): Date | null =>
        v === null ? null : v instanceof Date ? v : new Date(v);
      const toDateNotNull = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
      return rows.rows.map((r) => ({
        id: r.id,
        bitbucketUuid: r.bitbucket_uuid,
        workspace: r.workspace,
        project: r.project,
        slug: r.slug,
        fullName: r.full_name,
        archived: r.archived,
        syncExcluded: r.sync_excluded,
        syncExcludeReason: r.sync_exclude_reason,
        diffStatsExcludePatterns: r.diff_stats_exclude_patterns,
        lastSyncedAt: toDate(r.last_synced_at),
        prLastSyncedAt: toDate(r.pr_last_synced_at),
        latestCommitAt: toDate(r.latest_commit_at),
        latestPrAt: toDate(r.latest_pr_at),
        createdAt: toDateNotNull(r.created_at),
      }));
    },

    async listTrackedRepositories() {
      // Fair round-robin for the commit tick: ORDER BY last_synced_at ASC
      // NULLS FIRST so never-synced and least-recently-synced repos come
      // first. Without it, insertion order means the early rows always win
      // under budget pressure and the tail is perpetually deferred. The
      // LEFT JOIN is defensive — sync_state is created in the same tx as
      // the repo. id tiebreaker keeps the order deterministic for tests.
      return await db
        .select({
          id: repositories.id,
          bitbucketUuid: repositories.bitbucketUuid,
          workspace: repositories.workspace,
          project: repositories.project,
          slug: repositories.slug,
          fullName: repositories.fullName,
          archived: repositories.archived,
          syncExcluded: repositories.syncExcluded,
          syncExcludeReason: repositories.syncExcludeReason,
          diffStatsExcludePatterns: repositories.diffStatsExcludePatterns,
        })
        .from(repositories)
        .leftJoin(syncState, eq(syncState.repositoryId, repositories.id))
        .where(and(eq(repositories.archived, false), eq(repositories.syncExcluded, false)))
        .orderBy(sql`${syncState.lastSyncedAt} ASC NULLS FIRST`, asc(repositories.id));
    },
  };
}
