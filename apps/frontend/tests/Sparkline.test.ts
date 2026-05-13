import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Sparkline from '../src/components/Sparkline.vue';

describe('Sparkline', () => {
  it('renders the SVG with the requested dimensions + viewBox', () => {
    const w = mount(Sparkline, { props: { points: [0, 1, 2, 3], width: 60, height: 20 } });
    const svg = w.find('svg');
    expect(svg.attributes('width')).toBe('60');
    expect(svg.attributes('height')).toBe('20');
    expect(svg.attributes('viewBox')).toBe('0 0 60 20');
  });

  it('emits a polyline path proportional to point values', () => {
    const w = mount(Sparkline, { props: { points: [0, 10], width: 100, height: 20 } });
    const d = w.find('path').attributes('d')!;
    // Two points → "M x0 y0 L x1 y1". y is inverted (SVG y grows down).
    expect(d).toBe('M 0.00 20.00 L 100.00 0.00');
  });

  it('renders an empty path when fewer than 2 points provided', () => {
    const w = mount(Sparkline, { props: { points: [5] } });
    expect(w.find('path').attributes('d')).toBe('');
  });

  it('aria-label reflects peak and length', () => {
    const w = mount(Sparkline, { props: { points: [1, 2, 7, 3] } });
    expect(w.find('svg').attributes('aria-label')).toBe('4-day activity, peak 7');
  });

  it('flatlines when every point is 0 (no division by zero)', () => {
    const w = mount(Sparkline, { props: { points: [0, 0, 0, 0], width: 30, height: 10 } });
    // max defaults to 1 so y = 10 - 0 = 10 for every point.
    expect(w.find('path').attributes('d')).toBe('M 0.00 10.00 L 10.00 10.00 L 20.00 10.00 L 30.00 10.00');
  });
});
