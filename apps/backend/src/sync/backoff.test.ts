import { describe, expect, it } from 'vitest';
import { isDueForSync, type BackoffOptions } from './backoff.js';

const DEFAULT_OPTS: BackoffOptions = {
  slopeMinPerQuietDay: 4,
  minIntervalMin: 5,
  maxIntervalMin: 1440,
};

const NOW = new Date('2026-05-15T12:00:00Z');

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

describe('isDueForSync', () => {
  it('never-synced repos are always due', () => {
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: null,
        latestActivityAt: daysAgo(100), // doesn't matter
        createdAt: daysAgo(200),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('a recently active repo (within 1 day) uses the minimum interval', () => {
    // 4 minutes since last sync — below the 5-minute floor.
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(4),
        latestActivityAt: minutesAgo(30),
        createdAt: daysAgo(100),
        now: NOW,
      }),
    ).toBe(false);
    // 6 minutes since last sync — above the floor → due.
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(6),
        latestActivityAt: minutesAgo(30),
        createdAt: daysAgo(100),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('30 days quiet → ~2h interval (slope 4 min/day × 30 = 120 min)', () => {
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(119), // 1 min short
        latestActivityAt: daysAgo(30),
        createdAt: daysAgo(400),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(121), // 1 min past
        latestActivityAt: daysAgo(30),
        createdAt: daysAgo(400),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('365 days quiet → clamped to 24h interval', () => {
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(1439),
        latestActivityAt: daysAgo(365),
        createdAt: daysAgo(800),
        now: NOW,
      }),
    ).toBe(false);
    // The clamp means even 10-year-dead repos still poll daily.
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(1441),
        latestActivityAt: daysAgo(3650),
        createdAt: daysAgo(3650),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('empty repo with no commits ever: falls back to createdAt for quiet calc', () => {
    // Repo created 30 days ago, never produced a commit. Interval should
    // behave like "30 days quiet" → 120 min.
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(119),
        latestActivityAt: null,
        createdAt: daysAgo(30),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(121),
        latestActivityAt: null,
        createdAt: daysAgo(30),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('respects custom slope', () => {
    const aggressive: BackoffOptions = { slopeMinPerQuietDay: 8, minIntervalMin: 5, maxIntervalMin: 1440 };
    // 30 days × 8 = 240 min interval (vs. 120 with default slope).
    expect(
      isDueForSync(aggressive, {
        lastSyncedAt: minutesAgo(180),
        latestActivityAt: daysAgo(30),
        createdAt: daysAgo(400),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isDueForSync(aggressive, {
        lastSyncedAt: minutesAgo(241),
        latestActivityAt: daysAgo(30),
        createdAt: daysAgo(400),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('respects custom ceiling', () => {
    const tighterCap: BackoffOptions = { slopeMinPerQuietDay: 4, minIntervalMin: 5, maxIntervalMin: 360 };
    // 365 days × 4 = 1460 min unclamped, but cap is 360 min (6h).
    expect(
      isDueForSync(tighterCap, {
        lastSyncedAt: minutesAgo(359),
        latestActivityAt: daysAgo(365),
        createdAt: daysAgo(800),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isDueForSync(tighterCap, {
        lastSyncedAt: minutesAgo(361),
        latestActivityAt: daysAgo(365),
        createdAt: daysAgo(800),
        now: NOW,
      }),
    ).toBe(true);
  });

  it('activity in the future is treated as 0 days quiet (defensive against clock skew)', () => {
    expect(
      isDueForSync(DEFAULT_OPTS, {
        lastSyncedAt: minutesAgo(6),
        // "activity" timestamp 1 hour in the future — should not produce
        // a negative quiet duration that bypasses the floor.
        latestActivityAt: new Date(NOW.getTime() + 60 * 60_000),
        createdAt: daysAgo(400),
        now: NOW,
      }),
    ).toBe(true); // 6 min since sync >= 5 min floor
  });
});
