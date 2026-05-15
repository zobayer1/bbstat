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
        diffStatsEnabled: row.diffStatsEnabled,
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
        diffStatsEnabled: row.diffStatsEnabled,
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
};
