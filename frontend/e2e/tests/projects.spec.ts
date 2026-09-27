import { test, expect } from '../fixtures/test';
import { projectList } from '../fixtures/screens';
import { reactProject } from '../fixtures/project';

test.beforeEach(async ({ api }) => {
  api.addProject({ name: '在庫管理', outputKind: 'react' });
  api.addProject({ name: '予約システム', outputKind: 'vue' });
  api.addProject({ name: '古い試作', outputKind: 'react', archivedAt: new Date().toISOString() });
});

const cards = (page: import('@playwright/test').Page) =>
  page.getByText(/^(在庫管理|予約システム|古い試作)$/);

test('the list loads the projects, the models and the usage once signed in', async ({ page, api }) => {
  await page.goto('/');
  await expect(cards(page)).toHaveText(['在庫管理', '予約システム']);
  // Each tab carries its count, the archive included.
  await expect(projectList(page).getByRole('tab', { name: /プロジェクト/ })).toContainText('2');
  await expect(projectList(page).getByRole('tab', { name: /アーカイブ/ })).toContainText('1');
  expect(api.all('GET', '/projects')).toHaveLength(1);
  expect(api.all('GET', '/usage').length).toBeGreaterThanOrEqual(1);
});

test('search narrows the list by name', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'プロジェクト名で検索' }).fill('予約');
  await expect(cards(page)).toHaveText(['予約システム']);
  await page.getByRole('button', { name: '検索条件をクリア' }).click();
  await expect(cards(page)).toHaveText(['在庫管理', '予約システム']);
});

test('the framework filter shows one framework', async ({ page }) => {
  await page.goto('/');
  const filter = page.getByRole('group', { name: 'フレームワークで絞り込む' });
  await filter.getByRole('button', { name: /Vue/ }).click();
  await expect(cards(page)).toHaveText(['予約システム']);
  await filter.getByRole('button', { name: /すべて/ }).click();
  await expect(cards(page)).toHaveText(['在庫管理', '予約システム']);
});

test('archiving moves a project to the archive tab, and restoring brings it back', async ({ page, api }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '在庫管理 をアーカイブ', exact: true }).click();
  await expect(cards(page)).toHaveText(['予約システム']);
  await expect.poll(() => api.last('PUT', '/projects/p-e2e-1')?.body).toEqual({ archived: true });

  await projectList(page).getByRole('tab', { name: /アーカイブ/ }).click();
  await expect(cards(page)).toHaveText(['在庫管理', '古い試作']);
  await page.getByRole('button', { name: '在庫管理 を復元', exact: true }).click();
  await expect.poll(() => api.last('PUT', '/projects/p-e2e-1')?.body).toEqual({ archived: false });
  await expect(cards(page)).toHaveText(['古い試作']);
});

test.describe('a long list', () => {
  /*
   * With 120 projects a tab, a tab change used to mount every card's thumbnail
   * frame — each one running its app — and hold the main thread for about 0.9 s
   * (2026-09-27). Thumbnails now wait until their card comes near the viewport,
   * a bulk change drops the old cards at once, and unchanged cards are not
   * redrawn. Timing is left to the measurements in the commit; what is held
   * here is the mechanism.
   */
  test.beforeEach(({ api }) => {
    for (let i = 0; i < 60; i++) api.addProject({ name: `案件 ${i}`, lastHtml: reactProject() });
    for (let i = 0; i < 60; i++) api.addProject({ name: `古い案件 ${i}`, lastHtml: reactProject(), archivedAt: new Date().toISOString() });
  });

  test('switching tabs builds thumbnails only for the cards near the screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('案件 59', { exact: true })).toBeAttached();
    await projectList(page).getByRole('tab', { name: /アーカイブ/ }).click();
    await expect(page.getByText('古い案件 59', { exact: true })).toBeAttached();
    await expect(page.locator('iframe.project-list__card-iframe').first()).toBeVisible();
    const frames = await page.locator('iframe.project-list__card-iframe').count();
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(30);
    // The old tab's cards are gone, not kept for an exit nobody sees.
    await expect(page.getByText('案件 0', { exact: true })).toHaveCount(0);
  });

  test('a card further down gets its thumbnail once scrolled to', async ({ page }) => {
    await page.goto('/');
    const last = page.locator('.project-list__card').filter({ hasText: '案件 59' });
    await expect(last).toBeAttached();
    await expect(last.locator('iframe')).toHaveCount(0);
    await last.scrollIntoViewIfNeeded();
    await expect(last.locator('iframe')).toBeVisible();
  });

  test('the tab row answers the click at once', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('案件 0', { exact: true })).toBeVisible();
    const archive = projectList(page).getByRole('tab', { name: /アーカイブ/ });
    await archive.click();
    await expect(archive).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('古い案件 0', { exact: true })).toBeVisible();
  });
});
