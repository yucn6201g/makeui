import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SlidingIndicator } from './SlidingIndicator';

/**
 * The thumb of a segmented control, or the underline of a tab row, as one
 * element that glides between choices. Click the choices to see it move.
 */
const meta = {
  title: 'Common/SlidingIndicator',
  component: SlidingIndicator,
  args: { active: 'all' },
} satisfies Meta<typeof SlidingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

const CHOICES = [['all', 'すべて'], ['react', 'React'], ['vue', 'Vue']] as const;

export const Segmented: Story = {
  render: function Render() {
    const [active, setActive] = useState<string>('all');
    return (
      <div className="project-list__segmented motion-track" role="group" aria-label="フレームワークで絞り込む">
        <SlidingIndicator active={active} />
        {CHOICES.map(([id, label]) => (
          <button key={id} type="button" className={`project-list__segment${active === id ? ' project-list__segment--on' : ''}`} aria-pressed={active === id} onClick={() => setActive(id)}>
            {label}
          </button>
        ))}
      </div>
    );
  },
};

export const Underline: Story = {
  render: function Render() {
    const [active, setActive] = useState('active');
    return (
      <div className="project-list__tabs motion-track" role="tablist" aria-label="表示するプロジェクト">
        <SlidingIndicator active={active} variant="underline" />
        {[['active', 'プロジェクト'], ['shared', '共有'], ['archived', 'アーカイブ']].map(([id, label]) => (
          <button key={id} type="button" role="tab" className="project-list__tab" aria-selected={active === id} onClick={() => setActive(id)}>
            {label}
          </button>
        ))}
      </div>
    );
  },
};
