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
import { syncRepositoryCommits } from '../sync/commits.js';
import { addTrackedRepository } from '../sync/discovery.js';
import { runCommitsSync, runDiscoverySync } from './../sync/runner.js';
import type { RepositoryHandle } from '../sync/commits.js';
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
};
