// Admin endpoints — manual sync triggers and curated-repo management.
//
// No auth here intentionally. Per CLAUDE.md "Authentication", the dashboard
// is open within the deployed environment by design (drives intra-org
// transparency). When BitBucket OAuth + RBAC lands, this is the seam to gate
// on an admin role — wrap the route handlers with a preHandler that checks
// `request.session.user.role === 'admin'` (or whatever shape we settle on).
//
// Read-only Bitbucket scopes provide a backstop: even a malicious request
// here can't write to BitBucket through us.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { paginateCommits } from '../bitbucket/commits.js';
import { parseAuthorEmail } from '../sync/author-email.js';
import { BitbucketApiError } from '../bitbucket/errors.js';
import { validatePatterns } from '../bitbucket/diff-stats-filter.js';
import { syncRepositoryCommits } from '../sync/commits.js';
import { deepenOneRepo } from '../sync/deepen-backfill.js';
import { addTrackedRepository } from '../sync/discovery.js';
import { syncRepositoryPullRequests } from '../sync/pull-requests.js';
import { runCommitsSync, runDiscoverySync, runPullRequestsSync } from './../sync/runner.js';
import type { RepositoryHandle } from '../sync/commits.js';
import type { PrSyncOptions } from '../sync/pull-requests.js';
import type { SyncRunnerDeps } from '../sync/runner.js';

interface BitbucketRepoResponse {
  uuid: string;
  slug: string;
  full_name: string;
  workspace: { slug: string };
  project?: { key: string };
}

export interface AdminRouteOptions {
  syncDeps: SyncRunnerDeps;
}

const addRepositoryBody = z.object({
  workspace: z.string().min(1),
  slug: z.string().min(1),
});

const renameRepositoryBody = z.object({
  workspace: z.string().min(1),
  slug: z.string().min(1),
});

const excludePatternsBody = z.object({
  patterns: z.array(z.string()),
});

