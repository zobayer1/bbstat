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

export interface DiscoveryStore {
  upsertUser(input: UserUpsertInput): Promise<UserUpsertResult>;
  findRepositoryByFullName(fullName: string): Promise<RepositoryRow | null>;
  // Atomic for our purposes: inserts the repository row and the matching
  // sync_state row in the same transaction. Returns the row that was created.
  insertRepositoryWithSyncState(input: RepositoryInsertInput): Promise<RepositoryRow>;
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
        const inserted = await tx.insert(repositories).values(input).returning({
          id: repositories.id,
          bitbucketUuid: repositories.bitbucketUuid,
          workspace: repositories.workspace,
          project: repositories.project,
          slug: repositories.slug,
          fullName: repositories.fullName,
        });
        const row = inserted[0]!;
        await tx.insert(syncState).values({ repositoryId: row.id });
        return row;
      });
    },
  };
}
