import { describe, it, expect } from 'vitest';
import { prioritizeDue } from './runner.js';

// Models a row as it leaves listRepositoriesForSync: ordered
// `last_synced_at ASC NULLS FIRST`, so cold (never-synced) rows lead.
interface Row {
  id: number;
  cold: boolean;
}
const isCold = (r: Row): boolean => r.cold;

// `due` mirrors the query order: every cold row first (NULLS FIRST), then warm
// rows oldest-synced-first. The fix must invert that so warm leads.
function due(cold: number[], warm: number[]): Row[] {
  return [...cold.map((id) => ({ id, cold: true })), ...warm.map((id) => ({ id, cold: false }))];
}

describe('prioritizeDue', () => {
  it('returns the list untouched when no cap is wired (legacy NULLS-FIRST order)', () => {
    const rows = due([90, 91, 92], [1, 2]);
    const result = prioritizeDue(rows, isCold, undefined);
    expect(result.ordered).toBe(rows); // same reference — no reshuffle
    expect(result.ordered.map((r) => r.id)).toEqual([90, 91, 92, 1, 2]);
    expect(result).toMatchObject({ warmCount: 2, coldAdmitted: 3, coldDeferred: 0 });
  });

  it('puts every warm repo ahead of any cold repo so the active rotation is never starved', () => {
    const result = prioritizeDue(due([90, 91, 92], [1, 2]), isCold, 5);
    // Warm (1, 2) lead even though cold (90..) led in the source order.
    expect(result.ordered.map((r) => r.id)).toEqual([1, 2, 90, 91, 92]);
  });

  it('admits at most maxCold cold repos and defers the rest', () => {
    const result = prioritizeDue(due([90, 91, 92, 93, 94, 95], [1, 2]), isCold, 2);
    expect(result.ordered.map((r) => r.id)).toEqual([1, 2, 90, 91]);
    expect(result).toMatchObject({ warmCount: 2, coldAdmitted: 2, coldDeferred: 4 });
  });

  it('preserves the incoming order within the warm set (oldest-synced-first)', () => {
    const result = prioritizeDue(due([90], [3, 1, 2]), isCold, 5);
    expect(result.ordered.map((r) => r.id)).toEqual([3, 1, 2, 90]);
  });

  it('admits the cold backlog in its incoming (queue) order', () => {
    const result = prioritizeDue(due([90, 91, 92], []), isCold, 2);
    expect(result.ordered.map((r) => r.id)).toEqual([90, 91]);
    expect(result.coldDeferred).toBe(1);
  });

  it('maxCold = 0 services warm only, deferring all cold first-syncs', () => {
    const result = prioritizeDue(due([90, 91], [1, 2]), isCold, 0);
    expect(result.ordered.map((r) => r.id)).toEqual([1, 2]);
    expect(result).toMatchObject({ warmCount: 2, coldAdmitted: 0, coldDeferred: 2 });
  });

  it('all-warm tick is unaffected by the cap', () => {
    const result = prioritizeDue(due([], [1, 2, 3]), isCold, 5);
    expect(result.ordered.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ warmCount: 3, coldAdmitted: 0, coldDeferred: 0 });
  });
});
