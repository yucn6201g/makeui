import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { BudgetEditor, ModelPicker, NameEditor, PeriodPicker } from './editors';
import { THIS_MONTH, type Period } from './shared';
import type { ModelId } from '../../hooks/useAdmin';

/**
 * The admin panel's inline editors, on their own: a budget, the models allowed,
 * an account's name and a reporting period. Each saves through a prop, so here
 * the save is a short wait that succeeds, or one that fails.
 */
const meta = {
  title: 'Admin/Editors',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const wait = () => new Promise<void>((r) => setTimeout(r, 300));

function Budget({ initial, fail = false, disabled = false }: { initial: number; fail?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <BudgetEditor
      value={value}
      disabled={disabled}
      onSave={async (limit) => { await wait(); if (fail) throw new Error('予算を保存できませんでした。もう一度お試しください。'); setValue(limit); }}
    />
  );
}

/** A budget of $25; 「編集」 opens the field. */
export const BudgetSet: Story = { render: () => <Budget initial={25_000_000} /> };

/** No budget. */
export const BudgetUnlimited: Story = { render: () => <Budget initial={-1} /> };

/** Read-only, for an administrator who may not change it. */
export const BudgetReadOnly: Story = { render: () => <Budget initial={25_000_000} disabled /> };

/** Zero is refused before anything is sent. */
export const BudgetRefusesZero: Story = {
  render: () => <Budget initial={25_000_000} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '月間予算を編集' }));
    const field = canvas.getByRole('spinbutton', { name: '月間予算（USD）' });
    await userEvent.clear(field);
    await userEvent.type(field, '0');
    await userEvent.click(canvas.getByRole('button', { name: '保存' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('0より大きい金額を入力してください。');
  },
};

function Models({ initial }: { initial: ModelId[] }) {
  const [models, setModels] = useState(initial);
  return <ModelPicker models={models} onSave={async (m) => { await wait(); setModels(m); }} />;
}

/** Every model allowed; Opus is shown but cannot be granted. */
export const ModelsAll: Story = { render: () => <Models initial={['haiku', 'sonnet', 'opus', 'auto']} /> };

/** One real model left: it cannot be taken away. */
export const ModelsLastOne: Story = { render: () => <Models initial={['haiku']} /> };

function Name({ fail = false }: { fail?: boolean }) {
  const [name, setName] = useState('佐藤 花子');
  return (
    <NameEditor
      user={{ username: 'hanako@example.invalid', email: 'hanako@example.invalid', displayName: name, displayNameSet: true, group: null, isGroupAdmin: false, status: 'CONFIRMED', enabled: true, createdAt: new Date().toISOString() }}
      onRename={async (_u, n) => { await wait(); if (fail) throw new Error('ユーザー名を変更できませんでした。もう一度お試しください。'); setName(n); }}
    />
  );
}

export const NameAtRest: Story = { render: () => <Name /> };

/** Editing: Enter saves, Escape abandons. */
export const NameEditing: Story = {
  render: () => <Name />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '佐藤 花子 のユーザー名を編集' }));
  },
};

function Period_() {
  const [value, setValue] = useState<Period>(THIS_MONTH);
  return <PeriodPicker value={value} onChange={setValue} />;
}

/** The reporting period: this month, last, three or six, or a range. */
export const ReportingPeriod: Story = { render: () => <Period_ /> };
