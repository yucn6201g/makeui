import { test, expect } from '../fixtures/test';
import { reactProject } from '../fixtures/project';
import { openProject } from '../fixtures/screens';

// The clipboard is read back in the publish test.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(({ api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
});

async function openShare(page: import('@playwright/test').Page) {
  await openProject(page, '在庫管理');
  await page.getByRole('button', { name: '共有', exact: true }).click();
  return page.getByRole('dialog', { name: '共有' });
}

test('publishing builds the page, sends it, and puts the link on the clipboard', async ({ page, api }) => {
  const dialog = await openShare(page);
  await dialog.getByRole('button', { name: '公開リンクを作成してコピー' }).click();
  await expect(dialog.getByRole('button', { name: 'リンクをコピーしました' })).toBeVisible();

  const sent = api.last('POST', '/publish')?.body.html as string;
  // A page that runs on its own: compiled, not the transport the editor keeps.
  expect(sent).not.toContain('@@@makeui:file');
  expect(sent).toContain('<title>在庫管理</title>');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://share.e2e.test/site-e2e-1/index.html');
});

test('a publish the server refuses says why', async ({ page, api }) => {
  api.on('POST', '/publish', { status: 429, body: { error: 'リクエストが多すぎます。しばらく待ってから、もう一度お試しください。' } });
  const dialog = await openShare(page);
  await dialog.getByRole('button', { name: '公開リンクを作成してコピー' }).click();
  await expect(dialog.getByText('リクエストが多すぎます。しばらく待ってから、もう一度お試しください。')).toBeVisible();
});

test('sharing with a person: find them, choose the role, and they are listed', async ({ page, api }) => {
  const dialog = await openShare(page);
  await dialog.getByRole('searchbox', { name: '共有する相手を検索' }).fill('花子');
  await dialog.getByRole('option', { name: /佐藤 花子/ }).click();
  await dialog.getByLabel('付与する権限').selectOption('view');
  await dialog.getByRole('button', { name: '追加' }).click();

  const members = dialog.getByRole('list', { name: 'アクセスできるユーザー' });
  await expect(members).toContainText('佐藤 花子');
  expect(api.last('PUT', /\/shares$/)?.body).toEqual({ type: 'user', id: 'sub-hanako', role: 'view' });

  // Changing the role, then taking the share away.
  await members.getByLabel('佐藤 花子 の権限').selectOption('edit');
  await expect.poll(() => api.last('PUT', /\/shares$/)?.body.role).toBe('edit');
  await members.getByRole('button', { name: '佐藤 花子 との共有を解除' }).click();
  await expect(members).not.toContainText('佐藤 花子');
  expect(api.last('DELETE', /\/shares\/user\/sub-hanako$/)).toBeTruthy();
});

test('a search with nothing to find says so', async ({ page }) => {
  const dialog = await openShare(page);
  await dialog.getByRole('searchbox', { name: '共有する相手を検索' }).fill('該当なしの名前');
  await expect(dialog.getByText('該当するユーザー・グループがありません')).toBeVisible();
});
