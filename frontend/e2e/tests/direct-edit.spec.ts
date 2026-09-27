import { test, expect } from '../fixtures/test';
import { reactProject } from '../fixtures/project';
import { openProject, preview } from '../fixtures/screens';

// Editing by hand: no model runs, the edit shows at once, and it is saved as a version.

test.beforeEach(async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await openProject(page, '在庫管理');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  await page.getByRole('button', { name: 'Select' }).click();
  await preview(page).getByRole('heading', { name: '在庫一覧' }).click();
});

test('selecting an element opens its text and its styles', async ({ page }) => {
  await expect(page.getByRole('textbox', { name: '本文' })).toHaveValue('在庫一覧');
  await expect(page.getByRole('region', { name: 'CSS インスペクター' })).toContainText('main > h1');
});

test('its text is changed in the source, shown at once and saved', async ({ page, api }) => {
  const text = page.getByRole('textbox', { name: '本文' });
  await text.fill('在庫の一覧');
  await text.press('Enter');

  await expect(preview(page).getByRole('heading', { name: '在庫の一覧' })).toBeVisible();
  await expect.poll(() => api.all('POST', '/versions').length).toBe(1);
  const saved = api.last('POST', '/versions')?.body;
  expect(saved.note).toBe('直接編集');
  expect(saved.html).toContain('<h1>在庫の一覧</h1>');
  // By hand: nothing was asked of a model.
  expect([...api.all('POST', '/generate'), ...api.all('POST', '/modify')]).toEqual([]);
});

test('a style changed in the inspector is applied to the element and saved', async ({ page, api }) => {
  const size = page.getByRole('region', { name: 'CSS インスペクター' }).getByRole('textbox', { name: '文字サイズ' });
  await size.fill('40px');
  await size.press('Enter');

  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toHaveCSS('font-size', '40px');
  await expect.poll(() => api.all('POST', '/versions').length).toBeGreaterThanOrEqual(1);
  expect(api.last('POST', '/versions')?.body.html).toContain('40px');
});

test('an element can be deleted from the source', async ({ page, api }) => {
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toHaveCount(0);
  await expect.poll(() => api.all('POST', '/versions').length).toBe(1);
  expect(api.last('POST', '/versions')?.body.html).not.toContain('<h1>在庫一覧</h1>');
});

test('a save the server refuses keeps the edit on screen and says it was not saved', async ({ page, api }) => {
  api.on('POST', '/versions', { status: 500, body: { error: 'サーバーでエラーが起きました。しばらく待ってから、もう一度お試しください。' } });
  const text = page.getByRole('textbox', { name: '本文' });
  await text.fill('在庫の一覧');
  await text.press('Enter');
  await expect(preview(page).getByRole('heading', { name: '在庫の一覧' })).toBeVisible();
  await expect(page.getByText('保存が混み合っていて保存できませんでした。編集は画面に残っています。')).toBeVisible();
});
