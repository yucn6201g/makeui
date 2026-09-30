import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectCard, type CardActions } from './ProjectCard';
import type { Project } from '../../hooks/useProjects';
import { reactProject } from '../../../.storybook/fixtures';

/**
 * One card of the project list, in each state it can be in. The list gives a
 * card only its own state and one object of actions (see ProjectList), so every
 * state is reachable from props alone.
 */
const noop = () => {};
const actions: CardActions = { activate: noop, archive: noop, favourite: noop, askDelete: noop, cancelDelete: noop, delete: noop };
const now = Date.now();
const base: Project = {
  projectId: 'p-story', userId: 'sub-story', name: '在庫管理', createdAt: new Date(now - 86_400_000).toISOString(),
  updatedAt: new Date(now - 3_600_000).toISOString(), outputKind: 'react', lastHtml: reactProject(), totalTokens: 184_000, requestCount: 6,
};

const meta = {
  title: 'Project list/ProjectCard',
  component: ProjectCard,
  parameters: { layout: 'padded' },
  decorators: [(Story) => <div className="project-list__grid" style={{ width: 260, display: 'block' }}><Story /></div>],
  args: {
    project: base, exiting: false, selecting: false, isSelected: false, running: false, confirming: false, actions,
    fetchHtml: async () => null,
  },
} satisfies Meta<typeof ProjectCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Starred: the star stays visible. */
export const Favourite: Story = { args: { project: { ...base, favouritedAt: new Date(now).toISOString() } } };

/** A run for it is going in this browser. */
export const Running: Story = { args: { running: true } };

/** Put away: restore and delete only, and no way in. */
export const Archived: Story = { args: { project: { ...base, archivedAt: new Date(now).toISOString() } } };

/** Choosing several: the card is a checkbox. */
export const Selected: Story = { args: { selecting: true, isSelected: true } };

/** Shared by this account: who with. */
export const SharedByMe: Story = {
  args: {
    project: {
      ...base, sharedAt: new Date(now).toISOString(),
      sharedWith: [
        { type: 'user', label: '佐藤 花子', role: 'edit' },
        { type: 'group', label: 'design', role: 'view' },
        { type: 'user', label: '鈴木 次郎', role: 'full' },
      ],
    },
  },
};

/** Shared with this account for viewing: whose it is, and no star or archive. */
export const SharedWithMe: Story = {
  args: {
    project: {
      ...base, sharedAt: new Date(now).toISOString(),
      access: { role: 'view', ownerId: 'sub-owner', ownerName: '山田 太郎', via: 'user' },
      sharedWith: [{ type: 'user', label: '鈴木 次郎', role: 'edit' }],
    },
  },
};

/** Deleting from the archive asks on the card itself. */
export const ConfirmingDelete: Story = { args: { project: { ...base, archivedAt: new Date(now).toISOString() }, confirming: true } };

/** A long name and a Vue project with no document yet. */
export const LongNameNoDocument: Story = {
  args: {
    project: { ...base, name: '顧客管理と在庫管理と予約管理をひとつにまとめた社内向けダッシュボード', outputKind: 'vue', lastHtml: undefined, hasDocument: false, totalTokens: 0, requestCount: 0 },
  },
};
