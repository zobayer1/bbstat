// CLI utility: verifies BitBucket credentials end-to-end before any sync
// code runs. Hits /workspaces/<ws>, prints the workspace metadata and the
// rate-limit budget snapshot. Exits 0 on success, 1 on any failure.
//
// Run from the repo root: `make doctor`

/* eslint-disable no-console -- CLI utility, console output is the deliverable */

import { loadConfig } from '../config.js';
import { BitbucketClient } from '../bitbucket/client.js';
import { BitbucketApiError } from '../bitbucket/errors.js';

interface WorkspaceResponse {
  uuid: string;
  slug: string;
  name: string;
  created_on: string;
}

async function main(): Promise<void> {
  const config = loadConfig();

  const missing: string[] = [];
  if (!config.BITBUCKET_AUTH_EMAIL) missing.push('BITBUCKET_AUTH_EMAIL');
  if (!config.BITBUCKET_AUTH_TOKEN) missing.push('BITBUCKET_AUTH_TOKEN');
  if (!config.BITBUCKET_WORKSPACE) missing.push('BITBUCKET_WORKSPACE');
  if (missing.length > 0) {
    console.error(`✗ Missing required env vars: ${missing.join(', ')}`);
    console.error(`  Edit .env at the repo root.`);
    process.exit(1);
  }

  console.log(`→ Checking BitBucket credentials for ${config.BITBUCKET_AUTH_EMAIL}…`);

  const client = new BitbucketClient({
    baseUrl: config.BITBUCKET_BASE_URL,
    email: config.BITBUCKET_AUTH_EMAIL!,
    token: config.BITBUCKET_AUTH_TOKEN!,
  });

  try {
    const ws = await client.get<WorkspaceResponse>(`/workspaces/${config.BITBUCKET_WORKSPACE}`, {
      fields: ['uuid', 'slug', 'name', 'created_on'],
    });

    console.log(`✓ Authenticated.`);
    console.log(`✓ Workspace: ${ws.slug} ("${ws.name}")`);
    console.log(`  uuid:    ${ws.uuid}`);
    console.log(`  created: ${ws.created_on}`);

    const rl = client.getRateLimit();
    if (rl.limit !== null) {
      console.log(``);
      console.log(`Rate-limit budget:`);
      console.log(`  limit:     ${rl.limit}`);
      console.log(`  remaining: ${rl.remaining}`);
      if (rl.resetAt) console.log(`  resets at: ${rl.resetAt.toISOString()}`);
    } else {
      console.log(``);
      console.log(`(No X-RateLimit-* headers seen in response.)`);
    }

    console.log(``);
    console.log(`✓ Doctor passed.`);
  } catch (err) {
    console.error(``);
    console.error(`✗ Doctor failed.`);
    console.error(``);
    if (err instanceof BitbucketApiError) {
      console.error(`  Status: ${err.status}`);
      console.error(`  Path:   ${err.path}`);
      if (err.body !== undefined) console.error(`  Body:   ${JSON.stringify(err.body)}`);
      console.error(``);
      if (err.status === 401 || err.status === 403) {
        console.error(`Check BITBUCKET_AUTH_EMAIL and BITBUCKET_AUTH_TOKEN in .env.`);
        console.error(`Token must have read-only Bitbucket scopes (read:workspace:bitbucket at minimum).`);
      } else if (err.status === 404) {
        console.error(`Check BITBUCKET_WORKSPACE in .env (current: ${config.BITBUCKET_WORKSPACE}).`);
      }
    } else {
      console.error(`  ${String(err)}`);
    }
    process.exit(1);
  }
}

void main();
