// Workspace-repo discovery sweep. Auto-tracks repositories from the BitBucket
// workspace so the long tail doesn't have to be added by hand.
//
// It walks GET /repositories/{workspace} ordered by `updated_on` ASCENDING,
// keyed off a persisted Redis cursor (`bbstat:repo-discovery-cursor`). Each
// sweep scans a bounded batch with `updated_on > <cursor>`, inserts any
// untracked repo (idempotent — ON CONFLICT on bitbucket_uuid), and advances
// the cursor to the newest `updated_on` it saw. Two behaviours fall out of
// the ascending order:
//
//   * Backfill — from the seed (epoch), the cursor chews through the inactive
//     tail (oldest updated_on) first, climbing past already-tracked active
//     repos (re-seen → insert skipped) up to "now".
//   * Tail-follow — once caught up, `updated_on > cursor` only returns repos
//     updated since the last sweep: newly created repos or ones that just
//     became active. New repos get tracked automatically; the rest of the
//     sync system (cold sync, deepen, backoff, diff-stats, empty-revival)
//     handles them as usual. Inactive ones self-throttle via the backoff.
//
// Forks of repos OUTSIDE the workspace are skipped — a fork inherits its
// upstream's history, which isn't original org work and would double-count.
//
// Detection + insert only; it never archives, excludes, or mutates an
// already-tracked repo.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateWorkspaceRepositories } from '../bitbucket/repositories.js';
import type { CacheClient } from '../cache/redis.js';
import { repoDiscoveryCursorCache } from '../cache/redis.js';
import type { DiscoveryStore } from './discovery-store.js';

// Seed cursor for the very first sweep — "since the beginning", so the
// ascending walk starts at the oldest repo in the workspace.
export const DISCOVERY_SEED_SINCE = '1970-01-01T00:00:00+00:00';

export interface RepoDiscoveryOptions {
  // Repos scanned per sweep (one BB page is 100). Bounds the work so a large
  // workspace's backfill spreads over several ticks rather than one burst.
  maxReposPerSweep: number;
  // Skip the sweep when the BB call budget is below this.
  budgetThreshold: number;
  // When true, compute the plan WITHOUT inserting or advancing the cursor.
  dryRun?: boolean;
}

export interface RepoDiscoveryDeps {
  client: BitbucketClient;
  cache: CacheClient;
  store: Pick<DiscoveryStore, 'insertRepositoryWithSyncState' | 'findRepositoryByFullName'>;
  workspace: string;
  logger?: BitbucketLogger;
}

export interface RepoDiscoveryResult {
  scanned: number;
  // fullNames newly tracked this sweep (apply), or untracked candidates that
  // WOULD be tracked (dry-run).
  added: string[];
  skippedForks: number;
  newCursor: string | null;
  stoppedReason: 'budget' | 'page-cap' | 'caught-up';
  dryRun: boolean;
}

export async function runRepoDiscoverySweep(
  deps: RepoDiscoveryDeps,
  opts: RepoDiscoveryOptions,
): Promise<RepoDiscoveryResult> {
  const dryRun = opts.dryRun ?? false;
  if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
    return { scanned: 0, added: [], skippedForks: 0, newCursor: null, stoppedReason: 'budget', dryRun };
  }

  const since = (await repoDiscoveryCursorCache.get(deps.cache)) ?? DISCOVERY_SEED_SINCE;

  const added: string[] = [];
  let scanned = 0;
  let skippedForks = 0;
  let maxUpdatedOn: string | null = null;
  let stoppedReason: RepoDiscoveryResult['stoppedReason'] = 'caught-up';

  for await (const repo of paginateWorkspaceRepositories(deps.client, deps.workspace, { since })) {
    scanned += 1;
    // Advance the cursor past every scanned repo — including skipped forks —
    // so we don't re-examine them next sweep. Ascending order means
    // updated_on is non-decreasing; the guard just defends against ties.
    if (maxUpdatedOn === null || repo.updated_on > maxUpdatedOn) maxUpdatedOn = repo.updated_on;

    if (repo.parent && !repo.parent.full_name.startsWith(`${deps.workspace}/`)) {
      // Fork of a repo outside the workspace — skip.
      skippedForks += 1;
    } else if (dryRun) {
      // Report only repos that aren't already tracked, so the preview shows
      // genuine additions rather than the whole workspace.
      if ((await deps.store.findRepositoryByFullName(repo.full_name)) === null) {
        added.push(repo.full_name);
      }
    } else {
      const { inserted } = await deps.store.insertRepositoryWithSyncState({
        bitbucketUuid: repo.uuid,
        workspace: repo.workspace.slug,
        project: repo.project?.key ?? null,
        slug: repo.slug,
        fullName: repo.full_name,
        archived: false,
      });
      if (inserted) added.push(repo.full_name);
    }

    if (scanned >= opts.maxReposPerSweep) {
      stoppedReason = 'page-cap';
      break;
    }
    if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
      stoppedReason = 'budget';
      break;
    }
  }

  // Advance the persisted cursor to the newest updated_on we scanned. Skipped
  // in dry-run, and when nothing moved (a caught-up workspace is a no-op).
  if (!dryRun && maxUpdatedOn !== null && maxUpdatedOn !== since) {
    await repoDiscoveryCursorCache.set(deps.cache, maxUpdatedOn);
  }

  deps.logger?.info?.(
    {
      workspace: deps.workspace,
      scanned,
      added: added.length,
      skippedForks,
      since,
      newCursor: maxUpdatedOn,
      stoppedReason,
      dryRun,
    },
    'repo-discovery sweep complete',
  );

  return { scanned, added, skippedForks, newCursor: maxUpdatedOn, stoppedReason, dryRun };
}
