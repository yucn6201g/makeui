import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { LiveFrame } from './LiveFrame';
import { reactProject } from '../../../.storybook/fixtures';

/**
 * The comparison's frames: two versions running side by side. With following
 * on, a screen change on one side moves the other — click 「設定」 in either.
 */
const meta = {
  title: 'Version diff/LiveFrame',
  component: LiveFrame,
  parameters: { layout: 'fullscreen' },
  args: { html: null, title: '比較対象' },
} satisfies Meta<typeof LiveFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SideBySide: Story = {
  render: function Render() {
    const [hash, setHash] = useState<string | null>(null);
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, height: '100vh', padding: 12, boxSizing: 'border-box' }}>
        <LiveFrame html={reactProject()} title="比較対象" hash={hash} onNavigate={setHash} />
        <LiveFrame html={reactProject({ title: '在庫一覧（検索つき）' })} title="比較対象" hash={hash} onNavigate={setHash} />
      </div>
    );
  },
};
