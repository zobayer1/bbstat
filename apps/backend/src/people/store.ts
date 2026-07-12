// Storage interface for the person layer — CRUD over `people` plus
// attach/detach/primary-swap/dissolve. All mutations run in a single
// transaction so the schema invariants (CHECK users_primary_requires_person +
// partial unique index users_one_primary_per_person_idx) hold even under
// concurrent operators.
//
// Primary-alias designation lives on `users.is_primary_for_person`, not on
// `people.primary_user_id` (cycle-free schema). The CHECK
//   NOT is_primary_for_person OR person_id IS NOT NULL
// means every mutation must clear the primary flag before any person_id→NULL
// transition; the store funnels those through helpers so the invariant is local.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { people, users } from '../db/schema.js';
import {
  PersonNotFoundError,
  UserAlreadyAttachedError,
  UserNotAttachedToPersonError,
  UserNotFoundError,
} from './errors.js';

// The transaction callback's `tx`. Database is a strict superset, so helpers
// typed against Tx accept both the top-level db and an in-flight tx.
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AttachedUser {
  id: number;
  displayName: string;
  username: string | null;
  email: string | null;
  bitbucketUuid: string;
  isPrimary: boolean;
}

export interface PersonWithAliases {
  id: number;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
  attachedUsers: AttachedUser[];
}

export interface CreatePersonInput {
  displayName?: string | null;
  // When provided, the new person is created AND this user is attached as
  // primary in the same transaction.
  primaryUserId?: number | null;
}

export interface AttachOptions {
  // true → new alias becomes primary, clearing any existing one. false
  // (default) → auto-elect only if the person has no primary yet, so every
  // non-empty person has a primary unless an explicit detach left it empty.
  makePrimary?: boolean;
}

export interface AttachResult {
  becamePrimary: boolean;
}

export interface DetachResult {
  wasPrimary: boolean;
}

export interface SetPrimaryResult {
  // Null when the person had no primary before the swap.
  previousPrimaryUserId: number | null;
}

