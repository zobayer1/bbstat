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
}

// Shape of the seed file: a top-level `repos:` list of "<workspace>/<slug>"
// strings. Wrapping in a key (vs. a bare top-level list) leaves room to grow
// the file with sibling sections later without a breaking format change.
const seedFileSchema = z.object({
  repos: z.array(z.string()),
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
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const parts = entry.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Seed repo file entry must be "<workspace>/<slug>" — got "${entry}"`);
      }
      return { workspace: parts[0], slug: parts[1] };
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
): Promise<AddTrackedRepoResult> {
  const inputFullName = `${workspace}/${slug}`;

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
  });

  if (inserted) {
    deps.logger?.info?.({ fullName: row.fullName }, 'tracked-repo added');
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
    errors: [],
  };

  // Sequential intentionally — BitBucket rate-limit budget plus deterministic
  // logs. Phase 2 introduces parallelism with budget awareness.
  for (const seed of seeds) {
    const inputFullName = `${seed.workspace}/${seed.slug}`;
    try {
      const r = await addTrackedRepository(deps, seed.workspace, seed.slug);
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
