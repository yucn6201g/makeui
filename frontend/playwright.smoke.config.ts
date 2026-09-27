import { defineConfig, devices } from '@playwright/test';

/**
 * L3 smoke: the deployed MakeUI with a real test account. Run by hand, never in
 * CI — it signs in for real and can spend money. See e2e/smoke/smoke.spec.ts
 * for the environment it needs and docs/09_e2e_testing.md for when to run it.
 *
 *   npm run e2e:smoke
 */
export default defineConfig({
  testDir: './e2e/smoke',
  outputDir: './e2e/test-results/smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.MAKEUI_SMOKE_URL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    // A trace would record what was typed into the sign-in form.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
