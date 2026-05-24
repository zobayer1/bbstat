import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { StatsStore, UserSummary } from '../dashboard/stats-store.js';
import { createNoopUserSummaryCache, type UserSummaryCache } from '../dashboard/user-summary-cache.js';

export interface StatsRouteOptions {
  statsStore: StatsStore;
  // Optional. When wired (production), GET /users/:id/summary hits Redis
  // first and writes through on miss. When absent (tests that don't care
  // about caching), the route reads/writes against an internal noop cache
  // so the handler body stays uniform.
  userSummaryCache?: UserSummaryCache<UserSummary>;
}

const windowSchema = z.enum(['7d', '30d']).default('7d');
const userIdSchema = z.coerce.number().int().positive();

export const statsRoutes: FastifyPluginAsync<StatsRouteOptions> = async (app, opts) => {
  const userSummaryCache = opts.userSummaryCache ?? createNoopUserSummaryCache<UserSummary>();

  app.get('/overview', async () => {
    return opts.statsStore.getOverview();
  });

  app.get<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/latest-commit',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const commit = await opts.statsStore.getLatestCommitForRepository(workspace, slug);
      if (commit === null) return reply.code(404).send({ error: 'not_found', fullName: `${workspace}/${slug}` });
      return commit;
    },
  );

  // Members route — no window parameter. Every row carries both 7d
  // and 30d aggregates (commits + distinct repos) plus all-time
  // totals, so the table can render `{commits} ({repos})` per
  // window without a query-string toggle. Any ?window= the client
  // sends is ignored.
  app.get('/members', async () => {
    return opts.statsStore.listWorkspaceMembers();
  });

  app.get<{ Querystring: { window?: string } }>('/top-contributors', async (request, reply) => {
    const parsed = windowSchema.safeParse(request.query.window ?? '7d');
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_window', allowed: ['7d', '30d'] });
    }
    const days = parsed.data === '7d' ? 7 : 30;
    return opts.statsStore.getTopContributors(days);
  });

  // Read-through cache: Redis first; on miss, fetch from store and write back.
  // The sync hook (rollup-hook.ts) DELs this key the moment new commits land
  // for the user, so the 1h TTL is just a backstop for inactive users.
  app.get<{ Params: { userId: string } }>('/users/:userId/summary', async (request, reply) => {
    const parsed = userIdSchema.safeParse(request.params.userId);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }
    const userId = parsed.data;

    const cached = await userSummaryCache.get(userId);
    if (cached !== null) return cached;

    const summary = await opts.statsStore.getUserSummary(userId);
    if (summary === null) return reply.code(404).send({ error: 'not_found', userId });

    await userSummaryCache.set(userId, summary);
    return summary;
  });

  // Phase 5 — Person detail read. Not Redis-cached (yet): the three
  // aggregate pulls are cheap at the current scale and merges are rare,
  // so a read-through cache would add an invalidation surface (every
  // person.* admin mutation would need to DEL it) for little gain. If
  // person pages get hot, mirror the user-summary cache pattern here
  // and DEL from refreshAfterPersonMutation in routes/admin.ts.
  app.get<{ Params: { personId: string } }>('/people/:personId/summary', async (request, reply) => {
    const parsed = userIdSchema.safeParse(request.params.personId);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    const summary = await opts.statsStore.getPersonSummary(parsed.data);
    if (summary === null) return reply.code(404).send({ error: 'not_found', personId: parsed.data });
    return summary;
  });

  app.get<{ Params: { projectKey: string } }>('/projects/:projectKey', async (request, reply) => {
    const stats = await opts.statsStore.getProjectStats(request.params.projectKey);
    if (stats === null) return reply.code(404).send({ error: 'not_found', projectKey: request.params.projectKey });
    return stats;
  });

  app.get<{ Params: { workspace: string; slug: string } }>(
    '/repositories/:workspace/:slug/activity',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const activity = await opts.statsStore.getRepositoryActivity(workspace, slug);
      if (activity === null) return reply.code(404).send({ error: 'not_found', fullName: `${workspace}/${slug}` });
      return activity;
    },
  );

  app.get('/repositories', async () => {
    return opts.statsStore.listTrackedRepositoriesWithStats();
  });

  // Per-repo contributor breakdown feeding the Projects page sunburst.
  // Caps are server-side so a runaway client can't pull every (repo,
  // user) pair; defaults match what the chart renders cleanly. The
  // optional `project` filter scopes the breakdown to a single
  // project — used by the project-detail page to render the same
  // chart over just that project's repos.
  app.get<{
    Querystring: { windowDays?: string; topRepos?: string; topPerRepo?: string; project?: string };
  }>('/repo-contributors', async (request, reply) => {
    const parsed = repoContributorsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { windowDays, topRepos, topPerRepo, project } = parsed.data;
    return opts.statsStore.getRepoContributorBreakdown({
      windowDays,
      topRepos,
      topPerRepo,
      project: project ?? null,
    });
  });
};

const repoContributorsSchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  topRepos: z.coerce.number().int().min(1).max(50).default(15),
  topPerRepo: z.coerce.number().int().min(1).max(20).default(5),
  project: z.string().min(1).optional(),
});
