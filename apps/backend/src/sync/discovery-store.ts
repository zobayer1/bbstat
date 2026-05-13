// Storage interface for discovery operations. Keeps the discovery logic in
// `discovery.ts` testable with a fake store (see discovery.test.ts) without
// pulling in Drizzle / pg / a real database.
//
// The Drizzle-backed implementation at the bottom of this file is what gets
// wired up in the runtime (sync runner, admin endpoints).

import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { repositories, syncState, users } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
}

export interface RepositoryInsertInput {
  bitbucketUuid: string;
  workspace: string;
  project: string | null;
  slug: string;
  fullName: string;
}

export interface InsertRepositoryResult {
  row: RepositoryRow;
  // True iff this call actually inserted a new row. False when the input's
  // bitbucket_uuid already existed (e.g., a YAML alias like a case variant
  // resolved to the same canonical BitBucket repo, or a race between two
  // concurrent triggers). In the false case `row` is the existing row.
  inserted: boolean;
}

export interface DiscoveryStore {
  upsertUser(input: UserUpsertInput): Promise<UserUpsertResult>;
  findRepositoryByFullName(fullName: string): Promise<RepositoryRow | null>;
  // Atomic for our purposes: inserts the repository row and the matching
  // sync_state row in the same transaction. Idempotent against UUID
  // conflicts: if the bitbucket_uuid already exists, the existing row is
  // returned with `inserted: false` (caller treats as already-tracked).
  insertRepositoryWithSyncState(input: RepositoryInsertInput): Promise<InsertRepositoryResult>;
  // Enumerate the curated tracked set — every row in `repositories` is by
  // definition tracked (untracked repos are simply absent). Used by the
  // commit-sync cron / admin trigger to build the tick's repo list.
  listTrackedRepositories(): Promise<RepositoryRow[]>;
}

// ---------------------------------------------------------------------------
// Drizzle-backed implementation
// ---------------------------------------------------------------------------

export function createDrizzleDiscoveryStore(db: Database): DiscoveryStore {
  return {
    async upsertUser(input) {
      const result = await db
        .insert(users)
        .values({
          bitbucketUuid: input.bitbucketUuid,
          displayName: input.displayName,
          username: input.username,
        })
        .onConflictDoUpdate({
          target: users.bitbucketUuid,
          set: { displayName: input.displayName, username: input.username },
        })
        .returning({ id: users.id, createdAt: users.createdAt });
      // Postgres' INSERT ... ON CONFLICT doesn't natively expose "was it new?"
      // We approximate by comparing createdAt to "moments ago" — close enough
      // for sync stats; consumers that need exact counts can re-query.
      const row = result[0];
      const inserted = row !== undefined && Date.now() - row.createdAt.getTime() < 5_000;
      return { inserted };
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
          });
        if (inserted.length > 0) {
          const row = inserted[0]!;
          // sync_state PK is repository_id, so a fresh row always succeeds;
          // the DO NOTHING is just belt-and-braces against a concurrent
          // bootstrap that happened to land between the inserts above.
          await tx.insert(syncState).values({ repositoryId: row.id }).onConflictDoNothing();
          return { row, inserted: true };
        }
        // bitbucket_uuid collision — the canonical row is already present.
        // Fetch it so the caller can report the canonical full_name (which
        // may differ from the input alias).
        const existing = await tx
          .select({
            id: repositories.id,
            bitbucketUuid: repositories.bitbucketUuid,
            workspace: repositories.workspace,
            project: repositories.project,
            slug: repositories.slug,
            fullName: repositories.fullName,
          })
          .from(repositories)
          .where(eq(repositories.bitbucketUuid, input.bitbucketUuid))
          .limit(1);
        const row = existing[0]!;
        await tx.insert(syncState).values({ repositoryId: row.id }).onConflictDoNothing();
        return { row, inserted: false };
      });
    },

    async listTrackedRepositories() {
      return await db
        .select({
          id: repositories.id,
          bitbucketUuid: repositories.bitbucketUuid,
          workspace: repositories.workspace,
          project: repositories.project,
          slug: repositories.slug,
          fullName: repositories.fullName,
        })
        .from(repositories);
    },
  };
}
