// Per-repository commit sync. Walks /repositories/{ws}/{slug}/commits, stops
// at the cursor (delta mode) or at a configurable cap (cold mode), resolves
// authors, and bulk-inserts via the CommitStore. insertCommits dedupes on
// (repository_id, sha), so concurrent ticks for the same repo are safe.
//
// Modes:
//   * 'cold'     — first run (last_seen_sha null). Capped by firstRunMaxPages
//                  and/or firstRunSince so bootstrap doesn't drain the budget.
//   * 'delta'    — last_seen_sha set. Walks newest-first until it matches.
//                  An idle repo costs one call.
//   * 'no-state' — sync_state row missing; caller should bootstrap it first.

import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import { paginateCommits, type BitbucketCommit } from '../bitbucket/commits.js';
import { BitbucketApiError } from '../bitbucket/errors.js';
import type { EventBus } from '../events/bus.js';
import type { CommitInsertInput, CommitStore, PendingDiffStatCommit } from './commit-store.js';
import type { DiscoveryStore } from './discovery-store.js';
import { parseAuthorDisplayName, parseAuthorEmail } from './author-email.js';
import { fetchDiffStatsForCommits, type DiffStatsSyncResult } from './diff-stats.js';

export interface RepositoryHandle {
  repositoryId: number;
  workspace: string;
  slug: string;
  fullName: string;
  // File-path globs (picomatch) the diff-stat aggregator skips. Empty = no
  // filtering. Sourced from `repositories.diff_stats_exclude_patterns`.
  diffStatsExcludePatterns: string[];
}

export interface CommitSyncOptions {
  // First-run cap: stop the initial backfill after this many pages of 100
  // commits. No effect on delta runs (they always stop at last_seen_sha).
  firstRunMaxPages?: number;
  // First-run cap: stop the initial backfill at any commit authored before
  // this date. Combined with firstRunMaxPages, whichever fires first wins.
  firstRunSince?: Date;
  // Restrict history walk to a single ref. Defaults to BitBucket's
  // main-branch behavior; mostly here for tests.
  include?: string;
  // Opt-in per-commit diff-stat ingest. When present, only the
  // inline-eager path runs: /diffstat for the commits just inserted in
  // this run. Older pending commits are the backfill tick's job.
  diffStats?: { budgetThreshold: number };
}

export type SyncMode = 'cold' | 'delta' | 'no-state';

export interface RepoCommitSyncResult {
  repositoryId: number;
  fullName: string;
  mode: SyncMode;
  fetched: number;
  inserted: number;
  newCursor: string | null;
  hitKnownSha: boolean;
  hitPageCap: boolean;
  hitDateCap: boolean;
  // UTC day window over the just-pulled batch (set when non-empty,
  // regardless of how many actually inserted). The rollup hook uses it to
  // scope the commit_daily recompute.
  insertedRange: { sinceDay: string; untilDay: string } | null;
  // Inline-eager diff-stat results. All zero / null when opts.diffStats
  // wasn't supplied. The rollup hook ORs diffStatsRange with insertedRange
  // so commit_daily refreshes for diff-stat-only updates too.
  diffStatsUpdated: number;
  diffStatsFailed: number;
  diffStatsRange: { sinceDay: string; untilDay: string } | null;
  // UTC day window over commits whose author_user_id transitioned NULL →
  // known on this run. The rollup hook unions this before recomputing so
  // the stale (day, repo, NULL) row is replaced by (day, repo, user) in
  // the same window — without it the dashboard double-counts those days.
  reattributedRange: { sinceDay: string; untilDay: string } | null;
  // Set when this run's auto-trip flipped sync_excluded; NULL on a healthy
  // outcome. The DB write already happened before the result returned.
  autoExcluded: AutoExcludeReason | null;
}

export interface CommitSyncDeps {
  client: BitbucketClient;
  store: CommitStore;
  // When wired, the sync auto-trips `sync_excluded = true` on two terminal
  // conditions:
  //   * BB 404 on `/commits` (reason 'repo-404') — repo renamed/deleted
  //     upstream. Exclusion recorded before the BitbucketApiError re-raises.
  //   * Delta walk exhausted BB's full history without finding
  //     `last_seen_sha` (reason 'history-rewritten') — cursor sha rewritten
  //     out. No insert; cursor stays put. Operator recovers via /include.
  // Without this dep the failure paths still run but the row stays in
  // rotation (only the admin endpoint can exclude).
  discoveryStore?: DiscoveryStore;
  // When wired alongside discoveryStore, each auto-trip publishes a
  // `repository.sync-excluded` event so SSE clients update the badge
  // without waiting for the next poll.
  bus?: EventBus;
  logger?: BitbucketLogger;
}

