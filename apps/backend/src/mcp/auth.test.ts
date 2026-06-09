import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, extractBearer, type VerifyResult } from './auth.js';

// Mint a correctly-signed token over an arbitrary (possibly non-conforming)
// payload string — used to exercise verify paths past the signature check.
function signedOver(secret: string, rawPayload: string): string {
  const encodedPayload = Buffer.from(rawPayload).toString('base64url');
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `v1.${encodedPayload}.${signature}`;
}

const SECRET = 'test-secret-please-rotate';
const IAT = 1_700_000_000; // fixed clock for determinism

function expectOk(result: VerifyResult): asserts result is Extract<VerifyResult, { ok: true }> {
  expect(result.ok).toBe(true);
}

describe('signToken / verifyToken', () => {
  it('round-trips a valid token and carries the consumer + iat + exp', () => {
    const token = signToken(SECRET, { consumer: 'analytics-agent', iat: IAT, ttlSeconds: 3600 });
    const result = verifyToken(SECRET, token, IAT + 10);
    expectOk(result);
    expect(result.payload.consumer).toBe('analytics-agent');
    expect(result.payload.iat).toBe(IAT);
    expect(result.payload.exp).toBe(IAT + 3600);
  });

  it('mints a non-expiring token when ttl is omitted (exp = 0) and never expires', () => {
    const token = signToken(SECRET, { consumer: 'service', iat: IAT });
    const result = verifyToken(SECRET, token, IAT + 10 * 365 * 86_400); // a decade later
    expectOk(result);
    expect(result.payload.exp).toBe(0);
  });

  it('treats ttlSeconds of 0 as non-expiring', () => {
    const token = signToken(SECRET, { consumer: 'service', iat: IAT, ttlSeconds: 0 });
    expectOk(verifyToken(SECRET, token, IAT + 1_000_000));
  });

  it('rejects a token past its expiry', () => {
    const token = signToken(SECRET, { consumer: 'temp', iat: IAT, ttlSeconds: 3600 });
    const result = verifyToken(SECRET, token, IAT + 3600); // exactly at exp → expired (>=)
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken('other-secret', { consumer: 'x', iat: IAT, ttlSeconds: 3600 });
    expect(verifyToken(SECRET, token, IAT)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a token whose payload was tampered with (signature no longer matches)', () => {
    const token = signToken(SECRET, { consumer: 'low-priv', iat: IAT, ttlSeconds: 3600 });
    const [version, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ consumer: 'admin', iat: IAT, exp: 0 })).toString('base64url');
    const forged = `${version}.${forgedPayload}.${signature}`;
    expect(verifyToken(SECRET, forged, IAT)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects structurally malformed tokens', () => {
    for (const bad of ['', 'garbage', 'v1.only-two', 'v2.abc.def', 'a.b.c.d']) {
      expect(verifyToken(SECRET, bad, IAT)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('reports malformed (not a crash) for a validly-signed but non-conforming payload', () => {
    // Signature checks out, but the payload isn't valid JSON / is missing
    // required fields — exercises the parsePayload-null branch after the
    // signature check.
    expect(verifyToken(SECRET, signedOver(SECRET, 'not-json'), IAT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyToken(SECRET, signedOver(SECRET, '{"consumer":"x"}'), IAT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('extractBearer', () => {
  it('pulls the token out of a well-formed Authorization header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('tolerates surrounding whitespace', () => {
    expect(extractBearer('  Bearer abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('returns null for missing or non-bearer headers', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearer('bearer lowercase-scheme')).toBeNull();
  });
});
