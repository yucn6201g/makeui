import { test, expect } from '../fixtures/test';
import { projectList } from '../fixtures/screens';

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
