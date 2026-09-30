import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AdminPanel } from './AdminPanel';
import { withApi, withAuth } from '../../../.storybook/mocks';
import { ADMIN_USAGE, ADMIN_USERS } from '../../../e2e/fixtures/admin';
import type { MockApi } from '../../../e2e/fixtures/api';

/**
 * The admin panel, one story per tab, against the E2E suite's admin mock —
 * which keeps what is written, so each tab can be edited here as in the app.
 */
const meta = {
  title: 'Admin/AdminPanel',
  component: AdminPanel,
  parameters: { layout: 'fullscreen' },
  render: () => <div style={{ padding: 16 }}><AdminPanel /></div>,
  decorators: [withApi(undefined, { admin: true }), withAuth('super-admin')],
} satisfies Meta<typeof AdminPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const openOn = (tab: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: '管理画面を開く' }));
  const panel = await canvas.findByRole('region', { name: '管理画面' });
  await userEvent.click(await within(panel).findByRole('button', { name: new RegExp(`^${tab}`) }));
  return within(panel);
};

export const Usage: Story = { play: async (ctx) => { await openOn('使用量')(ctx); } };
export const Models: Story = { play: async (ctx) => { await openOn('モデル')(ctx); } };
export const Users: Story = {
  play: async (ctx) => {
    const panel = await openOn('ユーザー管理')(ctx);
    await expect(await panel.findByRole('table', { name: 'Cognitoユーザー一覧' })).toBeInTheDocument();
  },
};
export const Projects: Story = {
  play: async (ctx) => {
    const panel = await openOn('プロジェクト')(ctx);
    await userEvent.click(await panel.findByRole('button', { name: /山田 太郎/ }));
    await userEvent.click(await panel.findByText('在庫管理'));
    await expect(await panel.findByText('検索欄を付けて')).toBeInTheDocument();
  },
};
export const Groups: Story = {
  play: async (ctx) => {
    const panel = await openOn('グループ')(ctx);
    await userEvent.click(await panel.findByText('design', { selector: 'td *, td' }));
  },
};

function manyAccounts(api: MockApi) {
  const usage = [], users = [];
  for (let i = 0; i < 300; i++) {
    usage.push({ ...ADMIN_USAGE[1], userId: `sub-${i}`, email: `u${i}@example.invalid`, displayName: `利用者 ${i}`, projectCount: i % 5 });
    users.push({ ...ADMIN_USERS[1], username: `u${i}@example.invalid`, email: `u${i}@example.invalid`, displayName: `利用者 ${i}` });
  }
  api.on('GET', '/admin/usage', { body: { users: usage } });
  api.on('GET', '/admin/users', { body: { users } });
}

/** Three hundred accounts: rows are drawn a few screens at a time. */
export const ManyAccounts: Story = {
  decorators: [withApi(manyAccounts, { admin: true }), withAuth('super-admin')],
  play: async (ctx) => { await openOn('ユーザー管理')(ctx); },
};

/** A group administrator: their group only, and no account-wide tabs. */
export const GroupAdministrator: Story = {
  decorators: [withApi(undefined, { admin: true }), withAuth('super-admin', { membership: { role: 'group-admin', group: 'design' } })],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '管理画面を開く' }));
    const panel = within(await canvas.findByRole('region', { name: '管理画面' }));
    await expect(panel.queryByRole('button', { name: /^グループ/ })).toBeNull();
  },
};
