import { describe, it, expect } from 'vitest';
import { computeReconcilePlan } from './reconcile.js';

// computeReconcilePlan is the pure core of history-rewrite reconciliation:
// given BitBucket's head window (newest-first) and our recent commits
// (newest-first), find the common ancestor, the orphaned (rewritten-away)
// shas, and the new commits BB has above the ancestor. The orchestrator
// feeds it a bounded BB walk + a `listRecentCommitShas` window; everything
// downstream (delete, re-anchor, delta sync) keys off this result.

const D = new Date('2026-01-01T00:00:00Z');
// authoredAt is irrelevant to the diff (ancestor position is by index, not
// date) — fixed so the rows are well-formed.
function ours(...shas: string[]): Array<{ sha: string; authoredAt: Date }> {
  return shas.map((sha) => ({ sha, authoredAt: D }));
}

describe('computeReconcilePlan', () => {
  it('detects a single rebased-away tip commit (the kai scenario)', () => {
    // Excluded-state shape: `orphan` is our cursor/tip (rewritten away on
    // BB); BB replaced it with `new` on top of the shared `base`. So BB has
    // one commit above the ancestor we lack, and we have one above it BB lost.
    const bb = ['new', 'base', 'x', 'y'];
    const our = ours('orphan', 'base', 'x', 'y');
    const plan = computeReconcilePlan(bb, our);
    expect(plan).not.toBeNull();
    expect(plan!.ancestorSha).toBe('base');
    expect(plan!.bbAbove).toEqual(['new']);
    expect(plan!.orphanShas).toEqual(['orphan']);
  });

  it('handles a multi-commit rewrite: 2 orphans dropped, 3 new added', () => {
    // BB rewrote the two commits above the shared `base` into three new ones.
    const bb = ['n1', 'n2', 'n3', 'base', 'older'];
    const our = ours('o1', 'o2', 'base', 'older');
    const plan = computeReconcilePlan(bb, our);
    expect(plan!.ancestorSha).toBe('base');
    expect(plan!.bbAbove).toEqual(['n1', 'n2', 'n3']);
    expect(plan!.orphanShas).toEqual(['o1', 'o2']);
  });

  it('reports new commits only when our head is an ancestor of BB head', () => {
    // No rewrite — BB simply has commits we haven't pulled (stale cursor).
    const bb = ['new2', 'new1', 'head', 'mid', 'tail'];
    const our = ours('head', 'mid', 'tail');
    const plan = computeReconcilePlan(bb, our);
    expect(plan!.ancestorSha).toBe('head');
    expect(plan!.bbAbove).toEqual(['new2', 'new1']);
    expect(plan!.orphanShas).toEqual([]);
  });

  it('reports orphans only when BB dropped tip commits with nothing new', () => {
    const bb = ['shared', 'older'];
    const our = ours('gone2', 'gone1', 'shared', 'older');
    const plan = computeReconcilePlan(bb, our);
    expect(plan!.ancestorSha).toBe('shared');
    expect(plan!.bbAbove).toEqual([]);
    expect(plan!.orphanShas).toEqual(['gone2', 'gone1']);
  });

  it('is a clean no-op when BB head equals our head', () => {
    const bb = ['a', 'b', 'c'];
    const our = ours('a', 'b', 'c');
    const plan = computeReconcilePlan(bb, our);
    expect(plan!.ancestorSha).toBe('a');
    expect(plan!.bbAbove).toEqual([]);
    expect(plan!.orphanShas).toEqual([]);
  });

  it('returns null when no common ancestor exists in the windows', () => {
    // Fully divergent — BB shares nothing with our recent window.
    const bb = ['x', 'y', 'z'];
    const our = ours('p', 'q', 'r');
    expect(computeReconcilePlan(bb, our)).toBeNull();
  });

  it('only prunes orphans NEWER than the ancestor — deeper absentees are left alone', () => {
    // The ancestor is our newest sha (`shared` == BB head), so nothing is
    // newer than it. `buried` is absent from BB but sits BELOW the ancestor
    // in our history — out of scope for a tip reconcile, so it is NOT pruned.
    const bb = ['shared', 'anchor', 'old'];
    const our = ours('shared', 'buried', 'anchor', 'old');
    const plan = computeReconcilePlan(bb, our);
    expect(plan!.ancestorSha).toBe('shared');
    expect(plan!.orphanShas).toEqual([]);
    expect(plan!.bbAbove).toEqual([]);
  });

  it('handles an empty BB window (no head returned)', () => {
    expect(computeReconcilePlan([], ours('a', 'b'))).toBeNull();
  });

  it('handles an empty local window (no commits stored)', () => {
    expect(computeReconcilePlan(['a', 'b'], ours())).toBeNull();
  });
});
