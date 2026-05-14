// Self-queueing deepen-backfill. Phase 4 commit ingest captures the most
// recent COMMITS_BACKFILL_MAX_PAGES × 100 commits per repo on cold mode,
// then runs delta-only — older history is permanently absent unless
// something walks back to fetch it. This module is that something.
//
// State lives entirely on `sync_state`: a `deepen_complete` boolean flips
// true once a repo's history reaches BB's first commit (the paginated
// response runs out of `next` URLs), and `deepen_last_run_at` rotates
// candidates round-robin. No separate queue table; the queue is derived
// state.
//
// Triggered as a low-priority piggyback step at the tail of
// `runCommitsSync` — if the BB-call budget still has headroom after the
// delta tick (>= DEEPEN_BUDGET_THRESHOLD), we run exactly one repo's
// deepen page per tick. Heavy delta ticks naturally yield: no headroom →
// no deepen this round.
//
// One deepen page walks `paginateCommits(client, ws, slug, { include:
// <oldest_known_sha> })` newest-first starting AT the oldest commit we
// already have, skips that seed commit (we have it), then walks backwards
// through its ancestors, inserting via the existing
// `CommitStore.insertCommits` (which dedupes on (repo_id, sha) so
// re-runs converge). Cap is `firstRunMaxPages × 100` commits per call —
// same shape as cold-mode backfill.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits, type BitbucketCommit } from '../bitbucket/commits.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';
import type { CommitInsertInput, CommitStore, DeepenCandidate } from './commit-store.js';

export interface DeepenBackfillOptions {
  // Max pages of 100 commits per deepen page. Shape mirrors the cold-mode
  // backfill cap so operators have one mental model for both.
  maxPages: number;
  // Headroom required under BITBUCKET_HOURLY_CALL_BUDGET before we'll
  // attempt a deepen page. Higher than the commit-tick threshold so we
  // yield to delta sync.
  budgetThreshold: number;
}

export interface DeepenBackfillResult {
  repositoryId: number;
  fullName: string;
  // Number of commits fetched from BB on this run (excluding the seed sha
  // itself, which we always discard since we already have it). May be 0
  // when the seed had no parents (we'd reach root immediately) or the BB
  // call 404'd.
  fetched: number;
  // Number of rows newly inserted. `fetched - inserted` are deduped
  // collisions (rare but possible if force-push history overlaps).
  inserted: number;
  // True iff BB's paginated walk produced no `next` URL on the final
  // page — we've reached the repo's first commit. `deepen_complete` is
  // set on the row.
  reachedRoot: boolean;
  // True iff the page cap fired before BB ran out of `next` URLs. There's
  // still more older history beyond what this run pulled.
  hitPageCap: boolean;
  // True iff the seed sha 404'd on BB (force-pushed history). Treated as
  // "give up on this repo" — `deepen_complete` is set so we stop trying.
  seedMissing: boolean;
  // True iff BB rate-limited us *and* the client exhausted its in-request
  // retry budget. The deepen tick treats this as a tick-wide signal to stop
  // — hammering the next repo while BB's limiter is hot just compounds the
  // backoff. The remaining queue defers to the next cron tick (5 min by
  // default), by which time BB's rolling window has rotated.
  rateLimited: boolean;
}

export interface DeepenBackfillDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  // Optional. When wired, every successful deepen page recomputes
  // `commit_daily` for the day range its newly-inserted commits cover —
  // the same pattern `withRollupRecompute` applies to the delta tick.
  // Without this, deepen-inserted historical commits silently drift the
  // rollup (the original Phase 4 follow-up shipped without it; this fix
  // closes that gap).
  rollupStore?: RollupStore;
  // Optional. When wired alongside `rollupStore`, the affected user-summary
  // cache entries get DEL'd after the rollup recompute, so the next read
  // for those users repopulates from the fresh rollup.
  userSummaryCache?: UserSummaryCache;
}

// Extends CommitInsertInput with the BB-side author uuid so we can resolve
// it back to a users.id after collecting the batch (one bulk
// resolveUserIdsByUuid call instead of per-commit lookups). Stripped
// before passing to insertCommits.
interface DeepenInsertStaging extends CommitInsertInput {
  bitbucketUuid?: string;
}

export interface DeepenSpecificRepo {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
}

