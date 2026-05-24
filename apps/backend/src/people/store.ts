// Storage interface for the Phase 5 person layer. CRUD over `people`
// plus the attach / detach / primary-swap / dissolve mutations that
// drive the alias-merge admin endpoints. All mutations run in a single
// transaction so the schema invariants (CHECK
// users_primary_requires_person + the partial unique index
// users_one_primary_per_person_idx) stay tight even if a request races
// with a concurrent operator.
//
// The Drizzle-backed implementation at the bottom is what gets wired
// up in the runtime (admin endpoints via `opts.syncDeps.peopleStore`).
// The interface boundary lets us unit-test routes with a fake store
// without spinning up Postgres; tests/admin.test.ts uses the real
// implementation against the dev DB pattern.
//
// On the cycle-free schema (V1_4 amended): primary alias designation
// lives on `users.is_primary_for_person` rather than on
// `people.primary_user_id`. That means every mutation that touches
// the primary state has to clear the flag explicitly before any
// person_id transition — the CHECK
//   NOT is_primary_for_person OR person_id IS NOT NULL
// would otherwise block a `person_id = NULL` UPDATE on a row that
// still has the primary flag set. The store funnels every such
// transition through a single helper so the invariant is local to
// this file.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { people, users } from '../db/schema.js';
import {
  PersonNotFoundError,
  UserAlreadyAttachedError,
  UserNotAttachedToPersonError,
  UserNotFoundError,
} from './errors.js';

// Tx is the first argument of the `db.transaction(async (tx) => …)`
// callback — a Drizzle PgTransaction that exposes select/update/insert/
// delete but not `$client` / `transaction()`. The Database type from
// db/client.ts is a strict superset, so helpers typed against Tx
// accept both the top-level db and an in-flight tx without casts.
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
  // When provided, the new person is created AND this user is attached
  // with is_primary_for_person=true in the same transaction. Throws
  // UserAlreadyAttachedError if the user is already attached elsewhere,
  // UserNotFoundError if the user id doesn't exist.
  primaryUserId?: number | null;
}

export interface AttachOptions {
  // When true, the new alias becomes primary (atomically clearing any
  // existing primary for this person). When false (default), the new
  // alias takes the primary flag only if the person has no primary
  // yet — i.e. auto-election guarantees every non-empty person has a
  // primary unless an explicit detach left it empty.
  makePrimary?: boolean;
}

export interface AttachResult {
  becamePrimary: boolean;
}

export interface DetachResult {
  wasPrimary: boolean;
}

export interface SetPrimaryResult {
  // Null when the person had no primary set before the swap (a recent
  // detach cleared it, or no auto-election fired). Useful for the SSE
  // payload so the frontend can patch its cached roster precisely.
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
}

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

  // Mutation helpers — every state transition that touches person_id or
  // is_primary_for_person goes through these so the CHECK invariant
  // (primary requires person_id) stays satisfied locally.
  // -------------------------------------------------------------------------

  // Atomic clear of person_id + is_primary_for_person on a single user.
  // Both columns move together so the row never transitions through
  // the (is_primary=true, person_id=NULL) state that the CHECK rejects.
  async function detachUserRow(tx: Tx, userId: number): Promise<void> {
    await tx.update(users).set({ personId: null, isPrimaryForPerson: false }).where(eq(users.id, userId));
  }

  // Clear is_primary_for_person on every alias currently primary for
  // `personId`. Used by attach(makePrimary) and setPrimary() before
  // flipping a new alias to primary. The partial unique index allows
  // only one primary per person at any time, so we can't write a new
  // primary without first nulling the existing one (or we'd violate
  // the unique index).
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
      // Wrapped in a transaction purely so the helpers (typed against
      // Tx) accept the same runner the in-transaction mutations use.
      // Postgres auto-commits read-only single-statement transactions
      // with negligible overhead — the BEGIN/COMMIT pair adds <0.1ms.
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
        // Validate first so the INSERT can't half-succeed (Postgres
        // would auto-rollback on throw, but pre-checking gives a
        // cleaner error message before any side effect lands).
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

        // Decide whether this attach also makes the new alias primary.
        // makePrimary=true → always; else auto-elect if the person
        // currently has no primary (every non-empty person has one
        // unless detach explicitly cleared it).
        const explicitPrimary = opts?.makePrimary === true;
        const currentPrimary = explicitPrimary ? null : await findCurrentPrimary(tx, personId);
        const becamePrimary = explicitPrimary || currentPrimary === null;

        if (becamePrimary) {
          // Clear any existing primary so the partial unique index
          // doesn't get violated when we set the new one.
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
          // No-op — return early so we don't burn an UPDATE on a
          // partial unique index that would briefly violate the
          // single-primary invariant (it wouldn't actually fail, but
          // skipping the work is cleaner).
          return { previousPrimaryUserId };
        }
        await clearPrimaryFlagFor(tx, personId);
        await tx.update(users).set({ isPrimaryForPerson: true }).where(eq(users.id, userId));
        return { previousPrimaryUserId };
      });
    },

    async dissolve(id) {
      return await db.transaction(async (tx) => {
        if (!(await findPersonId(tx, id))) throw new PersonNotFoundError(id);
        // Capture the attached set before clearing so the route
        // handler can invalidate caches + emit a complete SSE payload.
        const attached = await tx.select({ id: users.id }).from(users).where(eq(users.personId, id));
        // Clear person_id AND is_primary_for_person in one UPDATE —
        // the FK ON DELETE SET NULL would otherwise fire mid-DELETE
        // with the primary flag still set and trip the CHECK.
        await tx.update(users).set({ personId: null, isPrimaryForPerson: false }).where(eq(users.personId, id));
        await tx.delete(people).where(eq(people.id, id));
        return { detachedUserIds: attached.map((r) => r.id) };
      });
    },
  };
}
