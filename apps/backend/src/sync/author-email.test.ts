import { describe, it, expect } from 'vitest';
import { parseAuthorDisplayName, parseAuthorEmail } from './author-email.js';

describe('parseAuthorEmail', () => {
  it('extracts an email from a standard "Display Name <email>" string', () => {
    expect(parseAuthorEmail('Alice Example <alice@example.com>')).toBe('alice@example.com');
  });

  it('lowercases the captured address for stable deduplication downstream', () => {
    expect(parseAuthorEmail('Alice <Alice@Example.COM>')).toBe('alice@example.com');
  });

  it('tolerates whitespace inside the angle brackets', () => {
    expect(parseAuthorEmail('Alice <   alice@example.com   >')).toBe('alice@example.com');
  });

  it('returns null when the raw string has no angle-bracket segment', () => {
    expect(parseAuthorEmail('Alice Example')).toBeNull();
    expect(parseAuthorEmail('')).toBeNull();
  });

  it('returns null when the angle-bracket content has no `@`', () => {
    expect(parseAuthorEmail('Alice <not-an-email>')).toBeNull();
  });

  it('returns null when the domain has no `.`', () => {
    // `foo@bar` is technically valid SMTP for a local domain but not what
    // we want surfacing on the dashboard.
    expect(parseAuthorEmail('Alice <alice@bar>')).toBeNull();
  });

  it('returns null when the local part is empty', () => {
    expect(parseAuthorEmail('Alice <@example.com>')).toBeNull();
  });

  it('returns null when the domain is empty', () => {
    expect(parseAuthorEmail('Alice <alice@>')).toBeNull();
  });

  it('filters BB web-merge synthetics (users.noreply.bitbucket.org)', () => {
    expect(parseAuthorEmail('Alice <12345+alice@users.noreply.bitbucket.org>')).toBeNull();
  });

  it('filters GitHub-mirror noreply addresses', () => {
    expect(parseAuthorEmail('Alice <12345+alice@users.noreply.github.com>')).toBeNull();
  });

  it('filters the bare `noreply@*` local-part pattern', () => {
    expect(parseAuthorEmail('Alice <noreply@example.com>')).toBeNull();
  });

  it('returns null for null / undefined inputs (defensive)', () => {
    expect(parseAuthorEmail(null)).toBeNull();
    expect(parseAuthorEmail(undefined)).toBeNull();
  });

  it('accepts addresses with `+` aliases when they are not the noreply pattern', () => {
    expect(parseAuthorEmail('Alice <alice+work@example.com>')).toBe('alice+work@example.com');
  });

  it('accepts subdomain addresses', () => {
    expect(parseAuthorEmail('Alice <alice@dev.team.example.com>')).toBe('alice@dev.team.example.com');
  });
});

describe('parseAuthorDisplayName', () => {
  it('extracts the name portion before the angle bracket', () => {
    expect(parseAuthorDisplayName('Alice Example <alice@example.com>')).toBe('Alice Example');
  });

  it('trims trailing whitespace before the angle bracket', () => {
    expect(parseAuthorDisplayName('Alice Example   <alice@example.com>')).toBe('Alice Example');
  });

  it('returns null when there is no usable name (just an angle-bracketed email)', () => {
    expect(parseAuthorDisplayName('<alice@example.com>')).toBeNull();
    expect(parseAuthorDisplayName('  <alice@example.com>')).toBeNull();
  });

  it('falls back to the whole trimmed string when no angle bracket exists', () => {
    expect(parseAuthorDisplayName('Alice Example')).toBe('Alice Example');
    expect(parseAuthorDisplayName('   Alice Example   ')).toBe('Alice Example');
  });

  it('returns null for empty / null / undefined inputs', () => {
    expect(parseAuthorDisplayName('')).toBeNull();
    expect(parseAuthorDisplayName('   ')).toBeNull();
    expect(parseAuthorDisplayName(null)).toBeNull();
    expect(parseAuthorDisplayName(undefined)).toBeNull();
  });
});
