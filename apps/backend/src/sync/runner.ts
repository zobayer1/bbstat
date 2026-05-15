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
import { runDiffStatsBackfillTick, type DiffStatsBackfillTickResult } from './diff-stats-tick.js';
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
  // Adaptive per-repo backoff for the commit + PR cron ticks. When
  // omitted, every non-archived repo is checked every tick (legacy
  // behavior). When wired (default in all runtime entrypoints), quiet
  // repos are skipped per the formula in backoff.ts. Diff-stats
  // backfill and deepen are NOT affected by this filter.
  backoffOptions?: BackoffOptions;
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
  // disabled (isMergeBackfillOptions not wired). When present and
  // `stoppedReason === 'queue-empty'`, every tracked repo's
  // is_merge backfill is complete — the diff-stats auto-opt-in gate
  // additionally requires this signal to be true.
  isMergeBackfill: IsMergeBackfillTickResult | null;
  // Phase 5 prep: diff-stats backfill tick that runs after deepen. Null
  // when the step is disabled (diffStatsBackfillOptions not wired).
  diffStatsBackfill: DiffStatsBackfillTickResult | null;
  // Self-paced diff-stats rollout. When the backfill tick drains
  // cleanly (stopReason === null AND attempted/deferred/errors all
  // empty), we flip diff_stats_enabled on the next non-opted-in
  // non-archived repo (most-recently-active first, see
  // `findNextDiffStatsCandidate`). One per tick max. Null when the
  // backfill is disabled, the tick had any work or any non-clean stop
  // reason, or every repo is already opted in / archived.
  diffStatsAutoOptIn: { repositoryId: number; fullName: string } | null;
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
  // `handles` is the full curated set — used by the diff-stats backfill
  // tick (which is independent of commit-list staleness; it drains
  // pending /diffstat fetches for any opted-in repo as long as budget
  // allows). `dueHandles` is the subset whose commit-list interval has
  // elapsed under the backoff formula — used by the commit-tick. When
  // backoffOptions is unset, dueHandles == handles (legacy behavior).
  const handles: RepositoryHandle[] = rows.map((r) => ({
    repositoryId: r.id,
    workspace: r.workspace,
    slug: r.slug,
    fullName: r.fullName,
    diffStatsEnabled: r.diffStatsEnabled,
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
            diffStatsEnabled: r.diffStatsEnabled,
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

  // Diff-stats backfill tick — runs after deepen so it consumes whatever
  // budget is left over. Inline-eager fetch inside the commit sync
  // already covers stats for commits that landed in this tick; this step
  // catches up on (a) pending commits whose inline fetch transiently
  // failed and (b) one-time historical backlog after enabling
  // diffStatsEnabled on a repo with already-ingested history. Errors
  // here never abort the commit-sync result.
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
        handles,
        deps.diffStatsBackfillOptions,
      );
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'diff-stats backfill: tick failed — delta + deepen still successful',
      );
    }
  }

  // Self-paced diff-stats rollout. Fires only when the diff-stats
  // backfill drained cleanly AND the retroactive is_merge backfill
  // also reports queue-empty. Both gates matter: opting another repo
  // into diff-stats while is_merge correctness is still in flight
  // would let merge-inflated rows leak into the per-day aggregates
  // before they get corrected. The natural drain time of the
  // newly-opted-in repo's history paces the rollout: a busy repo
  // with thousands of pending commits blocks the next auto-opt for
  // many ticks; an empty repo opts in immediately and the rollout
  // proceeds one repo per cron tick until the pool exhausts.
  //
  // The diff-stats gate is intentionally strict — an earlier revision
  // checked totals reduced over `attempted[]`, but the orchestrator
  // (a) suppresses fully-drained repos from `attempted[]` (zero-update
  // entries are noise) and (b) parks budget-/rate-limit-gated repos
  // in `deferred[]` outside `attempted[]`. So `totalUpdated +
  // totalFailed + totalDeferred` went to zero on ticks where the
  // backfill never actually ran — flipping repos on while work was
  // still pending. The gate now reads the orchestrator's own
  // "drained cleanly" invariants directly.
  let diffStatsAutoOptIn: { repositoryId: number; fullName: string } | null = null;
  if (
    diffStatsBackfill !== null &&
    diffStatsBackfill.stopReason === null &&
    diffStatsBackfill.deferred.length === 0 &&
    diffStatsBackfill.attempted.length === 0 &&
    diffStatsBackfill.errors.length === 0 &&
    isMergeBackfill !== null &&
    isMergeBackfill.stoppedReason === 'queue-empty'
  ) {
    try {
      const candidate = await deps.store.findNextDiffStatsCandidate();
      if (candidate !== null) {
        await deps.store.updateRepositoryDiffStatsEnabled(candidate.id, true);
        diffStatsAutoOptIn = { repositoryId: candidate.id, fullName: candidate.fullName };
        deps.logger.info?.({ ...candidate }, 'diff-stats auto-opt-in');
      }
    } catch (err) {
      deps.logger.warn?.(
        { err: err instanceof Error ? err.message : String(err) },
        'diff-stats auto-opt-in: candidate lookup or update failed',
      );
    }
  }

  const finishedAt = new Date().toISOString();
  deps.logger.info?.(
    { trigger, ...summary, deepen, isMergeBackfill, diffStatsBackfill, diffStatsAutoOptIn, startedAt, finishedAt },
    'commit sync complete',
  );

  return {
    trigger,
    startedAt,
    finishedAt,
    deepen,
    isMergeBackfill,
    diffStatsBackfill,
    diffStatsAutoOptIn,
    commits: summary,
    repoResults: tick.attempted,
    errors: tick.errors,
    deferred: tick.deferred,
  };
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
          diffStatsEnabled: r.diffStatsEnabled,
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
            diffStatsEnabled: r.diffStatsEnabled,
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
    maxPerRepoPerTick: config.DIFF_STATS_BACKFILL_MAX_PER_REPO_PER_TICK,
    budgetThreshold: config.DIFF_STATS_BACKFILL_BUDGET_THRESHOLD,
    concurrency: config.DIFF_STATS_BACKFILL_CONCURRENCY,
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
