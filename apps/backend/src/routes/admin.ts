// Admin endpoints — manual sync triggers and curated-repo management.
//
// No auth by design (CLAUDE.md "Authentication"). When BB OAuth + RBAC lands,
// this is the seam: wrap handlers with a preHandler checking the admin role.
// Read-only Bitbucket scopes are a backstop — nothing here can write to BB.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { paginateCommits } from '../bitbucket/commits.js';
import { parseAuthorEmail } from '../sync/author-email.js';
import { BitbucketApiError } from '../bitbucket/errors.js';
import { validatePatterns } from '../bitbucket/diff-stats-filter.js';
import { syncRepositoryCommits } from '../sync/commits.js';
import { reconcileHistoryRewrite } from '../sync/reconcile.js';
import { runEmptyRevivalTick } from '../sync/empty-revival.js';
import { runRepoDiscoverySweep } from '../sync/repo-discovery.js';
import { deepenOneRepo } from '../sync/deepen-backfill.js';
import { addTrackedRepository } from '../sync/discovery.js';
import { syncRepositoryPullRequests } from '../sync/pull-requests.js';
import { runCommitsSync, runDiscoverySync, runPullRequestsSync } from './../sync/runner.js';
import {
  PersonNotFoundError,
  UserAlreadyAttachedError,
  UserNotAttachedToPersonError,
  UserNotFoundError,
} from '../people/errors.js';
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

  // Re-probes empty-on-bitbucket excluded (non-archived) repos and clears the
  // exclusion for any that now have commits. Same step the commit-sync tick runs.
  app.post('/sync/revive-empty', async () => {
    return runEmptyRevivalTick(
      {
        client: opts.syncDeps.client,
        discoveryStore: opts.syncDeps.store,
        commitStore: opts.syncDeps.commitStore,
        logger: opts.syncDeps.logger,
        ...(opts.syncDeps.bus ? { bus: opts.syncDeps.bus } : {}),
      },
      opts.syncDeps.emptyRevivalOptions ?? { maxReposPerTick: 25, budgetThreshold: 100 },
    );
  });

  // Workspace-repo discovery sweep. DRY-RUN by default (lists what it WOULD add
  // without inserting or advancing the Redis cursor); `?dryRun=false` applies.
  // Works regardless of REPO_DISCOVERY_ENABLED, so an operator can preview first.
  app.post<{ Querystring: { dryRun?: string } }>('/sync/discover-repos', async (request, reply) => {
    if (opts.syncDeps.cache === undefined) {
      return reply.code(503).send({ error: 'cache_not_wired' });
    }
    const dryRun = request.query.dryRun !== 'false' && request.query.dryRun !== '0';
    const base = opts.syncDeps.repoDiscoveryOptions ?? { maxReposPerSweep: 100, budgetThreshold: 100 };
    return runRepoDiscoverySweep(
      {
        client: opts.syncDeps.client,
        cache: opts.syncDeps.cache,
        store: opts.syncDeps.store,
        workspace: opts.syncDeps.workspace,
        logger: opts.syncDeps.logger,
      },
      { ...base, dryRun },
    );
  });

  app.post('/sync/pullrequests', async () => {
    return runPullRequestsSync(opts.syncDeps, 'manual');
  });

  // ShipShow Score rollup (docs/scoring.md). Runs both passes — per-alias
  // `user_score` and per-person `person_score`. Already fired at the end of
  // every commits-sync tick; this endpoint is for backfills after threshold tuning.
  app.post('/scores/recompute', async (_request, reply) => {
    if (opts.syncDeps.recomputeAllScores === undefined) {
      return reply.code(503).send({ error: 'score_rollup_not_wired' });
    }
    return opts.syncDeps.recomputeAllScores();
  });

  // Force a fresh delta pull for a single tracked repo. Idempotent —
  // duplicate shas are deduped by the commits_sha_repo_unique constraint.
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
      // Strip tick-level concurrency/budget knobs to the per-repo subset.
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

  // Force one immediate page of historical backfill for a repo. The deepen
  // worker picks its own next page based on `commits.authored_at ASC`.
  app.post<{ Params: { workspace: string; slug: string } }>(
    '/sync/repositories/:workspace/:slug/deepen',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) {
        return reply.code(404).send({ error: 'not_tracked', fullName });
      }
      // Manual triggers don't bypass the budget gate — checked inline here
      // (the tick path checks before each iteration).
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

  // Soft-retire: historical data stays; the row drops out of
  // `listTrackedRepositories` so sync ticks skip it. Idempotent.
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

  // Reverse of archive. Idempotent.
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

  // Recover from an auto-trip exclusion. Clears the exclusion AND resets
  // commit-sync cursors to cold-mode defaults — the load-bearing bit: for a
  // `history-rewritten` row the stored `last_seen_sha` is invalid and a delta
  // walk would just re-trip detection. For `empty-on-bitbucket` rows the reset
  // also flips `deepen_complete = false`. Idempotent.
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

  // Rename. Re-fetches BB to confirm the bitbucket_uuid still matches our row
  // (same repo, just renamed). UUID mismatch is fatal — merging two repos'
  // histories would silently corrupt data. On success: ws/slug/full_name/project
  // update, exclusion clears, cursors reset.
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

      // Capture before the mutating update — some store impls return a
      // live reference whose `fullName` the rename rewrites in place.
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

  // Surgical recovery for a repo auto-excluded 'history-rewritten' (force-push
  // rewrote the cursor commit). Unlike `include` (cold re-walks the WHOLE repo),
  // this diffs BB's head against our recent history, deletes only orphaned
  // commits, re-anchors the cursor to the common ancestor, and delta-syncs the
  // rest — minimizing BB calls. Algorithm lives in src/sync/reconcile.ts.
  // DRY-RUN by default; `?dryRun=false` applies. 409 unless history-rewritten.
  app.post<{ Params: { workspace: string; slug: string }; Querystring: { dryRun?: string } }>(
    '/repositories/:workspace/:slug/reconcile',
    async (request, reply) => {
      const { workspace, slug } = request.params;
      const fullName = `${workspace}/${slug}`;
      const row = await opts.syncDeps.store.findRepositoryByFullName(fullName);
      if (row === null) return reply.code(404).send({ error: 'not_tracked', fullName });
      if (!row.syncExcluded || row.syncExcludeReason !== 'history-rewritten') {
        return reply.code(409).send({
          error: 'not_history_rewritten',
          message: 'Reconcile only applies to repos auto-excluded with reason "history-rewritten".',
          syncExcluded: row.syncExcluded,
          syncExcludeReason: row.syncExcludeReason,
        });
      }
      // Mutate only on explicit dry-run opt-out, so an accidental call previews.
      const dryRun = request.query.dryRun !== 'false' && request.query.dryRun !== '0';
      const handle: RepositoryHandle = {
        repositoryId: row.id,
        workspace: row.workspace,
        slug: row.slug,
        fullName: row.fullName,
        diffStatsExcludePatterns: row.diffStatsExcludePatterns,
      };
      const outcome = await reconcileHistoryRewrite(
        {
          client: opts.syncDeps.client,
          commitStore: opts.syncDeps.commitStore,
          discoveryStore: opts.syncDeps.store,
          logger: opts.syncDeps.logger,
          ...(opts.syncDeps.rollupStore ? { rollupStore: opts.syncDeps.rollupStore } : {}),
          ...(opts.syncDeps.recomputeAllScores ? { recomputeAllScores: opts.syncDeps.recomputeAllScores } : {}),
          ...(opts.syncDeps.bus ? { bus: opts.syncDeps.bus } : {}),
        },
        handle,
        {
          dryRun,
          ...(opts.syncDeps.commitTickOptions ? { commitSyncOptions: opts.syncDeps.commitTickOptions } : {}),
        },
      );
      if (outcome.kind === 'no-common-ancestor') {
        return reply.code(422).send({
          error: 'no_common_ancestor',
          walked: outcome.walked,
          message:
            'BitBucket head shares no commit with our recent history within the search window; the rewrite is too deep for surgical reconcile. Use DELETE + re-add to rebuild from scratch.',
        });
      }
      return reply.code(200).send(outcome);
    },
  );

  // Hard delete. Cascades via FKs to commits, sync_state, branches,
  // pull_requests. Idempotent on a missing row (404 → no-op).
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

  // One-shot retroactive `is_merge` backfill for commits ingested before
  // migration 0006 (DEFAULT false). Walks /commits, reads parents.length > 1,
  // bulk-UPDATEs is_merge by sha; touches no other column. Idempotent.
  // Cost: ~1 BB call per 100 commits of history.
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
        // Iterator doesn't surface page boundaries; derive pages for the log line.
        if (entries.length % 100 === 0) pages = Math.ceil(entries.length / 100);
      }
      pages = Math.ceil(entries.length / 100);

      const { updated } = await opts.syncDeps.commitStore.updateIsMergeBatch(row.id, entries);
      opts.syncDeps.logger?.info?.({ fullName, walked: entries.length, pages, updated }, 'is_merge backfill complete');
      return reply.code(200).send({ fullName, walked: entries.length, pages, updated });
    },
  );

  // Read the per-repo diff-stat exclude pattern list.
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

  // Replace (not merge) the diff-stat exclude pattern list; entries validated
  // as parseable picomatch globs. Does NOT touch commit data — the operator
  // runs POST .../reset separately, so they can iterate on patterns cheaply.
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

  // Zero commit + commit_daily diff-stats and clear diff_stats_synced_at so the
  // dashboard shows clearly-wrong (zero) rather than subtly-wrong (mixed) during
  // the drain. The backfill ticks re-fetch /diffstat per cleared commit using the
  // current exclude patterns. Cost: 1 BB call per commit, paced by the budget gates.
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

  // One-shot retroactive email backfill for users whose rows predate the
  // `users.email` column (NULL until their next commit lands — possibly never,
  // for inactive contributors). Per user: anchor BB's commits API at their most
  // recent ingested sha via `include=<sha>` (first yielded item IS the sha),
  // parse `<email>` from `author.raw`. One BB call per user, capped to bound
  // budget burn. Per-user failures are isolated — they roll over to a future run.
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
        // include=<sha> yields the sha first; break after one (ignore ancestors).
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
        // Isolate per-user failures (common: BB 404 on a renamed/recreated repo).
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

  // One-shot SQL backfill of commits.author_email + author_display_name for rows
  // predating the V1_16 migration. Pulls from the linked users row — no BB calls.
  // Only fills NULL snapshot columns (COALESCE), never overwrites; skips anonymous
  // rows (those need the BB-walk path). Idempotent — the WHERE excludes populated rows.
  app.post('/commits/backfill-author-snapshots', async () => {
    const { updated } = await opts.syncDeps.commitStore.backfillAuthorSnapshotsFromUsers();
    opts.syncDeps.logger?.info?.({ updated }, 'commits author-snapshot backfill complete');
    return { updated };
  });

  // Per-user retroactive reattribution of anonymous commits.
  //
  // A commit ingested before BB linked its author email to a workspace member is
  // stored with author_user_id NULL. Linking the email LATER makes BB attribute
  // the commit on future reads, but our row stays anonymous until re-fetched.
  // insertCommits fixes this on cold-mode re-sync; this endpoint backfills the
  // long tail (older than the cold-mode cap, or when waiting isn't acceptable).
  //
  // Walks anonymous commits (newest first, bounded by `limit`), reads current
  // `author.user.uuid` via `include=<sha>`, bulk-UPDATEs matches into the target
  // user, recomputes `commit_daily`, invalidates the summary cache. One BB call
  // per commit, no /diffstat (UPDATE only touches author_user_id).
  // Idempotent — re-calling converges. Race-safe: the UPDATE is guarded by
  // `author_user_id IS NULL`, so a concurrent commit-sync wins and we no-op.
  // Optional `workspace` + `slug` scope the walk; both or neither (partial = 400).
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

    // include=<sha> yields the sha first; break after one. Per-commit try/catch
    // isolates failures (404 from a recreated repo, transient 5xx).
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

    // Group by repo + UTC day range so the rollup recomputes only what changed.
    // recomputeCommitDailyForRepo is authoritative-for-the-window (DELETE + INSERT),
    // so stale (day, repo, NULL) rows give way to (day, repo, user) in one shot.
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

    // hasMore when we filled the limit; operator re-calls to drain the tail.
    // Conservative — an exact-fit limit makes the next call a cheap no-op.
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

  // Person layer (alias merge): operator-curated CRUD merging multiple BB user
  // rows into one canonical person. Every mutation goes through PeopleStore
  // (transactional) and is followed by: (a) a person_score recompute so the
  // leaderboard reflects the merge; (b) Redis user-summary invalidation for every
  // affected alias; (c) an SSE event so open tabs refresh. setPrimary is a UI-only
  // flag swap (no attribution change) so it skips (a). All paths emit (c).
  // When peopleStore is undefined (test scaffolding) every endpoint 503s.

  const createPersonBody = z.object({
    displayName: z.string().min(1).nullable().optional(),
    primaryUserId: z.number().int().positive().optional(),
  });
  const updatePersonBody = z.object({
    displayName: z.string().min(1).nullable(),
  });
  const attachBody = z.object({
    userId: z.number().int().positive(),
    makePrimary: z.boolean().optional(),
  });
  const detachBody = z.object({
    userId: z.number().int().positive(),
  });
  const setPrimaryBody = z.object({
    userId: z.number().int().positive(),
  });

  // Cache-only invalidation (no score recompute) — used when a mutation changes
  // a cached summary but NOT commit attribution (rename, primary swap).
  async function invalidateUserSummaries(userIds: ReadonlyArray<number>): Promise<void> {
    if (opts.syncDeps.userSummaryCache === undefined) return;
    await Promise.all(userIds.map((id) => opts.syncDeps.userSummaryCache!.invalidate(id)));
  }

  // Every alias attached to a person. A person-layer mutation shifts the cached
  // summary of ALL of them (siblings' linkedAccounts, embedded displayName,
  // isPrimary flag), so the whole roster must be busted. [] if the person is gone.
  async function rosterUserIds(personId: number): Promise<number[]> {
    if (opts.syncDeps.peopleStore === undefined) return [];
    const person = await opts.syncDeps.peopleStore.get(personId);
    return person?.attachedUsers.map((u) => u.id) ?? [];
  }

  // Refresh after mutations that change commit attribution (create-with-primary /
  // attach / detach / dissolve): recompute scores + invalidate affected summaries.
  // Errors surface to the caller — the mutation already committed, so a recompute
  // failure is informational; the next sync tick redoes it.
  async function refreshAfterPersonMutation(affectedUserIds: ReadonlyArray<number>): Promise<void> {
    if (opts.syncDeps.recomputeAllScores !== undefined) {
      await opts.syncDeps.recomputeAllScores();
    }
    await invalidateUserSummaries(affectedUserIds);
  }

  app.post('/people', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const body = createPersonBody.parse(request.body);
    try {
      const person = await opts.syncDeps.peopleStore.create({
        displayName: body.displayName ?? null,
        primaryUserId: body.primaryUserId ?? null,
      });
      if (body.primaryUserId !== undefined) {
        await refreshAfterPersonMutation([body.primaryUserId]);
      }
      opts.syncDeps.bus?.publish({
        event: 'person.created',
        payload: { personId: person.id, primaryUserId: body.primaryUserId ?? null },
      });
      if (body.primaryUserId !== undefined) {
        opts.syncDeps.bus?.publish({
          event: 'person.attached',
          payload: { personId: person.id, userId: body.primaryUserId, becamePrimary: true },
        });
      }
      return reply.code(201).send(person);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return reply.code(404).send({ error: 'user_not_found', userId: err.userId });
      }
      if (err instanceof UserAlreadyAttachedError) {
        return reply
          .code(409)
          .send({ error: 'user_already_attached', userId: err.userId, currentPersonId: err.currentPersonId });
      }
      throw err;
    }
  });

  app.get('/people', async (_request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    return await opts.syncDeps.peopleStore.list();
  });

  app.get<{ Params: { id: string } }>('/people/:id', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    const person = await opts.syncDeps.peopleStore.get(id);
    if (person === null) {
      return reply.code(404).send({ error: 'person_not_found', personId: id });
    }
    return person;
  });

  app.patch<{ Params: { id: string } }>('/people/:id', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    const body = updatePersonBody.parse(request.body);
    try {
      const person = await opts.syncDeps.peopleStore.updateDisplayName(id, body.displayName);
      // Rename doesn't touch attribution (no recompute), but the new name is
      // embedded in every attached alias's cached summary — bust the roster.
      await invalidateUserSummaries(person.attachedUsers.map((u) => u.id));
      opts.syncDeps.bus?.publish({ event: 'person.updated', payload: { personId: id } });
      return person;
    } catch (err) {
      if (err instanceof PersonNotFoundError) {
        return reply.code(404).send({ error: 'person_not_found', personId: id });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/people/:id/attach', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    const body = attachBody.parse(request.body);
    try {
      const result = await opts.syncDeps.peopleStore.attach(id, body.userId, {
        ...(body.makePrimary !== undefined ? { makePrimary: body.makePrimary } : {}),
      });
      // Bust the post-attach roster: the new alias plus every sibling whose
      // `linkedAccounts` grew.
      await refreshAfterPersonMutation([...new Set([...(await rosterUserIds(id)), body.userId])]);
      opts.syncDeps.bus?.publish({
        event: 'person.attached',
        payload: { personId: id, userId: body.userId, becamePrimary: result.becamePrimary },
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof PersonNotFoundError) {
        return reply.code(404).send({ error: 'person_not_found', personId: id });
      }
      if (err instanceof UserNotFoundError) {
        return reply.code(404).send({ error: 'user_not_found', userId: err.userId });
      }
      if (err instanceof UserAlreadyAttachedError) {
        return reply
          .code(409)
          .send({ error: 'user_already_attached', userId: err.userId, currentPersonId: err.currentPersonId });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/people/:id/detach', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    const body = detachBody.parse(request.body);
    try {
      const result = await opts.syncDeps.peopleStore.detach(id, body.userId);
      // Bust both the now-unattached user and the post-detach roster (every
      // remaining alias's `linkedAccounts` shrank).
      await refreshAfterPersonMutation([...new Set([...(await rosterUserIds(id)), body.userId])]);
      opts.syncDeps.bus?.publish({
        event: 'person.detached',
        payload: { personId: id, userId: body.userId, wasPrimary: result.wasPrimary },
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return reply.code(404).send({ error: 'user_not_found', userId: err.userId });
      }
      if (err instanceof UserNotAttachedToPersonError) {
        return reply.code(400).send({
          error: 'user_not_attached_to_person',
          userId: err.userId,
          expectedPersonId: err.personId,
          actualPersonId: err.actualPersonId,
        });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/people/:id/primary', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    const body = setPrimaryBody.parse(request.body);
    try {
      const result = await opts.syncDeps.peopleStore.setPrimary(id, body.userId);
      // No attribution change (skip recompute), but moving the `isPrimary` flag
      // and the display-name fallback shifts every alias's summary — bust the roster.
      await invalidateUserSummaries(await rosterUserIds(id));
      opts.syncDeps.bus?.publish({
        event: 'person.primary-changed',
        payload: {
          personId: id,
          previousPrimaryUserId: result.previousPrimaryUserId,
          newPrimaryUserId: body.userId,
        },
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return reply.code(404).send({ error: 'user_not_found', userId: err.userId });
      }
      if (err instanceof UserNotAttachedToPersonError) {
        return reply.code(400).send({
          error: 'user_not_attached_to_person',
          userId: err.userId,
          expectedPersonId: err.personId,
          actualPersonId: err.actualPersonId,
        });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/people/:id', async (request, reply) => {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_person_id' });
    }
    try {
      const result = await opts.syncDeps.peopleStore.dissolve(id);
      await refreshAfterPersonMutation(result.detachedUserIds);
      opts.syncDeps.bus?.publish({
        event: 'person.dissolved',
        payload: { personId: id, detachedUserIds: result.detachedUserIds },
      });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof PersonNotFoundError) {
        return reply.code(404).send({ error: 'person_not_found', personId: id });
      }
      throw err;
    }
  });

  // POST /users/:id/override {status} and /override/clear — operator override of
  // a user's membershipStatus. Forces 'member' | 'departed' | 'external' (or
  // clears back to auto). The escape hatch for cases no heuristic can resolve: a
  // departed ex-employee whose org email reads as 'member' (→ force 'departed'),
  // or a colleague on a personal email that reads as 'external' (→ force
  // 'member'). Distinct from a people-merge: no person is created; the standalone
  // user row is just flagged. See users.membership_override.
  async function applyMembershipOverride(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    override: 'member' | 'departed' | 'external' | null,
  ): Promise<FastifyReply> {
    if (opts.syncDeps.peopleStore === undefined) {
      return reply.code(503).send({ error: 'people_store_not_wired' });
    }
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid_user_id' });
    }
    try {
      const result = await opts.syncDeps.peopleStore.setMembershipOverride(id, override);
      // Membership feeds the /users/:id summary; refresh its cache so the change
      // shows immediately. The Members list + leaderboards read Postgres live.
      await invalidateUserSummaries([id]);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        return reply.code(404).send({ error: 'user_not_found', userId: id });
      }
      throw err;
    }
  }

  const membershipOverrideBody = z.object({ status: z.enum(['member', 'departed', 'external']) });

  app.post<{ Params: { id: string } }>('/users/:id/override', (request, reply) => {
    const parsed = membershipOverrideBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_status', allowed: ['member', 'departed', 'external'] });
    }
    return applyMembershipOverride(request, reply, parsed.data.status);
  });
  app.post<{ Params: { id: string } }>('/users/:id/override/clear', (request, reply) =>
    applyMembershipOverride(request, reply, null),
  );
};