export interface DissolveResult {
  detachedUserIds: number[];
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface PeopleStore {
  list(): Promise<PersonWithAliases[]>;
  get(id: number): Promise<PersonWithAliases | null>;
  create(input: CreatePersonInput): Promise<PersonWithAliases>;
  updateDisplayName(id: number, displayName: string | null): Promise<PersonWithAliases>;
  attach(personId: number, userId: number, opts?: AttachOptions): Promise<AttachResult>;
  detach(personId: number, userId: number): Promise<DetachResult>;
  setPrimary(personId: number, userId: number): Promise<SetPrimaryResult>;
  dissolve(id: number): Promise<DissolveResult>;
  // Operator override for `users.membership_override` — force an account's
  // membershipStatus ('member' | 'departed' | 'external'), or pass null to
  // clear back to auto-classification. Throws UserNotFoundError for an unknown
  // id. Distinct from the merge operations: no person is created; the standalone
  // user row is just flagged.
  setMembershipOverride(
    userId: number,
    override: MembershipOverride | null,
  ): Promise<{ userId: number; membershipOverride: MembershipOverride | null }>;
}

export type MembershipOverride = 'member' | 'departed' | 'external';

// ---------------------------------------------------------------------------
// Drizzle implementation
// ---------------------------------------------------------------------------

interface UserRow {
  id: number;
  personId: number | null;
  isPrimaryForPerson: boolean;
}

export function createDrizzlePeopleStore(db: Database): PeopleStore {
  // Reads
  // -------------------------------------------------------------------------

  async function loadAttachedUsers(runner: Tx, personIds: ReadonlyArray<number>): Promise<Map<number, AttachedUser[]>> {
    const byPerson = new Map<number, AttachedUser[]>();
    if (personIds.length === 0) return byPerson;
    const rows = await runner
      .select({
        personId: users.personId,
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        email: users.email,
        bitbucketUuid: users.bitbucketUuid,
        isPrimary: users.isPrimaryForPerson,
      })
      .from(users)
      .where(inArray(users.personId, [...personIds]))
      .orderBy(asc(users.personId), asc(users.id));
    for (const r of rows) {
      if (r.personId === null) continue;
      let bag = byPerson.get(r.personId);
      if (bag === undefined) {
        bag = [];
        byPerson.set(r.personId, bag);
      }
      bag.push({
        id: r.id,
        displayName: r.displayName,
        username: r.username,
        email: r.email,
        bitbucketUuid: r.bitbucketUuid,
        isPrimary: r.isPrimary,
      });
    }
    return byPerson;
  }

  async function loadPersonWithAliases(runner: Tx, personId: number): Promise<PersonWithAliases | null> {
    const [person] = await runner
      .select({
        id: people.id,
        displayName: people.displayName,
        createdAt: people.createdAt,
        updatedAt: people.updatedAt,
      })
      .from(people)
      .where(eq(people.id, personId))
      .limit(1);
    if (person === undefined) return null;
    const aliasMap = await loadAttachedUsers(runner, [personId]);
    return { ...person, attachedUsers: aliasMap.get(personId) ?? [] };
  }

  // Mutation helpers — every person_id / is_primary_for_person transition goes
  // through these so the CHECK invariant stays satisfied.
  // -------------------------------------------------------------------------

  // Clear both columns together so the row never passes through the
  // (is_primary=true, person_id=NULL) state the CHECK rejects.
  async function detachUserRow(tx: Tx, userId: number): Promise<void> {
    await tx.update(users).set({ personId: null, isPrimaryForPerson: false }).where(eq(users.id, userId));
  }

  // Clear the current primary flag before flipping a new alias to primary —
  // the partial unique index allows only one primary per person at a time.
  async function clearPrimaryFlagFor(tx: Tx, personId: number): Promise<void> {
    await tx
      .update(users)
      .set({ isPrimaryForPerson: false })
      .where(and(eq(users.personId, personId), eq(users.isPrimaryForPerson, true)));
  }

  async function findUserById(tx: Tx, userId: number): Promise<UserRow | null> {
    const [row] = await tx
      .select({ id: users.id, personId: users.personId, isPrimaryForPerson: users.isPrimaryForPerson })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ?? null;
  }

  async function findPersonId(tx: Tx, personId: number): Promise<boolean> {
    const [row] = await tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).limit(1);
    return row !== undefined;
  }

