// Per-repository commit sync. Walks /repositories/{ws}/{slug}/commits, stops
// at the cursor (delta mode) or at a configurable cap (cold mode), resolves
// authors, and bulk-inserts via the CommitStore. The runner / cron / admin
// trigger that actually invokes this lives in a follow-up commit.
//
// Idempotency:
//   * insertCommits dedupes on (repository_id, sha) — re-runs converge.
//   * Two concurrent ticks for the same repo are safe but wasteful; bounded
//     concurrency lands in the API-budget commit.
//
// Modes:
//   * 'cold'     — first run for a repo (last_seen_sha is null). Capped by
//                  firstRunMaxPages and/or firstRunSince so a fresh tracked
//                  repo doesn't drain the API budget on bootstrap.
//   * 'delta'    — last_seen_sha is set. Walks newest-first until it matches.
//                  Idle repo costs one call.
//   * 'no-state' — sync_state row missing. Caller should bootstrap it via
//                  insertRepositoryWithSyncState before invoking us.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits, type BitbucketCommit } from '../bitbucket/commits.js';
import type { CommitInsertInput, CommitStore } from './commit-store.js';

export interface RepositoryHandle {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
}

export interface CommitSyncOptions {
  // First-run cap: stop the initial backfill after this many pages of 100
  // commits. No effect on delta runs (they always stop at last_seen_sha).
  firstRunMaxPages?: number;
  // First-run cap: stop the initial backfill at any commit authored before
  // this date. Combined with firstRunMaxPages, whichever fires first wins.
  firstRunSince?: Date;
  // Restrict history walk to a single ref. Defaults to BitBucket's main-branch
  // behavior. Mostly here for tests; production calls leave it unset.
  include?: string;
}

export type SyncMode = 'cold' | 'delta' | 'no-state';

export interface RepoCommitSyncResult {
  repositoryId: number;
  fullName: string;
  mode: SyncMode;
  fetched: number;
  inserted: number;
  newCursor: string | null;
  hitKnownSha: boolean;
  hitPageCap: boolean;
  hitDateCap: boolean;
  // UTC day window covering every commit in the just-pulled batch. Set only
  // when the batch is non-empty (regardless of how many actually inserted —
  // some may have lost the ON CONFLICT race). Consumed by the rollup hook
  // in dashboard/rollup-hook.ts to scope the commit_daily recompute.
  insertedRange: { sinceDay: string; untilDay: string } | null;
}

export interface CommitSyncDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
}

export async function syncRepositoryCommits(
  deps: CommitSyncDeps,
  repo: RepositoryHandle,
  opts: CommitSyncOptions = {},
): Promise<RepoCommitSyncResult> {
  const cursor = await deps.store.getSyncState(repo.repositoryId);
  if (cursor === null) {
    deps.logger?.warn?.({ ...repo }, 'commit sync skipped: no sync_state row');
    return emptyResult(repo, 'no-state');
  }

  await deps.store.markSyncRunning(repo.repositoryId);

  try {
    const lastSeenSha = cursor.lastSeenSha;
    const isCold = lastSeenSha === null;
    const pull = await pullCommits(deps, repo, lastSeenSha, opts);

    // BB returns newest-first, so the head of the batch is our new cursor.
    // An empty batch leaves the existing cursor untouched (see store impl).
    const newCursor = pull.batch[0]?.hash ?? null;

    const uuids = Array.from(
      new Set(pull.batch.map((c) => c.author.user?.uuid).filter((u): u is string => u !== undefined)),
    );
    const userIdByUuid = await deps.store.resolveUserIdsByUuid(uuids);

    const inserts: CommitInsertInput[] = pull.batch.map((c) => ({
      repositoryId: repo.repositoryId,
      authorUserId: c.author.user ? (userIdByUuid.get(c.author.user.uuid) ?? null) : null,
      sha: c.hash,
      message: c.message,
      authoredAt: new Date(c.date),
    }));
    const { inserted } = await deps.store.insertCommits(inserts);

    await deps.store.markSyncSuccess(repo.repositoryId, {
      lastSeenSha: newCursor,
      commitsAdded: inserted,
    });

    deps.logger?.info?.(
      {
        ...repo,
        mode: isCold ? 'cold' : 'delta',
        fetched: pull.batch.length,
        inserted,
        hitKnownSha: pull.hitKnownSha,
        hitPageCap: pull.hitPageCap,
        hitDateCap: pull.hitDateCap,
      },
      'commit sync complete',
    );

    return {
      repositoryId: repo.repositoryId,
      fullName: repo.fullName,
      mode: isCold ? 'cold' : 'delta',
      fetched: pull.batch.length,
      inserted,
      newCursor,
      hitKnownSha: pull.hitKnownSha,
      hitPageCap: pull.hitPageCap,
      hitDateCap: pull.hitDateCap,
      insertedRange: rangeOfBatch(pull.batch),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.store.markSyncFailed(repo.repositoryId, msg);
    throw err;
  }
}

interface PullResult {
  batch: BitbucketCommit[];
  hitKnownSha: boolean;
  hitPageCap: boolean;
  hitDateCap: boolean;
}

async function pullCommits(
  deps: CommitSyncDeps,
  repo: RepositoryHandle,
  lastSeenSha: string | null,
  opts: CommitSyncOptions,
): Promise<PullResult> {
  const isCold = lastSeenSha === null;
  const maxCommits = opts.firstRunMaxPages !== undefined ? opts.firstRunMaxPages * 100 : undefined;
  const sinceMs = opts.firstRunSince?.getTime();

  const batch: BitbucketCommit[] = [];
  let hitKnownSha = false;
  let hitPageCap = false;
  let hitDateCap = false;

  const iterOpts = opts.include !== undefined ? { include: opts.include } : {};
  for await (const commit of paginateCommits(deps.client, repo.workspace, repo.slug, iterOpts)) {
    if (!isCold && commit.hash === lastSeenSha) {
      hitKnownSha = true;
      break;
    }
    if (isCold && sinceMs !== undefined && new Date(commit.date).getTime() < sinceMs) {
      hitDateCap = true;
      break;
    }
    batch.push(commit);
    if (isCold && maxCommits !== undefined && batch.length >= maxCommits) {
      hitPageCap = true;
      break;
    }
  }

  return { batch, hitKnownSha, hitPageCap, hitDateCap };
}

function emptyResult(repo: RepositoryHandle, mode: SyncMode): RepoCommitSyncResult {
  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    mode,
    fetched: 0,
    inserted: 0,
    newCursor: null,
    hitKnownSha: false,
    hitPageCap: false,
    hitDateCap: false,
    insertedRange: null,
  };
}

// UTC day bounds for a newest-first commit batch. batch[0] is the most
// recent commit (→ untilDay); the tail is the oldest (→ sinceDay). Returns
// null for an empty batch. The slice(0,10) trick reads the YYYY-MM-DD of
// an ISO timestamp, which matches Postgres
// `date_trunc('day', x AT TIME ZONE 'UTC')::date` exactly.
function rangeOfBatch(batch: BitbucketCommit[]): { sinceDay: string; untilDay: string } | null {
  if (batch.length === 0) return null;
  const newest = batch[0]!.date;
  const oldest = batch[batch.length - 1]!.date;
  return {
    sinceDay: new Date(oldest).toISOString().slice(0, 10),
    untilDay: new Date(newest).toISOString().slice(0, 10),
  };
}
