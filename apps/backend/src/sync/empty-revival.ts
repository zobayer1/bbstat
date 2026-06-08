// Empty-repo revival sweep. Counterpart to the empty-on-bitbucket auto-trip
// (deepen-backfill.ts): when a repo's cold + deepen walk converges with zero
// commits, it's excluded with reason 'empty-on-bitbucket' so the sync stops
// burning a BB call on it every tick. But an excluded repo is never re-polled
// — `listRepositoriesForSync` filters `sync_excluded = false` — so if someone
// later pushes the repo's first commits, nothing notices: it stays dark until
// an operator manually `/include`s it.
//
// This sweep closes that gap. It periodically re-probes the empty-excluded
// (non-archived) repos with a single cheap BB call each. The moment one has
// commits, it clears the exclusion and resets the cursor to cold, so the next
// commit-sync tick walks the fresh history. ARCHIVED repos are skipped on
// purpose — archiving is a deliberate retire, and auto-reviving it would
// override that decision (the candidate query in `listEmptyExcludedRepos`
// enforces `archived = false`).
//
// Detection only: it does NOT ingest commits itself. Clearing the exclusion
// hands the repo back to the normal tick. Until BitBucket webhooks land, this
// is the self-healing path for empty -> active repos.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits } from '../bitbucket/commits.js';
import type { EventBus } from '../events/bus.js';
import type { CommitStore } from './commit-store.js';
import type { DiscoveryStore } from './discovery-store.js';

export interface EmptyRevivalOptions {
  // Cap on repos probed per tick — one BB call each. Bounds the cost in the
  // pathological case where many repos sit empty-excluded at once; the set
  // is normally near-empty.
  maxReposPerTick: number;
  // Skip the sweep when the BB call budget is below this — delta sync and the
  // higher-priority backfills come first.
  budgetThreshold: number;
}

export interface EmptyRevivalDeps {
  client: BitbucketClient;
  // Narrow slices of the full stores — only what the sweep touches, which
  // keeps the unit-test fakes small.
  discoveryStore: Pick<DiscoveryStore, 'listEmptyExcludedRepos' | 'updateRepositorySyncExcluded'>;
  commitStore: Pick<CommitStore, 'resetSyncCursors'>;
  bus?: EventBus;
  logger?: BitbucketLogger;
}

export interface EmptyRevivalResult {
  // Repos probed this tick (one BB call each).
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
      // One page is one BB call; we only need to know whether ANY commit
      // exists, so take the first and stop iterating.
      for await (const _commit of paginateCommits(deps.client, repo.workspace, repo.slug)) {
        hasCommit = true;
        break;
      }
    } catch (err) {
      // 404 (deleted/renamed upstream) or a transient error — leave the repo
      // empty-excluded and re-probe next tick. Reclassifying a 404 isn't this
      // sweep's job; the commit sync's own auto-trip handles that if/when the
      // repo is back in rotation.
      deps.logger?.warn?.(
        { fullName: repo.fullName, err: err instanceof Error ? err.message : String(err) },
        'empty-revival: probe failed — leaving excluded, will retry next tick',
      );
      continue;
    }

    if (!hasCommit) continue; // still empty — nothing to do

    // Revived. Clear the exclusion and reset the cursor to cold so the next
    // commit-sync tick walks the fresh history (deepen / is-merge backfill
    // re-arm too). Detection only — no ingest here.
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
