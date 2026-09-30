import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ShareButton } from './ShareButton';
import { withApi, withAuth } from '../../../.storybook/mocks';
import { reactProject } from '../../../.storybook/fixtures';

/**
 * Sharing a project: people and groups at three roles, and a public link. The
 * mock keeps what is granted, so people can be added and removed here.
 */
const meta = {
  title: 'Workspace/ShareButton',
  component: ShareButton,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => <div style={{ minHeight: 560, minWidth: 420, display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-start' }}><Story /></div>,
    withApi((api) => {
      const p = api.addProject({ name: '在庫管理', lastHtml: reactProject() });
      api.share(p.projectId, [{ type: 'user', id: 'sub-hanako', label: '佐藤 花子', role: 'edit' }, { type: 'group', id: 'design', label: 'design', role: 'view' }]);
    }),
    withAuth(),
  ],
  args: { html: reactProject(), title: '在庫管理', projectId: 'p-e2e-1', role: 'owner' },
} satisfies Meta<typeof ShareButton>;

export default meta;
type Story = StoryObj<typeof meta>;

const open = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /共有/ }));
  await expect(await canvas.findByRole('dialog', { name: '共有' })).toBeInTheDocument();
};

export const Closed: Story = {};

/** The owner: who has access, adding someone, and the public link. */
export const OwnerPanel: Story = { play: open };

/** A viewer: who has access, and nothing to change. */
export const ViewerPanel: Story = { args: { role: 'view' }, play: open };

/** Nothing generated yet: there is no page to publish. */
export const NothingToPublish: Story = { args: { html: null }, play: open };
