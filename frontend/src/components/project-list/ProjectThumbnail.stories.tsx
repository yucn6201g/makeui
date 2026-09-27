import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectThumbnail } from './ProjectThumbnail';
import { reactProject } from '../../../.storybook/fixtures';

/** A project card's preview: the document drawn small, without its scripts. */
const meta = {
  title: 'Project list/ProjectThumbnail',
  component: ProjectThumbnail,
  args: { title: '在庫管理' },
  decorators: [(Story) => <div className="project-list__card" style={{ width: 260 }}><div className="project-list__card-preview"><Story /></div></div>],
} satisfies Meta<typeof ProjectThumbnail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithDocument: Story = { args: { html: reactProject() } };

/** Fetched when the card needs it, as the list does. */
export const Fetched: Story = {
  args: { projectId: 'p1', hasDocument: true, fetchHtml: async () => reactProject({ title: '予約一覧' }) },
};

/** Nothing built yet. */
export const Empty: Story = { args: { html: null, hasDocument: false } };

/** The document could not be fetched. */
export const CouldNotLoad: Story = {
  args: { projectId: 'p2', hasDocument: true, fetchHtml: async () => { throw new Error('offline'); } },
};
