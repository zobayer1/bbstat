// Convergence point for the sync surface. Multiple entry points so crons can
// dispatch to a focused operation (cheaper, more granular logs) while admin /
// future-webhook triggers can run combined flows.
//
//   runMembersSync   — workspace members → users
//   runReposSync     — curated tracked-repo bootstrap
//   runDiscoverySync — members + repos sequentially (manual admin trigger)
//   runCommitsSync   — per-repo commit ingest across the curated set
//
// All entry points are idempotent and tolerate races (cron + manual at the
// same time); upserts / cache-hit short-circuits / ON CONFLICT DO NOTHING /
// stop-on-known-sha all converge.
//
// Webhook trigger label is preserved in `SyncTrigger` for forward compat,
// but the receiver endpoint is deferred — see memory/webhook_deferred.md.

import { bootstrapTrackedRepositories, syncWorkspaceMembers } from './discovery.js';
import { runCommitsTick } from './commits-tick.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import type { AppConfig } from '../config.js';
import type { CommitStore } from './commit-store.js';
import type { CommitsTickOptions } from './commits-tick.js';
import type { RepoCommitSyncResult, RepositoryHandle } from './commits.js';
import type { BootstrapReposResult, RepoSeed, SyncMembersResult } from './discovery.js';
import type { DiscoveryStore } from './discovery-store.js';

export type SyncTrigger = 'manual' | 'cron' | 'webhook';

export interface SyncRunnerDeps {
  client: BitbucketClient;
  store: DiscoveryStore;
  logger: BitbucketLogger;
  workspace: string;
  // Thunk so each sync invocation re-reads the seed file. Lets operators
  // edit `tracked-repos.yaml` and have the next `POST /sync/discover` (or
  // next cron tick) pick up the change with no restart. A malformed file
  // throws here, surfaced as the sync's error path.
  seeds: () => RepoSeed[];
  commitStore: CommitStore;
  // Defaults applied by runCommitsTick if absent.
  commitTickOptions?: CommitsTickOptions;
}

interface BaseResult {
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string;
}

export interface MembersSyncResult extends BaseResult {
  members: SyncMembersResult;
}

export interface ReposSyncResult extends BaseResult {
  repos: BootstrapReposResult;
}

export interface DiscoverySyncResult extends BaseResult {
  members: SyncMembersResult;
  repos: BootstrapReposResult;
}

export interface CommitsSyncSummary {
  attempted: number;
  deferred: number;
  errors: number;
  totalCommitsInserted: number;
  budgetRemainingAtEnd: number;
  stoppedEarly: boolean;
}

export interface CommitsSyncResult extends BaseResult {
  commits: CommitsSyncSummary;
  // Per-repo detail kept separate from the summary so log lines stay terse;
  // admins / debuggers can drill into the array via the response body.
  repoResults: RepoCommitSyncResult[];
  errors: Array<{ repository: RepositoryHandle; error: string }>;
  deferred: RepositoryHandle[];
}

export async function runMembersSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<MembersSyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace }, 'members sync start');
  const members = await syncWorkspaceMembers(deps, deps.workspace);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, members, startedAt, finishedAt }, 'members sync complete');
  return { trigger, startedAt, finishedAt, members };
}

export async function runReposSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<ReposSyncResult> {
  const startedAt = new Date().toISOString();
  const seeds = deps.seeds();
  deps.logger.info?.({ trigger, workspace: deps.workspace, seedCount: seeds.length }, 'repos sync start');
  const repos = await bootstrapTrackedRepositories(deps, seeds);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, repos, startedAt, finishedAt }, 'repos sync complete');
  return { trigger, startedAt, finishedAt, repos };
}

export async function runDiscoverySync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<DiscoverySyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace }, 'discovery sync start');
  const members = await syncWorkspaceMembers(deps, deps.workspace);
  const repos = await bootstrapTrackedRepositories(deps, deps.seeds());
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, members, repos, startedAt, finishedAt }, 'discovery sync complete');
  return { trigger, startedAt, finishedAt, members, repos };
}

export async function runCommitsSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<CommitsSyncResult> {
  const startedAt = new Date().toISOString();
  const rows = await deps.store.listTrackedRepositories();
  const handles: RepositoryHandle[] = rows.map((r) => ({
    repositoryId: r.id,
    workspace: r.workspace,
    slug: r.slug,
    fullName: r.fullName,
  }));
  deps.logger.info?.({ trigger, workspace: deps.workspace, repoCount: handles.length }, 'commit sync start');

  const tick = await runCommitsTick(
    { client: deps.client, store: deps.commitStore, logger: deps.logger },
    handles,
    deps.commitTickOptions ?? {},
  );

  const totalCommitsInserted = tick.attempted.reduce((acc, r) => acc + r.inserted, 0);
  const summary: CommitsSyncSummary = {
    attempted: tick.attempted.length,
    deferred: tick.deferred.length,
    errors: tick.errors.length,
    totalCommitsInserted,
    budgetRemainingAtEnd: tick.budgetRemainingAtEnd,
    stoppedEarly: tick.stoppedEarly,
  };
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, ...summary, startedAt, finishedAt }, 'commit sync complete');

  return {
    trigger,
    startedAt,
    finishedAt,
    commits: summary,
    repoResults: tick.attempted,
    errors: tick.errors,
    deferred: tick.deferred,
  };
}

// Build CommitsTickOptions from app config. Both runtime entry points (HTTPS
// API and the cron host) share this so the same env vars apply everywhere.
export function commitTickOptionsFromConfig(config: AppConfig): CommitsTickOptions {
  const since = config.COMMITS_BACKFILL_SINCE === '' ? undefined : new Date(config.COMMITS_BACKFILL_SINCE);
  return {
    firstRunMaxPages: config.COMMITS_BACKFILL_MAX_PAGES,
    ...(since !== undefined ? { firstRunSince: since } : {}),
    concurrency: config.COMMIT_SYNC_CONCURRENCY,
    budgetLowThreshold: config.COMMIT_SYNC_BUDGET_THRESHOLD,
  };
}
