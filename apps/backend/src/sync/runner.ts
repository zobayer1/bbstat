// Convergence point for the sync surface. Multiple entry points so crons can
// dispatch a focused operation while admin / future-webhook triggers run
// combined flows.
//
//   runMembersSync   — workspace members → users
//   runReposSync     — curated tracked-repo bootstrap
//   runDiscoverySync — members + repos sequentially (manual admin trigger)
//   runCommitsSync   — per-repo commit ingest across the curated set
//
// All entry points are idempotent and tolerate cron-vs-manual races.
//
// The 'webhook' SyncTrigger label is preserved for forward compat; the
// receiver endpoint is deferred — see memory/webhook_deferred.md.

import { bootstrapTrackedRepositories, syncWorkspaceMembers } from './discovery.js';
import { isDueForSync, type BackoffOptions } from './backoff.js';
import { runCommitsTick } from './commits-tick.js';
import { syncRepositoryCommits } from './commits.js';
import { runDeepenTick, type DeepenTickResult } from './deepen-backfill.js';
import type { EventBus } from '../events/bus.js';
import { runDiffStatsBackfillTick, type DiffStatsBackfillTickResult } from './diff-stats-tick.js';
import { runEmptyRevivalTick, type EmptyRevivalOptions, type EmptyRevivalResult } from './empty-revival.js';
import { runRepoDiscoverySweep, type RepoDiscoveryOptions, type RepoDiscoveryResult } from './repo-discovery.js';
import type { CacheClient } from '../cache/redis.js';
import {
  runIsMergeBackfillTick,
  type IsMergeBackfillOptions,
  type IsMergeBackfillTickResult,
} from './is-merge-tick.js';
import { runPullRequestsTick } from './pr-tick.js';
import { withRollupRecompute } from '../dashboard/rollup-hook.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import type { AppConfig } from '../config.js';
import type { CommitStore } from './commit-store.js';
import type { CommitsTickOptions } from './commits-tick.js';
import type { RepoCommitSyncResult, RepositoryHandle } from './commits.js';
import type { DiffStatsBackfillTickOptions } from './diff-stats-tick.js';
import type { BootstrapReposResult, RepoSeed, SyncMembersResult } from './discovery.js';
import type { DiscoveryStore } from './discovery-store.js';
import type { PrStore } from './pr-store.js';
import type { PrTickOptions } from './pr-tick.js';
import type { RepoPrSyncResult } from './pull-requests.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';
import type { PeopleStore } from '../people/store.js';
import type { AllScoresRollupResult } from '../scoring/rollup.js';

export type SyncTrigger = 'manual' | 'cron' | 'webhook';

