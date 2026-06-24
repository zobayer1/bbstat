// Standalone anonymous-commit sweep — drains the pre-V1_16 backlog of
// commits whose `author_user_id IS NULL` because the contributor's BB
// UUID wasn't in our `users` table at original ingest (typically
// ex-employees, never-members, or external pushers).
//
// Runs independently of the main `dev-sync` cron (entry point in
// `apps/backend/src/anonymous-sweep-main.ts`) so the operator can drain
// the backlog without interfering with steady-state sync. Same
// email-gated auto-create rule as the forward sync. Marks a repo
// complete once a pass produces zero new attributions — the residual is
// structurally anonymous.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits } from '../bitbucket/commits.js';
import { BitbucketApiError, BitbucketRateLimitError } from '../bitbucket/errors.js';
import type { RollupStore } from '../dashboard/rollup-store.js';
import type { UserSummaryCache } from '../dashboard/user-summary-cache.js';
import { parseAuthorDisplayName, parseAuthorEmail } from './author-email.js';
import type { CommitStore } from './commit-store.js';

export interface AnonymousSweepDeps {
  client: BitbucketClient;
  commitStore: CommitStore;
  // When wired, attributed-row updates trigger a scoped `commit_daily`
  // recompute over the affected day window. Snapshot-only updates don't
  // recompute — commit_daily aggregates by author_user_id, not the
  // snapshot columns.
  rollupStore?: RollupStore;
  // When wired alongside rollupStore, affected user-summary cache
  // entries get invalidated after the rollup recompute.
  userSummaryCache?: UserSummaryCache;
  logger?: BitbucketLogger;
}

export interface SweepRepoResult {
  repositoryId: number;
  fullName: string;
  localAnonymousCount: number;
  // Below `localAnonymousCount` when some local shas are unreachable
  // from BB's main branch (force-pushed-away, in feature branches);
  // equal in the typical case.
  matchedFromBB: number;
  // Commits where `author_user_id` transitioned NULL → known on this
  // pass. Drives the rollup recompute scope.
  attributed: number;
  // Snapshot columns filled but `author_user_id` stayed NULL — BB had
  // no UUID or no parseable email. Structurally anonymous; needs manual
  // investigation per operator policy.
  snapshotOnly: number;
  complete: boolean;
}

export interface SweepRunSummary {
  reposSwept: number;
  reposCompletedThisRun: number;
  totalAttributed: number;
  totalSnapshotOnly: number;
  exitReason: 'zero-remaining' | 'no-candidate';
}

const DEFAULT_BUDGET_THRESHOLD = 100;
const DEFAULT_BUDGET_SLEEP_MS = 60_000;

export interface RunAnonymousSweepOptions {
  // BB hourly budget below which we sleep instead of starting a new
  // repo. A single repo's full walk can be hundreds of pages, so we
  // want headroom before kicking one off. Default 100.
  budgetThreshold?: number;
  // Sleep when budget is below threshold. The BB hourly window is
  // rolling, so budget recovers within a few minutes. Default 60_000.
  budgetSleepMs?: number;
  // Injectable for tests so they don't actually wait.
  sleep?: (ms: number) => Promise<void>;
}