export type AutoExcludeReason = 'repo-404' | 'history-rewritten';

export async function syncRepositoryCommits(
  deps: CommitSyncDeps,
  repo: RepositoryHandle,
  opts: CommitSyncOptions = {},
): Promise<RepoCommitSyncResult> {
  const cursor = await deps.store.getSyncState(repo.repositoryId);
  if (cursor === null) {
    deps.logger?.warn?.({ ...repo }, 'commit sync skipped: no sync_state row');
    return emptyResult(repo, 'no-state');
  }

  await deps.store.markSyncRunning(repo.repositoryId);

  try {
    const lastSeenSha = cursor.lastSeenSha;
    const isCold = lastSeenSha === null;
    const pull = await pullCommits(deps, repo, lastSeenSha, opts);

    // History-rewrite detection: in delta mode the iterator exhausting
    // AND never seeing the cursor AND BB actually having commits means the
    // cursor sha is no longer reachable (force-push / reset). Skip the
    // insert — persisting under the same row would strand the orphaned
    // shas and confuse the cursor next tick. Operator recovers via
    // POST /include (clears cursor + exclusion in one shot).
    if (!isCold && !pull.hitKnownSha && pull.batch.length > 0 && deps.discoveryStore !== undefined) {
      await deps.discoveryStore.updateRepositorySyncExcluded(repo.repositoryId, true, 'history-rewritten');
      await deps.store.markSyncFailed(
        repo.repositoryId,
        `history-rewritten: walked ${pull.batch.length} commits without finding last_seen_sha=${lastSeenSha}`,
      );
      deps.bus?.publish({
        event: 'repository.sync-excluded',
        payload: { repositoryId: repo.repositoryId, fullName: repo.fullName, reason: 'history-rewritten' },
      });
      deps.logger?.warn?.(
        { ...repo, walked: pull.batch.length, lastSeenSha },
        'commit sync: BB history rewritten — auto-excluding repo',
      );
      return {
        ...emptyResult(repo, 'delta'),
        fetched: pull.batch.length,
        hitKnownSha: false,
        autoExcluded: 'history-rewritten',
      };
    }

    // BB returns newest-first, so the head of the batch is our new cursor.
    // An empty batch leaves the existing cursor untouched (see store impl).
    const newCursor = pull.batch[0]?.hash ?? null;

    const uuids = Array.from(
      new Set(pull.batch.map((c) => c.author.user?.uuid).filter((u): u is string => u !== undefined)),
    );
    const userIdByUuid = await deps.store.resolveUserIdsByUuid(uuids);

    // Pre-extract author metadata once so email-capture, auto-create, and
    // insert-input building all read the same parsed view. Display-name
    // snapshot prefers BB's author.user.display_name, falls back to the
    // name portion of author.raw, else NULL.
    const parsed = pull.batch.map((c) => ({
      commit: c,
      uuid: c.author.user?.uuid,
      email: parseAuthorEmail(c.author.raw),
      displayNameSnapshot: c.author.user?.display_name ?? parseAuthorDisplayName(c.author.raw),
    }));

    // Auto-create user rows for BB-resolved UUIDs not yet in `users` that
    // carry a parseable email — ex-employees, never-members, external
    // pushers. The email gate is the operator's explicit rule: no
    // auto-create without a real email.
    const autoCreateInputs: Array<{ bitbucketUuid: string; displayName: string; email: string }> = [];
    const seenAutoCreate = new Set<string>();
    for (const p of parsed) {
      if (p.uuid === undefined) continue;
      if (userIdByUuid.has(p.uuid)) continue;
      if (p.email === null) continue;
      if (seenAutoCreate.has(p.uuid)) continue;
      seenAutoCreate.add(p.uuid);
      autoCreateInputs.push({
        bitbucketUuid: p.uuid,
        displayName: p.displayNameSnapshot ?? p.email,
        email: p.email,
      });
    }
    if (autoCreateInputs.length > 0) {
      const created = await deps.store.upsertAuthorUsers(autoCreateInputs);
      for (const [uuid, id] of created) userIdByUuid.set(uuid, id);
      deps.logger?.info?.(
        { ...repo, autoCreatedCount: autoCreateInputs.length },
        'commit sync: auto-created out-of-workspace user rows',
      );
    }

    // Write-once email capture for commits whose UUID was already in
    // `users` at the start of this run. Auto-created authors set email at
    // INSERT time above, so they're skipped here.
    const emailEntries: Array<{ bitbucketUuid: string; email: string }> = [];
    for (const p of parsed) {
      if (p.uuid === undefined || p.email === null) continue;
      if (seenAutoCreate.has(p.uuid)) continue; // INSERTed with email above
      if (!userIdByUuid.has(p.uuid)) continue;
      emailEntries.push({ bitbucketUuid: p.uuid, email: p.email });
    }
    if (emailEntries.length > 0) {
      await deps.store.setUserEmailsIfMissing(emailEntries);
    }

    const inserts: CommitInsertInput[] = parsed.map((p) => ({
      repositoryId: repo.repositoryId,
      // author_user_id is set only with both a UUID AND a parseable email
      // (the no-auto-create-without-email policy). UUID-only stays anonymous.
      authorUserId: p.uuid !== undefined && p.email !== null ? (userIdByUuid.get(p.uuid) ?? null) : null,
      sha: p.commit.hash,
      message: p.commit.message,
      // parents.length > 1 means merge. Captured at insert time so
      // aggregates can default-exclude merges without an extra fetch.
      isMerge: p.commit.parents.length > 1,
      authoredAt: new Date(p.commit.date),
      // Snapshot columns populated even when author_user_id ends up NULL —
      // a forensic hook for later reprocessing.
      authorEmail: p.email,
      authorDisplayName: p.displayNameSnapshot,
    }));
    const { inserted, insertedRows, reattributedRows } = await deps.store.insertCommits(inserts);

    await deps.store.markSyncSuccess(repo.repositoryId, {
      lastSeenSha: newCursor,
      commitsAdded: inserted,
    });

    // Inline-eager diff-stat ingest for the just-inserted commits. Runs
    // after markSyncSuccess so commits + cursor are durable first; a
    // failure here leaves diff stats NULL to be retried via the backfill
    // tick. Older pending commits are the backfill tick's job — splitting
    // eager-forward from trickle-backward keeps new commits' stats fresh
    // without a backlog crowding the commit-tick budget.
    let diffStatsResult: DiffStatsSyncResult = {
      updated: 0,
      failed: 0,
      deferred: 0,
      hitBudgetGate: false,
      diffStatsRange: null,
    };
    if (opts.diffStats && insertedRows.length > 0) {
      const justInserted: PendingDiffStatCommit[] = insertedRows.map((r) => ({
        id: r.id,
        sha: r.sha,
        authoredAt: r.authoredAt,
      }));
      try {
        diffStatsResult = await fetchDiffStatsForCommits(
          { client: deps.client, store: deps.store, ...(deps.logger ? { logger: deps.logger } : {}) },
          repo,
          justInserted,
          opts.diffStats,
        );
      } catch (err) {
        deps.logger?.warn?.(
          { ...repo, err: err instanceof Error ? err.message : String(err) },
          'diff-stats step failed — commits already landed, will retry via backfill tick',
        );
      }
    }

    // Idle path logs at debug — at curated-set scale it fires ~70 times
    // per cron tick and would drown out everything else.
    const logFields = {
      ...repo,
      mode: isCold ? 'cold' : 'delta',
      fetched: pull.batch.length,
      inserted,
      hitKnownSha: pull.hitKnownSha,
      hitPageCap: pull.hitPageCap,
      hitDateCap: pull.hitDateCap,
      diffStatsUpdated: diffStatsResult.updated,
      diffStatsFailed: diffStatsResult.failed,
    };
    if (pull.batch.length === 0 && inserted === 0) {
      deps.logger?.debug?.(logFields, 'commit sync complete (idle)');
    } else {
      deps.logger?.info?.(logFields, 'commit sync complete');
    }

    return {
      repositoryId: repo.repositoryId,
      fullName: repo.fullName,
      mode: isCold ? 'cold' : 'delta',
      fetched: pull.batch.length,
      inserted,
      newCursor,
      hitKnownSha: pull.hitKnownSha,
      hitPageCap: pull.hitPageCap,
      hitDateCap: pull.hitDateCap,
      insertedRange: rangeOfBatch(pull.batch),
      diffStatsUpdated: diffStatsResult.updated,
      diffStatsFailed: diffStatsResult.failed,
      diffStatsRange: diffStatsResult.diffStatsRange,
      reattributedRange: rangeOfRows(reattributedRows),
      autoExcluded: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // BB 404 means the repo was renamed/deleted upstream — not coming back
    // under this slug. Auto-trip exclusion before re-raising so the next
    // tick won't burn another call. Operator recovers via POST /rename or
    // DELETE.
    if (err instanceof BitbucketApiError && err.status === 404 && deps.discoveryStore !== undefined) {
      await deps.discoveryStore.updateRepositorySyncExcluded(repo.repositoryId, true, 'repo-404');
      deps.bus?.publish({
        event: 'repository.sync-excluded',
        payload: { repositoryId: repo.repositoryId, fullName: repo.fullName, reason: 'repo-404' },
      });
      deps.logger?.warn?.({ ...repo }, 'commit sync: BB 404 — auto-excluding repo');
    }
    await deps.store.markSyncFailed(repo.repositoryId, msg);
    throw err;
  }
}

interface PullResult {
  batch: BitbucketCommit[];
  hitKnownSha: boolean;
  hitPageCap: boolean;
  hitDateCap: boolean;
}

async function pullCommits(
  deps: CommitSyncDeps,
  repo: RepositoryHandle,
  lastSeenSha: string | null,
  opts: CommitSyncOptions,
): Promise<PullResult> {
  const isCold = lastSeenSha === null;
  const maxCommits = opts.firstRunMaxPages !== undefined ? opts.firstRunMaxPages * 100 : undefined;
  const sinceMs = opts.firstRunSince?.getTime();

  const batch: BitbucketCommit[] = [];
  let hitKnownSha = false;
  let hitPageCap = false;
  let hitDateCap = false;

  const iterOpts = opts.include !== undefined ? { include: opts.include } : {};
  for await (const commit of paginateCommits(deps.client, repo.workspace, repo.slug, iterOpts)) {
    if (!isCold && commit.hash === lastSeenSha) {
      hitKnownSha = true;
      break;
    }
    if (isCold && sinceMs !== undefined && new Date(commit.date).getTime() < sinceMs) {
      hitDateCap = true;
      break;
    }
    batch.push(commit);
    if (isCold && maxCommits !== undefined && batch.length >= maxCommits) {
      hitPageCap = true;
      break;
    }
  }

  return { batch, hitKnownSha, hitPageCap, hitDateCap };
}

function emptyResult(repo: RepositoryHandle, mode: SyncMode): RepoCommitSyncResult {
  return {
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    mode,
    fetched: 0,
    inserted: 0,
    newCursor: null,
    hitKnownSha: false,
    hitPageCap: false,
    hitDateCap: false,
    insertedRange: null,
    diffStatsUpdated: 0,
    diffStatsFailed: 0,
    diffStatsRange: null,
    reattributedRange: null,
    autoExcluded: null,
  };
}

// UTC day bounds for a newest-first batch (batch[0] is newest → untilDay).
// The slice(0,10) reads YYYY-MM-DD of an ISO timestamp, matching Postgres
// `date_trunc('day', x AT TIME ZONE 'UTC')::date` exactly.
function rangeOfBatch(batch: BitbucketCommit[]): { sinceDay: string; untilDay: string } | null {
  if (batch.length === 0) return null;
  const newest = batch[0]!.date;
  const oldest = batch[batch.length - 1]!.date;
  return {
    sinceDay: new Date(oldest).toISOString().slice(0, 10),
    untilDay: new Date(newest).toISOString().slice(0, 10),
  };
}

// Day-window for rows in unspecified order (RETURNING order isn't defined
// for ON CONFLICT DO UPDATE), so it scans instead of indexing head/tail
// like rangeOfBatch. Same UTC YYYY-MM-DD slice convention.
function rangeOfRows(rows: Array<{ authoredAt: Date }>): { sinceDay: string; untilDay: string } | null {
  if (rows.length === 0) return null;
  let minMs = rows[0]!.authoredAt.getTime();
  let maxMs = minMs;
  for (let i = 1; i < rows.length; i++) {
    const t = rows[i]!.authoredAt.getTime();
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  return {
    sinceDay: new Date(minMs).toISOString().slice(0, 10),
    untilDay: new Date(maxMs).toISOString().slice(0, 10),
  };
}
