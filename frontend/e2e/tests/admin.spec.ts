import { test, expect } from '../fixtures/test';
import { SUPER_ADMIN, type TestUser } from '../fixtures/auth';
import { mockAdmin, THIS_MONTH } from '../fixtures/admin';

const GROUP_ADMIN: TestUser = { email: 'e2e-grpadm@example.invalid', username: 'e2e-grpadm@example.invalid', groups: ['grpadm:design'] };

test.describe('an ordinary user', () => {
  test('has no way into the admin panel, and asks nothing of the admin routes', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.getByRole('tablist', { name: '表示するプロジェクト' })).toBeVisible();
    await expect(page.getByRole('button', { name: '管理画面を開く' })).toHaveCount(0);
    expect(api.calls.filter((c) => c.path.startsWith('/admin/'))).toEqual([]);
  });
});

test.describe('the account administrator', () => {
  test.use({ user: SUPER_ADMIN });
  test.beforeEach(({ api }) => mockAdmin(api));

  test('opens the panel on this month\'s usage, one row per person', async ({ page, api }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = page.getByRole('region', { name: '管理画面' });

    const rows = panel.getByRole('table', { name: 'ユーザー使用量一覧' }).getByRole('row');
    await expect(rows).toHaveCount(3); // the header and two people
    await expect(rows.nth(1)).toContainText('山田 太郎');
    await expect(rows.nth(1)).toContainText('$1.80 USD');
    await expect(rows.nth(2)).toContainText('無制限');

    const usage = api.last('GET', '/admin/usage');
    expect([usage?.query.get('from'), usage?.query.get('to')]).toEqual([THIS_MONTH, THIS_MONTH]);
  });

  test('sees every tab, the account-wide ones included, and each loads its own data', async ({ page, api }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = page.getByRole('region', { name: '管理画面' });

    await panel.getByRole('button', { name: 'ユーザー管理' }).click();
    await expect(panel.getByText('hanako@example.invalid').first()).toBeVisible();
    expect(api.all('GET', '/admin/users').length).toBeGreaterThanOrEqual(1);

    await panel.getByRole('button', { name: 'グループ' }).click();
    await expect(panel.getByText('design').first()).toBeVisible();
    expect(api.all('GET', '/admin/groups').length).toBeGreaterThanOrEqual(1);

    await panel.getByRole('button', { name: '閉じる' }).click();
    await expect(panel).toHaveCount(0);
  });
});

test.describe('a group administrator', () => {
  test.use({ user: GROUP_ADMIN });
  test.beforeEach(({ api }) => mockAdmin(api));

  test('gets the panel without the account-wide tabs', async ({ page, api }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = page.getByRole('region', { name: '管理画面' });
    await expect(panel.getByRole('button', { name: /^使用量/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'グループ' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^モデル/ })).toHaveCount(0);
    // The model inventory is the account's infrastructure, not a group's business.
    expect(api.all('GET', '/admin/models')).toEqual([]);
  });
});
