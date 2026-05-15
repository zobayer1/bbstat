import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SyncStateIcon from '../src/components/SyncStateIcon.vue';

describe('SyncStateIcon', () => {
  it('renders the synced label + emerald tone for status=ok', () => {
    const wrapper = mount(SyncStateIcon, { props: { status: 'ok' } });
    expect(wrapper.attributes('aria-label')).toBe('Synced');
    expect(wrapper.attributes('title')).toBe('Synced');
    expect(wrapper.classes()).toContain('text-emerald-600');
  });

  it('renders the error label + amber tone for status=error', () => {
    const wrapper = mount(SyncStateIcon, { props: { status: 'error' } });
    expect(wrapper.attributes('aria-label')).toBe('Sync error');
    expect(wrapper.classes()).toContain('text-amber-600');
  });

  it('renders the never label + slate tone for status=never', () => {
    const wrapper = mount(SyncStateIcon, { props: { status: 'never' } });
    expect(wrapper.attributes('aria-label')).toBe('Not synced yet');
    expect(wrapper.classes()).toContain('text-slate-400');
  });

  it('renders the needs-attention label + red tone for status=excluded', () => {
    const wrapper = mount(SyncStateIcon, { props: { status: 'excluded' } });
    expect(wrapper.attributes('aria-label')).toBe('Excluded from sync — needs attention');
    expect(wrapper.classes()).toContain('text-red-600');
  });
});
