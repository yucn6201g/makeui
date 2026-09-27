import type { Meta, StoryObj } from '@storybook/react-vite';
import { GeneratingCanvas } from './GeneratingCanvas';
import { ActivityCard } from './ActivityCard';
import { ReasoningTranscript } from './ReasoningTranscript';
import { PHASES_DONE, PHASES_RUNNING } from '../../../.storybook/fixtures';

/** What a run looks like while it runs: the preview's placeholder, the chat's card, and its transcript. */
const meta = {
  title: 'Workspace/Progress',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The preview before there is anything to preview: a wireframe assembling itself. */
export const GeneratingPreview: Story = {
  render: () => <div style={{ width: 720, height: 480, display: 'flex' }}><GeneratingCanvas phases={PHASES_RUNNING} /></div>,
};

export const ModifyingPreview: Story = {
  render: () => <div style={{ width: 720, height: 480, display: 'flex' }}><GeneratingCanvas phases={PHASES_RUNNING} mode="modify" /></div>,
};

/** The running job in the chat thread. */
export const RunningCard: Story = {
  render: () => <div style={{ width: 380 }}><ActivityCard title="生成中" phases={PHASES_RUNNING} isActive /></div>,
};

/** The transcript kept with the reply, collapsed steps with their time and tokens. */
export const FinishedTranscript: Story = {
  render: () => <div style={{ width: 380 }}><ReasoningTranscript phases={PHASES_DONE} isActive={false} /></div>,
};
