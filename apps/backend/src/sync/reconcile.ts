// History-rewrite reconciliation. Recovery path for a repo auto-excluded
// with reason 'history-rewritten' (see commits.ts: the delta walk exhausted
// BitBucket's history without finding our `last_seen_sha`, because a
// force-push / rebase rewrote the commit it pointed at).
//
// The naive recovery — `POST .../include`, which nulls the cursor and lets
// the next tick cold-re-walk the whole repo — re-pages the entire history
// and is wasteful when (as is typical for a force-push) only the tip
// diverged. This module does it surgically instead:
//
//   1. Walk BB's head newest-first until we hit a sha we already store —
//      the COMMON ANCESTOR (the rebase base). Bounded, so a deep rewrite
//      bails rather than walking forever.
//   2. ORPHANS = our commits newer than the ancestor that BB no longer has
//      (the rewritten-away shas). NEW = BB commits above the ancestor we
//      don't have yet.
//   3. Delete the orphans, re-anchor `last_seen_sha` to the ancestor, clear
//      the exclusion, then re-run the normal *delta* commit sync — which
//      stops at the ancestor and ingests only the handful of NEW commits
//      (plus their eager diff-stats). No full re-walk, no re-fetch of
//      existing diff-stats.
//   4. Recompute the affected `commit_daily` day range + scores so deleted
//      / inserted commits are reflected.
//
// `dryRun` returns the computed plan (ancestor, orphans, new-commit count)
// without mutating, so an operator can eyeball the orphan list before the
// irreversible delete.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits } from '../bitbucket/commits.js';
import type { EventBus } from '../events/bus.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { CommitStore } from './commit-store.js';
import type { DiscoveryStore } from './discovery-store.js';
import { syncRepositoryCommits, type CommitSyncOptions, type RepositoryHandle } from './commits.js';

export interface ReconcileDeps {
  client: BitbucketClient;
  commitStore: CommitStore;
  discoveryStore: DiscoveryStore;
  // Optional dashboard upkeep — same dependencies the runner wires for the
  // normal sync. When omitted (tests), the recompute steps are skipped.
  rollupStore?: RollupStore;
  recomputeAllScores?: () => Promise<unknown>;
  bus?: EventBus;
  logger?: BitbucketLogger;
}

export interface ReconcileOptions {
  // When true, compute and return the plan without mutating anything.
  dryRun: boolean;
  // Cap on how many of OUR newest commits to consider as the ancestor
  // search window, and how many BB commits to walk. A force-push rarely
  // rewrites more than a few; the default tolerates a generous rewrite
  // while still bounding the work. Default 500.
  windowSize?: number;
  // Forwarded to the post-anchor delta sync (diff-stats budget etc.).
  commitSyncOptions?: CommitSyncOptions;
}

export interface ReconcilePlan {
  ancestorSha: string;
  // Our commits to delete (newer than the ancestor, absent from BB).
  orphanShas: string[];
  // Count of BB commits above the ancestor the forward sync will ingest.
  newCommitCount: number;
}

export type ReconcileOutcome =
  | { kind: 'dry-run'; plan: ReconcilePlan }
  | {
      kind: 'applied';
      plan: ReconcilePlan;
      orphansDeleted: number;
      commitsInserted: number;
      newCursor: string | null;
    }
  // BB head shares no commit with our recent window — the rewrite is deeper
  // than `windowSize`. Caller should fall back to DELETE + re-add.
  | { kind: 'no-common-ancestor'; walked: number };

type DayRange = { sinceDay: string; untilDay: string };

// Pure diff of two newest-first head windows. Exported for unit testing —
// the orchestrator below feeds it BB's walked shas and our recent rows.
//
//   ancestor   = first BB sha (newest-first) that we also store
//   bbAbove    = BB shas strictly newer than the ancestor (the NEW commits)
//   orphanShas = our commits strictly newer than the ancestor that aren't
//                among bbAbove (the rewritten-away commits)
//
// Returns null when no common ancestor exists in the supplied windows.
export function computeReconcilePlan(
  bbNewestFirst: string[],
  ourRecentNewestFirst: ReadonlyArray<{ sha: string; authoredAt: Date }>,
): { ancestorSha: string; bbAbove: string[]; orphanShas: string[] } | null {
  const ourSet = new Set(ourRecentNewestFirst.map((c) => c.sha));
  const bbAbove: string[] = [];
  let ancestorSha: string | null = null;
  for (const hash of bbNewestFirst) {
    if (ourSet.has(hash)) {
      ancestorSha = hash;
      break;
    }
    bbAbove.push(hash);
  }
  if (ancestorSha === null) return null;

  const ancestorIdx = ourRecentNewestFirst.findIndex((c) => c.sha === ancestorSha);
  const ourNewer = ancestorIdx >= 0 ? ourRecentNewestFirst.slice(0, ancestorIdx) : [];
  const bbAboveSet = new Set(bbAbove);
  const orphanShas = ourNewer.filter((c) => !bbAboveSet.has(c.sha)).map((c) => c.sha);
  return { ancestorSha, bbAbove, orphanShas };
}

