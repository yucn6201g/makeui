import type { Meta, StoryObj } from '@storybook/react-vite';
import { Preview } from './Preview';
import { CodeEditor } from './CodeEditor';
import { CSSInspector } from './CSSInspector';
import { PromptTemplates } from './PromptTemplates';
import { reactProject } from '../../../.storybook/fixtures';

const PROJECT = reactProject();

/** The right-hand pane and the pieces around the composer. */
const meta = {
  title: 'Workspace/Panes',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A generated project, compiled in the browser and running in the sandboxed frame. Its links work. */
export const PreviewDesktop: Story = {
  render: () => <div style={{ height: '100vh', display: 'flex' }}><Preview html={PROJECT} score={86} title="在庫管理" /></div>,
};

export const PreviewMobile: Story = {
  render: () => <div style={{ height: '100vh', display: 'flex' }}><Preview html={PROJECT} score={86} device="mobile" title="在庫管理" /></div>,
};

export const PreviewEmpty: Story = {
  render: () => <div style={{ height: '100vh', display: 'flex' }}><Preview html={null} score={null} /></div>,
};

/** The code tab: the project's files, a tab per open file, and editing. */
export const Code: Story = {
  render: () => <div style={{ height: '100vh', display: 'flex' }}><CodeEditor html={PROJECT} onEditFile={() => {}} /></div>,
};

export const CodeReadOnly: Story = {
  render: () => <div style={{ height: '100vh', display: 'flex' }}><CodeEditor html={PROJECT} /></div>,
};

/** The styles of a selected element, changed in place. */
export const Inspector: Story = {
  parameters: { layout: 'centered' },
  render: () => (
    <div style={{ width: 320 }}>
      <CSSInspector selector="#root > div > main > h1" html={PROJECT} onEdit={() => {}} />
    </div>
  ),
};

/** The briefs a new project can start from, by category. */
export const Templates: Story = {
  parameters: { layout: 'centered' },
  render: () => <div style={{ width: 420 }}><PromptTemplates onSelect={() => {}} /></div>,
};
