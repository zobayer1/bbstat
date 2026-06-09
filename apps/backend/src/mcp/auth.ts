// Stateless bearer tokens for the read-only MCP server.
//
// A token is a compact, signed, self-describing string — JWT-shaped but
// hand-rolled on node:crypto so it pulls in no dependency:
//
//   v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>
//
// `payload` is `{ consumer, iat, exp }`. The signature is keyed by
// MCP_TOKEN_SECRET; verification recomputes it and compares in constant time,
// so a token can't be forged or altered without the secret. There is NO token
// store: tokens are minted by the CLI (src/scripts/mint-mcp-token.ts) and
// verified on every request with nothing but the secret. The only revocation
// lever is rotating MCP_TOKEN_SECRET, which invalidates every token at once —
// acceptable while consumers are provisioned by hand. A real per-token revoke
// list would be a DB-backed follow-up.
//
// `exp` is a unix epoch in seconds; `exp === 0` means "never expires" (for a
// long-lived service token). The mint CLI defaults to a finite TTL.

import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';

export interface TokenPayload {
  // Human label for who the token was issued to (e.g. "ci-bot",
  // "analytics-agent"). Carried only for auditing / log context — it grants
  // nothing beyond the read-only tool surface.
  consumer: string;
  // Issued-at, unix epoch seconds.
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

// Constant-time string compare that never throws on length mismatch (which
// timingSafeEqual would). Returns false for differing lengths before the
// constant-time step.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface SignTokenInput {
  consumer: string;
  iat: number;
  // Seconds until expiry from `iat`. Omit / undefined / 0 → a non-expiring
  // token (exp = 0).
  ttlSeconds?: number;
}

// Mint a signed token. `iat` is passed in (not read from the clock here) so
// callers stay testable and deterministic.
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

// Verify a token against the secret. `nowSeconds` is injected so callers /
// tests control the clock. Signature is checked before expiry so a tampered
// token always reads as 'bad-signature', never leaking expiry state.
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

// Pull a bearer token out of an Authorization header value. Returns null when
// the header is absent or not a well-formed `Bearer <token>`.
export function extractBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  return match ? match[1]! : null;
}
