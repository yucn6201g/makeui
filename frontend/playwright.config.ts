import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * .env.e2e, passed to the build as real environment variables.
 *
 * Vite lets variables already in the environment win over any .env file, and
 * CodeBuild has the real VITE_* values in its environment for the production
 * build. Without this the E2E build would point at the real API and user pool.
 */
const E2E_ENV = Object.fromEntries(
  readFileSync(new URL('./.env.e2e', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^VITE_\w+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);

/**
 * End-to-end tests of MakeUI's own screens, against a mocked API and user pool.
 *
 * The app is built with `--mode e2e` (.env.e2e points it at hosts that do not
 * exist) and served by `vite preview`; every request to the API or to Cognito is
 * answered by e2e/fixtures. Nothing reaches AWS and nothing costs anything.
 * See docs/09_e2e_testing.md.
 *
 *   npm run e2e              build, serve and run every test
 *   npm run e2e -- --ui      pick tests and watch them run
 */
const PORT = 4180;
const CI = Boolean(process.env.CI || process.env.CODEBUILD_BUILD_ID);

export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './e2e/test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npm run e2e:build && npx vite preview --mode e2e --outDir dist-e2e --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    env: E2E_ENV,
    reuseExistingServer: !CI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
