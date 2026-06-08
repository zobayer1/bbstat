// Endpoint wrapper for BitBucket Cloud `GET /repositories/{workspace}` — the
// list-all-repos-in-a-workspace endpoint. Consumed by the repo-discovery
// sweep (src/sync/repo-discovery.ts) to auto-track repositories without
// manual seeding.

import type { BitbucketClient } from './client.js';

// Slim repo shape — only the fields the discovery sweep field-filters for.
export interface BitbucketRepoSummary {
  uuid: string;
  slug: string;
  full_name: string;
  workspace: { slug: string };
  // Absent when the repo has no project assignment.
  project?: { key: string };
  is_private: boolean;
  // ISO 8601 with microseconds + offset, e.g. "2024-10-27T09:56:02.818970+00:00".
  updated_on: string;
  // Absent for an empty repo whose mainbranch pointer has no ref behind it.
  mainbranch?: { name: string };
  // Present ONLY on forks — the upstream repo's full_name.
  parent?: { full_name: string };
}

// Field filter for the list endpoint. Paginated → `values.` prefix required;
// `next` is appended automatically by client.paginate().
export const REPO_LIST_FIELDS = [
  'values.uuid',
  'values.slug',
  'values.full_name',
  'values.workspace.slug',
  'values.project.key',
  'values.is_private',
  'values.updated_on',
  'values.mainbranch.name',
  'values.parent.full_name',
];

export interface PaginateWorkspaceReposOptions {
  // BBQL lower bound — yields repos with `updated_on` strictly greater than
  // this ISO timestamp. Omit to walk the whole workspace.
  since?: string;
}

// Async iterator over every repository in a workspace, ordered by `updated_on`
// ASCENDING (oldest first). The ascending order is load-bearing for the
// discovery cursor: it backfills the long tail of inactive repos before
// catching up to the active front and any newly created repos.
export function paginateWorkspaceRepositories(
  client: BitbucketClient,
  workspace: string,
  opts: PaginateWorkspaceReposOptions = {},
): AsyncGenerator<BitbucketRepoSummary, void, void> {
  const query: Record<string, string | undefined> = { sort: 'updated_on' };
  if (opts.since !== undefined) query.q = `updated_on > "${opts.since}"`;
  return client.paginate<BitbucketRepoSummary>(`/repositories/${workspace}`, {
    fields: REPO_LIST_FIELDS,
    query,
  });
}
