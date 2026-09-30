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

/** The project list could not be read: said so, with 再試行. */
export const ProjectListCouldNotLoad: Story = {
  decorators: [withApi((api) => { api.on('GET', '/projects', { status: 503, body: { message: 'Service Unavailable' } }); }), withAuth()],
};

/** A hundred and fifty projects a tab: a screenful drawn, more on scrolling. */
export const ManyProjects: Story = {
  decorators: [withApi((api) => {
    const starred = new Date().toISOString();
    for (let i = 0; i < 150; i++) {
      api.addProject({ name: `案件 ${i}`, outputKind: i % 3 === 0 ? 'vue' : 'react', lastHtml: reactProject({ title: `在庫 ${i}` }), ...(i % 9 === 0 ? { favouritedAt: starred } : {}) });
    }
  }), withAuth()],
};

/** A long conversation: two hundred exchanges, each reply formatted. */
export const LongConversation: Story = {
  decorators: [withApi((api) => {
    const now = Date.now();
    const project = api.addProject({ name: '長い会話', lastHtml: reactProject() });
    const messages = [];
    for (let i = 0; i < 200; i++) {
      messages.push({ id: `u${i}`, role: 'user', content: `一覧に機能 ${i} を足して`, timestamp: now - (200 - i) * 60_000 });
      messages.push({ id: `a${i}`, role: 'assistant', content: `## 変更 ${i}\n\n一覧に**機能 ${i}**を追加しました。\n\n- 検索\n- 並び替え`, timestamp: now - (200 - i) * 60_000 + 30_000 });
    }
    api.messages.set(project.projectId, messages);
  }), withAuth()],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: '長い会話' }));
    await expect(await canvas.findByText('変更 199')).toBeInTheDocument();
  },
};

/** A project shared with this account for viewing: readable, not editable. */
export const SharedForViewing: Story = {
  decorators: [withApi((api) => {
    api.addProject({
      name: '共有された案件', userId: 'sub-owner', lastHtml: reactProject(), sharedAt: new Date().toISOString(),
      access: { role: 'view', ownerId: 'sub-owner', ownerName: '山田 太郎', via: 'user' },
    });
  }), withAuth()],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('tab', { name: /共有/ }));
    await userEvent.click(await canvas.findByRole('button', { name: '共有された案件' }));
  },
};