  async function findCurrentPrimary(tx: Tx, personId: number): Promise<number | null> {
    const [row] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.personId, personId), eq(users.isPrimaryForPerson, true)))
      .limit(1);
    return row?.id ?? null;
  }

  // Public surface
  // -------------------------------------------------------------------------

  return {
    async list() {
      // Transaction-wrapped only so the Tx-typed helpers accept this runner.
      return await db.transaction(async (tx) => {
        const personRows = await tx
          .select({
            id: people.id,
            displayName: people.displayName,
            createdAt: people.createdAt,
            updatedAt: people.updatedAt,
          })
          .from(people)
          .orderBy(asc(people.id));
        const aliasMap = await loadAttachedUsers(
          tx,
          personRows.map((p) => p.id),
        );
        return personRows.map((p) => ({
          ...p,
          attachedUsers: aliasMap.get(p.id) ?? [],
        }));
      });
    },

    async get(id) {
      return await db.transaction(async (tx) => loadPersonWithAliases(tx, id));
    },

    async create(input) {
      return await db.transaction(async (tx) => {
        // Validate before INSERT for a cleaner error than a rollback.
        if (input.primaryUserId !== undefined && input.primaryUserId !== null) {
          const user = await findUserById(tx, input.primaryUserId);
          if (user === null) throw new UserNotFoundError(input.primaryUserId);
          if (user.personId !== null) throw new UserAlreadyAttachedError(input.primaryUserId, user.personId);
        }

        const [inserted] = await tx
          .insert(people)
          .values({ displayName: input.displayName ?? null })
          .returning({
            id: people.id,
            displayName: people.displayName,
            createdAt: people.createdAt,
            updatedAt: people.updatedAt,
          });
        if (inserted === undefined) {
          throw new Error('failed to insert person row');
        }

        if (input.primaryUserId !== undefined && input.primaryUserId !== null) {
          await tx
            .update(users)
            .set({ personId: inserted.id, isPrimaryForPerson: true })
            .where(eq(users.id, input.primaryUserId));
        }

        const aliasMap = await loadAttachedUsers(tx, [inserted.id]);
        return { ...inserted, attachedUsers: aliasMap.get(inserted.id) ?? [] };
      });
    },

    async updateDisplayName(id, displayName) {
      return await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(people)
          .set({ displayName, updatedAt: new Date() })
          .where(eq(people.id, id))
          .returning({
            id: people.id,
            displayName: people.displayName,
            createdAt: people.createdAt,
            updatedAt: people.updatedAt,
          });
        if (updated === undefined) throw new PersonNotFoundError(id);
        const aliasMap = await loadAttachedUsers(tx, [id]);
        return { ...updated, attachedUsers: aliasMap.get(id) ?? [] };
      });
    },

    async attach(personId, userId, opts) {
      return await db.transaction(async (tx) => {
        if (!(await findPersonId(tx, personId))) throw new PersonNotFoundError(personId);
        const user = await findUserById(tx, userId);
        if (user === null) throw new UserNotFoundError(userId);
        if (user.personId !== null) throw new UserAlreadyAttachedError(userId, user.personId);

        // makePrimary=true → always primary; else auto-elect if the person has
        // no primary yet.
        const explicitPrimary = opts?.makePrimary === true;
        const currentPrimary = explicitPrimary ? null : await findCurrentPrimary(tx, personId);
        const becamePrimary = explicitPrimary || currentPrimary === null;

        if (becamePrimary) {
          await clearPrimaryFlagFor(tx, personId);
        }
        await tx.update(users).set({ personId, isPrimaryForPerson: becamePrimary }).where(eq(users.id, userId));

        return { becamePrimary };
      });
    },

    async detach(personId, userId) {
      return await db.transaction(async (tx) => {
        const user = await findUserById(tx, userId);
        if (user === null) throw new UserNotFoundError(userId);
        if (user.personId !== personId) {
          throw new UserNotAttachedToPersonError(userId, personId, user.personId);
        }
        const wasPrimary = user.isPrimaryForPerson;
        await detachUserRow(tx, userId);
        return { wasPrimary };
      });
    },

    async setPrimary(personId, userId) {
      return await db.transaction(async (tx) => {
        const user = await findUserById(tx, userId);
        if (user === null) throw new UserNotFoundError(userId);
        if (user.personId !== personId) {
          throw new UserNotAttachedToPersonError(userId, personId, user.personId);
        }
        const previousPrimaryUserId = await findCurrentPrimary(tx, personId);
        if (previousPrimaryUserId === userId) {
          // Already primary — skip the redundant UPDATE.
          return { previousPrimaryUserId };
        }
        await clearPrimaryFlagFor(tx, personId);
        await tx.update(users).set({ isPrimaryForPerson: true }).where(eq(users.id, userId));
        return { previousPrimaryUserId };
      });
    },

    async setMembershipOverride(userId, override) {
      return await db.transaction(async (tx) => {
        const user = await findUserById(tx, userId);
        if (user === null) throw new UserNotFoundError(userId);
        await tx.update(users).set({ membershipOverride: override }).where(eq(users.id, userId));
        return { userId, membershipOverride: override };
      });
    },

    async dissolve(id) {
      return await db.transaction(async (tx) => {
        if (!(await findPersonId(tx, id))) throw new PersonNotFoundError(id);
        // Capture the attached set before clearing so the route can invalidate
        // caches + emit a complete SSE payload.
        const attached = await tx.select({ id: users.id }).from(users).where(eq(users.personId, id));
        // Clear both columns explicitly — relying on the FK ON DELETE SET NULL
        // would fire mid-DELETE with the primary flag still set and trip the CHECK.
        await tx.update(users).set({ personId: null, isPrimaryForPerson: false }).where(eq(users.personId, id));
        await tx.delete(people).where(eq(people.id, id));
        return { detachedUserIds: attached.map((r) => r.id) };
      });
    },
  };
}