export interface SyncRunnerDeps {
  client: BitbucketClient;
  store: DiscoveryStore;
  logger: BitbucketLogger;
  workspace: string;
  // Thunk so each invocation re-reads the seed file — operators can edit
  // `tracked-repos.yaml` and have the next sync pick it up without restart.
  // A malformed file throws here, surfaced as the sync's error path.
  seeds: () => RepoSeed[];
  commitStore: CommitStore;
  // When present, each per-repo commit sync is wrapped so a successful
  // insert triggers a scoped commit_daily recompute.
  rollupStore?: RollupStore;
  // When present alongside rollupStore, summaries for users in the touched
  // range are invalidated after the recompute.
  userSummaryCache?: UserSummaryCache;
  commitTickOptions?: CommitsTickOptions;
  // Required for runPullRequestsSync. All runtime entrypoints wire it.
  prStore: PrStore;
  prTickOptions?: PrTickOptions;
  // Self-queueing deepen-backfill. Omitted → the piggyback step is a no-op.
  deepenOptions?: { maxPages: number; budgetThreshold: number; emptyGraceHours?: number };
  // Retroactive is_merge backfill (between deepen and diff-stats). Omitted →
  // pre-V1_7 commits keep their stale `is_merge = false` until an operator
  // runs the admin endpoint.
  isMergeBackfillOptions?: IsMergeBackfillOptions;
  // Diff-stats backfill (after deepen). Omitted → inline-eager forward fetch
  // still runs, but past ticks' pending commits aren't picked up.
  diffStatsBackfillOptions?: DiffStatsBackfillTickOptions;
  // Empty-repo revival sweep. Omitted → the step is skipped.
  emptyRevivalOptions?: EmptyRevivalOptions;
  // Adaptive per-repo backoff for the commit + PR ticks. Omitted → every
  // non-archived repo is checked every tick. Does NOT affect deepen /
  // diff-stats backfill.
  backoffOptions?: BackoffOptions;
  // Cold-repo admission cap. A cold repo (NULL last_synced_at) can't apply
  // backoff and sorts to the head of the NULLS-FIRST queue; after a bulk
  // discovery sweep hundreds of cold repos would otherwise monopolize the
  // budget and starve the warm rotation. Warm repos run first and in full;
  // at most this many cold repos are appended per tick. Omitted → no cap.
  maxColdReposPerTick?: number;
  // In-process pub/sub for live updates. When wired, the runner publishes
  // tick.{commits,prs}.complete; auto-trip sites publish
  // repository.sync-excluded through it too.
  bus?: EventBus;
  // Raw Redis client — backs the repo-discovery cursor. Omit to disable the sweep.
  cache?: CacheClient;
  // Workspace-repo auto-discovery sweep (REPO_DISCOVERY_ENABLED).
  repoDiscoveryOptions?: RepoDiscoveryOptions;
  // ShipShow Score rollup. Runs last in runCommitsSync, after every
  // commit-side ingest path, so the eligible commit set is as fresh as it
  // gets. Failures are score-freshness blips and never poison the sync.
  recomputeAllScores?: () => Promise<AllScoresRollupResult>;
  // Phase 5 alias-merge layer. The runner does NOT call into this — it
  // carries the field purely so admin /people routes can reach it via
  // opts.syncDeps. Omitted → those endpoints 503 with people_store_not_wired.
  peopleStore?: PeopleStore;
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
  // Null when discovery is disabled or the cache isn't wired.
  repoDiscovery: RepoDiscoveryResult | null;
}

export interface DiscoverySyncResult extends BaseResult {
  members: SyncMembersResult;
  repos: BootstrapReposResult;
  repoDiscovery: RepoDiscoveryResult | null;
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
  // Per-repo detail kept out of the summary so log lines stay terse.
  repoResults: RepoCommitSyncResult[];
  errors: Array<{ repository: RepositoryHandle; error: string }>;
  deferred: RepositoryHandle[];
  // Each null when its step is disabled (the corresponding option not wired).
  deepen: DeepenTickResult | null;
  isMergeBackfill: IsMergeBackfillTickResult | null;
  diffStatsBackfill: DiffStatsBackfillTickResult | null;
  emptyRevival: EmptyRevivalResult | null;
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

export interface PrioritizedDue<T> {
  // Warm rows first (incoming order), then at most `maxCold` cold rows.
  ordered: T[];
  warmCount: number;
  coldAdmitted: number;
  coldDeferred: number;
}

// Keep the warm active rotation from being starved by a cold (never-synced)
// backlog. `due` arrives last_synced_at ASC NULLS FIRST, so cold rows lead —
// exactly what a bulk discovery sweep dumps. Split warm from cold, keep warm
// first, and admit at most `maxCold` cold rows per tick; the rest rolls to
// later ticks. `maxCold === undefined` → no cap, list returned untouched.
export function prioritizeDue<T>(
  due: T[],
  isCold: (row: T) => boolean,
  maxCold: number | undefined,
): PrioritizedDue<T> {
  const warm: T[] = [];
  const cold: T[] = [];
  for (const row of due) (isCold(row) ? cold : warm).push(row);
  if (maxCold === undefined) {
    return { ordered: due, warmCount: warm.length, coldAdmitted: cold.length, coldDeferred: 0 };
  }
  const admitted = cold.slice(0, maxCold);
  return {
    ordered: [...warm, ...admitted],
    warmCount: warm.length,
    coldAdmitted: admitted.length,
    coldDeferred: cold.length - admitted.length,
  };
}

export async function runMembersSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<MembersSyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace }, 'members sync start');
  const members = await syncWorkspaceMembers(deps, deps.workspace);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, members, startedAt, finishedAt }, 'members sync complete');
  return { trigger, startedAt, finishedAt, members };
}

