import { test, expect } from '../fixtures/test';
import { SUPER_ADMIN } from '../fixtures/auth';
import { mockAdmin } from '../fixtures/admin';
import type { Page } from '@playwright/test';

/*
 * What the admin panel CHANGES (2026-09-30).
 *
 * Every write route the panel calls — renaming, enabling, deleting an account,
 * a budget, the models allowed, groups and their members, administrator and
 * budget — had no E2E test at all; the admin specs only read. The mock answers
 * as the handlers do and keeps what was written (fixtures/admin.ts), so each
 * test checks both what was sent and what the screen shows afterwards.
 */
test.use({ user: SUPER_ADMIN });
test.beforeEach(({ api }) => mockAdmin(api));

async function openTab(page: Page, tab: string) {
  await page.goto('/');
  await page.getByRole('button', { name: '管理画面を開く' }).click();
  const panel = page.getByRole('region', { name: '管理画面' });
  await panel.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
  return panel;
}

test.describe('accounts', () => {
  test('renaming an account saves the name and shows it', async ({ page, api }) => {
    const panel = await openTab(page, 'ユーザー管理');
    await panel.getByRole('button', { name: '佐藤 花子 のユーザー名を編集' }).click();
    const field = panel.getByRole('textbox', { name: 'ユーザー名' });
    await field.fill('佐藤 花');
    await field.press('Enter');
    await expect.poll(() => api.last('PATCH', '/admin/users/hanako%40example.invalid')?.body).toEqual({ displayName: '佐藤 花' });
    await expect(panel.getByRole('table', { name: 'Cognitoユーザー一覧' })).toContainText('佐藤 花');
  });

  test('disabling an account and enabling it again', async ({ page, api }) => {
    const panel = await openTab(page, 'ユーザー管理');
    const row = panel.getByRole('row').filter({ hasText: 'hanako@example.invalid' });
    await row.getByRole('button', { name: '有効' }).click();
    await expect.poll(() => api.last('PATCH', '/admin/users/hanako%40example.invalid')?.body).toEqual({ enabled: false });
    await expect(row.getByRole('button', { name: '無効' })).toBeVisible();
    await row.getByRole('button', { name: '無効' }).click();
    await expect.poll(() => api.last('PATCH', '/admin/users/hanako%40example.invalid')?.body).toEqual({ enabled: true });
    await expect(row.getByRole('button', { name: '有効' })).toBeVisible();
  });

  test('deleting an account asks first, and a cancel deletes nothing', async ({ page, api }) => {
    const panel = await openTab(page, 'ユーザー管理');
    const table = panel.getByRole('table', { name: 'Cognitoユーザー一覧' });
    page.once('dialog', (d) => d.dismiss());
    await panel.getByRole('button', { name: '佐藤 花子 を削除' }).click();
    await expect(table).toContainText('hanako@example.invalid');
    expect(api.all('DELETE', /^\/admin\/users\//)).toEqual([]);

    page.once('dialog', (d) => { expect(d.message()).toContain('この操作は取り消せません'); void d.accept(); });
    await panel.getByRole('button', { name: '佐藤 花子 を削除' }).click();
    await expect(table).not.toContainText('hanako@example.invalid');
    expect(api.all('DELETE', /^\/admin\/users\//)).toHaveLength(1);
  });

  test('a monthly budget is saved in millionths of a dollar, and an empty one is unlimited', async ({ page, api }) => {
    const panel = await openTab(page, 'ユーザー管理');
    const row = panel.getByRole('row').filter({ hasText: 'taro@example.invalid' });
    await row.getByRole('button', { name: '月間予算を編集' }).click();
    await row.getByRole('spinbutton', { name: '月間予算（USD）' }).fill('25');
    await row.getByRole('button', { name: '保存' }).click();
    await expect.poll(() => api.last('POST', '/admin/usage/limit')?.body).toEqual({ userId: 'sub-taro', limit: 25_000_000 });
    await expect(row).toContainText('$25.00 USD');

    await row.getByRole('button', { name: '月間予算を編集' }).click();
    await row.getByRole('spinbutton', { name: '月間予算（USD）' }).fill('');
    await row.getByRole('button', { name: '保存' }).click();
    await expect.poll(() => api.last('POST', '/admin/usage/limit')?.body).toEqual({ userId: 'sub-taro', limit: -1 });
    await expect(row).toContainText('無制限');
  });

  test('a budget of zero is refused on the spot and not sent', async ({ page, api }) => {
    const panel = await openTab(page, 'ユーザー管理');
    const row = panel.getByRole('row').filter({ hasText: 'taro@example.invalid' });
    await row.getByRole('button', { name: '月間予算を編集' }).click();
    await row.getByRole('spinbutton', { name: '月間予算（USD）' }).fill('0');
    await row.getByRole('button', { name: '保存' }).click();
    await expect(row.getByRole('alert')).toHaveText('0より大きい金額を入力してください。');
    expect(api.all('POST', '/admin/usage/limit')).toEqual([]);
  });

  test('taking a model away from an account sends the rest', async ({ page, api }) => {
    const panel = await openTab(page, 'ユーザー管理');
    const row = panel.getByRole('row').filter({ hasText: 'taro@example.invalid' });
    // Controlled by what the server holds, so it changes once the save lands, not on the click.
    await row.getByRole('checkbox', { name: 'Sonnet' }).click();
    await expect.poll(() => api.last('POST', '/admin/usage/model-allowance')?.body?.userId).toBe('sub-taro');
    expect(api.last('POST', '/admin/usage/model-allowance')?.body?.models).not.toContain('sonnet');
    await expect(row.getByRole('checkbox', { name: 'Sonnet' })).not.toBeChecked();
  });
});

test.describe('groups', () => {
  test('a group is created, given a member and an administrator, then deleted', async ({ page, api }) => {
    const panel = await openTab(page, 'グループ');
    await panel.getByRole('textbox', { name: '新しいグループ名' }).fill('sales');
    await panel.getByRole('button', { name: '作成', exact: true }).click();
    await expect.poll(() => api.last('POST', '/admin/groups')?.body?.name).toBe('sales');
    const row = panel.getByRole('row').filter({ hasText: 'sales' });
    await expect(row).toBeVisible();

    // Choosing the group opens its members; someone in no group is added.
    await row.click();
    const hanako = panel.getByRole('row').filter({ hasText: 'hanako@example.invalid' });
    await hanako.getByRole('button', { name: '追加' }).click();
    await expect.poll(() => api.last('POST', '/admin/groups/membership')?.body).toEqual({ username: 'hanako@example.invalid', group: 'sales' });
    await expect(hanako.getByRole('button', { name: '外す' })).toBeVisible();

    await hanako.getByRole('button', { name: '管理者にする' }).click();
    await expect.poll(() => api.last('POST', '/admin/groups/admin')?.body).toEqual({ group: 'sales', username: 'hanako@example.invalid' });

    // Deleting asks, says the accounts stay, and takes the group off the list.
    page.once('dialog', (d) => { expect(d.message()).toContain('アカウントは削除されません'); void d.accept(); });
    await row.getByRole('button', { name: '削除' }).click();
    await expect.poll(() => api.all('DELETE', '/admin/groups/sales').length).toBe(1);
    await expect(panel.getByRole('row').filter({ hasText: 'sales' })).toHaveCount(0);
  });

  test('a group name that breaks the rule is refused with the reason', async ({ page, api }) => {
    const panel = await openTab(page, 'グループ');
    await panel.getByRole('textbox', { name: '新しいグループ名' }).fill('営業部');
    await panel.getByRole('button', { name: '作成', exact: true }).click();
    await expect(panel.getByText(/グループ名は英数字で始まる/)).toBeVisible();
    await expect(panel.getByRole('row').filter({ hasText: '営業部' })).toHaveCount(0);
    expect(api.all('POST', '/admin/groups').length).toBeLessThanOrEqual(1);
  });

  test('a group budget is saved for the group', async ({ page, api }) => {
    const panel = await openTab(page, 'グループ');
    const row = panel.getByRole('row').filter({ hasText: 'design' });
    await row.getByRole('button', { name: '月間予算を編集' }).click();
    await row.getByRole('spinbutton', { name: '月間予算（USD）' }).fill('100');
    await row.getByRole('button', { name: '保存' }).click();
    await expect.poll(() => api.last('POST', '/admin/groups/limit')?.body).toEqual({ group: 'design', limit: 100_000_000 });
    await expect(row).toContainText('$100.00 USD');
  });
});

test.describe('projects', () => {
  test('an account\'s project, its history, and one version drawn', async ({ page, api }) => {
    const panel = await openTab(page, 'プロジェクト');
    await panel.getByRole('button', { name: /山田 太郎/ }).click();
    await expect.poll(() => api.all('GET', '/admin/projects/sub-taro').length).toBeGreaterThan(0);
    await panel.getByRole('row').filter({ hasText: '在庫管理' }).click();
    const history = panel.getByRole('row').filter({ hasText: '検索欄を付けて' });
    await expect(history).toBeVisible();
    await expect(panel.getByRole('row').filter({ hasText: '在庫一覧を作って' })).toBeVisible();

    await history.getByRole('button', { name: '表示' }).click();
    const viewer = page.getByRole('dialog', { name: '生成されたUI' });
    await expect(viewer).toBeVisible();
    await expect(viewer.frameLocator('iframe').first().getByRole('heading', { name: '在庫一覧（検索つき）' })).toBeVisible();
    await viewer.getByRole('button', { name: '閉じる' }).click();
    await expect(viewer).toHaveCount(0);
  });

  test('an account with no projects says so', async ({ page }) => {
    const panel = await openTab(page, 'プロジェクト');
    await panel.getByRole('button', { name: /佐藤 花子/ }).click();
    await expect(panel.getByText(/プロジェクトがありません/)).toBeVisible();
  });
});

test.describe('usage', () => {
  test('the usage downloads as a CSV with a row per account', async ({ page }) => {
    const panel = await openTab(page, '使用量');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: /CSV/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^usage-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = (await (await download.createReadStream()).toArray()).map((c) => c.toString()).join('');
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('"Email"');
    expect(lines).toHaveLength(3);
    expect(text).toContain('taro@example.invalid');
  });
});