// Single repo. Returns `null` only when the candidate queue is empty;
// transient errors return an empty result (fetched=0, inserted=0) so the
// caller's loop can rotate to the next repo. The budget gate is the
// caller's responsibility — `runDeepenTick` checks before each iteration.
//
// `explicitRepo` overrides the round-robin pick — used by the admin route
// `POST /sync/repositories/:ws/:slug/deepen` to force a specific repo's
// next page without waiting for the cron's next rotation. The seed sha is
// still resolved fresh via `getOldestCommitSha`.
export async function deepenOneRepo(
  deps: DeepenBackfillDeps,
  opts: DeepenBackfillOptions,
  explicitRepo?: DeepenSpecificRepo,
): Promise<DeepenBackfillResult | null> {
  let candidate: DeepenCandidate | null;
  if (explicitRepo !== undefined) {
    const oldestSha = await deps.store.getOldestCommitSha(explicitRepo.repositoryId);
    candidate = { ...explicitRepo, oldestSha };
  } else {
    candidate = await deps.store.pickRepoForDeepening();
  }
  if (candidate === null) {
    // Every tracked repo has deepen_complete = true. We're done forever
    // (or until an operator flips a row back manually).
    return null;
  }

  // Always bump `deepen_last_run_at` so the next pick rotates to a
  // different repo even on no-op outcomes. Failures to update this would
  // make us re-pick the same repo every tick, starving siblings.
  await deps.store.markDeepenAttempt(candidate.repositoryId);

  if (candidate.oldestSha === null) {
    // No commits ingested at all. Two sub-cases — distinguish via the
    // repo's last_sync_status:
    //
    // - `'success'` — cold mode ran cleanly and BB returned an empty
    //   `/commits` response. The repo is genuinely empty on BB (no
    //   commits at all). Flip `deepen_complete` so it drops out of the
    //   rotation forever instead of cycling through every tick.
    //
    // - anything else (`'idle' | 'running' | 'failed'` or no row) — cold
    //   mode hasn't successfully run yet. Don't mark complete; leave it
    //   for the next tick rotation, by which time cold mode may have
    //   landed commits (or we'll learn the underlying error and the
    //   operator fixes it).
    const state = await deps.store.getSyncState(candidate.repositoryId);
    const isEmptyOnBitbucket = state?.lastSyncStatus === 'success';
    if (isEmptyOnBitbucket) {
      await deps.store.markDeepenComplete(candidate.repositoryId);
      deps.logger?.info?.(
        { repositoryId: candidate.repositoryId, fullName: candidate.fullName },
        'deepen-backfill: repo is empty on BB (cold-mode success, 0 commits) — marking complete',
      );
      return {
        ...emptyResult(candidate.repositoryId, candidate.fullName),
        reachedRoot: true,
        seedMissing: false,
      };
    }
    deps.logger?.debug?.(
      {
        repositoryId: candidate.repositoryId,
        fullName: candidate.fullName,
        lastSyncStatus: state?.lastSyncStatus ?? null,
      },
      'deepen-backfill: no oldest commit yet — skipping',
    );
    return { ...emptyResult(candidate.repositoryId, candidate.fullName), seedMissing: false };
  }

  let fetched = 0;
  const inserts: DeepenInsertStaging[] = [];
  let reachedRoot = false;
  let hitPageCap = false;
  let seedMissing = false;

  const maxCommits = opts.maxPages * 100;
  // BB returns the include= sha as the FIRST item — we already have it.
  let seenSeed = false;

  try {
    for await (const commit of paginateCommits(deps.client, candidate.workspace, candidate.slug, {
      include: candidate.oldestSha,
    })) {
      if (!seenSeed && commit.hash === candidate.oldestSha) {
        seenSeed = true;
        continue;
      }
      fetched++;
      inserts.push(buildInsertInput(candidate.repositoryId, commit));
      if (inserts.length >= maxCommits) {
        hitPageCap = true;
        break;
      }
    }
    if (!hitPageCap) {
      // We exhausted the iterator without hitting the cap → BB has nothing
      // older. This repo is fully backfilled.
      reachedRoot = true;
    }
  } catch (err) {
    if (err instanceof BitbucketRateLimitError) {
      // BB's burst limiter exhausted the client's in-request retry budget.
      // Surface a tick-wide stop signal — `runDeepenTick` will halt instead
      // of marching to the next repo (which would almost certainly trip the
      // limiter again). `warn` not `error`: this is expected backpressure,
      // not a fault. Next 5-min cron tick starts fresh.
      deps.logger?.warn?.(
        {
          repositoryId: candidate.repositoryId,
          fullName: candidate.fullName,
          retryAfterSeconds: err.retryAfterSeconds,
        },
        'deepen-backfill: BB rate-limited — yielding remaining queue to next tick',
      );
      return { ...emptyResult(candidate.repositoryId, candidate.fullName), rateLimited: true };
    }
    if (err instanceof BitbucketApiError && err.status === 404) {
      // Seed sha doesn't exist on BB anymore (force-push rewrote history).
      // Mark complete so we stop trying — operator can flip the flag back
      // if they want to resume from a different seed sha later.
      seedMissing = true;
      reachedRoot = true;
      deps.logger?.warn?.(
        { repositoryId: candidate.repositoryId, fullName: candidate.fullName, oldestSha: candidate.oldestSha },
        'deepen-backfill: seed sha 404 — likely force-pushed; marking complete',
      );
    } else {
      // Transient failure — don't flip deepen_complete, just log. Next
      // tick will retry (or rotate to another repo first via the round
      // robin). Return an empty result rather than null so the caller's
      // tick loop can continue with the next candidate.
      deps.logger?.error?.(err, `deepen-backfill: ${candidate.fullName} failed`);
      return { ...emptyResult(candidate.repositoryId, candidate.fullName), seedMissing: false };
    }
  }

  // Resolve authors for the just-pulled batch (same path the cold/delta
  // commit sync uses).
  const uuids = Array.from(new Set(inserts.map((i) => i.bitbucketUuid).filter((u): u is string => u !== undefined)));
  if (uuids.length > 0) {
    const userIdByUuid = await deps.store.resolveUserIdsByUuid(uuids);
    for (const input of inserts) {
      if (input.bitbucketUuid !== undefined) {
        input.authorUserId = userIdByUuid.get(input.bitbucketUuid) ?? null;
      }
    }
  }

  const { inserted } = await deps.store.insertCommits(
    inserts.map(({ bitbucketUuid: _bitbucketUuid, ...rest }) => rest),
  );

  // Rollup + cache hook — mirrors `withRollupRecompute` for the delta
  // tick. Without this, commits inserted by deepen never reflect in the
  // dashboard until someone runs `make rebuild-rollups`. Failures here
  // are isolated: commits are already durable, so we log and continue.
  if (inserted > 0) {
    const range = rangeOfInserts(inserts);
    if (range !== null && deps.rollupStore !== undefined) {
      try {
        const { rowsAffected } = await deps.rollupStore.recomputeCommitDailyForRepo(candidate.repositoryId, range);
        deps.logger?.info?.(
          { repositoryId: candidate.repositoryId, fullName: candidate.fullName, range, rowsAffected },
          'deepen-backfill: rollup recompute complete',
        );
      } catch (err) {
        deps.logger?.warn?.(
          {
            repositoryId: candidate.repositoryId,
            fullName: candidate.fullName,
            range,
            err: err instanceof Error ? err.message : String(err),
          },
          'deepen-backfill: rollup recompute failed — commits already landed',
        );
      }
      if (deps.userSummaryCache !== undefined) {
        try {
          const userIds = await deps.rollupStore.listAffectedUserIdsForRepo(candidate.repositoryId, range);
          await Promise.all(userIds.map((id) => deps.userSummaryCache!.invalidate(id)));
        } catch (err) {
          deps.logger?.warn?.(
            {
              repositoryId: candidate.repositoryId,
              fullName: candidate.fullName,
              range,
              err: err instanceof Error ? err.message : String(err),
            },
            'deepen-backfill: user-summary cache invalidation failed — TTL backstop will eventually catch up',
          );
        }
      }
    }
  }

  if (reachedRoot) {
    await deps.store.markDeepenComplete(candidate.repositoryId);
  }

  deps.logger?.info?.(
    {
      repositoryId: candidate.repositoryId,
      fullName: candidate.fullName,
      fetched,
      inserted,
      reachedRoot,
      hitPageCap,
      seedMissing,
    },
    'deepen-backfill complete',
  );

  return {
    repositoryId: candidate.repositoryId,
    fullName: candidate.fullName,
    fetched,
    inserted,
    reachedRoot,
    hitPageCap,
    seedMissing,
    rateLimited: false,
  };
}

