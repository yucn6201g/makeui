import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures/test';
import { reactProject } from '../fixtures/project';
import { composer, openProject, preview, projectList, send } from '../fixtures/screens';

/*
 * At phone width (390×844, touch). Found on 2026-09-27: the workspace kept its
 * 420px chat column on a 390px screen — the preview was pushed off it and the
 * header's and composer's right-hand controls were cut — because the chat
 * width, written inline as the grid template, beat the phone layout's single
 * column. Nothing overflowed the page, so nothing scrolled: the controls were
 * simply out of reach.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

/** Every one of these is fully inside the screen's width. */
async function expectWithinWidth(page: Page, locators: Locator[]) {
  const width = page.viewportSize()!.width;
  for (const l of locators) {
    const box = await l.boundingBox();
    expect(box, `${l} is on screen`).not.toBeNull();
    expect(box!.x, `${l} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${l} ends on screen`).toBeLessThanOrEqual(width + 0.5);
  }
}

test.beforeEach(({ api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
});

test('the project list fits and its controls are reachable', async ({ page }) => {
  await page.goto('/');
  await expect(projectList(page)).toBeVisible();
  await expectWithinWidth(page, [
    projectList(page),
    page.getByRole('searchbox', { name: 'プロジェクト名で検索' }),
    page.getByRole('button', { name: /新規プロジェクト/ }),
    page.getByRole('button', { name: 'ログアウト' }),
  ]);
  // Tab labels stay on one line.
  for (const tab of await projectList(page).getByRole('tab').all()) {
    const box = (await tab.boundingBox())!;
    expect(box.height).toBeLessThan(60);
  }
});

test('the workspace stacks: the conversation, then the preview, all within the screen', async ({ page }) => {
  await openProject(page, '在庫管理');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  await expectWithinWidth(page, [
    page.getByRole('button', { name: '共有', exact: true }),
    page.getByRole('button', { name: 'ログアウト' }),
    composer(page),
    page.getByRole('button', { name: '送信', exact: true }),
    page.getByRole('region', { name: 'プレビュー' }),
  ]);
  // The preview is under the conversation, not beside it.
  const chat = (await page.getByRole('region', { name: 'チャット' }).boundingBox())!;
  const shown = (await page.getByRole('region', { name: 'プレビュー' }).boundingBox())!;
  expect(shown.y).toBeGreaterThanOrEqual(chat.y + chat.height - 1);
});

test('a request can be sent and its result seen, by touch', async ({ page, api }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /新規プロジェクト/ }).tap();
  await send(page, '在庫一覧の画面を作ってください');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  expect(api.all('POST', '/generate')).toHaveLength(1);
});