export async function runAnonymousSweep(
  deps: AnonymousSweepDeps,
  opts: RunAnonymousSweepOptions = {},
): Promise<SweepRunSummary> {
  const budgetThreshold = opts.budgetThreshold ?? DEFAULT_BUDGET_THRESHOLD;
  const budgetSleepMs = opts.budgetSleepMs ?? DEFAULT_BUDGET_SLEEP_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let reposSwept = 0;
  let reposCompletedThisRun = 0;
  let totalAttributed = 0;
  let totalSnapshotOnly = 0;

  deps.logger?.info?.({ budgetThreshold, budgetSleepMs }, 'anonymous-sweep runner: starting');

  // Two clean exits: zero anonymous commits remaining, or no incomplete
  // repo left to pick (every repo's residual is structurally anonymous).
  while (true) {
    const remainingAnon = await deps.commitStore.countAnonymousCommits();
    if (remainingAnon === 0) {
      deps.logger?.info?.(
        { reposSwept, reposCompletedThisRun, totalAttributed, totalSnapshotOnly },
        'anonymous-sweep: zero anonymous commits remaining — exiting',
      );
      return { reposSwept, reposCompletedThisRun, totalAttributed, totalSnapshotOnly, exitReason: 'zero-remaining' };
    }

    const budget = deps.client.getBudgetRemaining();
    if (budget < budgetThreshold) {
      deps.logger?.info?.({ budget, budgetThreshold, remainingAnon }, 'anonymous-sweep: budget low — sleeping');
      await sleep(budgetSleepMs);
      continue;
    }

    const candidate = await deps.commitStore.pickRepoForAnonymousSweep();
    if (candidate === null) {
      deps.logger?.info?.(
        { remainingAnon, reposSwept, reposCompletedThisRun, totalAttributed, totalSnapshotOnly },
        'anonymous-sweep: no incomplete repos with anonymous commits — exiting',
      );
      return { reposSwept, reposCompletedThisRun, totalAttributed, totalSnapshotOnly, exitReason: 'no-candidate' };
    }

    try {
      const result = await sweepOneRepo(deps, candidate);
      reposSwept++;
      if (result.complete) reposCompletedThisRun++;
      totalAttributed += result.attributed;
      totalSnapshotOnly += result.snapshotOnly;
      deps.logger?.info?.(result, 'anonymous-sweep: repo pass complete');
    } catch (err) {
      // markAnonymousSweepAttempt already fired inside sweepOneRepo, so
      // the picker rotates off this repo next iteration. NOT marked
      // complete — operator can retry by re-running the runner.
      deps.logger?.error?.(
        { err: err instanceof Error ? err.message : String(err), ...candidate },
        'anonymous-sweep: repo pass failed — rotating to next',
      );
    }
  }
}

