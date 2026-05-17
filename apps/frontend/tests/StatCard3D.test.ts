import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatCard3D from '../src/components/StatCard3D.vue';

const STUBS = {
  // RouterLink is dynamically substituted via :is when `to` is set —
  // stub it as a bare <a> so we can assert visible content + class shape
  // without booting a router.
  RouterLink: { template: '<a><slot /></a>', props: ['to'] },
};

describe('StatCard3D', () => {
  it('renders label, value, and the optional hint', () => {
    const w = mount(StatCard3D, {
      props: {
        label: 'Tracked repositories',
        value: 17,
        hint: 'Across all projects',
        glyphPath: 'M0 0 L10 10',
        tone: 'cyan',
        tilt: { x: 5, y: -3 },
      },
      global: { stubs: STUBS },
    });
    expect(w.text()).toContain('Tracked repositories');
    expect(w.text()).toContain('17');
    expect(w.text()).toContain('Across all projects');
  });

  it.each([
    ['cyan', 'group-hover:text-cyan-500'],
    ['fuchsia', 'group-hover:text-fuchsia-500'],
    ['blue', 'group-hover:text-blue-500'],
    ['yellow', 'group-hover:text-yellow-500'],
    ['green', 'group-hover:text-green-500'],
    ['red', 'group-hover:text-red-500'],
  ] as const)('applies the %s tone highlight class on the glyph', (tone, klass) => {
    const w = mount(StatCard3D, {
      props: {
        label: 'X',
        value: 0,
        glyphPath: 'M0 0',
        tone,
        tilt: { x: 0, y: 0 },
      },
      global: { stubs: STUBS },
    });
    const svg = w.find('svg');
    expect(svg.exists()).toBe(true);
    expect(svg.classes().join(' ')).toContain(klass);
  });

  it('renders as a <div> when `to` is not provided', () => {
    const w = mount(StatCard3D, {
      props: { label: 'L', value: 1, glyphPath: 'M0 0', tone: 'red', tilt: { x: 1, y: 1 } },
      global: { stubs: STUBS },
    });
    // No <a> at the outermost wrapper — Vue renders the bare element.
    expect(w.element.tagName).toBe('DIV');
  });

  it('renders as a RouterLink (stubbed <a>) when `to` is provided', () => {
    const w = mount(StatCard3D, {
      props: {
        label: 'L',
        value: 1,
        glyphPath: 'M0 0',
        tone: 'blue',
        tilt: { x: 0, y: 0 },
        to: { name: 'members' },
      },
      global: { stubs: STUBS },
    });
    expect(w.element.tagName).toBe('A');
  });
});