export async function reconcileHistoryRewrite(
  deps: ReconcileDeps,
  repo: RepositoryHandle,
  opts: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const windowSize = opts.windowSize ?? 500;

  // Our newest commits — the search window for the common ancestor.
  const ourRecent = await deps.commitStore.listRecentCommitShas(repo.repositoryId, windowSize);
  const ourSet = new Set(ourRecent.map((c) => c.sha));

  // Walk BB newest-first, stopping as soon as we hit a sha we already store
  // (the ancestor) — for a tip rewrite that's page one. Bounded by the
  // window so a fully-divergent history doesn't page forever.
  const bbNewestFirst: string[] = [];
  let walked = 0;
  let foundAncestor = false;
  for await (const commit of paginateCommits(deps.client, repo.workspace, repo.slug)) {
    walked += 1;
    bbNewestFirst.push(commit.hash);
    if (ourSet.has(commit.hash)) {
      foundAncestor = true;
      break;
    }
    if (walked >= windowSize) break;
  }

  const diff = foundAncestor ? computeReconcilePlan(bbNewestFirst, ourRecent) : null;
  if (diff === null) {
    deps.logger?.warn?.(
      { ...repo, walked, windowSize },
      'reconcile: no common ancestor within window — rewrite too deep for surgical recovery',
    );
    return { kind: 'no-common-ancestor', walked };
  }

  const plan: ReconcilePlan = {
    ancestorSha: diff.ancestorSha,
    orphanShas: diff.orphanShas,
    newCommitCount: diff.bbAbove.length,
  };

  if (opts.dryRun) {
    deps.logger?.info?.(
      { ...repo, ancestorSha: plan.ancestorSha, orphans: plan.orphanShas.length, newCommits: plan.newCommitCount },
      'reconcile: dry-run plan computed',
    );
    return { kind: 'dry-run', plan };
  }

  // Apply. Prune orphans, re-anchor the cursor to the ancestor, lift the
  // exclusion — then let the proven delta sync ingest the NEW commits.
  const orphanDays = collectOrphanDays(ourRecent, plan.orphanShas);
  const orphansDeleted = await deps.commitStore.deleteCommitsByShas(repo.repositoryId, plan.orphanShas);
  await deps.commitStore.setLastSeenSha(repo.repositoryId, plan.ancestorSha);
  await deps.discoveryStore.updateRepositorySyncExcluded(repo.repositoryId, false, null);

  const syncResult = await syncRepositoryCommits(
    {
      client: deps.client,
      store: deps.commitStore,
      logger: deps.logger,
      discoveryStore: deps.discoveryStore,
      ...(deps.bus ? { bus: deps.bus } : {}),
    },
    repo,
    opts.commitSyncOptions ?? {},
  );

  // Refresh commit_daily over the union of orphan-deletion days and the
  // inserted range, so both the removals and the additions land in the
  // dashboard rollup. Score recompute is unconditional but cheap (sub-second
  // at corpus scale) — simpler than gating on orphan eligibility.
  const range = mergeDayRanges(orphanDays, syncResult.insertedRange);
  if (deps.rollupStore && range) {
    try {
      await deps.rollupStore.recomputeCommitDailyForRepo(repo.repositoryId, range);
    } catch (err) {
      deps.logger?.warn?.(
        { ...repo, range, err: err instanceof Error ? err.message : String(err) },
        'reconcile: commit_daily recompute failed — will recover on next sync',
      );
    }
  }
  if (deps.recomputeAllScores) {
    try {
      await deps.recomputeAllScores();
    } catch (err) {
      deps.logger?.warn?.(
        { ...repo, err: err instanceof Error ? err.message : String(err) },
        'reconcile: score recompute failed — will recover on next tick',
      );
    }
  }

  deps.logger?.info?.(
    {
      ...repo,
      ancestorSha: plan.ancestorSha,
      orphansDeleted,
      commitsInserted: syncResult.inserted,
      newCursor: syncResult.newCursor,
    },
    'reconcile: applied',
  );

  return {
    kind: 'applied',
    plan,
    orphansDeleted,
    commitsInserted: syncResult.inserted,
    newCursor: syncResult.newCursor,
  };
}

// UTC day window covering the orphaned commits (the rows we delete). Null
// when nothing is orphaned. Day strings are YYYY-MM-DD so lexical compare
// matches chronological order — same convention as rollup-hook.ts.
function collectOrphanDays(
  ourRecent: ReadonlyArray<{ sha: string; authoredAt: Date }>,
  orphanShas: string[],
): DayRange | null {
  if (orphanShas.length === 0) return null;
  const orphanSet = new Set(orphanShas);
  const days = ourRecent
    .filter((c) => orphanSet.has(c.sha))
    .map((c) => c.authoredAt.toISOString().slice(0, 10))
    .sort();
  if (days.length === 0) return null;
  return { sinceDay: days[0]!, untilDay: days[days.length - 1]! };
}

function mergeDayRanges(a: DayRange | null, b: DayRange | null): DayRange | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return {
    sinceDay: a.sinceDay < b.sinceDay ? a.sinceDay : b.sinceDay,
    untilDay: a.untilDay > b.untilDay ? a.untilDay : b.untilDay,
  };
}