export async function sweepOneRepo(
  deps: AnonymousSweepDeps,
  repo: { repositoryId: number; workspace: string; slug: string; fullName: string },
): Promise<SweepRepoResult> {
  // Bump the rotation cursor up front — even an error/no-op pass
  // advances the picker so we don't repeatedly hammer the same repo.
  await deps.commitStore.markAnonymousSweepAttempt(repo.repositoryId);

  // limit=1_000_000 is effectively no limit — sweep is one-shot per
  // repo, not paginated. The query is index-driven.
  const localAnon = await deps.commitStore.listAnonymousCommits({
    workspace: repo.workspace,
    slug: repo.slug,
    limit: 1_000_000,
  });

  if (localAnon.length === 0) {
    // Concurrent sync may have drained it between picks. Mark complete
    // so the picker stops returning it.
    await deps.commitStore.markAnonymousSweepComplete(repo.repositoryId);
    return {
      repositoryId: repo.repositoryId,
      fullName: repo.fullName,
      localAnonymousCount: 0,
      matchedFromBB: 0,
      attributed: 0,
      snapshotOnly: 0,
      complete: true,
    };
  }

  const oldestAnonMs = localAnon.reduce((m, c) => Math.min(m, c.authoredAt.getTime()), Infinity);
  const shasByLocal = new Map(localAnon.map((c) => [c.sha, c]));
  const metaBySha = new Map<string, { uuid?: string; raw: string; displayName?: string }>();

  // Stop walking as soon as we've crossed the oldest local anonymous
  // commit — anything older can't be in our local set. BB 404 (repo
  // gone upstream) marks the repo complete; rate-limit errors bubble up.
  try {
    for await (const commit of paginateCommits(deps.client, repo.workspace, repo.slug)) {
      const commitMs = new Date(commit.date).getTime();
      if (shasByLocal.has(commit.hash)) {
        metaBySha.set(commit.hash, {
          uuid: commit.author.user?.uuid,
          raw: commit.author.raw,
          displayName: commit.author.user?.display_name,
        });
      }
      if (commitMs < oldestAnonMs) break;
    }
  } catch (err) {
    if (err instanceof BitbucketApiError && err.status === 404) {
      deps.logger?.warn?.({ ...repo }, 'anonymous-sweep: BB 404 on commits endpoint — marking complete');
      await deps.commitStore.markAnonymousSweepComplete(repo.repositoryId);
      return {
        repositoryId: repo.repositoryId,
        fullName: repo.fullName,
        localAnonymousCount: localAnon.length,
        matchedFromBB: 0,
        attributed: 0,
        snapshotOnly: 0,
        complete: true,
      };
    }
    // Rate limit + everything else propagates; the outer loop rotates
    // to the next repo. Complete stays false but the attempt timestamp
    // already advanced, so the picker won't re-pick this repo immediately.
    throw err;
  }

  // Same gating as the forward sync: no email → no auto-create →
  // commit stays anonymous (snapshot columns still populated as a
  // forensic hook).
  const upsertInputs: Array<{ bitbucketUuid: string; displayName: string; email: string }> = [];
  const seenUuids = new Set<string>();
  type PerCommit = {
    commitId: number;
    uuid: string | null;
    email: string | null;
    displayName: string | null;
  };
  const perCommit: PerCommit[] = [];

  for (const [sha, meta] of metaBySha) {
    const local = shasByLocal.get(sha)!;
    const email = parseAuthorEmail(meta.raw);
    const displayName = meta.displayName ?? parseAuthorDisplayName(meta.raw);
    perCommit.push({
      commitId: local.commitId,
      uuid: meta.uuid ?? null,
      email,
      displayName,
    });
    if (meta.uuid !== undefined && email !== null && !seenUuids.has(meta.uuid)) {
      seenUuids.add(meta.uuid);
      upsertInputs.push({
        bitbucketUuid: meta.uuid,
        displayName: displayName ?? email,
        email,
      });
    }
  }

  const userByUuid =
    upsertInputs.length > 0 ? await deps.commitStore.upsertAuthorUsers(upsertInputs) : new Map<string, number>();

  if (perCommit.length === 0) {
    // None of BB's returned shas matched our local anonymous set —
    // typically the local commits live on branches we don't walk. No
    // point retrying without changing the walk strategy.
    await deps.commitStore.markAnonymousSweepComplete(repo.repositoryId);
    return {
      repositoryId: repo.repositoryId,
      fullName: repo.fullName,
      localAnonymousCount: localAnon.length,
      matchedFromBB: 0,
      attributed: 0,
      snapshotOnly: 0,
      complete: true,
    };
  }

  const updateEntries = perCommit.map((p) => ({
    commitId: p.commitId,
    userId: p.uuid !== null && p.email !== null ? (userByUuid.get(p.uuid) ?? null) : null,
    email: p.email,
    displayName: p.displayName,
  }));

  const updatedRows = await deps.commitStore.bulkUpdateAnonymousAttribution(updateEntries);

  let attributed = 0;
  let snapshotOnly = 0;
  const attributedAuthoredAt: Date[] = [];
  for (const r of updatedRows) {
    if (r.attributed) {
      attributed++;
      attributedAuthoredAt.push(r.authoredAt);
    } else {
      snapshotOnly++;
    }
  }

  // Snapshot-only updates don't shift commit_daily (it aggregates by
  // author_user_id, not the snapshot columns), so skip recompute when
  // attributed === 0.
  if (attributed > 0 && deps.rollupStore !== undefined && attributedAuthoredAt.length > 0) {
    const minMs = attributedAuthoredAt.reduce((m, d) => Math.min(m, d.getTime()), Infinity);
    const maxMs = attributedAuthoredAt.reduce((m, d) => Math.max(m, d.getTime()), -Infinity);
    const range = {
      sinceDay: new Date(minMs).toISOString().slice(0, 10),
      untilDay: new Date(maxMs).toISOString().slice(0, 10),
    };
    try {
      await deps.rollupStore.recomputeCommitDailyForRepo(repo.repositoryId, range);
      if (deps.userSummaryCache !== undefined) {
        const affectedUserIds = await deps.rollupStore.listAffectedUserIdsForRepo(repo.repositoryId, range);
        await Promise.all(affectedUserIds.map((id) => deps.userSummaryCache!.invalidate(id)));
      }
    } catch (err) {
      deps.logger?.warn?.(
        { ...repo, range, err: err instanceof Error ? err.message : String(err) },
        'anonymous-sweep: rollup recompute / cache invalidate failed — commits already attributed',
      );
    }
  }

  // Zero attributions → residual is structurally anonymous; mark
  // complete. Snapshot columns record what BB returned for manual
  // follow-up; an operator can flip the flag back to FALSE in SQL to
  // re-attempt.
  const complete = attributed === 0;
  if (complete) {
    await deps.commitStore.markAnonymousSweepComplete(repo.repositoryId);
  }

  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    localAnonymousCount: localAnon.length,
    matchedFromBB: metaBySha.size,
    attributed,
    snapshotOnly,
    complete,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exported so tests can construct & throw the same error class the
// runner catches. The runner lets it propagate but does NOT mark the
// repo complete, treating rate-limit errors as transient.
export { BitbucketRateLimitError };
