import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Every story in the built Storybook renders: no error screen, no uncaught
 * exception, its play function (if any) finishes, and axe finds nothing on
 * MakeUI's own UI (the generated app inside a frame is excluded, as in the E2E
 * suite and the a11y addon).
 *
 * The list is read from storybook-static/index.json, so a new story is checked
 * the day it is written.
 */
const index = JSON.parse(readFileSync(new URL('../../storybook-static/index.json', import.meta.url), 'utf8')) as {
  entries: Record<string, { id: string; title: string; name: string; type: string }>;
};
const stories = Object.values(index.entries).filter((e) => e.type === 'story');

test('the build lists the stories', () => {
  expect(stories.length).toBeGreaterThan(20);
});

for (const story of stories) {
  test(`${story.title} / ${story.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // MakeUI's web fonts: answered empty, so nothing here depends on the network.
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.fulfill({ status: 200, body: '' }));

    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await expect(page.locator('#storybook-root > *').first()).toBeAttached();
    // Storybook marks the body when a story throws or its play function fails.
    await page.waitForTimeout(600);
    await expect(page.locator('body.sb-show-errordisplay')).toHaveCount(0);
    expect(errors, 'uncaught exceptions').toEqual([]);

    // Finite ones only: the progress placeholders loop for as long as a run lasts.
    await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).forEach((a) => a.finish()));
    // The a11y addon runs axe in the page itself after each render; wait for it to finish rather than collide.
    const analyze = async (attempt = 0): Promise<Awaited<ReturnType<AxeBuilder['analyze']>>> => {
      try {
        return await new AxeBuilder({ page }).include('#storybook-root').exclude('iframe').analyze();
      } catch (e) {
        if (attempt < 10 && /already running/.test(String(e))) {
          await page.waitForTimeout(300);
          return analyze(attempt + 1);
        }
        throw e;
      }
    };
    const { violations } = await analyze();
    expect(violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
}
