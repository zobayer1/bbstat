// Empty-repo revival sweep. Counterpart to the empty-on-bitbucket auto-trip
// (deepen-backfill.ts): an empty-excluded repo is never re-polled
// (listRepositoriesForSync filters sync_excluded = false), so if someone
// later pushes its first commits, nothing notices until an operator
// /include's it.
//
// This sweep closes that gap: it periodically re-probes the empty-excluded
// (non-archived) repos with one cheap BB call each, and the moment one has
// commits, clears the exclusion and resets the cursor to cold. Detection
// only — it does NOT ingest; clearing the exclusion hands the repo back to
// the normal tick. ARCHIVED repos are skipped on purpose (deliberate retire).

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits } from '../bitbucket/commits.js';
import type { EventBus } from '../events/bus.js';
import type { CommitStore } from './commit-store.js';
import type { DiscoveryStore } from './discovery-store.js';

export interface EmptyRevivalOptions {
  // Cap on repos probed per tick — one BB call each. Bounds the cost when
  // many repos sit empty-excluded; normally near-empty.
  maxReposPerTick: number;
  // Skip the sweep below this budget — delta sync and the backfills come first.
  budgetThreshold: number;
}

export interface EmptyRevivalDeps {
  client: BitbucketClient;
  // Narrow store slices — only what the sweep touches, keeping the fakes small.
  discoveryStore: Pick<DiscoveryStore, 'listEmptyExcludedRepos' | 'updateRepositorySyncExcluded'>;
  commitStore: Pick<CommitStore, 'resetSyncCursors'>;
  bus?: EventBus;
  logger?: BitbucketLogger;
}

export interface EmptyRevivalResult {
  checked: number;
  // fullNames whose exclusion was cleared because BB now has commits.
  revived: string[];
  stoppedReason: 'budget' | 'queue-empty' | 'done';
}

export async function runEmptyRevivalTick(
  deps: EmptyRevivalDeps,
  opts: EmptyRevivalOptions,
): Promise<EmptyRevivalResult> {
  if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
    return { checked: 0, revived: [], stoppedReason: 'budget' };
  }

  const candidates = await deps.discoveryStore.listEmptyExcludedRepos();
  if (candidates.length === 0) {
    return { checked: 0, revived: [], stoppedReason: 'queue-empty' };
  }

  const revived: string[] = [];
  let checked = 0;
  for (const repo of candidates.slice(0, opts.maxReposPerTick)) {
    if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
      return { checked, revived, stoppedReason: 'budget' };
    }
    checked += 1;

    let hasCommit = false;
    try {
      // We only need to know whether ANY commit exists, so take the first
      // page's first item and stop.
      for await (const _commit of paginateCommits(deps.client, repo.workspace, repo.slug)) {
        hasCommit = true;
        break;
      }
    } catch (err) {
      // 404 or transient — leave it empty-excluded and re-probe next tick.
      // Reclassifying a 404 isn't this sweep's job; the commit sync's
      // auto-trip handles that once the repo is back in rotation.
      deps.logger?.warn?.(
        { fullName: repo.fullName, err: err instanceof Error ? err.message : String(err) },
        'empty-revival: probe failed — leaving excluded, will retry next tick',
      );
      continue;
    }

    if (!hasCommit) continue;

    // Clear the exclusion and reset the cursor to cold so the next
    // commit-sync tick walks the fresh history (deepen / is-merge re-arm too).
    await deps.discoveryStore.updateRepositorySyncExcluded(repo.id, false, null);
    await deps.commitStore.resetSyncCursors(repo.id);
    deps.bus?.publish({
      event: 'repository.included',
      payload: { repositoryId: repo.id, fullName: repo.fullName, source: 'include' },
    });
    deps.logger?.info?.(
      { fullName: repo.fullName },
      'empty-revival: repo gained commits on BitBucket — exclusion cleared, will sync next tick',
    );
    revived.push(repo.fullName);
  }

  return { checked, revived, stoppedReason: 'done' };
}
