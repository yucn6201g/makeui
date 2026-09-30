import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { VersionDiff } from './VersionDiff';
import { withApi } from '../../../.storybook/mocks';
import { reactProject } from '../../../.storybook/fixtures';

/**
 * Comparing two versions side by side, the screens linked, and the code. The
 * versions are fetched from the mock API as the workspace fetches them.
 */
const now = Date.now();
const versions = [
  { versionId: 'v2', projectId: 'p-e2e-1', createdAt: new Date(now - 60_000).toISOString(), prompt: '一覧に検索欄を付けて', score: 88, preset: 'none', model: 'haiku' },
  { versionId: 'v1', projectId: 'p-e2e-1', createdAt: new Date(now - 600_000).toISOString(), prompt: '在庫一覧を作って', score: 80, preset: 'none', model: 'haiku' },
];

const meta = {
  title: 'Version diff/VersionDiff',
  component: VersionDiff,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => <div style={{ padding: 16, minHeight: '100vh' }}><Story /></div>,
    withApi((api) => {
      api.addProject({ name: '在庫管理', lastHtml: reactProject({ title: '在庫一覧（検索つき）' }) });
      api.versions.push(
        { ...versions[0], html: reactProject({ title: '在庫一覧（検索つき）' }) },
        { ...versions[1], html: reactProject() },
      );
    }),
  ],
  args: {
    currentHtml: reactProject({ title: '在庫一覧（検索つき）' }),
    versions: versions as never,
    apiUrl: 'http://api.e2e.test',
    token: 'storybook-token',
    projectId: 'p-e2e-1',
  },
} satisfies Meta<typeof VersionDiff>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

/** Opened: the two versions side by side. */
export const Comparing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '比較' }));
    await expect(await canvas.findByRole('dialog', { name: 'バージョン比較' })).toBeInTheDocument();
  },
};

/** With only one version there is nothing to compare against. */
export const OneVersion: Story = { args: { versions: versions.slice(0, 1) as never } };