// Shared repo-discovery step. Returns null unless both the Redis cache and
// discovery options are wired. Failure-isolated — a discovery error never
// fails the repos sync.
async function maybeRunRepoDiscovery(deps: SyncRunnerDeps): Promise<RepoDiscoveryResult | null> {
  if (deps.cache === undefined || deps.repoDiscoveryOptions === undefined) return null;
  try {
    return await runRepoDiscoverySweep(
      { client: deps.client, cache: deps.cache, store: deps.store, workspace: deps.workspace, logger: deps.logger },
      deps.repoDiscoveryOptions,
    );
  } catch (err) {
    deps.logger.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      'repo-discovery sweep failed — repos sync still successful',
    );
    return null;
  }
}

export async function runReposSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<ReposSyncResult> {
  const startedAt = new Date().toISOString();
  const seeds = deps.seeds();
  deps.logger.info?.({ trigger, workspace: deps.workspace, seedCount: seeds.length }, 'repos sync start');
  const repos = await bootstrapTrackedRepositories(deps, seeds);
  const repoDiscovery = await maybeRunRepoDiscovery(deps);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, repos, repoDiscovery, startedAt, finishedAt }, 'repos sync complete');
  return { trigger, startedAt, finishedAt, repos, repoDiscovery };
}

export async function runDiscoverySync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<DiscoverySyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace }, 'discovery sync start');
  const members = await syncWorkspaceMembers(deps, deps.workspace);
  const repos = await bootstrapTrackedRepositories(deps, deps.seeds());
  const repoDiscovery = await maybeRunRepoDiscovery(deps);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, members, repos, repoDiscovery, startedAt, finishedAt }, 'discovery sync complete');
  return { trigger, startedAt, finishedAt, members, repos, repoDiscovery };
}

