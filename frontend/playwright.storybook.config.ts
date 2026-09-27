import { defineConfig, devices } from '@playwright/test';

/**
 * Checks the built Storybook (storybook-static/) story by story.
 *
 *   npm run test-storybook     build it, then check every story
 */
const PORT = 6007;
const CI = Boolean(process.env.CI || process.env.CODEBUILD_BUILD_ID);

export default defineConfig({
  testDir: './e2e/storybook',
  outputDir: './e2e/test-results/storybook',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite preview --outDir storybook-static --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
