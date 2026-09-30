import { test, expect } from '../fixtures/test';
import { projectList } from '../fixtures/screens';
import { reactProject } from '../fixtures/project';

/*
 * The project list's remaining controls, each through the screen (2026-09-30):
 * the star on a card, deleting one project, the order, a list that will not
 * load, and the three ways of having nothing to show.
 */

const names = (page: import('@playwright/test').Page) =>
  page.locator('.project-list__card:not(.project-list__card--new) .project-list__card-name');

test.describe('with projects', () => {
  test.beforeEach(({ api }) => {
    api.addProject({ name: '安い', lastHtml: reactProject(), totalTokens: 10_000, requestCount: 9 });
    api.addProject({ name: '高い', lastHtml: reactProject(), totalTokens: 900_000, requestCount: 1 });
    api.addProject({ name: '中くらい', lastHtml: reactProject(), totalTokens: 200_000, requestCount: 5 });
  });

  test('a star puts a project first and counts it, and taking it away undoes both', async ({ page, api }) => {
    await page.goto('/');
    await expect(names(page)).toHaveText(['安い', '高い', '中くらい']);
    const star = page.getByRole('button', { name: /^お気に入り/ });
    await expect(star).toContainText('0');

    await page.getByRole('button', { name: '中くらい をお気に入りに追加' }).click();
    await expect.poll(() => api.last('PUT', '/projects/p-e2e-3')?.body).toEqual({ favourite: true });
    await expect(names(page).first()).toHaveText('中くらい');
    await expect(star).toContainText('1');

    await page.getByRole('button', { name: '中くらい をお気に入りから外す' }).click();
    await expect.poll(() => api.last('PUT', '/projects/p-e2e-3')?.body).toEqual({ favourite: false });
    await expect(star).toContainText('0');
  });

  test('the list orders by tokens and by runs, either way round', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^並び替え/ }).click();
    await page.getByRole('option', { name: 'トークン数' }).click();
    await expect(names(page)).toHaveText(['高い', '中くらい', '安い']);
    await page.getByRole('button', { name: /多い順で並んでいます/ }).click();
    await expect(names(page)).toHaveText(['安い', '中くらい', '高い']);

    await page.getByRole('button', { name: /^並び替え/ }).click();
    await page.getByRole('option', { name: '生成回数' }).click();
    await expect(names(page)).toHaveText(['高い', '中くらい', '安い']);
  });

  test('deleting one project from the archive asks on the card, and a cancel keeps it', async ({ page, api }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '安い をアーカイブ', exact: true }).click();
    await projectList(page).getByRole('tab', { name: /アーカイブ/ }).click();
    await expect(names(page)).toHaveText(['安い']);

    await page.getByRole('button', { name: '安い を完全に削除', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '安い を完全に削除しますか' });
    await expect(confirm).toContainText('元に戻せません');
    await confirm.getByRole('button', { name: 'キャンセル' }).click();
    await expect(confirm).toHaveCount(0);
    expect(api.all('DELETE', /^\/projects\//)).toEqual([]);

    await page.getByRole('button', { name: '安い を完全に削除', exact: true }).click();
    await page.getByRole('alertdialog', { name: '安い を完全に削除しますか' }).getByRole('button', { name: '削除する' }).click();
    await expect(page.getByText('アーカイブは空です')).toBeVisible();
    expect(api.all('DELETE', '/projects/p-e2e-1')).toHaveLength(1);
  });

  test('a filter that matches nothing says so, and clearing it brings the list back', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('searchbox', { name: 'プロジェクト名で検索' }).fill('存在しない名前');
    await expect(page.getByText('条件に合うプロジェクトがありません')).toBeVisible();
    await page.getByRole('button', { name: '条件をクリア', exact: true }).click();
    await expect(names(page)).toHaveCount(3);
  });

  test('a run in progress in this browser is marked on its card', async ({ page }) => {
    // What the workspace records while a run is going (utils/requests/activeJob.ts).
    await page.addInitScript(() => {
      localStorage.setItem('makeui:activeJob:p-e2e-2', JSON.stringify({ jobId: 'job-e2e-x', kind: 'generate', startedAt: Date.now() }));
    });
    await page.goto('/');
    const card = page.locator('.project-list__card').filter({ hasText: '高い' });
    await expect(card.getByText('生成中')).toBeVisible();
    await expect(page.locator('.project-list__card').filter({ hasText: '安い' }).getByText('生成中')).toHaveCount(0);
  });
});

test('a list that will not load says so, and 再試行 loads it', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  let down = true;
  api.on('GET', '/projects', () => (down
    ? { status: 503, body: { message: 'Service Unavailable' } }
    : { body: { projects: api.projects.map(({ lastHtml, ...p }) => ({ ...p, hasDocument: Boolean(lastHtml) })) } }));
  await page.goto('/');
  const error = page.getByRole('alert').filter({ has: page.getByRole('button', { name: '再試行' }) });
  await expect(error).toBeVisible();
  await expect(error).not.toContainText('Service Unavailable');
  down = false;
  await error.getByRole('button', { name: '再試行' }).click();
  await expect(names(page)).toHaveText(['在庫管理']);
  await expect(error).toHaveCount(0);
});

test('an account with no projects is told how to start, and the archive how it fills', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('まだプロジェクトがありません。上の「新規プロジェクト」から始められます。')).toBeVisible();
  await projectList(page).getByRole('tab', { name: /共有/ }).click();
  await expect(page.getByText(/共有しているプロジェクトはありません/)).toBeVisible();
  await projectList(page).getByRole('tab', { name: /アーカイブ/ }).click();
  await expect(page.getByText('アーカイブは空です')).toBeVisible();
});

test('a new project opens its workspace, ready for the first request', async ({ page, api }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /新規プロジェクト/ }).click();
  await expect(page.getByRole('textbox', { name: 'メッセージ入力' })).toBeVisible();
  expect(api.last('POST', '/projects')?.body).toEqual({ name: 'Untitled' });
  // And going back lists it.
  await page.getByRole('button', { name: 'MakeUI' }).click();
  await expect(names(page)).toHaveText(['Untitled']);
});