function buildInsertInput(repositoryId: number, commit: BitbucketCommit): DeepenInsertStaging {
  return {
    repositoryId,
    authorUserId: null, // resolved in the batch step below
    sha: commit.hash,
    message: commit.message,
    isMerge: commit.parents.length > 1,
    authoredAt: new Date(commit.date),
    ...(commit.author.user !== undefined ? { bitbucketUuid: commit.author.user.uuid } : {}),
  };
}

export interface DeepenTickResult {
  // Per-repo results, in the order they were processed this tick. Empty
  // array means the queue was already drained (or no budget left at start).
  repos: DeepenBackfillResult[];
  // Why the tick stopped: 'budget' (we ran out of headroom), 'queue-empty'
  // (every tracked repo has deepen_complete = true), or 'rate-limited' (BB
  // pushed back hard enough to exhaust the client's in-request retries — we
  // yield the rest of the queue to the next cron firing), or
  // 'rotation-complete' (we've given every incomplete repo one turn this
  // tick — picking again would just revisit. This protects against the
  // pathological case where every incomplete repo has `oldestSha = null`
  // and the empty-result path doesn't consume budget, which would
  // otherwise loop forever since `markDeepenAttempt` only rotates
  // ordering, not the set of candidates).
  stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete';
  budgetRemainingAtEnd: number;
}

