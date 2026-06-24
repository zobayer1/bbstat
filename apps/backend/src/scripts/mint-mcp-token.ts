// CLI: mint a signed access token for an MCP consumer.
//
// Tokens are stateless, signed by MCP_TOKEN_SECRET (see src/mcp/auth.ts), so
// minting loads only that secret — no full app config (no DATABASE_URL).
//
// Usage:
//   mint-mcp-token <consumer> [--days N | --no-expiry]
//
//   <consumer>     audit-only label for who the token is for
//   --days N       lifetime in days (default 365)
//   --no-expiry    non-expiring token (exp = 0)
//
// Only the token goes to STDOUT (info → STDERR), so it pipes cleanly.
// Exits 0 on success, 1 on any usage / config error.

/* eslint-disable no-console -- one-shot CLI; stdout (token) + stderr (info) are the deliverable */

import { signToken } from '../mcp/auth.js';

const DEFAULT_TTL_DAYS = 365;

interface Args {
  consumer: string;
  ttlSeconds: number; // 0 = no expiry
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let days = DEFAULT_TTL_DAYS;
  let noExpiry = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--no-expiry') {
      noExpiry = true;
    } else if (arg === '--days') {
      const value = argv[++i];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--days expects a positive integer, got ${value ?? '(missing)'}`);
      }
      days = n;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error('expected exactly one <consumer> argument');
  }
  if (noExpiry && days !== DEFAULT_TTL_DAYS) {
    throw new Error('--days and --no-expiry are mutually exclusive');
  }

  return {
    consumer: positional[0]!,
    ttlSeconds: noExpiry ? 0 : days * 86_400,
  };
}

function main(): void {
  const secret = process.env.MCP_TOKEN_SECRET;
  if (!secret) {
    console.error('✗ MCP_TOKEN_SECRET is not set — cannot mint a token.');
    console.error('  Set it in the environment (e.g. .env / .env.docker) and retry.');
    process.exit(1);
  }

  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Usage: mint-mcp-token <consumer> [--days N | --no-expiry]');
    process.exit(1);
  }

  const iat = Math.floor(Date.now() / 1000);
  const token = signToken(secret, { consumer: args.consumer, iat, ttlSeconds: args.ttlSeconds });

  const expiryNote =
    args.ttlSeconds === 0 ? 'never expires' : `expires ${new Date((iat + args.ttlSeconds) * 1000).toISOString()}`;
  console.error(`✓ Minted token for "${args.consumer}" (${expiryNote}).`);
  console.error('  Hand it to the consumer as:  Authorization: Bearer <token>');
  console.log(token);
}

main();
