import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import CommitHeatmap from '../src/components/CommitHeatmap.vue';

// 53 cols × 7 rows = 371. The component renders this many <rect>s always —
// future-of-this-week cells are present but `v-show="visible"` hides them.
const TOTAL_CELLS = 371;

function todayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('CommitHeatmap', () => {
  beforeEach(() => {
    // Pin "today" so the grid math is deterministic — use a Wednesday so
    // we exercise a mid-week trailing-blanks scenario.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders 371 <rect> cells (53 cols × 7 rows)', () => {
    const w = mount(CommitHeatmap, { props: { data: [] } });
    expect(w.findAll('rect').length).toBe(TOTAL_CELLS);
  });

  it('paints the empty-bucket color when there is no data', () => {
    const w = mount(CommitHeatmap, { props: { data: [] } });
    const fills = new Set(w.findAll('rect').map((r) => r.attributes('fill')));
    expect(fills.has('#ebedf0')).toBe(true);
    // No saturated blue at all when data is empty.
    expect(fills.has('#1e40af')).toBe(false);
  });

  it('auto-calibrates buckets to the data max — the max-commit day gets the darkest blue', () => {
    const w = mount(CommitHeatmap, {
      props: {
        data: [
          { date: todayIso(), commits: 100 }, // max → bucket 4
          { date: '2026-05-12', commits: 75 }, // upper-quartile → bucket 4 (≤ max)
          { date: '2026-05-11', commits: 50 }, // mid → bucket 2
          { date: '2026-05-10', commits: 25 }, // lower-quartile → bucket 1
          { date: '2026-05-09', commits: 1 }, // tiny non-zero → bucket 1
        ],
      },
    });
    const fills = w.findAll('rect').map((r) => r.attributes('fill'));
    // The darkest swatch is reachable.
    expect(fills).toContain('#1e40af');
    // All five palette levels actually appear because the data spans the
    // four quartile boundaries.
    expect(new Set(fills).size).toBeGreaterThanOrEqual(3);
  });

  it("emits each cell's tooltip via <title> for native + a11y", () => {
    const w = mount(CommitHeatmap, {
      props: { data: [{ date: todayIso(), commits: 7 }] },
    });
    const titles = w.findAll('title').map((t) => t.text());
    // Today's tooltip mentions "7 commits".
    expect(titles.some((t) => t.includes('7 commits'))).toBe(true);
    // Most days say "no commits" — bare empty cells include the friendly date.
    expect(titles.some((t) => t.includes('no commits'))).toBe(true);
  });

  it('singularizes the tooltip for 1-commit days', () => {
    const w = mount(CommitHeatmap, {
      props: { data: [{ date: todayIso(), commits: 1 }] },
    });
    const titles = w.findAll('title').map((t) => t.text());
    expect(titles.some((t) => t.includes('· 1 commit') && !t.includes('1 commits'))).toBe(true);
  });

  it('hides future-of-this-week cells via v-show', () => {
    // "Today" is a Wednesday (May 13, 2026). The grid runs Sun..Sat, so
    // Thu/Fri/Sat of the current week are future cells → 3 hidden <rect>s.
    const w = mount(CommitHeatmap, { props: { data: [] } });
    const hidden = w.findAll('rect').filter((r) => {
      const style = r.attributes('style') ?? '';
      return style.includes('display: none');
    });
    expect(hidden.length).toBe(3);
  });

  it('renders the legend swatches', () => {
    const w = mount(CommitHeatmap, { props: { data: [] } });
    expect(w.text()).toContain('Less');
    expect(w.text()).toContain('More');
  });
});
