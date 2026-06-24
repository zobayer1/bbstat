// Discovery: the slow-cadence sync work that establishes who and what we
// track. Workspace members go into `users`; the curated repo list (from
// the SEED_REPO_FILE_PATH YAML plus admin-added entries) goes into
// `repositories` + `sync_state`. Functions here are pure relative to the
// injected client / store, so they test without a database.

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

// BitBucket API response shapes — only the fields we consume.
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

export interface RepoSeed {
  workspace: string;
  slug: string;
  // Soft-retire seed: pre-archives on first insert, but flipping it on an
  // existing repo via YAML is a no-op (use the admin endpoints).
  archived: boolean;
}

// One entry in the seed file's `repos:` list: a plain `<workspace>/<slug>`
// string or `{ name, archived? }`. The legacy `diffStats:` flag is tolerated
// (z.passthrough) but ignored — diff-stat ingest is automatic now.
const seedEntrySchema = z.union([
  z.string(),
  z
    .object({
      name: z.string(),
      archived: z.boolean().optional().default(false),
    })
    .passthrough(),
]);

// Wrapping in a `repos:` key (vs. a bare top-level list) leaves room for
// sibling sections later without a breaking format change.
const seedFileSchema = z.object({
  repos: z.array(seedEntrySchema),
});

// Throws on shape mismatches so typos fail loud.
export function parseSeedRepoFile(text: string): RepoSeed[] {
  const raw: unknown = parseYaml(text);
  const parsed = seedFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Seed repo file is malformed: ${issues}`);
  }
  return parsed.data.repos
    .map((entry) => (typeof entry === 'string' ? { name: entry, archived: false } : entry))
    .map((entry) => ({ name: entry.name.trim(), archived: entry.archived }))
    .filter((entry) => entry.name.length > 0)
    .map((entry) => {
      const parts = entry.name.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Seed repo file entry must be "<workspace>/<slug>" — got "${entry.name}"`);
      }
      return {
        workspace: parts[0],
        slug: parts[1],
        archived: entry.archived,
      };
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
  // Pre-archive on insert. On already-tracked, does NOT update the stored
  // flag (use the admin endpoints).
  archived?: boolean;
}

// Idempotent at two layers: the findRepositoryByFullName short-circuit
// avoids a BB call when the input already matches a tracked row, and the
// insert's ON CONFLICT on bitbucket_uuid resolves an alias of an existing
// repo to the canonical row (status 'already-tracked') instead of a 23505.
// The returned `fullName` is always the canonical full_name, so logs stay
// consistent across alias retries.
export async function addTrackedRepository(
  deps: DiscoveryDeps,
  workspace: string,
  slug: string,
  opts: AddTrackedRepoOptions = {},
): Promise<AddTrackedRepoResult> {
  const inputFullName = `${workspace}/${slug}`;
  const archived = opts.archived ?? false;

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
    archived,
  });

  if (inserted) {
    deps.logger?.info?.({ fullName: row.fullName, archived }, 'tracked-repo added');
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
  // Per-seed failures. A single bad seed never aborts the run — every entry
  // is attempted and unexpected throws land here with the offending repo's
  // full_name.
  errors: Array<{ fullName: string; error: string }>;
}

// Seed-only: new rows pick up `archived` from the YAML entry; existing rows
// are NOT reconciled — once a repo is in the DB, the DB is canonical.
// Operators flip flags via admin endpoints or SQL.
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

  // Sequential intentionally — BB rate-limit budget plus deterministic logs.
  for (const seed of seeds) {
    const inputFullName = `${seed.workspace}/${seed.slug}`;
    try {
      const r = await addTrackedRepository(deps, seed.workspace, seed.slug, {
        archived: seed.archived,
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
