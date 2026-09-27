import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppContent } from './App';
import { AdminPanel } from './components/admin/AdminPanel';
import { withApi, withAuth } from '../.storybook/mocks';
import { reactProject } from '../.storybook/fixtures';
import type { MockApi } from '../e2e/fixtures/api';

/**
 * Whole screens, signed in, against the E2E suite's mock API — clickable end to
 * end: open a project, send a request (the job runs and the result appears),
 * compare versions, share, edit by hand.
 */
function seed(api: MockApi) {
  const now = Date.now();
  const stock = api.addProject({ name: '在庫管理', lastHtml: reactProject({ title: '在庫一覧（検索つき）' }) });
  api.addProject({ name: '予約システム', outputKind: 'vue', lastHtml: reactProject({ title: '予約一覧', items: ['10:00 田中', '11:30 鈴木'] }) });
  api.addProject({ name: '古い試作', archivedAt: new Date(now - 86_400_000).toISOString(), lastHtml: reactProject({ title: '試作' }) });
  api.versions.push(
    { versionId: 'v2', projectId: stock.projectId, createdAt: new Date(now - 60_000).toISOString(), prompt: '一覧に検索欄を付けて', html: reactProject({ title: '在庫一覧（検索つき）' }), score: 88, preset: 'none', model: 'haiku' },
    { versionId: 'v1', projectId: stock.projectId, createdAt: new Date(now - 600_000).toISOString(), prompt: '在庫一覧を作って', html: reactProject(), score: 80, preset: 'none', model: 'haiku' },
  );
  api.messages.set(stock.projectId, [
    { id: 'm1', role: 'user', content: '在庫一覧を作って', timestamp: now - 600_000 },
    { id: 'm2', role: 'assistant', content: '在庫一覧の画面を作成しました。', timestamp: now - 590_000 },
    { id: 'm3', role: 'user', content: '一覧に検索欄を付けて', timestamp: now - 70_000 },
    { id: 'm4', role: 'assistant', content: '一覧の上に検索欄を追加しました。', timestamp: now - 60_000 },
  ]);
}

const meta = {
  title: 'Screens/App',
  component: AppContent,
  parameters: { layout: 'fullscreen' },
  decorators: [withApi(seed), withAuth()],
} satisfies Meta<typeof AppContent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The project list; click a card to open it. */
export const ProjectList: Story = {};

/** A project opened: its conversation, versions and preview. */
export const Workspace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '在庫管理' }));
    await expect(await canvas.findByRole('log', { name: '会話履歴' })).toBeInTheDocument();
  },
};

/** A new project, before its first request. */
export const NewProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /新規プロジェクト/ }));
    await expect(await canvas.findByRole('textbox', { name: 'メッセージ入力' })).toBeInTheDocument();
  },
};

/** An account with no projects yet. */
export const Empty: Story = { decorators: [withApi(), withAuth()] };

/** The admin panel, as the account administrator sees it. */
export const AdminPanelOpen: Story = {
  render: () => <div style={{ padding: 16 }}><AdminPanel /></div>,
  decorators: [withApi(undefined, { admin: true }), withAuth('super-admin')],
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole('button', { name: '管理画面を開く' }));
  },
};
