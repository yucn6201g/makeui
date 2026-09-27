import type { Preview } from '@storybook/react-vite';
import '../src/index.css';

const preview: Preview = {
  parameters: {
    layout: 'centered',
    controls: { expanded: true },
    // The same bar as the E2E suite: no axe violation on MakeUI's own UI. The
    // generated app inside a preview frame is the user's, and is not checked here.
    a11y: {
      test: 'error',
      context: { exclude: ['iframe'] },
    },
    options: {
      storySort: { order: ['Screens', 'Workspace', 'Project list', 'Version diff', 'Admin', 'Sign-in', 'Common'] },
    },
  },
};

export default preview;