export async function runCommitsSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<CommitsSyncResult> {
  const startedAt = new Date().toISOString();
  const rows = await deps.store.listRepositoriesForSync();
  // dueHandles is the subset whose backoff interval has elapsed, reordered
  // (warm first, cold capped) — the only list passed to the commit tick. The
  // diff-stats backfill tick does its own global pickup.
  const toHandle = (r: (typeof rows)[number]): RepositoryHandle => ({
    repositoryId: r.id,
    workspace: r.workspace,
    slug: r.slug,
    fullName: r.fullName,
    diffStatsExcludePatterns: r.diffStatsExcludePatterns,
  });
  const now = new Date();
  // Backoff (when wired) drops quiet warm repos; cold repos are always due.
  const dueRows =
    deps.backoffOptions === undefined
      ? rows
      : rows.filter((r) =>
          isDueForSync(deps.backoffOptions!, {
            lastSyncedAt: r.lastSyncedAt,
            latestActivityAt: r.latestCommitAt,
            createdAt: r.createdAt,
            now,
          }),
        );
  const prioritized = prioritizeDue(dueRows, (r) => r.lastSyncedAt === null, deps.maxColdReposPerTick);
  const dueHandles: RepositoryHandle[] = prioritized.ordered.map(toHandle);
  deps.logger.info?.(
    {
      trigger,
      workspace: deps.workspace,
      repoCount: rows.length,
      dueCount: dueHandles.length,
      warmCount: prioritized.warmCount,
      coldAdmitted: prioritized.coldAdmitted,
      coldDeferred: prioritized.coldDeferred,
    },
    'commit sync start',
  );

  // When rollupStore is wired, decorate the per-repo syncer so each
  // successful insert triggers a scoped commit_daily recompute (and
  // user-summary invalidation if that cache is wired too). Failures never
  // poison commit-sync results — see rollup-hook.ts.
  const syncOne = deps.rollupStore
    ? withRollupRecompute(syncRepositoryCommits, {
        rollupStore: deps.rollupStore,
        ...(deps.userSummaryCache ? { userSummaryCache: deps.userSummaryCache } : {}),
        logger: deps.logger,
      })
    : syncRepositoryCommits;

  const tick = await runCommitsTick(
    {
      client: deps.client,
      store: deps.commitStore,
      logger: deps.logger,
      discoveryStore: deps.store,
      ...(deps.bus ? { bus: deps.bus } : {}),
      syncOne,
    },
    dueHandles,
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

  // Piggyback the deepen-backfill tick on whatever budget the delta tick
  // left. Errors never abort the commit-sync result.
  let deepen: DeepenTickResult | null = null;
  if (deps.deepenOptions !== undefined) {
    try {
      deepen = await runDeepenTick(
        {
          client: deps.client,
          store: deps.commitStore,
          logger: deps.logger,
          discoveryStore: deps.store,
          ...(deps.bus ? { bus: deps.bus } : {}),
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

  // Retroactive is_merge backfill, between deepen and diff-stats so merge
  // correctness lands before any merge-excluding aggregate consumes the row.
  // Once every flag converges this is a single SELECT exiting 'queue-empty'.
  // Errors never abort the commit-sync result.
  let isMergeBackfill: IsMergeBackfillTickResult | null = null;
  if (deps.isMergeBackfillOptions !== undefined) {
    try {
      isMergeBackfill = await runIsMergeBackfillTick(
        {
          client: deps.client,
          store: deps.commitStore,
          logger: deps.logger,
        },
        deps.isMergeBackfillOptions,
      );
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'is-merge backfill: tick failed — delta + deepen still successful',
      );
    }
  }

  // Diff-stats backfill — runs last on leftover budget. Inline-eager fetch
  // already covers this tick's new commits; this catches up on transient
  // inline failures and the historical backlog. Errors never abort the
  // commit-sync result.
  let diffStatsBackfill: DiffStatsBackfillTickResult | null = null;
  if (deps.diffStatsBackfillOptions !== undefined) {
    try {
      diffStatsBackfill = await runDiffStatsBackfillTick(
        {
          client: deps.client,
          store: deps.commitStore,
          logger: deps.logger,
          ...(deps.rollupStore ? { rollupStore: deps.rollupStore } : {}),
          ...(deps.userSummaryCache ? { userSummaryCache: deps.userSummaryCache } : {}),
        },
        deps.diffStatsBackfillOptions,
      );
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'diff-stats backfill: tick failed — delta + deepen still successful',
      );
    }
  }

  // Empty-repo revival sweep — re-probes empty-excluded repos and clears the
  // exclusion when one gains commits. Errors never abort the commit-sync result.
  let emptyRevival: EmptyRevivalResult | null = null;
  if (deps.emptyRevivalOptions !== undefined) {
    try {
      emptyRevival = await runEmptyRevivalTick(
        {
          client: deps.client,
          discoveryStore: deps.store,
          commitStore: deps.commitStore,
          logger: deps.logger,
          ...(deps.bus ? { bus: deps.bus } : {}),
        },
        deps.emptyRevivalOptions,
      );
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'empty-revival: sweep failed — commit sync still successful',
      );
    }
  }

  // Score rollup last, after every commit-side ingest path. A stale
  // leaderboard for one tick beats a failed sync, and the next tick
  // recomputes the same set.
  if (deps.recomputeAllScores !== undefined) {
    try {
      await deps.recomputeAllScores();
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'score rollup: tick failed — leaderboard stale until next tick',
      );
    }
  }

  const finishedAt = new Date().toISOString();
  deps.logger.info?.(
    { trigger, ...summary, deepen, isMergeBackfill, diffStatsBackfill, emptyRevival, startedAt, finishedAt },
    'commit sync complete',
  );

  const result: CommitsSyncResult = {
    trigger,
    startedAt,
    finishedAt,
    deepen,
    isMergeBackfill,
    diffStatsBackfill,
    emptyRevival,
    commits: summary,
    repoResults: tick.attempted,
    errors: tick.errors,
    deferred: tick.deferred,
  };
  // Slim payload for the SSE wire: drop the per-repo arrays, which across
  // four sub-ticks can overrun the SSE response's write buffers. In-process
  // callers still get the full `result` via the return value.
  deps.bus?.publish({
    event: 'tick.commits.complete',
    payload: {
      trigger,
      startedAt,
      finishedAt,
      attempted: summary.attempted,
      deferred: summary.deferred,
      errors: summary.errors,
      totalCommitsInserted: summary.totalCommitsInserted,
      budgetRemainingAtEnd: summary.budgetRemainingAtEnd,
      stoppedEarly: summary.stoppedEarly,
      deepenStoppedReason: deepen?.stoppedReason ?? null,
      isMergeBackfillStoppedReason: isMergeBackfill?.stoppedReason ?? null,
      diffStatsBackfillStopReason: diffStatsBackfill?.stopReason ?? null,
      diffStatsBackfillTotalUpdated: diffStatsBackfill?.totalUpdated ?? 0,
    },
  });
  return result;
}

export async function runPullRequestsSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<PrsSyncResult> {
  const startedAt = new Date().toISOString();
  const rows = await deps.store.listRepositoriesForSync();
  // One list (the due-for-PR-sync set under backoff). Cold here keys on
  // `pr_last_synced_at` — a repo can be warm for commits but never have had
  // its PRs synced — so the same admission cap protects the warm PR rotation.
  const toHandle = (r: (typeof rows)[number]): RepositoryHandle => ({
    repositoryId: r.id,
    workspace: r.workspace,
    slug: r.slug,
    fullName: r.fullName,
    diffStatsExcludePatterns: r.diffStatsExcludePatterns,
  });
  const now = new Date();
  const dueRows =
    deps.backoffOptions === undefined
      ? rows
      : rows.filter((r) =>
          isDueForSync(deps.backoffOptions!, {
            lastSyncedAt: r.prLastSyncedAt,
            latestActivityAt: r.latestPrAt,
            createdAt: r.createdAt,
            now,
          }),
        );
  const prioritized = prioritizeDue(dueRows, (r) => r.prLastSyncedAt === null, deps.maxColdReposPerTick);
  const dueHandles: RepositoryHandle[] = prioritized.ordered.map(toHandle);
  deps.logger.info?.(
    {
      trigger,
      workspace: deps.workspace,
      repoCount: rows.length,
      dueCount: dueHandles.length,
      warmCount: prioritized.warmCount,
      coldAdmitted: prioritized.coldAdmitted,
      coldDeferred: prioritized.coldDeferred,
    },
    'PR sync start',
  );

  const tick = await runPullRequestsTick(
    { client: deps.client, store: deps.prStore, logger: deps.logger },
    dueHandles,
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

  const result: PrsSyncResult = {
    trigger,
    startedAt,
    finishedAt,
    prs: summary,
    repoResults: tick.attempted,
    errors: tick.errors,
    deferred: tick.deferred,
  };
  // Slim payload — see runCommitsSync above for rationale.
  deps.bus?.publish({
    event: 'tick.prs.complete',
    payload: {
      trigger,
      startedAt,
      finishedAt,
      attempted: summary.attempted,
      deferred: summary.deferred,
      errors: summary.errors,
      totalPrsInserted: summary.totalPrsInserted,
      totalPrsUpdated: summary.totalPrsUpdated,
      budgetRemainingAtEnd: summary.budgetRemainingAtEnd,
      stoppedEarly: summary.stoppedEarly,
    },
  });
  return result;
}

// Both runtime entry points (HTTPS API and cron host) share this so the same
// env vars apply everywhere.
export function commitTickOptionsFromConfig(config: AppConfig): CommitsTickOptions {
  const since = config.COMMITS_BACKFILL_SINCE === '' ? undefined : new Date(config.COMMITS_BACKFILL_SINCE);
  return {
    firstRunMaxPages: config.COMMITS_BACKFILL_MAX_PAGES,
    ...(since !== undefined ? { firstRunSince: since } : {}),
    concurrency: config.COMMIT_SYNC_CONCURRENCY,
    budgetLowThreshold: config.COMMIT_SYNC_BUDGET_THRESHOLD,
    // Inline-eager needs only the budget threshold — the input list is already
    // bounded by however many commits the delta tick just inserted.
    diffStats: { budgetThreshold: config.DIFF_STATS_BUDGET_THRESHOLD },
  };
}

export function prTickOptionsFromConfig(config: AppConfig): PrTickOptions {
  return {
    firstRunMaxPages: config.PR_BACKFILL_MAX_PAGES,
    concurrency: config.PR_SYNC_CONCURRENCY,
    budgetLowThreshold: config.PR_SYNC_BUDGET_THRESHOLD,
  };
}

export function deepenOptionsFromConfig(config: AppConfig): {
  maxPages: number;
  budgetThreshold: number;
  emptyGraceHours: number;
} {
  return {
    maxPages: config.DEEPEN_BACKFILL_MAX_PAGES,
    budgetThreshold: config.DEEPEN_BUDGET_THRESHOLD,
    emptyGraceHours: config.SYNC_EMPTY_GRACE_HOURS,
  };
}

export function diffStatsBackfillOptionsFromConfig(config: AppConfig): DiffStatsBackfillTickOptions {
  return {
    maxCommitsPerTick: config.DIFF_STATS_BACKFILL_MAX_COMMITS_PER_TICK,
    budgetThreshold: config.DIFF_STATS_BACKFILL_BUDGET_THRESHOLD,
  };
}

export function emptyRevivalOptionsFromConfig(config: AppConfig): EmptyRevivalOptions {
  return {
    // The empty-excluded set is normally near-empty, so a modest cap only
    // bounds the pathological case. Budget gate reuses the deepen threshold.
    maxReposPerTick: 25,
    budgetThreshold: config.DEEPEN_BUDGET_THRESHOLD,
  };
}

// undefined (sweep skipped) unless REPO_DISCOVERY_ENABLED. Budget gate reuses
// the deepen threshold.
export function repoDiscoveryOptionsFromConfig(config: AppConfig): RepoDiscoveryOptions | undefined {
  if (!config.REPO_DISCOVERY_ENABLED) return undefined;
  return {
    maxReposPerSweep: 100,
    budgetThreshold: config.DEEPEN_BUDGET_THRESHOLD,
  };
}

export function isMergeBackfillOptionsFromConfig(config: AppConfig): IsMergeBackfillOptions {
  return {
    maxPages: config.IS_MERGE_BACKFILL_MAX_PAGES,
    budgetThreshold: config.IS_MERGE_BACKFILL_BUDGET_THRESHOLD,
  };
}

export function backoffOptionsFromConfig(config: AppConfig): BackoffOptions {
  return {
    slopeMinPerQuietDay: config.SYNC_BACKOFF_SLOPE_MIN_PER_QUIET_DAY,
    minIntervalMin: config.SYNC_BACKOFF_MIN_INTERVAL_MIN,
    maxIntervalMin: config.SYNC_BACKOFF_MAX_INTERVAL_MIN,
  };
}
