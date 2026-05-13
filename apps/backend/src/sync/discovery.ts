// Discovery: the slow-cadence sync work that establishes who and what we
// track. Workspace members go into `users`; the curated repo list (from
// the SEED_REPO_FILE_PATH YAML plus admin-added entries) goes into
// `repositories` + `sync_state`.
//
// All functions here are pure (relative to the injected `client` and
// `store`), so they're trivial to test without a database. Wiring into
// runSync() / cron / admin endpoints lives in Phase 1.3.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { BitbucketClient } from '../bitbucket/client.js';
import type { BitbucketLogger } from '../bitbucket/client.js';
import type { DiscoveryStore } from './discovery-store.js';
import { BitbucketApiError } from '../bitbucket/errors.js';

export interface DiscoveryDeps {
  client: BitbucketClient;
  store: DiscoveryStore;
  logger?: BitbucketLogger;
}

// ---------------------------------------------------------------------------
// Types of the BitBucket API responses we consume (only the fields we use)
// ---------------------------------------------------------------------------

interface WorkspaceMembership {
  user: {
    uuid: string;
    display_name: string;
    nickname?: string;
  };
}

interface RepositoryResponse {
  uuid: string;
  slug: string;
  full_name: string;
  workspace: { slug: string };
  project?: { key: string };
}

// ---------------------------------------------------------------------------
// Workspace members
// ---------------------------------------------------------------------------

export interface SyncMembersResult {
  total: number;
  inserted: number;
  updated: number;
}

export async function syncWorkspaceMembers(deps: DiscoveryDeps, workspace: string): Promise<SyncMembersResult> {
  const result: SyncMembersResult = { total: 0, inserted: 0, updated: 0 };

  for await (const membership of deps.client.paginate<WorkspaceMembership>(`/workspaces/${workspace}/members`, {
    fields: ['values.user.uuid', 'values.user.display_name', 'values.user.nickname'],
  })) {
    const upsert = await deps.store.upsertUser({
      bitbucketUuid: membership.user.uuid,
      displayName: membership.user.display_name,
      username: membership.user.nickname ?? null,
    });
    result.total++;
    if (upsert.inserted) result.inserted++;
    else result.updated++;
  }

  deps.logger?.info?.(
    { workspace, total: result.total, inserted: result.inserted, updated: result.updated },
    'workspace members sync complete',
  );
  return result;
}

// ---------------------------------------------------------------------------
// Tracked repositories (curated set)
// ---------------------------------------------------------------------------

export interface RepoSeed {
  workspace: string;
  slug: string;
  // Phase 4 T21: per-repo opt-in for /diffstat/:sha ingest. Plain-string
  // entries default to false. The object form `{ name: ws/slug, diffStats:
  // true }` flips it on. Hot-reloaded — toggling the flag in YAML re-applies
  // at the next runReposSync / runDiscoverySync tick.
  diffStatsEnabled: boolean;
}

// One entry in the seed file's `repos:` list. Accepts either a plain
// `<workspace>/<slug>` string (back-compat, diffStats=false) or an object
// `{ name: <workspace>/<slug>, diffStats?: boolean }`. Anything else fails
// the schema check and surfaces as a malformed-file error at parse time.
const seedEntrySchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    diffStats: z.boolean().optional().default(false),
  }),
]);

// Shape of the seed file: a top-level `repos:` list of either bare strings
// or `{ name, diffStats? }` objects. Wrapping in a key (vs. a bare top-level
// list) leaves room to grow the file with sibling sections later without a
// breaking format change.
const seedFileSchema = z.object({
  repos: z.array(seedEntrySchema),
});

// Parse the raw YAML text of a seed file into RepoSeed[]. Pure — no IO.
// Throws on shape mismatches or malformed entries so typos fail loud.
export function parseSeedRepoFile(text: string): RepoSeed[] {
  const raw: unknown = parseYaml(text);
  const parsed = seedFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Seed repo file is malformed: ${issues}`);
  }
  return parsed.data.repos
    .map((entry) => (typeof entry === 'string' ? { name: entry, diffStats: false } : entry))
    .map((entry) => ({ name: entry.name.trim(), diffStats: entry.diffStats }))
    .filter((entry) => entry.name.length > 0)
    .map((entry) => {
      const parts = entry.name.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Seed repo file entry must be "<workspace>/<slug>" — got "${entry.name}"`);
      }
      return { workspace: parts[0], slug: parts[1], diffStatsEnabled: entry.diffStats };
    });
}

// Load seeds from `filePath`. When `required` is true (env explicitly set),
// a missing file throws; otherwise (default path) missing is a no-op.
export function loadSeedTrackedRepos(filePath: string, options: { required: boolean }): RepoSeed[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' && !options.required) return [];
    throw new Error(`Seed repo file at ${filePath} could not be read: ${e.message}`);
  }
  return parseSeedRepoFile(text);
}

export interface AddTrackedRepoResult {
  fullName: string;
  status: 'inserted' | 'already-tracked' | 'not-found';
}

export interface AddTrackedRepoOptions {
  // Phase 4 T21: per-repo opt-in for /diffstat/:sha ingest. Defaults to
  // false. On insert, written to repositories.diff_stats_enabled. On
  // already-tracked, this method does NOT update the stored flag — the
  // bootstrap flow handles flip-flop reconciliation separately so the
  // single-repo admin endpoint behavior stays explicit.
  diffStatsEnabled?: boolean;
}

