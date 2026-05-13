// Endpoint wrapper for BitBucket Cloud
// `/repositories/{ws}/{slug}/pullrequests` — typed shape + paginator. Sync
// orchestration (cursor / cold cap / delta stop / UPSERT) lives in
// src/sync/pull-requests.ts and consumes this.
//
// We filter on all four PR states. BB defaults to OPEN only, so the four
// `state=` params are required to surface merged/declined/superseded PRs in
// the same paginated walk. RequestOptions.query only accepts one value per
// key, so the state filters live inline in the request path; `new URL()`
// parses them into multi-value searchParams which subsequent set() calls
// (for fields + pagelen) leave intact.
//
// Sort by `-updated_on` so the cursor walk runs newest-first: ingest stops
// at the first PR with `updated_on < cursor`. PRs share `updated_on` only
// to per-second resolution, so the cursor pair is (updated_on, id) — the
// numeric BB id tie-breaks within the same second.

import type { BitbucketClient } from './client.js';

export type BitbucketPullRequestState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';

// Slim BB pull-request shape — only the fields we field-filter for. The full
// BB payload carries far more (rendered diffs, reviewers, links, etc.) —
// none of which we ingest.
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

// Field filter for /pullrequests. Paginated endpoint, so values.-prefix is
// required; `next` is appended automatically by client.paginate().
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

// Async iterator yielding each PR in BB's natural order (newest by
// `updated_on` first, thanks to `sort=-updated_on`). Caller decides when to
// stop — e.g. on hitting `updated_on < cursor` for delta sync, or after N
// pages on first-run backfill.
export function paginatePullRequests(
  client: BitbucketClient,
  workspace: string,
  slug: string,
): AsyncGenerator<BitbucketPullRequest, void, void> {
  const path =
    `/repositories/${workspace}/${slug}/pullrequests` +
    `?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on`;
  return client.paginate<BitbucketPullRequest>(path, { fields: PR_LIST_FIELDS });
}
