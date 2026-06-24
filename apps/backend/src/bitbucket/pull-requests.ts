// Endpoint wrapper for `/repositories/{ws}/{slug}/pullrequests` — typed shape
// + paginator. Sync orchestration lives in src/sync/pull-requests.ts.
//
// BB defaults to OPEN only, so all four `state=` params are required to
// surface merged/declined/superseded PRs in one walk. They live inline in the
// path because RequestOptions.query only accepts one value per key; `new
// URL()` parses them into multi-value searchParams that later set() calls
// leave intact.
//
// Sort `-updated_on` makes the cursor walk newest-first (stop at the first PR
// with `updated_on < cursor`). `updated_on` is per-second only, so the cursor
// pair is (updated_on, id) — the numeric BB id tie-breaks within a second.

import type { BitbucketClient } from './client.js';

export type BitbucketPullRequestState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';

export interface BitbucketPullRequest {
  id: number;
  title: string;
  state: BitbucketPullRequestState;
  source: {
    branch: { name: string };
    commit?: { hash: string };
  };
  destination: {
    branch: { name: string };
    commit?: { hash: string };
  };
  // Absent for PRs authored by deleted / anonymous BB accounts — sync code
  // treats `author_user_id = null` the same way it does for commits.
  author?: { uuid: string };
  created_on: string;
  updated_on: string;
  closed_on: string | null;
  comment_count: number;
  task_count: number;
}

// Paginated endpoint → `values.` prefix required; `next` is appended by
// client.paginate().
export const PR_LIST_FIELDS = [
  'values.id',
  'values.title',
  'values.state',
  'values.source.branch.name',
  'values.destination.branch.name',
  'values.source.commit.hash',
  'values.destination.commit.hash',
  'values.author.uuid',
  'values.created_on',
  'values.updated_on',
  'values.closed_on',
  'values.comment_count',
  'values.task_count',
];

// Yields PRs newest-first by `updated_on` (sort=-updated_on). Caller decides
// when to stop (`updated_on < cursor` for delta, or N pages for backfill).
export function paginatePullRequests(
  client: BitbucketClient,
  workspace: string,
  slug: string,
): AsyncGenerator<BitbucketPullRequest, void, void> {
  const path =
    `/repositories/${workspace}/${slug}/pullrequests` +
    `?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on`;
  // BB's /pullrequests caps `pagelen` at 50 (vs 100 for /commits); the
  // paginate() default of 100 trips a 400 here. BB's `next` URL preserves
  // the override, so subsequent pages inherit it.
  return client.paginate<BitbucketPullRequest>(path, {
    fields: PR_LIST_FIELDS,
    query: { pagelen: 50 },
  });
}
