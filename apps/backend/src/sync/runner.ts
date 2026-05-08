// Convergence point for the discovery sync surface. Three entry points so
// crons can dispatch to a focused operation (cheaper, more granular logs)
// while admin / future-webhook triggers can run the full thing.
//
//   runMembersSync   — workspace members → users
//   runReposSync     — curated tracked-repo bootstrap
//   runDiscoverySync — both, sequentially (manual admin trigger)
//
// All three are idempotent and can race safely (e.g., cron + manual at the
// same time); each underlying op uses upserts / cache-hit short-circuits.
//
// Webhook trigger label is preserved in `SyncTrigger` for forward compat,
// but the receiver endpoint is deferred — see memory/webhook_deferred.md.

import { bootstrapTrackedRepositories, syncWorkspaceMembers } from './discovery.js';
import type { BitbucketClient, BitbucketLogger } from '../bitbucket/client.js';
import type { BootstrapReposResult, RepoSeed, SyncMembersResult } from './discovery.js';
import type { DiscoveryStore } from './discovery-store.js';

export type SyncTrigger = 'manual' | 'cron' | 'webhook';

export interface SyncRunnerDeps {
  client: BitbucketClient;
  store: DiscoveryStore;
  logger: BitbucketLogger;
  workspace: string;
  seeds: RepoSeed[];
}

interface BaseResult {
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string;
}

export interface MembersSyncResult extends BaseResult {
  members: SyncMembersResult;
}

export interface ReposSyncResult extends BaseResult {
  repos: BootstrapReposResult;
}

export interface DiscoverySyncResult extends BaseResult {
  members: SyncMembersResult;
  repos: BootstrapReposResult;
}

export async function runMembersSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<MembersSyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace }, 'members sync start');
  const members = await syncWorkspaceMembers(deps, deps.workspace);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, members, startedAt, finishedAt }, 'members sync complete');
  return { trigger, startedAt, finishedAt, members };
}

export async function runReposSync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<ReposSyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace, seedCount: deps.seeds.length }, 'repos sync start');
  const repos = await bootstrapTrackedRepositories(deps, deps.seeds);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, repos, startedAt, finishedAt }, 'repos sync complete');
  return { trigger, startedAt, finishedAt, repos };
}

export async function runDiscoverySync(deps: SyncRunnerDeps, trigger: SyncTrigger): Promise<DiscoverySyncResult> {
  const startedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, workspace: deps.workspace }, 'discovery sync start');
  const members = await syncWorkspaceMembers(deps, deps.workspace);
  const repos = await bootstrapTrackedRepositories(deps, deps.seeds);
  const finishedAt = new Date().toISOString();
  deps.logger.info?.({ trigger, members, repos, startedAt, finishedAt }, 'discovery sync complete');
  return { trigger, startedAt, finishedAt, members, repos };
}
