// Self-queueing deepen-backfill. Cold mode captures only the most recent
// COMMITS_BACKFILL_MAX_PAGES × 100 commits per repo, then runs delta-only;
// older history stays absent unless something walks back to fetch it. This
// module is that something.
//
// State lives entirely on `sync_state`: `deepen_complete` flips true once a
// repo's history reaches BB's first commit (the paginated walk runs out of
// `next` URLs), and `deepen_last_run_at` rotates candidates round-robin —
// the queue is derived state, no table.
//
// Runs as a low-priority piggyback at the tail of `runCommitsSync`: one
// deepen page per repo only when budget headroom remains after the delta
// tick. A page walks newest-first from the oldest known sha (skipping that
// seed) backward through its ancestors. insertCommits dedupes, so re-runs
// converge.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits, type BitbucketCommit } from '../bitbucket/commits.js';
import { parseAuthorDisplayName, parseAuthorEmail } from './author-email.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';
import type { CommitInsertInput, CommitStore, DeepenCandidate } from './commit-store.js';
import type { DiscoveryStore } from './discovery-store.js';
import type { EventBus } from '../events/bus.js';

export interface DeepenBackfillOptions {
  // Max pages of 100 commits per deepen page. Mirrors the cold-mode cap.
  maxPages: number;
  // Headroom required before attempting a deepen page. Higher than the
  // commit-tick threshold so we yield to delta sync.
  budgetThreshold: number;
  // Grace window (hours) before a still-empty repo is auto-excluded with
  // reason 'empty-on-bitbucket'. Anchored on `repositories.created_at`: a
  // repo added moments before its first push must not be excluded in the
  // gap, or it goes dark until an operator runs /sync/revive-empty. Within
  // the window it stays in active sync so the commit tick keeps probing.
  // Defaults to DEFAULT_EMPTY_GRACE_HOURS.
  emptyGraceHours?: number;
}

// Fallback when opts.emptyGraceHours is unset (tests, admin force-deepen).
// Production wires SYNC_EMPTY_GRACE_HOURS, which also defaults to 24h.
const DEFAULT_EMPTY_GRACE_HOURS = 24;

export interface DeepenBackfillResult {
  repositoryId: number;
  fullName: string;
  // Commits fetched from BB this run, excluding the always-discarded seed
  // sha. 0 when the seed had no parents or the BB call 404'd.
  fetched: number;
  // Rows newly inserted; `fetched - inserted` are deduped collisions.
  inserted: number;
  // BB's walk produced no `next` URL — reached the first commit.
  // deepen_complete is set on the row.
  reachedRoot: boolean;
  // Page cap fired before BB ran out — older history still remains.
  hitPageCap: boolean;
  // Seed sha 404'd (force-pushed history). Give up: deepen_complete is set.
  seedMissing: boolean;
  // BB rate-limited AND the client's retry budget was exhausted. Tick-wide
  // stop signal — hammering the next repo while BB's limiter is hot just
  // compounds the backoff. The rest defers to the next cron tick.
  rateLimited: boolean;
}

export interface DeepenBackfillDeps {
  client: BitbucketClient;
  store: CommitStore;
  logger?: BitbucketLogger;
  // When wired, every successful deepen page recomputes `commit_daily` for
  // its inserted day range — same pattern as the delta tick. Without it,
  // deepen-inserted historical commits silently drift the rollup.
  rollupStore?: RollupStore;
  // When wired alongside rollupStore, affected user-summary cache entries
  // are invalidated after the rollup recompute.
  userSummaryCache?: UserSummaryCache;
  // When wired, the empty-on-BB branch auto-trips `sync_excluded = true,
  // reason = 'empty-on-bitbucket'`. Without it, empty repos skip sync work
  // via deepen_complete but the operator never sees them flagged.
  discoveryStore?: DiscoveryStore;
  // When wired alongside discoveryStore, the empty-on-BB auto-trip
  // publishes `repository.sync-excluded` so SSE subscribers update immediately.
  bus?: EventBus;
}

// CommitInsertInput plus the BB author uuid (resolved to users.id in one
// bulk call after collecting the batch) and parsedEmail (the parsed
// author.raw email when it survives the noreply filter, so write-once
// capture batches without re-parsing). Both stripped before insertCommits.
interface DeepenInsertStaging extends CommitInsertInput {
  bitbucketUuid?: string;
  parsedEmail?: string;
}

export interface DeepenSpecificRepo {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
}

