import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Dropdown, type DropdownOption } from './Dropdown';

const PRESETS: DropdownOption[] = [
  { id: 'none', label: 'プリセットなし', description: 'AIが自由にデザインを決定' },
  { id: 'digital-agency', label: 'デジタル庁デザインシステム', description: '行政サービス向け' },
  { id: 'carbon', label: 'Carbon（IBM）', description: '業務システム・データの多い管理画面' },
];

const MODELS: DropdownOption[] = [
  { id: 'auto', label: '自動', description: '依頼の内容からモデルを選びます' },
  { id: 'haiku', label: 'Haiku', badge: '4.5', description: '速く、安い' },
  { id: 'sonnet', label: 'Sonnet', badge: '5', description: 'バランスのよい標準' },
];

/** A single choice with a description per option: the composer's モード / モデル / デザイン / 形式. */
const meta = {
  title: 'Common/Dropdown',
  component: Dropdown,
  args: { label: 'デザイン', value: 'none', options: PRESETS, onChange: () => {} },
  // Controlled: the story keeps the value, as the composer does.
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <Dropdown {...args} value={value} onChange={(id) => { setValue(id); args.onChange(id); }} />;
  },
} satisfies Meta<typeof Dropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Presets: Story = {};

export const WithBadges: Story = { args: { label: 'モデル', value: 'haiku', options: MODELS } };

/** Opens upwards, as it does in the composer at the bottom of the chat. */
export const OpensUp: Story = { args: { placement: 'up' }, parameters: { layout: 'padded' }, decorators: [(Story) => <div style={{ paddingTop: 240 }}><Story /></div>] };

export const Disabled: Story = { args: { disabled: true, title: '編集中は変更できません' } };
