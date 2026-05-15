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
import type { CommitInsertInput, CommitStore, PendingDiffStatCommit } from './commit-store.js';
import { fetchDiffStatsForCommits, type DiffStatsSyncResult } from './diff-stats.js';

export interface RepositoryHandle {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  // Phase 4 T21: when true, the per-repo sync also fetches /diffstat/:sha
  // for newly-inserted commits and any leftover pending ones (those with
  // commits.diff_stats_synced_at IS NULL). When false, the diff-stats step
  // is skipped entirely — no extra BB calls, no extra DB work.
  diffStatsEnabled: boolean;
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
  // Phase 4 T21: opt-in per-commit diff-stat ingest. When omitted, the
  // diff-stats step is skipped entirely (legacy callers, tests that don't
  // care). When present, only the *inline-eager* path runs here: we walk
  // the commits just inserted in this run and fetch /diffstat for each.
  // Older pending commits (`diff_stats_synced_at IS NULL` from past runs)
  // are NOT picked up inline — that's the backfill tick's job. Opt-out
  // repos still short-circuit cheaply inside `fetchDiffStatsForCommits`.
  diffStats?: { budgetThreshold: number };
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
  // Phase 4 T21: per-commit diff-stat ingest results. All zero / null when
  // the repo's diffStatsEnabled flag is off or when opts.diffStats wasn't
  // supplied. The rollup hook ORs `diffStatsRange` with `insertedRange` so
  // commit_daily refreshes for diff-stat-only updates too.
  diffStatsUpdated: number;
  diffStatsFailed: number;
  diffStatsRange: { sinceDay: string; untilDay: string } | null;
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
      // BB returns one entry in `parents` for a normal commit, two+ for a
      // merge. Captured at insert time so downstream aggregates can
      // default-exclude merges without an extra fetch.
      isMerge: c.parents.length > 1,
      authoredAt: new Date(c.date),
    }));
    const { inserted, insertedRows } = await deps.store.insertCommits(inserts);

    await deps.store.markSyncSuccess(repo.repositoryId, {
      lastSeenSha: newCursor,
      commitsAdded: inserted,
    });

    // Phase 4 T21 — inline-eager diff-stat ingest for the commits we just
    // inserted. Runs after markSyncSuccess so commits + cursor are durable
    // first; a failure here doesn't poison the commit-sync result (the
    // cursor advanced, the commits landed, and pending diff stats stay
    // NULL → retried via the backfill tick).
    //
    // Older pending commits are intentionally *not* walked here — those
    // are the backfill tick's responsibility, which runs after deepen with
    // a lower priority. Splitting forward (eager) from backward (trickle)
    // keeps new commits' stats fresh without letting a long backlog
    // crowd the commit-tick budget.
    let diffStatsResult: DiffStatsSyncResult = {
      updated: 0,
      failed: 0,
      deferred: 0,
      hitBudgetGate: false,
      diffStatsRange: null,
    };
    if (repo.diffStatsEnabled && opts.diffStats && insertedRows.length > 0) {
      const justInserted: PendingDiffStatCommit[] = insertedRows.map((r) => ({
        id: r.id,
        sha: r.sha,
        authoredAt: r.authoredAt,
      }));
      try {
        diffStatsResult = await fetchDiffStatsForCommits(
          { client: deps.client, store: deps.store, ...(deps.logger ? { logger: deps.logger } : {}) },
          repo,
          justInserted,
          opts.diffStats,
        );
      } catch (err) {
        deps.logger?.warn?.(
          { ...repo, err: err instanceof Error ? err.message : String(err) },
          'diff-stats step failed — commits already landed, will retry via backfill tick',
        );
      }
    }

    deps.logger?.info?.(
      {
        ...repo,
        mode: isCold ? 'cold' : 'delta',
        fetched: pull.batch.length,
        inserted,
        hitKnownSha: pull.hitKnownSha,
        hitPageCap: pull.hitPageCap,
        hitDateCap: pull.hitDateCap,
        diffStatsUpdated: diffStatsResult.updated,
        diffStatsFailed: diffStatsResult.failed,
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
      diffStatsUpdated: diffStatsResult.updated,
      diffStatsFailed: diffStatsResult.failed,
      diffStatsRange: diffStatsResult.diffStatsRange,
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
    diffStatsUpdated: 0,
    diffStatsFailed: 0,
    diffStatsRange: null,
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
