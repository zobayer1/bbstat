import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ActiveMembersBar from '../src/components/ActiveMembersBar.vue';
import type { ActivityBucket } from '../src/components/ActiveMembersBar.vue';

function makeBuckets(counts: number[]): ActivityBucket[] {
  const colors = ['#047857', '#10b981', '#6ee7b7'];
  const labels = ['Active · 7d', 'Active · 30d', 'Active · 1y'];
  return counts.map((count, i) => ({ count, color: colors[i]!, label: labels[i]! }));
}

describe('ActiveMembersBar (cumulative nested-range bars)', () => {
  it('renders one row per bucket, preserving order', () => {
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([5, 12, 30]) } });
    const rows = w.findAll('[data-bucket]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.attributes('data-bucket')).toBe('Active · 7d');
    expect(rows[1]!.attributes('data-bucket')).toBe('Active · 30d');
    expect(rows[2]!.attributes('data-bucket')).toBe('Active · 1y');
  });

  it('sizes each filled bar relative to the LARGEST bucket count (max = 100%)', () => {
    // Cumulative semantic: 7d <= 30d <= 1y. Largest = 1y = 30 → 100%.
    // 7d = 5 → 5/30 = 16.666...% ; 30d = 12 → 12/30 = 40%.
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([5, 12, 30]) } });
    const rows = w.findAll('[data-bucket]');
    // The filled bar carries the data-width-percent attribute we
    // set in the template — verifying via the computed value
    // rather than the inline style string (which Tailwind/JSDOM
    // round-trip differently across environments).
    const widths = rows.map((r) => r.find('[data-width-percent]').attributes('data-width-percent'));
    expect(widths[0]).toMatch(/^16\.6/);
    expect(widths[1]).toBe('40%');
    expect(widths[2]).toBe('100%');
  });

  it('renders short labels (strips the "Active · " prefix)', () => {
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([5, 12, 30]) } });
    const text = w.text();
    expect(text).toContain('7d');
    expect(text).toContain('30d');
    expect(text).toContain('1y');
    // The prefix shouldn't appear as visible text on the bars; full
    // label survives only in the title attribute for the tooltip.
    expect(w.find('[data-bucket="Active · 7d"]').text()).not.toContain('Active');
  });

  it('renders each count next to its bar', () => {
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([5, 12, 30]) } });
    const rows = w.findAll('[data-bucket]');
    expect(rows[0]!.text()).toContain('5');
    expect(rows[1]!.text()).toContain('12');
    expect(rows[2]!.text()).toContain('30');
  });

  it('every bar renders at 0% width when all counts are zero (no division by zero)', () => {
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([0, 0, 0]) } });
    const widths = w.findAll('[data-width-percent]').map((r) => r.attributes('data-width-percent'));
    expect(widths).toEqual(['0%', '0%', '0%']);
  });

  it('uses the bucket color for the filled bar via inline style', () => {
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([5, 12, 30]) } });
    const fill = w.find('[data-bucket="Active · 7d"]').find('[data-width-percent]');
    // jsdom normalizes hex to rgb in `style` attribute reads.
    const style = fill.attributes('style') ?? '';
    expect(style).toMatch(/background-color: rgb\(4, 120, 87\)|background-color: #047857/i);
  });

  it('applies the title attribute with full label + count for hover tooltips', () => {
    const w = mount(ActiveMembersBar, { props: { buckets: makeBuckets([5, 12, 30]) } });
    const titles = w.findAll('[data-width-percent]').map((r) => r.attributes('title'));
    expect(titles).toEqual(['Active · 7d: 5', 'Active · 30d: 12', 'Active · 1y: 30']);
  });
});
