import type { Meta, StoryObj } from '@storybook/react-vite';
import { UsageMenu } from './UsageMenu';

const limits = (fields: Partial<Parameters<typeof UsageMenu>[0]['limits'] & object> = {}) => ({
  tokensUsed: 120_000,
  tokensLimit: 10_000_000,
  requestsUsed: 12,
  cost: 2.5,
  costEstimated: false,
  groupBudget: null,
  ...fields,
});

/** The header's name button and the month's spend against the budget. Click the name to open it. */
const meta = {
  title: 'Common/UsageMenu',
  component: UsageMenu,
  args: { name: '山田 太郎', limits: limits() },
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 320 }}><Story /></div>],
} satisfies Meta<typeof UsageMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithinBudget: Story = {};

/** 80% and over is where the figure stops being background information. */
export const NearTheLimit: Story = { args: { limits: limits({ cost: 8.6 }) } };

/** No bar and no percentage: 「予算 無制限」. (Read 「$-0.00」 until 2026-09-27.) */
export const Unlimited: Story = { args: { limits: limits({ tokensLimit: -1, cost: 1 }) } };

export const InAGroup: Story = {
  args: { group: 'design', limits: limits({ groupBudget: { limit: 50_000_000, used: 21_000_000, cost: 21 } }) },
};

/** Nothing has arrived yet: a placeholder holds the name's place. */
export const Loading: Story = { args: { name: '', limits: null } };

/** The fetch failed — said so, instead of 「読み込み中…」 for ever. */
export const CouldNotLoad: Story = { args: { limits: null, error: '使用状況を読み込めませんでした。' } };
