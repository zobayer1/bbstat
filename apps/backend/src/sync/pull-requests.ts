// Per-repository PR sync. Walks /repositories/{ws}/{slug}/pullrequests
// sorted newest-first by updated_on, stops at the cursor (delta mode) or at
// a configurable cap (cold mode), resolves authors, and bulk-upserts via
// PrStore.upsertPullRequests. The runner / cron / admin trigger that
// invokes this lives in runner.ts; the tick orchestrator in pr-tick.ts.
//
// Idempotency:
//   * upsertPullRequests handles repeat (repo_id, bb_pr_id) conflicts with
//     DO UPDATE — PR state mutates (OPEN → MERGED, comment churn), so we
//     refresh the mutable columns rather than skipping. Re-runs converge.
//   * Two concurrent ticks for the same repo are safe but wasteful;
//     bounded concurrency lives in the tick orchestrator.
//
// Delta-cursor stop condition is strictly `updated_on < cursor`. PRs sharing
// the cursor's exact second will re-flow through the upsert path — the
// UPDATE is cheap and idempotent. Storing `last_pr_id` alongside is purely
// advisory for ops debugging; it does NOT participate in the stop check
// since BB's per-second ordering between same-updated_on PRs is not
// documented as stable.
//
// Modes:
//   * 'cold'     — first run for a repo (last_pr_updated_at is null). Capped
//                  by firstRunMaxPages so a fresh tracked repo doesn't drain
//                  the API budget on bootstrap.
//   * 'delta'    — last_pr_updated_at is set. Walks newest-first until
//                  updated_on < cursor. Idle repo costs one call.
//   * 'no-state' — sync_state row missing. Caller should bootstrap it via
//                  insertRepositoryWithSyncState before invoking us.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginatePullRequests, type BitbucketPullRequest } from '../bitbucket/pull-requests.js';
import type { RepositoryHandle } from './commits.js';
import type { PrStore, PullRequestInsertInput } from './pr-store.js';

export interface PrSyncOptions {
  // First-run cap: stop the initial backfill after this many pages of 100
  // PRs. No effect on delta runs (they always stop at the cursor).
  firstRunMaxPages?: number;
}

export type PrSyncMode = 'cold' | 'delta' | 'no-state';

export interface RepoPrSyncResult {
  repositoryId: number;
  fullName: string;
  mode: PrSyncMode;
  fetched: number;
  inserted: number;
  updated: number;
  newCursor: { updatedAt: string; prId: number } | null;
  hitKnownCursor: boolean;
  hitPageCap: boolean;
}

export interface PrSyncDeps {
  client: BitbucketClient;
  store: PrStore;
  logger?: BitbucketLogger;
}

export async function syncRepositoryPullRequests(
  deps: PrSyncDeps,
  repo: RepositoryHandle,
  opts: PrSyncOptions = {},
): Promise<RepoPrSyncResult> {
  const cursor = await deps.store.getPrSyncState(repo.repositoryId);
  if (cursor === null) {
    deps.logger?.warn?.({ ...repo }, 'PR sync skipped: no sync_state row');
    return emptyResult(repo, 'no-state');
  }

  const lastPrUpdatedAt = cursor.lastPrUpdatedAt;
  const isCold = lastPrUpdatedAt === null;
  const pull = await pullPullRequests(deps, repo, lastPrUpdatedAt, opts);

  // BB returns newest-first → head of the batch is our new cursor. Empty
  // batch leaves the existing cursor untouched (see store impl).
  const head = pull.batch[0];
  const newCursor =
    head !== undefined
      ? {
          updatedAt: new Date(head.updated_on),
          prId: head.id,
        }
      : null;

  const uuids = Array.from(
    new Set(pull.batch.map((pr) => pr.author?.uuid).filter((u): u is string => u !== undefined)),
  );
  const userIdByUuid = await deps.store.resolveUserIdsByUuid(uuids);

  const inputs: PullRequestInsertInput[] = pull.batch.map((pr) => ({
    repositoryId: repo.repositoryId,
    bitbucketPrId: pr.id,
    title: pr.title,
    state: pr.state,
    authorUserId: pr.author ? (userIdByUuid.get(pr.author.uuid) ?? null) : null,
    sourceBranch: pr.source.branch.name,
    destinationBranch: pr.destination.branch.name,
    sourceSha: pr.source.commit?.hash ?? null,
    destinationSha: pr.destination.commit?.hash ?? null,
    commentCount: pr.comment_count,
    taskCount: pr.task_count,
    bitbucketCreatedAt: new Date(pr.created_on),
    bitbucketUpdatedAt: new Date(pr.updated_on),
    bitbucketClosedAt: pr.closed_on !== null ? new Date(pr.closed_on) : null,
  }));
  const upsert = inputs.length > 0 ? await deps.store.upsertPullRequests(inputs) : { inserted: 0, updated: 0 };

  await deps.store.markPrSyncSuccess(repo.repositoryId, {
    newCursor,
    addedOrUpdated: upsert.inserted + upsert.updated,
  });

  deps.logger?.info?.(
    {
      ...repo,
      mode: isCold ? 'cold' : 'delta',
      fetched: pull.batch.length,
      inserted: upsert.inserted,
      updated: upsert.updated,
      hitKnownCursor: pull.hitKnownCursor,
      hitPageCap: pull.hitPageCap,
    },
    'PR sync complete',
  );

  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    mode: isCold ? 'cold' : 'delta',
    fetched: pull.batch.length,
    inserted: upsert.inserted,
    updated: upsert.updated,
    newCursor: newCursor !== null ? { updatedAt: newCursor.updatedAt.toISOString(), prId: newCursor.prId } : null,
    hitKnownCursor: pull.hitKnownCursor,
    hitPageCap: pull.hitPageCap,
  };
}

interface PullResult {
  batch: BitbucketPullRequest[];
  hitKnownCursor: boolean;
  hitPageCap: boolean;
}

async function pullPullRequests(
  deps: PrSyncDeps,
  repo: RepositoryHandle,
  lastPrUpdatedAt: Date | null,
  opts: PrSyncOptions,
): Promise<PullResult> {
  const isCold = lastPrUpdatedAt === null;
  const maxItems = opts.firstRunMaxPages !== undefined ? opts.firstRunMaxPages * 100 : undefined;
  const cursorMs = lastPrUpdatedAt?.getTime();

  const batch: BitbucketPullRequest[] = [];
  let hitKnownCursor = false;
  let hitPageCap = false;

  for await (const pr of paginatePullRequests(deps.client, repo.workspace, repo.slug)) {
    if (!isCold) {
      const prMs = new Date(pr.updated_on).getTime();
      if (prMs < cursorMs!) {
        hitKnownCursor = true;
        break;
      }
    }
    batch.push(pr);
    if (isCold && maxItems !== undefined && batch.length >= maxItems) {
      hitPageCap = true;
      break;
    }
  }

  return { batch, hitKnownCursor, hitPageCap };
}

function emptyResult(repo: RepositoryHandle, mode: PrSyncMode): RepoPrSyncResult {
  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    mode,
    fetched: 0,
    inserted: 0,
    updated: 0,
    newCursor: null,
    hitKnownCursor: false,
    hitPageCap: false,
  };
}
