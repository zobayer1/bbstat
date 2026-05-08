import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatCard from '../src/components/StatCard.vue';

describe('StatCard', () => {
  it('renders label and value', () => {
    const wrapper = mount(StatCard, { props: { label: 'Commits', value: 42 } });
    expect(wrapper.text()).toContain('Commits');
    expect(wrapper.text()).toContain('42');
  });

  it('renders the optional hint when provided', () => {
    const wrapper = mount(StatCard, {
      props: { label: 'Last sync', value: 'never', hint: 'no sync yet' },
    });
    expect(wrapper.text()).toContain('no sync yet');
  });
});
