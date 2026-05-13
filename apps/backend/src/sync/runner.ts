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
import { syncRepositoryCommits } from './commits.js';
import { runDeepenTick, type DeepenTickResult } from './deepen-backfill.js';
import { runPullRequestsTick } from './pr-tick.js';
import { withRollupRecompute } from '../dashboard/rollup-hook.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import type { AppConfig } from '../config.js';
import type { CommitStore } from './commit-store.js';
import type { CommitsTickOptions } from './commits-tick.js';
import type { RepoCommitSyncResult, RepositoryHandle } from './commits.js';
import type { BootstrapReposResult, RepoSeed, SyncMembersResult } from './discovery.js';
import type { DiscoveryStore } from './discovery-store.js';
import type { PrStore } from './pr-store.js';
import type { PrTickOptions } from './pr-tick.js';
import type { RepoPrSyncResult } from './pull-requests.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';

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
  // Optional. When present, each per-repo commit sync is wrapped so that a
  // successful insert triggers a scoped commit_daily recompute. Absent in
  // tests that don't care about rollups.
  rollupStore?: RollupStore;
  // Optional. When present (alongside rollupStore), summaries for users with
  // commits in the touched range are DEL'd after the recompute completes.
  userSummaryCache?: UserSummaryCache;
  // Defaults applied by runCommitsTick if absent.
  commitTickOptions?: CommitsTickOptions;
  // Phase 4 T22: PR-ingest store. Required for `runPullRequestsSync`; if
  // omitted, the PR sync paths simply aren't reachable. All runtime
  // entrypoints (HTTPS API + cron host) wire it.
  prStore: PrStore;
  // Defaults applied by runPullRequestsTick if absent.
  prTickOptions?: PrTickOptions;
  // Self-queueing deepen-backfill. When omitted (e.g., in tests that only
  // care about delta sync), the piggyback step inside runCommitsSync is
  // a no-op. All runtime entrypoints wire it.
  deepenOptions?: { maxPages: number; budgetThreshold: number };
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
  // Phase 4 follow-up: piggybacked deepen-backfill outcome. Null when the
  // step is disabled (deepenOptions not wired). Otherwise contains per-repo
  // results from this tick (zero or more) plus a stoppedReason indicating
  // whether the budget gate fired or the queue drained.
  deepen: DeepenTickResult | null;
}

export interface PrsSyncSummary {
  attempted: number;
  deferred: number;
  errors: number;
  totalPrsInserted: number;
  totalPrsUpdated: number;
  budgetRemainingAtEnd: number;
  stoppedEarly: boolean;
}

export interface PrsSyncResult extends BaseResult {
  prs: PrsSyncSummary;
  repoResults: RepoPrSyncResult[];
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
    diffStatsEnabled: r.diffStatsEnabled,
  }));
  deps.logger.info?.({ trigger, workspace: deps.workspace, repoCount: handles.length }, 'commit sync start');

  // When a rollupStore is wired, decorate the per-repo syncer so each
  // successful insert triggers a scoped commit_daily recompute (and, if
  // userSummaryCache is also wired, invalidates affected user-summary
  // entries). Failures in either never poison commit-sync results — see
  // rollup-hook.ts.
  const syncOne = deps.rollupStore
    ? withRollupRecompute(syncRepositoryCommits, {
        rollupStore: deps.rollupStore,
        ...(deps.userSummaryCache ? { userSummaryCache: deps.userSummaryCache } : {}),
        logger: deps.logger,
      })
    : syncRepositoryCommits;

  const tick = await runCommitsTick(
    { client: deps.client, store: deps.commitStore, logger: deps.logger, syncOne },
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

  // Piggyback the deepen-backfill tick. Drains the queue until either the
  // BB-call budget falls below DEEPEN_BUDGET_THRESHOLD (delta tick burned
  // through the headroom) or every tracked repo is fully backfilled. Many
  // repos per tick — at scale (~100+ tracked repos) this is what fills
  // history in finite time. Errors here never abort the commit-sync
  // result; the delta tick already succeeded.
  let deepen: DeepenTickResult | null = null;
  if (deps.deepenOptions !== undefined) {
    try {
      deepen = await runDeepenTick(
        {
          client: deps.client,
          store: deps.commitStore,
          logger: deps.logger,
          ...(deps.rollupStore ? { rollupStore: deps.rollupStore } : {}),
          ...(deps.userSummaryCache ? { userSummaryCache: deps.userSummaryCache } : {}),
        },
        deps.deepenOptions,
      );
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'deepen-backfill: tick failed — delta tick still successful',
      );
    }
  }

  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, ...summary, deepen, startedAt, finishedAt }, 'commit sync complete');

  return {
    trigger,
    startedAt,
    finishedAt,
    deepen,
    commits: summary,
    repoResults: tick.attempted,
    errors: tick.errors,
    deferred: tick.deferred,
  };
}

export async function runPullRequestsSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<PrsSyncResult> {
  const startedAt = new Date().toISOString();
  const rows = await deps.store.listTrackedRepositories();
  const handles: RepositoryHandle[] = rows.map((r) => ({
    repositoryId: r.id,
    workspace: r.workspace,
    slug: r.slug,
    fullName: r.fullName,
    diffStatsEnabled: r.diffStatsEnabled,
  }));
  deps.logger.info?.({ trigger, workspace: deps.workspace, repoCount: handles.length }, 'PR sync start');

  const tick = await runPullRequestsTick(
    { client: deps.client, store: deps.prStore, logger: deps.logger },
    handles,
    deps.prTickOptions ?? {},
  );

  const totalPrsInserted = tick.attempted.reduce((acc, r) => acc + r.inserted, 0);
  const totalPrsUpdated = tick.attempted.reduce((acc, r) => acc + r.updated, 0);
  const summary: PrsSyncSummary = {
    attempted: tick.attempted.length,
    deferred: tick.deferred.length,
    errors: tick.errors.length,
    totalPrsInserted,
    totalPrsUpdated,
    budgetRemainingAtEnd: tick.budgetRemainingAtEnd,
    stoppedEarly: tick.stoppedEarly,
  };
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, ...summary, startedAt, finishedAt }, 'PR sync complete');

  return {
    trigger,
    startedAt,
    finishedAt,
    prs: summary,
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
    diffStats: {
      maxPerRepoPerTick: config.DIFF_STATS_MAX_PER_REPO_PER_TICK,
      budgetThreshold: config.DIFF_STATS_BUDGET_THRESHOLD,
    },
  };
}

export function prTickOptionsFromConfig(config: AppConfig): PrTickOptions {
  return {
    firstRunMaxPages: config.PR_BACKFILL_MAX_PAGES,
    concurrency: config.PR_SYNC_CONCURRENCY,
    budgetLowThreshold: config.PR_SYNC_BUDGET_THRESHOLD,
  };
}

export function deepenOptionsFromConfig(config: AppConfig): { maxPages: number; budgetThreshold: number } {
  return {
    maxPages: config.DEEPEN_BACKFILL_MAX_PAGES,
    budgetThreshold: config.DEEPEN_BUDGET_THRESHOLD,
  };
}
