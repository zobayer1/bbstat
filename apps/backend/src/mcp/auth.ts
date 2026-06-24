// Stateless bearer tokens for the read-only MCP server. JWT-shaped but
// hand-rolled on node:crypto (no dependency):
//
//   v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>
//
// There is NO token store — tokens are minted by the CLI
// (src/scripts/mint-mcp-token.ts) and verified with nothing but the secret. The
// only revocation lever is rotating MCP_TOKEN_SECRET, which invalidates every
// token at once; acceptable while consumers are provisioned by hand.

import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';

export interface TokenPayload {
  // Audit/log label only — grants nothing beyond the read-only tool surface.
  consumer: string;
  iat: number;
  // Expiry, unix epoch seconds. 0 = no expiry.
  exp: number;
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(secret: string, encodedPayload: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

// Constant-time compare that returns false on length mismatch rather than
// throwing (which raw timingSafeEqual would).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface SignTokenInput {
  consumer: string;
  iat: number;
  // Seconds until expiry from `iat`. Omit / 0 → non-expiring token (exp = 0).
  ttlSeconds?: number;
}

// `iat` is passed in (not read from the clock) so callers stay deterministic.
export function signToken(secret: string, input: SignTokenInput): string {
  const exp = input.ttlSeconds && input.ttlSeconds > 0 ? input.iat + input.ttlSeconds : 0;
  const payload: TokenPayload = { consumer: input.consumer, iat: input.iat, exp };
  const encodedPayload = b64urlEncode(JSON.stringify(payload));
  const signature = sign(secret, encodedPayload);
  return `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
}

function parsePayload(encodedPayload: string): TokenPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const obj = decoded as Record<string, unknown>;
  if (typeof obj.consumer !== 'string' || obj.consumer.length === 0) return null;
  if (typeof obj.iat !== 'number' || !Number.isFinite(obj.iat)) return null;
  if (typeof obj.exp !== 'number' || !Number.isFinite(obj.exp)) return null;
  return { consumer: obj.consumer, iat: obj.iat, exp: obj.exp };
}

// Signature is checked before expiry so a tampered token always reads as
// 'bad-signature', never leaking expiry state. `nowSeconds` injected for tests.
export function verifyToken(secret: string, token: string, nowSeconds: number): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };
  const [, encodedPayload, signature] = parts as [string, string, string];

  const expected = sign(secret, encodedPayload);
  if (!safeEqual(signature, expected)) return { ok: false, reason: 'bad-signature' };

  const payload = parsePayload(encodedPayload);
  if (payload === null) return { ok: false, reason: 'malformed' };

  if (payload.exp !== 0 && nowSeconds >= payload.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

export function extractBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  return match ? match[1]! : null;
}