// Drains the deepen-backfill queue until either (a) the call budget falls
// below `budgetThreshold` — meaning delta sync consumed our headroom or
// we've made enough progress this hour — or (b) every tracked repo is
// complete. One tick can process many repos; the throughput is now
// budget-shaped, not "one per cron firing".
export async function runDeepenTick(deps: DeepenBackfillDeps, opts: DeepenBackfillOptions): Promise<DeepenTickResult> {
  const repos: DeepenBackfillResult[] = [];
  // Repos attempted this tick. The candidate picker orders by
  // `deepen_last_run_at ASC NULLS FIRST` and we always `markDeepenAttempt`
  // before returning, so within one tick the picker rotates through every
  // incomplete repo before revisiting. Once a result.repositoryId
  // reappears we've completed a full rotation and should stop — the
  // remaining work (if any) goes to the next cron firing.
  const seen = new Set<number>();
  let stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete';
  for (;;) {
    if (deps.client.getBudgetRemaining() < opts.budgetThreshold) {
      stoppedReason = 'budget';
      deps.logger?.info?.(
        { remaining: deps.client.getBudgetRemaining(), threshold: opts.budgetThreshold, repos: repos.length },
        'deepen-backfill tick: budget gate fired',
      );
      break;
    }
    const result = await deepenOneRepo(deps, opts);
    if (result === null) {
      stoppedReason = 'queue-empty';
      deps.logger?.info?.({ repos: repos.length }, 'deepen-backfill tick: queue drained');
      break;
    }
    if (seen.has(result.repositoryId)) {
      // Full rotation — we've cycled back to the first repo attempted
      // this tick. Common when most/all incomplete repos have
      // `oldestSha = null` (the empty-result path), since those don't
      // consume budget and wouldn't otherwise stop the loop.
      stoppedReason = 'rotation-complete';
      deps.logger?.info?.(
        { repos: repos.length, attempted: seen.size, repeatRepository: result.fullName },
        'deepen-backfill tick: full rotation completed',
      );
      break;
    }
    seen.add(result.repositoryId);
    repos.push(result);
    if (result.rateLimited) {
      stoppedReason = 'rate-limited';
      deps.logger?.info?.(
        { repos: repos.length, lastRepo: result.fullName },
        'deepen-backfill tick: yielded on BB rate limit',
      );
      break;
    }
  }
  return {
    repos,
    stoppedReason,
    budgetRemainingAtEnd: deps.client.getBudgetRemaining(),
  };
}

// UTC day bounds for the staged inserts. `paginateCommits` walks newest-first
// so insert[0] is the most recent and the tail is the oldest, but we
// min/max defensively in case ancestry isn't strictly chronological.
function rangeOfInserts(inserts: DeepenInsertStaging[]): { sinceDay: string; untilDay: string } | null {
  if (inserts.length === 0) return null;
  let minMs = inserts[0]!.authoredAt.getTime();
  let maxMs = minMs;
  for (let i = 1; i < inserts.length; i++) {
    const t = inserts[i]!.authoredAt.getTime();
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  return {
    sinceDay: new Date(minMs).toISOString().slice(0, 10),
    untilDay: new Date(maxMs).toISOString().slice(0, 10),
  };
}

function emptyResult(repositoryId: number, fullName: string): DeepenBackfillResult {
  return {
    repositoryId,
    fullName,
    fetched: 0,
    inserted: 0,
    reachedRoot: false,
    hitPageCap: false,
    seedMissing: false,
    rateLimited: false,
  };
}
