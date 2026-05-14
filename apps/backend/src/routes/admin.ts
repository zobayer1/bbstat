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
import { syncRepositoryCommits } from '../sync/commits.js';
import { deepenOneRepo } from '../sync/deepen-backfill.js';
import { addTrackedRepository } from '../sync/discovery.js';
import { syncRepositoryPullRequests } from '../sync/pull-requests.js';
import { runCommitsSync, runDiscoverySync, runPullRequestsSync } from './../sync/runner.js';
import type { RepositoryHandle } from '../sync/commits.js';
import type { PrSyncOptions } from '../sync/pull-requests.js';
import type { SyncRunnerDeps } from '../sync/runner.js';

export interface AdminRouteOptions {
  syncDeps: SyncRunnerDeps;
}

const addRepositoryBody = z.object({
  workspace: z.string().min(1),
  slug: z.string().min(1),
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
      };
      return await syncRepositoryCommits(
        {
          client: opts.syncDeps.client,
          store: opts.syncDeps.commitStore,
          logger: opts.syncDeps.logger,
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
};