// Single repo. Returns `null` only when the queue is empty; transient
// errors return an empty result so the caller's loop rotates on. The budget
// gate is the caller's responsibility (runDeepenTick checks each iteration).
//
// `explicitRepo` overrides the round-robin pick (admin force-deepen route);
// the seed sha is still resolved fresh via getOldestCommitSha.
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
    // Every tracked repo has deepen_complete = true.
    return null;
  }

  // Always bump `deepen_last_run_at` so the next pick rotates even on no-op
  // outcomes — otherwise we'd re-pick the same repo every tick, starving siblings.
  await deps.store.markDeepenAttempt(candidate.repositoryId);

  if (candidate.oldestSha === null) {
    // No commits ingested. last_sync_status='success' means cold mode ran
    // cleanly and BB returned empty → genuinely empty on BB, flip
    // deepen_complete so it drops out of rotation. Anything else means cold
    // mode hasn't successfully run yet → leave it for the next rotation.
    const state = await deps.store.getSyncState(candidate.repositoryId);
    const isEmptyOnBitbucket = state?.lastSyncStatus === 'success';
    if (isEmptyOnBitbucket) {
      // Grace period: a just-tracked repo may be empty now but gain its
      // first commit any moment; excluding it in that gap sends it dark
      // until /sync/revive-empty. Within the window leave it untouched so
      // the commit tick keeps probing. `createdAt` is absent only on the
      // admin force-deepen path, where we deliberately fall through to
      // exclusion (operator action, not the brand-new-repo race).
      const graceHours = opts.emptyGraceHours ?? DEFAULT_EMPTY_GRACE_HOURS;
      if (candidate.createdAt !== undefined) {
        const ageMs = Date.now() - candidate.createdAt.getTime();
        if (ageMs < graceHours * 3_600_000) {
          deps.logger?.debug?.(
            {
              repositoryId: candidate.repositoryId,
              fullName: candidate.fullName,
              ageMs,
              graceHours,
            },
            'deepen-backfill: repo empty on BB but within new-repo grace window — leaving in active sync',
          );
          return { ...emptyResult(candidate.repositoryId, candidate.fullName), seedMissing: false };
        }
      }
      await deps.store.markDeepenComplete(candidate.repositoryId);
      // Surface in the dashboard via the same auto-trip channel as
      // commit-sync 404 / history-rewrite.
      if (deps.discoveryStore !== undefined) {
        await deps.discoveryStore.updateRepositorySyncExcluded(candidate.repositoryId, true, 'empty-on-bitbucket');
        deps.bus?.publish({
          event: 'repository.sync-excluded',
          payload: {
            repositoryId: candidate.repositoryId,
            fullName: candidate.fullName,
            reason: 'empty-on-bitbucket',
          },
        });
      }
      deps.logger?.info?.(
        { repositoryId: candidate.repositoryId, fullName: candidate.fullName },
        'deepen-backfill: repo is empty on BB (cold-mode success, 0 commits) — marking complete + auto-excluding',
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
      // Iterator exhausted without hitting the cap → BB has nothing older;
      // fully backfilled.
      reachedRoot = true;
    }
  } catch (err) {
    if (err instanceof BitbucketRateLimitError) {
      // Tick-wide stop signal so runDeepenTick halts instead of marching to
      // the next repo (which would re-trip the limiter). warn, not error:
      // expected backpressure. Next cron tick starts fresh.
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
      // Seed sha gone (force-push rewrote history). Mark complete to stop
      // trying — operator can flip the flag back to resume from another seed.
      seedMissing = true;
      reachedRoot = true;
      deps.logger?.warn?.(
        { repositoryId: candidate.repositoryId, fullName: candidate.fullName, oldestSha: candidate.oldestSha },
        'deepen-backfill: seed sha 404 — likely force-pushed; marking complete',
      );
    } else {
      // Transient failure — don't flip deepen_complete. Return an empty
      // result (not null) so the caller's tick loop continues.
      deps.logger?.error?.(err, `deepen-backfill: ${candidate.fullName} failed`);
      return { ...emptyResult(candidate.repositoryId, candidate.fullName), seedMissing: false };
    }
  }

  // Resolve authors for the batch — same path as cold/delta commit sync,
  // including the auto-create-for-unknown-uuid step.
  const uuids = Array.from(new Set(inserts.map((i) => i.bitbucketUuid).filter((u): u is string => u !== undefined)));
  if (uuids.length > 0) {
    const userIdByUuid = await deps.store.resolveUserIdsByUuid(uuids);

    // Auto-create user rows for unknown BB UUIDs carrying a parseable
    // email — same email-gated policy as the forward sync.
    const autoCreateInputs: Array<{ bitbucketUuid: string; displayName: string; email: string }> = [];
    const seenAutoCreate = new Set<string>();
    for (const input of inserts) {
      const uuid = input.bitbucketUuid;
      const email = input.parsedEmail;
      if (uuid === undefined || email === undefined) continue;
      if (userIdByUuid.has(uuid)) continue;
      if (seenAutoCreate.has(uuid)) continue;
      seenAutoCreate.add(uuid);
      autoCreateInputs.push({
        bitbucketUuid: uuid,
        // Fall back to email so users.display_name (NOT NULL) is meaningful.
        displayName: input.authorDisplayName ?? email,
        email,
      });
    }
    if (autoCreateInputs.length > 0) {
      const created = await deps.store.upsertAuthorUsers(autoCreateInputs);
      for (const [uuid, id] of created) userIdByUuid.set(uuid, id);
      deps.logger?.info?.(
        {
          repositoryId: candidate.repositoryId,
          fullName: candidate.fullName,
          autoCreatedCount: autoCreateInputs.length,
        },
        'deepen-backfill: auto-created out-of-workspace user rows',
      );
    }

    for (const input of inserts) {
      if (input.bitbucketUuid !== undefined && input.parsedEmail !== undefined) {
        input.authorUserId = userIdByUuid.get(input.bitbucketUuid) ?? null;
      }
    }

    // Write-once email capture for commits whose UUID was already in
    // `users` before this run. Auto-created rows set email at INSERT time;
    // skip them here.
    const emailEntries: Array<{ bitbucketUuid: string; email: string }> = [];
    for (const input of inserts) {
      if (
        input.bitbucketUuid !== undefined &&
        input.parsedEmail !== undefined &&
        userIdByUuid.has(input.bitbucketUuid) &&
        !seenAutoCreate.has(input.bitbucketUuid)
      ) {
        emailEntries.push({ bitbucketUuid: input.bitbucketUuid, email: input.parsedEmail });
      }
    }
    if (emailEntries.length > 0) {
      await deps.store.setUserEmailsIfMissing(emailEntries);
    }
  }

  const { inserted } = await deps.store.insertCommits(
    inserts.map(({ bitbucketUuid: _bitbucketUuid, parsedEmail: _parsedEmail, ...rest }) => rest),
  );

  // Rollup + cache hook — mirrors withRollupRecompute. Without it,
  // deepen-inserted commits don't reflect in the dashboard until a manual
  // rebuild. Commits are already durable, so failures here just log.
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
  const parsedEmail = parseAuthorEmail(commit.author.raw);
  // Prefer BB's author.user.display_name, fall back to author.raw's name
  // portion, else NULL.
  const displayNameSnapshot = commit.author.user?.display_name ?? parseAuthorDisplayName(commit.author.raw);
  return {
    repositoryId,
    authorUserId: null, // resolved in the batch step below
    sha: commit.hash,
    message: commit.message,
    isMerge: commit.parents.length > 1,
    authoredAt: new Date(commit.date),
    // Snapshot columns populated regardless of author resolution.
    authorEmail: parsedEmail,
    authorDisplayName: displayNameSnapshot,
    ...(commit.author.user !== undefined ? { bitbucketUuid: commit.author.user.uuid } : {}),
    ...(parsedEmail !== null ? { parsedEmail } : {}),
  };
}

