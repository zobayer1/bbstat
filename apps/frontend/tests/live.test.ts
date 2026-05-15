import { describe, it, expect, vi, beforeEach } from 'vitest';
import { liveBus } from '../src/lib/live';

describe('liveBus', () => {
  beforeEach(() => {
    liveBus.clear();
  });

  it('delivers a published event to every subscribed handler', () => {
    const a = vi.fn();
    const b = vi.fn();
    liveBus.on('tick.commits.complete', a);
    liveBus.on('tick.commits.complete', b);

    const payload = {
      trigger: 'cron' as const,
      startedAt: '2026-05-15T21:00:00.000Z',
      finishedAt: '2026-05-15T21:00:38.000Z',
      attempted: 4,
      deferred: 0,
      errors: 0,
      totalCommitsInserted: 0,
      budgetRemainingAtEnd: 809,
      stoppedEarly: false,
      deepenStoppedReason: 'queue-empty' as const,
      isMergeBackfillStoppedReason: 'queue-empty' as const,
      diffStatsBackfillStopReason: 'rate-limited' as const,
      diffStatsBackfillTotalUpdated: 0,
    };
    liveBus.emit('tick.commits.complete', payload);

    expect(a).toHaveBeenCalledOnce();
    expect(a).toHaveBeenCalledWith(payload);
    expect(b).toHaveBeenCalledOnce();
  });

  it('returns an unsubscribe function that stops further delivery', () => {
    const handler = vi.fn();
    const unsub = liveBus.on('repository.deleted', handler);

    liveBus.emit('repository.deleted', { repositoryId: 1, fullName: 'a/b' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    liveBus.emit('repository.deleted', { repositoryId: 2, fullName: 'a/c' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates throwing handlers — others still receive the event', () => {
    const broken = vi.fn(() => {
      throw new Error('boom');
    });
    const ok = vi.fn();
    liveBus.on('repository.deleted', broken);
    liveBus.on('repository.deleted', ok);

    liveBus.emit('repository.deleted', { repositoryId: 1, fullName: 'a/b' });

    expect(broken).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
  });

  it('emit ignores events with no handlers — no throw', () => {
    expect(() =>
      liveBus.emit('tick.prs.complete', {
        trigger: 'cron',
        startedAt: '',
        finishedAt: '',
        attempted: 0,
        deferred: 0,
        errors: 0,
        totalPrsInserted: 0,
        totalPrsUpdated: 0,
        budgetRemainingAtEnd: 0,
        stoppedEarly: false,
      }),
    ).not.toThrow();
  });

  it('fallback handlers fire on emitFallback and not on regular emits', () => {
    const fallback = vi.fn();
    const regular = vi.fn();
    liveBus.onFallback(fallback);
    liveBus.on('tick.commits.complete', regular);

    liveBus.emitFallback();
    expect(fallback).toHaveBeenCalledOnce();
    expect(regular).not.toHaveBeenCalled();

    liveBus.emit('tick.commits.complete', {
      trigger: 'cron',
      startedAt: '',
      finishedAt: '',
      attempted: 0,
      deferred: 0,
      errors: 0,
      totalCommitsInserted: 0,
      budgetRemainingAtEnd: 0,
      stoppedEarly: false,
      deepenStoppedReason: null,
      isMergeBackfillStoppedReason: null,
      diffStatsBackfillStopReason: null,
      diffStatsBackfillTotalUpdated: 0,
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(regular).toHaveBeenCalledOnce();
  });

  it('clear() removes both event and fallback handlers', () => {
    const a = vi.fn();
    const b = vi.fn();
    liveBus.on('repository.deleted', a);
    liveBus.onFallback(b);

    liveBus.clear();

    liveBus.emit('repository.deleted', { repositoryId: 1, fullName: 'a/b' });
    liveBus.emitFallback();

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});