// Idempotent at two layers: the early `findRepositoryByFullName` short-circuit
// avoids a BB call when the input string already matches a tracked row, and
// the underlying insert uses ON CONFLICT on bitbucket_uuid so an alias of an
// existing repo (e.g. a YAML entry whose casing differs from the canonical
// slug, or a race between two concurrent triggers) resolves to the canonical
// row with `status: 'already-tracked'` instead of bubbling up a 23505.
//
// The returned `fullName` is always the canonical BitBucket-side full_name,
// not the caller's input — so logs and admin responses identify the repo
// consistently across alias retries.
export async function addTrackedRepository(
  deps: DiscoveryDeps,
  workspace: string,
  slug: string,
  opts: AddTrackedRepoOptions = {},
): Promise<AddTrackedRepoResult> {
  const inputFullName = `${workspace}/${slug}`;
  const diffStatsEnabled = opts.diffStatsEnabled ?? false;

  const existing = await deps.store.findRepositoryByFullName(inputFullName);
  if (existing !== null) return { fullName: existing.fullName, status: 'already-tracked' };

  let repo: RepositoryResponse;
  try {
    repo = await deps.client.get<RepositoryResponse>(`/repositories/${workspace}/${slug}`, {
      fields: ['uuid', 'slug', 'full_name', 'workspace.slug', 'project.key'],
    });
  } catch (err) {
    if (err instanceof BitbucketApiError && err.status === 404) {
      deps.logger?.warn?.({ fullName: inputFullName }, 'tracked-repo not found on BitBucket');
      return { fullName: inputFullName, status: 'not-found' };
    }
    throw err;
  }

  const { row, inserted } = await deps.store.insertRepositoryWithSyncState({
    bitbucketUuid: repo.uuid,
    workspace: repo.workspace.slug,
    project: repo.project?.key ?? null,
    slug: repo.slug,
    fullName: repo.full_name,
    diffStatsEnabled,
  });

  if (inserted) {
    deps.logger?.info?.({ fullName: row.fullName, diffStatsEnabled }, 'tracked-repo added');
    return { fullName: row.fullName, status: 'inserted' };
  }
  deps.logger?.info?.(
    { inputFullName, canonicalFullName: row.fullName },
    'tracked-repo already tracked (canonical uuid matched)',
  );
  return { fullName: row.fullName, status: 'already-tracked' };
}

export interface BootstrapReposResult {
  requested: number;
  inserted: number;
  alreadyTracked: number;
  notFound: string[];
  // Phase 4 T21: count of already-tracked repos whose diff-stats opt-in
  // diverged from the seed's value and was updated this run. Lets the
  // operator see when a YAML toggle actually flipped a stored row vs.
  // when it was already in sync.
  diffStatsToggled: number;
  // Per-seed failures collected during the loop. A single bad seed never
  // aborts the run — every entry in `seeds` is attempted, and unexpected
  // throws land here with the offending repo's input full_name so the admin
  // / cron caller can see exactly which repo failed and why (e.g. a BB 5xx,
  // a transient network error, an unknown DB constraint hit).
  errors: Array<{ fullName: string; error: string }>;
}

export async function bootstrapTrackedRepositories(
  deps: DiscoveryDeps,
  seeds: RepoSeed[],
): Promise<BootstrapReposResult> {
  const result: BootstrapReposResult = {
    requested: seeds.length,
    inserted: 0,
    alreadyTracked: 0,
    notFound: [],
    diffStatsToggled: 0,
    errors: [],
  };

  // Sequential intentionally — BitBucket rate-limit budget plus deterministic
  // logs. Phase 2 introduces parallelism with budget awareness.
  for (const seed of seeds) {
    const inputFullName = `${seed.workspace}/${seed.slug}`;
    try {
      // Reconcile the diff-stats flag for already-tracked repos in the same
      // pass. `addTrackedRepository` doesn't touch the stored flag on the
      // already-tracked path (that's only the YAML-driven flow's concern), so
      // we look up the existing row here and UPDATE it if the YAML value
      // diverges. Lookup-by-fullName matches the addTrackedRepository
      // short-circuit, so the BB call cost is unchanged.
      const existing = await deps.store.findRepositoryByFullName(inputFullName);
      if (existing !== null && existing.diffStatsEnabled !== seed.diffStatsEnabled) {
        await deps.store.updateRepositoryDiffStatsEnabled(existing.id, seed.diffStatsEnabled);
        result.diffStatsToggled++;
        deps.logger?.info?.(
          { fullName: existing.fullName, diffStatsEnabled: seed.diffStatsEnabled },
          'tracked-repo diff_stats_enabled updated from YAML',
        );
      }

      const r = await addTrackedRepository(deps, seed.workspace, seed.slug, {
        diffStatsEnabled: seed.diffStatsEnabled,
      });
      if (r.status === 'inserted') result.inserted++;
      else if (r.status === 'already-tracked') result.alreadyTracked++;
      else result.notFound.push(r.fullName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ fullName: inputFullName, error: message });
      deps.logger?.error?.(err, `tracked-repo bootstrap failed: ${inputFullName}`);
    }
  }

  deps.logger?.info?.(result, 'tracked-repo bootstrap complete');
  return result;
}