export interface DeepenTickResult {
  // Per-repo results in processing order. Empty when the queue was already
  // drained (or no budget left at start).
  repos: DeepenBackfillResult[];
  // 'budget' = ran out of headroom. 'queue-empty' = all complete.
  // 'rate-limited' = BB exhausted the client's retries; rest yields to the
  // next tick. 'rotation-complete' = gave every incomplete repo one turn —
  // guards the pathological loop where every repo has oldestSha = null and
  // the empty-result path consumes no budget (markDeepenAttempt rotates
  // ordering, not the candidate set).
  stoppedReason: 'budget' | 'queue-empty' | 'rate-limited' | 'rotation-complete';
  budgetRemainingAtEnd: number;
}

// Drains the deepen-backfill queue until the budget falls below
// `budgetThreshold` or every repo is complete. One tick can process many
// repos — throughput is budget-shaped, not one-per-cron.
export async function runDeepenTick(deps: DeepenBackfillDeps, opts: DeepenBackfillOptions): Promise<DeepenTickResult> {
  const repos: DeepenBackfillResult[] = [];
  // The picker orders by deepen_last_run_at ASC NULLS FIRST and we always
  // markDeepenAttempt before returning, so the picker rotates through every
  // incomplete repo before revisiting. A reappearing repositoryId means a
  // full rotation — stop; remaining work goes to the next cron firing.
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
      // Cycled back to a repo already attempted this tick. Common when
      // incomplete repos have oldestSha = null (empty-result path), which
      // doesn't consume budget and wouldn't otherwise stop the loop.
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

// UTC day bounds for the staged inserts. min/max defensively rather than
// indexing head/tail, in case ancestry isn't strictly chronological.
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
