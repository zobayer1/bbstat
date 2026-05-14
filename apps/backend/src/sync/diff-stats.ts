// Per-commit diff-stat ingest — fetches /diffstat/:sha and persists
// additions / deletions / files_changed onto each commit row. Two call
// paths share the inner walker:
//
//   1. Inline-eager (forward path) — invoked by `syncRepositoryCommits`
//      right after `insertCommits` returns the newly-landed rows. We feed
//      those rows directly into `fetchDiffStatsForCommits`, so brand-new
//      commits get their stats with minimal lag and without a DB pickup.
//
//   2. Backfill (backward path) — invoked by `runDiffStatsBackfillTick`
//      after the deepen tick, lower priority than commit-list ingest.
//      `syncRepositoryDiffStats` pulls pending commits from the DB
//      (`commits.diff_stats_synced_at IS NULL`, newest-authored first)
//      and feeds them to the same inner walker.
//
// Resumability lives on `diff_stats_synced_at`: a successful fetch +
// UPDATE stamps now(), so the next pickup query skips it. A transient
// failure (HTTP 5xx, network blip) leaves the row NULL → retried next
// tick. A persistent 4xx on a single commit will waste one BB call per
// tick until investigated, but won't block others since the loop
// continues past per-commit errors.
//
// Pure short-circuit when `repo.diffStatsEnabled === false` — no DB
// read, no BB call. Cheap to call unconditionally.

import { getCommitDiffStat } from '../bitbucket/diff-stats.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import type { CommitStore, PendingDiffStatCommit } from './commit-store.js';
import type { RepositoryHandle } from './commits.js';

export interface DiffStatsSyncOptions {
  // Max commits in flight per repo per tick. Caps both BB-call volume and
  // worst-case per-tick work so a backlog of pending commits drains over
  // multiple ticks rather than blowing the budget in one.
  maxPerRepoPerTick: number;
  // Headroom below BITBUCKET_HOURLY_CALL_BUDGET. The loop stops scheduling
  // new commits once getBudgetRemaining() falls below this; remaining
  // pending commits are picked up on the next tick.
  budgetThreshold: number;
}

export interface DiffStatsSyncResult {
  // Commits whose diff stats were successfully fetched + persisted this run.
  updated: number;
  // Commits whose fetch failed and remain pending (diff_stats_synced_at IS NULL).
  failed: number;
  // True iff the budget gate fired and we stopped before draining the pickup.
  hitBudgetGate: boolean;
  // UTC day range covering every commit whose diff stats just landed. Consumed
  // by the rollup hook to scope the commit_daily refresh. Null when nothing
  // was successfully updated.
  diffStatsRange: { sinceDay: string; untilDay: string } | null;
}

export interface DiffStatsSyncDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
}

const EMPTY: DiffStatsSyncResult = {
  updated: 0,
  failed: 0,
  hitBudgetGate: false,
  diffStatsRange: null,
};

// Inline-eager forward path. Fetches diff stats for an explicit list of
// commits (typically the ones just inserted by `syncRepositoryCommits`)
// — no DB pickup, no `maxPerRepoPerTick` cap (caller decides how many
// rows to pass in). Budget gate still applies so a fat batch can't blow
// the hourly cap.
export async function fetchDiffStatsForCommits(
  deps: DiffStatsSyncDeps,
  repo: RepositoryHandle,
  commits: PendingDiffStatCommit[],
  opts: { budgetThreshold: number },
): Promise<DiffStatsSyncResult> {
  if (!repo.diffStatsEnabled || commits.length === 0) return EMPTY;
  return walkAndPersist(deps, repo, commits, opts.budgetThreshold);
}

// Backfill / backward path. Pulls up to `maxPerRepoPerTick` pending
// commits (`diff_stats_synced_at IS NULL`) newest-first from the store
// and feeds them to the same walker. Used by `runDiffStatsBackfillTick`.
export async function syncRepositoryDiffStats(
  deps: DiffStatsSyncDeps,
  repo: RepositoryHandle,
  opts: DiffStatsSyncOptions,
): Promise<DiffStatsSyncResult> {
  if (!repo.diffStatsEnabled) return EMPTY;

  const pending = await deps.store.listPendingDiffStatCommits(repo.repositoryId, opts.maxPerRepoPerTick);
  if (pending.length === 0) return EMPTY;

  return walkAndPersist(deps, repo, pending, opts.budgetThreshold);
}

async function walkAndPersist(
  deps: DiffStatsSyncDeps,
  repo: RepositoryHandle,
  commits: PendingDiffStatCommit[],
  budgetThreshold: number,
): Promise<DiffStatsSyncResult> {
  let updated = 0;
  let failed = 0;
  let hitBudgetGate = false;
  let sinceDay: string | null = null;
  let untilDay: string | null = null;

  for (const commit of commits) {
    if (deps.client.getBudgetRemaining() < budgetThreshold) {
      hitBudgetGate = true;
      deps.logger?.warn?.(
        {
          repositoryId: repo.repositoryId,
          fullName: repo.fullName,
          remaining: deps.client.getBudgetRemaining(),
          threshold: budgetThreshold,
          deferred: commits.length - updated - failed,
        },
        'diff-stats sync: budget gate — deferring remaining commits',
      );
      break;
    }
    try {
      const stat = await getCommitDiffStat(deps.client, repo.workspace, repo.slug, commit.sha);
      await deps.store.updateCommitDiffStats(commit.id, stat);
      updated++;
      // YYYY-MM-DD of the commit's authored_at, matching Postgres'
      // `(date_trunc('day', x AT TIME ZONE 'UTC'))::date` exactly — same
      // bucketing the rollup uses, so the range we hand back lines up.
      const day = commit.authoredAt.toISOString().slice(0, 10);
      if (sinceDay === null || day < sinceDay) sinceDay = day;
      if (untilDay === null || day > untilDay) untilDay = day;
    } catch (err) {
      failed++;
      deps.logger?.warn?.(
        {
          repositoryId: repo.repositoryId,
          fullName: repo.fullName,
          sha: commit.sha,
          err: err instanceof Error ? err.message : String(err),
        },
        'diff-stats fetch failed — leaving commit pending for next tick',
      );
    }
  }

  const diffStatsRange = sinceDay !== null && untilDay !== null ? { sinceDay, untilDay } : null;
  deps.logger?.info?.(
    {
      repositoryId: repo.repositoryId,
      fullName: repo.fullName,
      updated,
      failed,
      hitBudgetGate,
      diffStatsRange,
    },
    'diff-stats sync complete',
  );
  return { updated, failed, hitBudgetGate, diffStatsRange };
}
