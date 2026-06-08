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
import { isDueForSync, type BackoffOptions } from './backoff.js';
import { runCommitsTick } from './commits-tick.js';
import { syncRepositoryCommits } from './commits.js';
import { runDeepenTick, type DeepenTickResult } from './deepen-backfill.js';
import type { EventBus } from '../events/bus.js';
import { runDiffStatsBackfillTick, type DiffStatsBackfillTickResult } from './diff-stats-tick.js';
import { runEmptyRevivalTick, type EmptyRevivalOptions, type EmptyRevivalResult } from './empty-revival.js';
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
  // Retroactive is_merge backfill that runs between deepen and diff-stats
  // backfill. When omitted, the step is skipped — pre-V1_7 commits keep
  // their stale `is_merge = false` value until an operator runs the
  // admin endpoint. All runtime entrypoints wire this in production.
  isMergeBackfillOptions?: IsMergeBackfillOptions;
  // Diff-stats backfill tick that runs after deepen. When omitted, the
  // backfill step is skipped — inline-eager forward fetch inside the
  // commit sync still runs, but pending commits from past ticks won't
  // be picked up.
  diffStatsBackfillOptions?: DiffStatsBackfillTickOptions;
  // Empty-repo revival sweep — re-probes empty-on-bitbucket excluded
  // (non-archived) repos and clears the exclusion when BB shows commits, so
  // a repo that got its first push self-heals back into the rotation. When
  // omitted the step is skipped (tests, or to disable the sweep).
  emptyRevivalOptions?: EmptyRevivalOptions;
  // Adaptive per-repo backoff for the commit + PR cron ticks. When
  // omitted, every non-archived repo is checked every tick (legacy
  // behavior). When wired (default in all runtime entrypoints), quiet
  // repos are skipped per the formula in backoff.ts. Diff-stats
  // backfill and deepen are NOT affected by this filter.
  backoffOptions?: BackoffOptions;
  // In-process pub/sub for live updates. When wired, the runner
  // publishes a `tick.commits.complete` / `tick.prs.complete` event at
  // the end of each sync entry-point. Auto-trip sites (commits.ts,
  // deepen-backfill.ts) also publish `repository.sync-excluded`
  // through this bus. Optional — omit in tests that don't care.
  bus?: EventBus;
  // ShipShow Score rollup (docs/scoring.md phase 3 + Phase 5). When
  // wired, runs at the end of every successful runCommitsSync — after
  // all commit-side ingest (delta + deepen + is-merge + diff-stats
  // backfill) has landed, so the eligible commit set is as fresh as it
  // gets. Drives both per-alias `user_score` and per-person
  // `person_score` passes via `recomputeAllScores`. Failures here are
  // score-freshness blips and never poison the sync result; the next
  // tick will recompute the same set. Omit in tests that don't care
  // about scoring.
  recomputeAllScores?: () => Promise<AllScoresRollupResult>;
  // Phase 5 alias-merge layer (docs/ROADMAP.md). When wired, the
  // /api/admin/people/* endpoints are reachable; otherwise they 503
  // with `people_store_not_wired`. The sync runner itself does NOT
  // call into the people store — it carries the field purely so admin
  // routes can reach it via opts.syncDeps. Omit in tests that don't
  // exercise the people endpoints.
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
  // Retroactive is_merge backfill outcome. Null when the step is
  // disabled (isMergeBackfillOptions not wired).
  isMergeBackfill: IsMergeBackfillTickResult | null;
  // Diff-stats backfill tick that runs after is-merge. Uses a global
  // newest-first pickup across every non-archived non-excluded repo —
  // see src/sync/diff-stats-tick.ts. Null when the step is disabled.
  diffStatsBackfill: DiffStatsBackfillTickResult | null;
  // Empty-repo revival sweep outcome. Null when the step is disabled
  // (emptyRevivalOptions not wired).
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
  const rows = await deps.store.listRepositoriesForSync();
  // `handles` is the full curated set, used only for the start-of-tick
  // log line that reports total vs due counts. The diff-stats backfill
  // tick no longer consumes a handles list — it does its own global
  // pickup. `dueHandles` is the subset whose commit-list interval has
  // elapsed under the backoff formula and is the only list passed to
  // the commit tick. When backoffOptions is unset, dueHandles == handles.
  const handles: RepositoryHandle[] = rows.map((r) => ({
    repositoryId: r.id,
    workspace: r.workspace,
    slug: r.slug,
    fullName: r.fullName,
    diffStatsExcludePatterns: r.diffStatsExcludePatterns,
  }));
  const now = new Date();
  const dueHandles: RepositoryHandle[] =
    deps.backoffOptions === undefined
      ? handles
      : rows
          .filter((r) =>
            isDueForSync(deps.backoffOptions!, {
              lastSyncedAt: r.lastSyncedAt,
              latestActivityAt: r.latestCommitAt,
              createdAt: r.createdAt,
              now,
            }),
          )
          .map((r) => ({
            repositoryId: r.id,
            workspace: r.workspace,
            slug: r.slug,
            fullName: r.fullName,
            diffStatsExcludePatterns: r.diffStatsExcludePatterns,
          }));
  deps.logger.info?.(
    { trigger, workspace: deps.workspace, repoCount: handles.length, dueCount: dueHandles.length },
    'commit sync start',
  );

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

  // Retroactive is_merge backfill — runs between deepen and diff-stats
  // backfill so per-commit merge correctness lands before any
  // merge-excluding aggregate consumes the row. Drains the pre-V1_7
  // backlog of stuck-false is_merge values; once every repo's flag
  // converges this tick is a single SELECT and exits with 'queue-empty'.
  // Errors here never abort the commit-sync result.
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

  // Diff-stats backfill tick — runs last so it consumes whatever
  // budget is left over. Inline-eager fetch inside the commit sync
  // already covers stats for commits that landed in this tick; this
  // step catches up on (a) pending commits whose inline fetch
  // transiently failed and (b) historical backlog for repos whose
  // commits pre-date diff-stat ingest. Global newest-first pickup
  // (no per-repo iteration) — see src/sync/diff-stats-tick.ts.
  // Errors here never abort the commit-sync result.
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

  // Empty-repo revival sweep — re-probes empty-on-bitbucket excluded
  // (non-archived) repos with one cheap BB call each and clears the exclusion
  // the moment one has commits, so a repo that got its first push self-heals
  // back into the rotation (it'll be ingested next tick). Errors never abort
  // the commit-sync result.
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

  // Score rollup runs last, after every commit-side ingest path has had
  // its turn. Runs both passes (user_score + person_score) under one
  // orchestrator. Wrapped in try/catch — a stale leaderboard for one
  // tick is much less bad than a failed sync, and the next tick
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
  // Slim payload for the SSE wire: drop the per-repo arrays
  // (repoResults / deepen.repos / isMergeBackfill.repos /
  // diffStatsBackfill.perRepo). At ~20+ repos × ~500 bytes each
  // across four sub-ticks the full result can overrun the SSE
  // response's write buffers; callers in-process still see the full
  // `result` via the return value.
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
  // PR sync has no analog of the diff-stats backfill — there's just one
  // list (the due-for-PR-sync set under the backoff formula). When
  // backoffOptions is absent we fall back to the full list.
  const now = new Date();
  const dueHandles: RepositoryHandle[] =
    deps.backoffOptions === undefined
      ? rows.map((r) => ({
          repositoryId: r.id,
          workspace: r.workspace,
          slug: r.slug,
          fullName: r.fullName,
          diffStatsExcludePatterns: r.diffStatsExcludePatterns,
        }))
      : rows
          .filter((r) =>
            isDueForSync(deps.backoffOptions!, {
              lastSyncedAt: r.prLastSyncedAt,
              latestActivityAt: r.latestPrAt,
              createdAt: r.createdAt,
              now,
            }),
          )
          .map((r) => ({
            repositoryId: r.id,
            workspace: r.workspace,
            slug: r.slug,
            fullName: r.fullName,
            diffStatsExcludePatterns: r.diffStatsExcludePatterns,
          }));
  deps.logger.info?.(
    { trigger, workspace: deps.workspace, repoCount: rows.length, dueCount: dueHandles.length },
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

// Build CommitsTickOptions from app config. Both runtime entry points (HTTPS
// API and the cron host) share this so the same env vars apply everywhere.
export function commitTickOptionsFromConfig(config: AppConfig): CommitsTickOptions {
  const since = config.COMMITS_BACKFILL_SINCE === '' ? undefined : new Date(config.COMMITS_BACKFILL_SINCE);
  return {
    firstRunMaxPages: config.COMMITS_BACKFILL_MAX_PAGES,
    ...(since !== undefined ? { firstRunSince: since } : {}),
    concurrency: config.COMMIT_SYNC_CONCURRENCY,
    budgetLowThreshold: config.COMMIT_SYNC_BUDGET_THRESHOLD,
    // Inline-eager only needs the budget threshold; per-repo cap doesn't
    // apply here because the input list is bounded by however many
    // commits the delta tick just inserted.
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

export function deepenOptionsFromConfig(config: AppConfig): { maxPages: number; budgetThreshold: number } {
  return {
    maxPages: config.DEEPEN_BACKFILL_MAX_PAGES,
    budgetThreshold: config.DEEPEN_BUDGET_THRESHOLD,
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
    // The empty-excluded set is normally near-empty (newly-tracked repos that
    // turned out empty), so a modest cap is plenty — it only bounds the
    // pathological case. Budget gate reuses the deepen threshold; both do BB
    // history walks.
    maxReposPerTick: 25,
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