export const adminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, opts) => {
  app.post('/sync/discover', async () => {
    return runDiscoverySync(opts.syncDeps, 'manual');
  });

  app.post('/sync/commits', async () => {
    return runCommitsSync(opts.syncDeps, 'manual');
  });

  app.post('/sync/pullrequests', async () => {
    return runPullRequestsSync(opts.syncDeps, 'manual');
  });

  // Force a fresh delta pull for a single tracked repo. Useful for backfills,
  // for re-running after fixing a sync bug, and as the manual smoke test for
  // commit ingest in dev. Idempotent — duplicate shas are deduped by the
  // commits_sha_repo_unique constraint.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/sync/repositories/:workspace/:slug/commits',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) {
        return reply.code(404).send({ error: 'not_tracked', fullName });
      }
      const handle: RepositoryHandle = {
        repositoryId: row.id,
        workspace: row.workspace,
        slug: row.slug,
        fullName: row.fullName,
        diffStatsExcludePatterns: row.diffStatsExcludePatterns,
      };
      return await syncRepositoryCommits(
        {
          client: opts.syncDeps.client,
          store: opts.syncDeps.commitStore,
          logger: opts.syncDeps.logger,
          discoveryStore: opts.syncDeps.store,
        },
        handle,
        opts.syncDeps.commitTickOptions ?? {},
      );
    },
  );

  app.post<{ Params: { workspace: string; slug: string } }>(
    '/sync/repositories/:workspace/:slug/pullrequests',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) {
        return reply.code(404).send({ error: 'not_tracked', fullName });
      }
      const handle: RepositoryHandle = {
        repositoryId: row.id,
        workspace: row.workspace,
        slug: row.slug,
        fullName: row.fullName,
        diffStatsExcludePatterns: row.diffStatsExcludePatterns,
      };
      // The tick options carry concurrency/budget knobs that don't apply to
      // a single-repo run; strip to just the per-repo subset.
      const prRepoOpts: PrSyncOptions = {
        ...(opts.syncDeps.prTickOptions?.firstRunMaxPages !== undefined
          ? { firstRunMaxPages: opts.syncDeps.prTickOptions.firstRunMaxPages }
          : {}),
      };
      return await syncRepositoryPullRequests(
        {
          client: opts.syncDeps.client,
          store: opts.syncDeps.prStore,
          logger: opts.syncDeps.logger,
        },
        handle,
        prRepoOpts,
      );
    },
  );

  // Manual deepen trigger for one repo. Useful when an operator wants to
  // force an immediate page of historical backfill without waiting for the
  // commit cron to round-robin to that repo. Body / params are ignored
  // beyond the URL — the deepen worker picks its own next page based on
  // `commits.authored_at ASC` for the given repo.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/sync/repositories/:workspace/:slug/deepen',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) {
        return reply.code(404).send({ error: 'not_tracked', fullName });
      }
      // Manual triggers don't bypass the budget gate — easier reasoning,
      // no surprise burn. (`runDeepenTick` checks before each iteration;
      // for one-shot manual runs the budget check lives inline here.)
      const deepenOptions = opts.syncDeps.deepenOptions ?? { maxPages: 5, budgetThreshold: 100 };
      if (opts.syncDeps.client.getBudgetRemaining() < deepenOptions.budgetThreshold) {
        return reply.code(503).send({
          error: 'budget_below_threshold',
          fullName,
          remaining: opts.syncDeps.client.getBudgetRemaining(),
          threshold: deepenOptions.budgetThreshold,
        });
      }
      const result = await deepenOneRepo(
        {
          client: opts.syncDeps.client,
          store: opts.syncDeps.commitStore,
          logger: opts.syncDeps.logger,
          discoveryStore: opts.syncDeps.store,
          ...(opts.syncDeps.rollupStore ? { rollupStore: opts.syncDeps.rollupStore } : {}),
          ...(opts.syncDeps.userSummaryCache ? { userSummaryCache: opts.syncDeps.userSummaryCache } : {}),
        },
        deepenOptions,
        { repositoryId: row.id, workspace: row.workspace, slug: row.slug, fullName: row.fullName },
      );
      if (result === null) {
        // explicitRepo path always returns a result; guard anyway.
        return reply.code(503).send({ error: 'no_candidate', fullName });
      }
      return result;
    },
  );

  app.post('/repositories', async (request, reply) => {
    const parsed = addRepositoryBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await addTrackedRepository(opts.syncDeps, parsed.data.workspace, parsed.data.slug);
    if (result.status === 'not-found') return reply.code(404).send(result);
    if (result.status === 'inserted') return reply.code(201).send(result);
    return reply.code(200).send(result);
  });

  // Soft-retire a tracked repo. Historical data stays (commits,
  // sync_state, etc.); the row is excluded from `listTrackedRepositories`
  // so commit / deepen / diff-stats ticks skip it. Idempotent — POSTing
  // archive on an already-archived repo still returns 200 with the row.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/archive',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      if (!row.archived) await opts.syncDeps.store.updateRepositoryArchived(row.id, true);
      return reply.code(200).send({ fullName: row.fullName, archived: true });
    },
  );

  // Reverse of archive. Idempotent — POSTing unarchive on an already-
  // active repo still returns 200.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/unarchive',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      if (row.archived) await opts.syncDeps.store.updateRepositoryArchived(row.id, false);
      return reply.code(200).send({ fullName: row.fullName, archived: false });
    },
  );

  // Recover from an auto-trip exclusion. Clears `sync_excluded` +
  // `sync_exclude_reason`, AND resets the commit-sync cursors to
  // cold-mode defaults so the next tick starts fresh. The cursor
  // reset is the load-bearing bit: when the row was excluded for
  // `history-rewritten`, the stored `last_seen_sha` is invalid and
  // a delta walk would just re-trip the same detection. Idempotent
  // on a non-excluded repo (still returns 200).
  //
  // For `empty-on-bitbucket` rows, the cursor reset also flips
  // `deepen_complete = false` so the deepen tick re-checks once commits
  // eventually appear.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/include',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      if (row.syncExcluded) {
        await opts.syncDeps.store.updateRepositorySyncExcluded(row.id, false, null);
      }
      await opts.syncDeps.commitStore.resetSyncCursors(row.id);
      opts.syncDeps.bus?.publish({
        event: 'repository.included',
        payload: { repositoryId: row.id, fullName: row.fullName, source: 'include' },
      });
      opts.syncDeps.logger?.info?.(
        { fullName: row.fullName, previousReason: row.syncExcludeReason },
        'repository re-included in sync — cursors reset',
      );
      return reply.code(200).send({ fullName: row.fullName, syncExcluded: false, cursorsReset: true });
    },
  );

  // Rename. Operator hands us the new workspace/slug; we re-fetch BB
  // to confirm the bitbucket_uuid still matches our row (i.e., this is
  // the SAME repo just renamed, not a different repo at the new path).
  // UUID mismatch is fatal — operator's input pointed at the wrong
  // repo and merging the histories would silently corrupt data. On
  // success: workspace/slug/full_name/project update, sync_excluded
  // clears, cursors reset. Caller can re-sync immediately.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/rename',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      const parsed = renameRepositoryBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const { workspace: newWorkspace, slug: newSlug } = parsed.data;

      let bb: BitbucketRepoResponse;
      try {
        bb = await opts.syncDeps.client.get<BitbucketRepoResponse>(`/repositories/${newWorkspace}/${newSlug}`, {
          fields: ['uuid', 'slug', 'full_name', 'workspace.slug', 'project.key'],
        });
      } catch (err) {
        if (err instanceof BitbucketApiError && err.status === 404) {
          return reply.code(404).send({ error: 'bitbucket_not_found', target: `${newWorkspace}/${newSlug}` });
        }
        throw err;
      }

      if (bb.uuid !== row.bitbucketUuid) {
        return reply.code(409).send({
          error: 'uuid_mismatch',
          message:
            'Target ws/slug resolves to a different BitBucket repository. Use POST /repositories to track it separately.',
          stored: { fullName: row.fullName, bitbucketUuid: row.bitbucketUuid },
          target: { fullName: bb.full_name, bitbucketUuid: bb.uuid },
        });
      }

      // Capture before the mutating update — some store impls return
      // a live reference whose `fullName` is rewritten by the rename.
      const previousFullName = row.fullName;
      const previousReason = row.syncExcludeReason;
      const wasExcluded = row.syncExcluded;
      await opts.syncDeps.store.updateRepositoryRename(row.id, {
        workspace: bb.workspace.slug,
        slug: bb.slug,
        fullName: bb.full_name,
        project: bb.project?.key ?? null,
      });
      if (wasExcluded) {
        await opts.syncDeps.store.updateRepositorySyncExcluded(row.id, false, null);
      }
      await opts.syncDeps.commitStore.resetSyncCursors(row.id);
      opts.syncDeps.bus?.publish({
        event: 'repository.included',
        payload: { repositoryId: row.id, fullName: bb.full_name, source: 'rename' },
      });
      opts.syncDeps.logger?.info?.(
        { previousFullName, newFullName: bb.full_name, previousReason },
        'repository renamed — cursors reset',
      );
      return reply.code(200).send({
        previousFullName,
        fullName: bb.full_name,
        syncExcluded: false,
        cursorsReset: true,
      });
    },
  );

  // Hard delete. Cascades via FKs to commits, sync_state, branches,
  // pull_requests. Use when soft-retire (archive) is insufficient and
  // the row is truly dead. Idempotent on a missing row (404 → no-op).
  app.delete<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      const deleted = await opts.syncDeps.store.deleteRepository(row.id);
      if (deleted > 0) {
        opts.syncDeps.bus?.publish({
          event: 'repository.deleted',
          payload: { repositoryId: row.id, fullName: row.fullName },
        });
      }
      opts.syncDeps.logger?.info?.({ fullName: row.fullName, repositoryId: row.id }, 'repository deleted');
      return reply.code(200).send({ fullName: row.fullName, deleted });
    },
  );

  // One-shot retroactive backfill of `is_merge` on already-ingested
  // commits. The column was added in migration 0006 with DEFAULT false,
  // so rows that pre-date the migration are stuck at false even if BB
  // reports them as merges. This endpoint walks /commits paginated for
  // the given repo, reads `parents.length > 1` per row, and bulk-UPDATEs
  // is_merge by sha. Doesn't touch any other column — additions /
  // deletions / files_changed / authored_at / message stay untouched.
  // Idempotent.
  //
  // Cost: ~1 BB call per 100 commits in the repo's history (e.g., 38
  // calls for a 3,700-commit repo). Operator-triggered; not on any
  // cron, not visible from the UI. New commits ingested after the
  // migration are flagged correctly at insert time so this is strictly
  // a historical-cleanup tool.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/backfill/is_merge',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });

      const entries: Array<{ sha: string; isMerge: boolean }> = [];
      let pages = 0;
      for await (const commit of paginateCommits(opts.syncDeps.client, row.workspace, row.slug)) {
        entries.push({ sha: commit.hash, isMerge: commit.parents.length > 1 });
        // Pagination is internal to paginateCommits; we track pages by
        // dividing the entry count for the log line, since the iterator
        // doesn't surface page boundaries.
        if (entries.length % 100 === 0) pages = Math.ceil(entries.length / 100);
      }
      pages = Math.ceil(entries.length / 100);

      const { updated } = await opts.syncDeps.commitStore.updateIsMergeBatch(row.id, entries);
      opts.syncDeps.logger?.info?.({ fullName, walked: entries.length, pages, updated }, 'is_merge backfill complete');
      return reply.code(200).send({ fullName, walked: entries.length, pages, updated });
    },
  );

  // Read the per-repo diff-stat exclude pattern list. Cheap — single
  // SELECT. Useful for inspecting what the dashboard's additions /
  // deletions / files_changed columns are currently filtering.
  app.get<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/diff-stats/exclusions',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      return reply.code(200).send({ fullName: row.fullName, patterns: row.diffStatsExcludePatterns });
    },
  );

  // Replace (not merge) the diff-stat exclude pattern list. Each entry
  // is validated as a parseable picomatch glob before persisting. Does
  // NOT touch the commit data — the operator runs POST .../reset
  // separately when they're confident in the new filter. This lets
  // them iterate on patterns cheaply.
  app.put<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/diff-stats/exclusions',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      const parsed = excludePatternsBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const invalid = validatePatterns(parsed.data.patterns);
      if (invalid !== null) {
        return reply.code(400).send({ error: 'invalid_pattern', ...invalid });
      }
      await opts.syncDeps.store.updateRepositoryExcludePatterns(row.id, parsed.data.patterns);
      opts.syncDeps.logger?.info?.(
        { fullName: row.fullName, patternCount: parsed.data.patterns.length },
        'diff-stats exclude patterns updated',
      );
      return reply.code(200).send({ fullName: row.fullName, patterns: parsed.data.patterns });
    },
  );

  // Recount: zero commits.additions/deletions/files_changed + clear
  // diff_stats_synced_at on every commit for the repo, AND zero
  // commit_daily.additions/deletions so the dashboard shows
  // clearly-wrong (zero) rather than subtly-wrong (mixed) during the
  // drain. The existing diff-stats backfill ticks re-fetch /diffstat
  // for every cleared commit using the current exclude-pattern list,
  // and the rollup hook refills commit_daily as each repo drains.
  //
  // Cost: 1 BB call per commit, paced by the existing budget gates.
  // At the default 100-per-repo-per-tick cap, a 3,700-commit repo
  // drains in ~37 ticks (~3 hours at 5-min cron cadence).
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/diff-stats/reset',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      const { resetCount } = await opts.syncDeps.commitStore.resetDiffStatsForRepo(row.id);
      opts.syncDeps.logger?.info?.(
        { fullName: row.fullName, resetCount, patternCount: row.diffStatsExcludePatterns.length },
        'diff-stats reset — re-armed for backfill',
      );
      return reply.code(200).send({ fullName: row.fullName, resetCount });
    },
  );

  // One-shot retroactive email backfill. The live ingest path
  // (commits.ts + deepen-backfill.ts) captures author-raw emails on
  // every new commit, but rows that predate the `users.email` column
  // stay NULL until that user's next commit lands. For inactive
  // contributors (left the org, on vacation, between projects) that
  // could be never — this endpoint fills the backlog in one shot.
  //
  // Strategy: per user-with-NULL-email, find their most recent
  // ingested commit's (workspace, slug, sha), hit BB's commits API
  // anchored at that sha via `include=<sha>` (the first yielded item
  // IS the sha itself), parse `<email>` out of `author.raw`, write
  // via setUserEmailsIfMissing. One BB call per user — bounded by
  // the cap below.
  //
  // Cap exists to prevent surprise BB-budget burn if the call lands
  // against a workspace with thousands of inactive users. With "few
  // users" being the expected case, the default 500 is well above
  // any realistic batch size; the operator can pass a query param to
  // raise it consciously.
  //
  // Per-user failures are isolated (try/catch around each user's
  // fetch) — one BB hiccup doesn't poison the whole pass; the
  // affected user simply rolls over to a future run.
  const DEFAULT_BACKFILL_LIMIT = 500;
  app.post<{ Querystring: { limit?: string } }>('/users/backfill-emails', async (request, reply) => {
    const parsed = z.coerce
      .number()
      .int()
      .positive()
      .max(2000)
      .safeParse(request.query.limit ?? DEFAULT_BACKFILL_LIMIT);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_limit', max: 2000 });
    }
    const limit = parsed.data;
    const seed = await opts.syncDeps.commitStore.listUsersMissingEmailWithLastCommit(limit);

    const entries: Array<{ bitbucketUuid: string; email: string }> = [];
    let attempted = 0;
    let fetched = 0;
    let skippedNoParseableEmail = 0;
    let fetchFailed = 0;

    for (const u of seed) {
      attempted++;
      try {
        // paginateCommits with include=<sha> yields the requested sha as
        // its first item. Break after one — we don't care about ancestors.
        let raw: string | null = null;
        for await (const commit of paginateCommits(opts.syncDeps.client, u.workspace, u.slug, {
          include: u.sha,
        })) {
          raw = commit.author.raw;
          break;
        }
        if (raw === null) {
          fetchFailed++;
          continue;
        }
        fetched++;
        const email = parseAuthorEmail(raw);
        if (email === null) {
          skippedNoParseableEmail++;
          continue;
        }
        entries.push({ bitbucketUuid: u.bitbucketUuid, email });
      } catch (err) {
        // Don't poison the batch — log + move on. Common cause: BB
        // 404 on a sha whose repo got renamed/recreated upstream.
        fetchFailed++;
        opts.syncDeps.logger?.warn?.(
          { workspace: u.workspace, slug: u.slug, sha: u.sha, userId: u.userId, err },
          'email backfill: per-user fetch failed',
        );
      }
    }

    if (entries.length > 0) {
      await opts.syncDeps.commitStore.setUserEmailsIfMissing(entries);
    }

    opts.syncDeps.logger?.info?.(
      { attempted, fetched, written: entries.length, skippedNoParseableEmail, fetchFailed, limit },
      'email backfill complete',
    );

    return {
      attempted,
      fetched,
      written: entries.length,
      skippedNoParseableEmail,
      fetchFailed,
    };
  });

  // Per-user retroactive reattribution of anonymous commits.
  //
  // Why this exists: when a commit is first ingested, we resolve the
  // author via BB's `author.user.uuid` and write `author_user_id`. If
  // the commit was authored from an email BB hadn't yet linked to a
  // workspace member, `author.user` is absent on ingest and we store
  // NULL. Adding that email to a workspace member LATER makes BB
  // attribute the same commit on future reads — but our row stays
  // anonymous until something re-fetches it. The in-place fix in
  // insertCommits handles re-attribution on cold-mode re-sync; this
  // endpoint backfills the long tail (commits older than the
  // cold-mode cap, or rows where the operator doesn't want to wait
  // for `/include` + a runner tick).
  //
  // Strategy: walk anonymous commits in our DB (newest first, bounded
  // by `limit`), hit BB `paginateCommits include=<sha>` to read the
  // current `author.user.uuid`, bulk-UPDATE the matches into the
  // target user, recompute `commit_daily` for affected days, invalidate
  // the user's summary cache. Cost is one BB call per anonymous
  // commit walked, no `/diffstat` calls (UPDATE only touches
  // `author_user_id`).
  //
  // Idempotent: re-calling with the same uuid converges (matches that
  // already updated drop out of the candidate list on the next pass).
  // Race-safe: the UPDATE is guarded by `author_user_id IS NULL`, so a
  // concurrent commit-sync landing the same row first wins and we
  // no-op.
  //
  // Optional `workspace` + `slug` scope the walk to one repo. Both or
  // neither — partial scope is a 400.
  const DEFAULT_REATTRIBUTE_LIMIT = 200;
  const MAX_REATTRIBUTE_LIMIT = 2000;
  const uuidPattern = /^\{[0-9a-fA-F-]{36}\}$/;
  app.post<{
    Params: { uuid: string };
    Querystring: { limit?: string; workspace?: string; slug?: string };
  }>('/users/:uuid/reattribute-anonymous', async (request, reply) => {
    const { uuid } = request.params;
    if (!uuidPattern.test(uuid)) {
      return reply.code(400).send({ error: 'invalid_uuid', expected: '{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}' });
    }

    const userMap = await opts.syncDeps.commitStore.resolveUserIdsByUuid([uuid]);
    const userId = userMap.get(uuid);
    if (userId === undefined) {
      return reply.code(404).send({
        error: 'user_not_in_workspace',
        uuid,
        hint: 'Run the workspace member sync first so this UUID lands in the users table.',
      });
    }

    const limitParsed = z.coerce
      .number()
      .int()
      .positive()
      .max(MAX_REATTRIBUTE_LIMIT)
      .safeParse(request.query.limit ?? DEFAULT_REATTRIBUTE_LIMIT);
    if (!limitParsed.success) {
      return reply.code(400).send({ error: 'invalid_limit', max: MAX_REATTRIBUTE_LIMIT });
    }
    const limit = limitParsed.data;

    const { workspace, slug } = request.query;
    if ((workspace === undefined) !== (slug === undefined)) {
      return reply.code(400).send({
        error: 'partial_repo_scope',
        message: 'workspace and slug must both be present or both omitted.',
      });
    }

    const candidates = await opts.syncDeps.commitStore.listAnonymousCommits({
      ...(workspace !== undefined && slug !== undefined ? { workspace, slug } : {}),
      limit,
    });

    // Walk each candidate, hitting BB's commits endpoint anchored at
    // the sha. paginateCommits with `include=<sha>` yields the
    // requested sha as the FIRST item — we break after one. A per-
    // commit try/catch isolates failures so one BB hiccup (404 from a
    // recreated repo, transient 5xx) doesn't poison the whole batch.
    const matches: Array<{ commitId: number; userId: number }> = [];
    let walked = 0;
    let bbMatched = 0;
    let bbDifferentUser = 0;
    let bbStillAnonymous = 0;
    let bbFailed = 0;

    for (const c of candidates) {
      walked++;
      try {
        let bbUuid: string | undefined;
        for await (const commit of paginateCommits(opts.syncDeps.client, c.workspace, c.slug, { include: c.sha })) {
          bbUuid = commit.author.user?.uuid;
          break;
        }
        if (bbUuid === undefined) {
          bbStillAnonymous++;
          continue;
        }
        if (bbUuid !== uuid) {
          bbDifferentUser++;
          continue;
        }
        bbMatched++;
        matches.push({ commitId: c.commitId, userId });
      } catch (err) {
        bbFailed++;
        opts.syncDeps.logger?.warn?.(
          {
            fullName: c.fullName,
            sha: c.sha,
            err: err instanceof Error ? err.message : String(err),
          },
          'reattribute: BB fetch failed',
        );
      }
    }

    const updatedRows = matches.length > 0 ? await opts.syncDeps.commitStore.reattributeAnonymousCommits(matches) : [];

    // Group affected rows by repo + compute UTC day ranges so the
    // rollup hook recomputes only what changed. `recomputeCommitDailyForRepo`
    // is authoritative-for-the-window post-fix (DELETE + INSERT), so the
    // stale (day, repo, NULL) rows disappear and the new (day, repo,
    // user) rows take their place in one shot.
    const rangeByRepo = new Map<number, { sinceMs: number; untilMs: number }>();
    for (const row of updatedRows) {
      const t = row.authoredAt.getTime();
      const existing = rangeByRepo.get(row.repositoryId);
      if (existing === undefined) {
        rangeByRepo.set(row.repositoryId, { sinceMs: t, untilMs: t });
      } else {
        if (t < existing.sinceMs) existing.sinceMs = t;
        if (t > existing.untilMs) existing.untilMs = t;
      }
    }
    if (opts.syncDeps.rollupStore !== undefined && rangeByRepo.size > 0) {
      for (const [repositoryId, range] of rangeByRepo) {
        const sinceDay = new Date(range.sinceMs).toISOString().slice(0, 10);
        const untilDay = new Date(range.untilMs).toISOString().slice(0, 10);
        try {
          await opts.syncDeps.rollupStore.recomputeCommitDailyForRepo(repositoryId, { sinceDay, untilDay });
        } catch (err) {
          opts.syncDeps.logger?.warn?.(
            {
              repositoryId,
              sinceDay,
              untilDay,
              err: err instanceof Error ? err.message : String(err),
            },
            'reattribute: rollup recompute failed — commits already updated; will recover on next sync',
          );
        }
      }
    }

    if (opts.syncDeps.userSummaryCache !== undefined && updatedRows.length > 0) {
      try {
        await opts.syncDeps.userSummaryCache.invalidate(userId);
      } catch (err) {
        opts.syncDeps.logger?.warn?.(
          { userId, err: err instanceof Error ? err.message : String(err) },
          'reattribute: user-summary cache invalidation failed — will fall out via TTL',
        );
      }
    }

    // `hasMore=true` whenever we filled the limit; operator should
    // re-call to drain the tail. Conservative — if the limit was
    // exactly the remaining count, the next call returns 0 candidates
    // and is a cheap no-op.
    const hasMore = walked === limit;

    opts.syncDeps.logger?.info?.(
      {
        uuid,
        userId,
        ...(workspace !== undefined && slug !== undefined ? { scope: `${workspace}/${slug}` } : { scope: 'all-repos' }),
        walked,
        bbMatched,
        bbDifferentUser,
        bbStillAnonymous,
        bbFailed,
        updated: updatedRows.length,
        affectedRepos: rangeByRepo.size,
        hasMore,
      },
      'reattribute-anonymous complete',
    );

    return reply.code(200).send({
      uuid,
      userId,
      walked,
      bbMatched,
      bbDifferentUser,
      bbStillAnonymous,
      bbFailed,
      updated: updatedRows.length,
      affectedRepos: rangeByRepo.size,
      hasMore,
    });
  });
};
