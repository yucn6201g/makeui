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

/*
 * The count beside お気に入り was every starred project outside the archive, so
 * すべて/React/Vue — and プロジェクト/共有 — never moved it (2026-09-27). Each
 * count now says what pressing its control would show, the other filter as set.
 */
test('the favourite count follows the framework and the tab, and the framework counts follow the star', async ({ page, api }) => {
  const starred = new Date().toISOString();
  api.addProject({ name: 'React の星 1', outputKind: 'react', favouritedAt: starred });
  api.addProject({ name: 'React の星 2', outputKind: 'react', favouritedAt: starred });
  api.addProject({ name: 'Vue の星', outputKind: 'vue', favouritedAt: starred });
  const sharedStar = api.addProject({ name: '共有の星', outputKind: 'vue', favouritedAt: starred });
  api.share(sharedStar.projectId, [{ type: 'user', id: 'sub-hanako', label: '佐藤 花子', role: 'edit' }]);

  await page.goto('/');
  const frameworks = page.getByRole('group', { name: 'フレームワークで絞り込む' });
  const star = page.getByRole('button', { name: /^お気に入り/ });
  await expect(star).toContainText('3');
  await frameworks.getByRole('button', { name: /React/ }).click();
  await expect(star).toContainText('2');
  await frameworks.getByRole('button', { name: /Vue/ }).click();
  await expect(star).toContainText('1');

  // And the other way: with the star on, each framework counts its starred ones.
  await frameworks.getByRole('button', { name: /すべて/ }).click();
  await expect(frameworks.getByRole('button', { name: /React/ })).toContainText('3'); // 在庫管理 + 2 starred
  await star.click();
  await expect(frameworks.getByRole('button', { name: /React/ })).toContainText('2');
  await expect(frameworks.getByRole('button', { name: /すべて/ })).toContainText('3');
  await expect(page.getByText(/の星/)).toHaveCount(3);

  // The 共有 tab counts its own.
  await projectList(page).getByRole('tab', { name: /共有/ }).click();
  await expect(star).toContainText('1');
  await expect(page.getByText('共有の星', { exact: true })).toBeVisible();
});

test('clearing the filters clears the star too', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^お気に入り/ }).click();
  await page.getByRole('button', { name: '条件をクリア' }).click();
  await expect(page.getByRole('button', { name: /^お気に入り/ })).toHaveAttribute('aria-pressed', 'false');
  await expect(cards(page)).toHaveText(['在庫管理', '予約システム']);
});

/*
 * The 共有 tab said 「共有中」 on the owner's cards and nothing about with whom
 * (2026-09-27). Two names and a count of the rest; the whole list, roles
 * included, is what a screen reader reads.
 */
test('a shared project\'s card names who it is shared with', async ({ page, api }) => {
  const mine = api.addProject({ name: '共有した案件', outputKind: 'react' });
  api.share(mine.projectId, [
    { type: 'user', id: 'sub-hanako', label: '佐藤 花子', role: 'edit' },
    { type: 'group', id: 'design', label: 'design', role: 'view' },
    { type: 'user', id: 'sub-jiro', label: '鈴木 次郎', role: 'full' },
  ]);
  const theirs = api.addProject({
    name: '共有された案件', outputKind: 'vue', userId: 'sub-owner',
    access: { role: 'view', ownerId: 'sub-owner', ownerName: '所有者', via: 'user' },
  });
  // Shared with this account and one other; the card leaves this account out.
  api.share(theirs.projectId, [
    { type: 'user', id: 'sub-e2e', label: 'E2E 利用者', role: 'view' },
    { type: 'user', id: 'sub-jiro', label: '鈴木 次郎', role: 'edit' },
  ]);

  await page.goto('/');
  await projectList(page).getByRole('tab', { name: /共有/ }).click();
  const card = (name: string) => page.locator('.project-list__card').filter({ hasText: name });

  const members = card('共有した案件').locator('.project-list__card-members');
  await expect(members).toContainText('共有先');
  await expect(members).toContainText('佐藤 花子、design（グループ）');
  await expect(members).toContainText('ほか1件');
  await expect(members).toContainText('共有先: 佐藤 花子（編集）、design（グループ）（閲覧）、鈴木 次郎（全権限）');
  await expect(card('共有した案件')).not.toContainText('共有中');

  await expect(card('共有された案件')).toContainText('所有者 さんから共有');
  await expect(card('共有された案件').locator('.project-list__card-members')).toContainText('鈴木 次郎');
  await expect(card('共有された案件')).not.toContainText('E2E 利用者');
});
