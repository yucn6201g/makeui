import type { Meta, StoryObj } from '@storybook/react-vite';
import { ErrorBoundary } from './ErrorBoundary';

function Broken(): never {
  throw new Error('e is not iterable');
}

/** What a screen shows when it throws: a sentence to read, and the exception folded away. */
const meta = {
  title: 'Common/ErrorBoundary',
  component: ErrorBoundary,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AScreenThatThrew: Story = { args: { children: <Broken /> } };
