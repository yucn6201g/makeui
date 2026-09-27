import type { StorybookConfig } from '@storybook/react-vite';
import { readFileSync } from 'node:fs';

/**
 * Storybook for MakeUI's own components and screens.
 *
 *   npm run storybook          develop, at http://localhost:6006
 *   npm run build-storybook    the static build (storybook-static/), checked in CI
 *
 * The project's vite.config.ts is used as it is, so the preview's framework
 * runtimes (virtual:react-runtime, virtual:vue-global) work in stories too.
 *
 * The API and Cognito settings are the E2E ones from .env.e2e, never the real
 * ones: auth/cognito.ts builds its user pool when it is imported, and a story
 * must not reach the deployed API. Requests the stories make are answered by
 * the E2E mock (see mocks.tsx).
 */
const E2E_ENV = Object.fromEntries(
  readFileSync(new URL('../.env.e2e', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^VITE_\w+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  viteFinal: async (vite) => ({
    ...vite,
    define: {
      ...vite.define,
      ...Object.fromEntries(Object.entries(E2E_ENV).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
    },
  }),
};

export default config;
