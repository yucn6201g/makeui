import { test, expect } from '../fixtures/test';
import { SUPER_ADMIN, type TestUser } from '../fixtures/auth';
import { mockAdmin, THIS_MONTH, ADMIN_USAGE, ADMIN_USERS } from '../fixtures/admin';

const GROUP_ADMIN: TestUser = { email: 'e2e-grpadm@example.invalid', username: 'e2e-grpadm@example.invalid', groups: ['grpadm:design'] };

/*
 * Every tab carries its count as soon as the panel opens (2026-09-27). ユーザー管理
 * and グループ fetched their lists only when first chosen, so their chips were
 * empty until clicked. Asserted without clicking any tab.
 */
const tabCounts = async (page: import('@playwright/test').Page, names: string[]) => {
  const panel = page.getByRole('region', { name: '管理画面' });
  for (const name of names) {
    await expect(panel.getByRole('button', { name: new RegExp(`^${name}`) }).locator('.adm-tab-badge'), `${name} has its count`).toHaveText(/^\d+$/);
  }
  return panel;
};

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

  test('sees every tab\'s count on opening, before choosing any', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = await tabCounts(page, ['使用量', 'モデル', 'ユーザー管理', 'プロジェクト', 'グループ']);
    await expect(panel.getByRole('button', { name: /^ユーザー管理/ }).locator('.adm-tab-badge')).toHaveText('2');
    await expect(panel.getByRole('button', { name: /^グループ/ }).locator('.adm-tab-badge')).toHaveText('1');
    await expect(panel.getByRole('button', { name: /^プロジェクト/ }).locator('.adm-tab-badge')).toHaveText('5');
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

test.describe('creating an account', () => {
  test.use({ user: SUPER_ADMIN });
  test.beforeEach(({ api }) => mockAdmin(api));

  async function openForm(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = page.getByRole('region', { name: '管理画面' });
    await panel.getByRole('button', { name: 'ユーザー管理' }).click();
    await panel.getByRole('button', { name: '+ ユーザーを追加' }).click();
    return panel;
  }

  test('the temporary password field states the pool\'s rule, not a sample password', async ({ page }) => {
    const panel = await openForm(page);
    const field = panel.getByRole('textbox', { name: '仮パスワード' });
    // 「Temp@1234」 was nine characters for a pool that requires twelve.
    await expect(field).toHaveAttribute('placeholder', '12文字以上・大文字・小文字・数字・記号を含む');
    await expect(panel.getByText('仮パスワードは12文字以上で、大文字・小文字・数字・記号をそれぞれ1文字以上含めてください。')).toBeVisible();
  });

  test('a temporary password that breaks the rule is refused before it is sent', async ({ page, api }) => {
    const panel = await openForm(page);
    await panel.getByRole('textbox', { name: 'ユーザー名', exact: true }).fill('鈴木 一郎');
    await panel.getByRole('textbox', { name: 'メールアドレス（ログインID）' }).fill('ichiro@example.invalid');
    await panel.getByRole('textbox', { name: '仮パスワード' }).fill('Temp@1234');
    await panel.getByRole('button', { name: '作成', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText('仮パスワードが条件を満たしていません。12文字以上にしてください（今は9文字です）。');
    expect(api.all('POST', '/admin/users')).toEqual([]);
  });

  test('one that meets it creates the account, which then appears in the list', async ({ page, api }) => {
    const panel = await openForm(page);
    await panel.getByRole('textbox', { name: 'ユーザー名', exact: true }).fill('鈴木 一郎');
    await panel.getByRole('textbox', { name: 'メールアドレス（ログインID）' }).fill('ichiro@example.invalid');
    // A made-up value for the mocked API; the pool never sees it.
    await panel.getByRole('textbox', { name: '仮パスワード' }).fill('E2e-Temporary-Pass1');
    await panel.getByRole('button', { name: '作成', exact: true }).click();
    await expect(panel.getByText('ichiro@example.invalid')).toBeVisible();
    expect(api.last('POST', '/admin/users')?.body).toEqual({
      displayName: '鈴木 一郎', email: 'ichiro@example.invalid', temporaryPassword: 'E2e-Temporary-Pass1',
    });
  });

  test('the server refusing it is reported in the server\'s words', async ({ page }) => {
    const panel = await openForm(page);
    await panel.getByRole('textbox', { name: 'ユーザー名', exact: true }).fill('佐藤 花子');
    await panel.getByRole('textbox', { name: 'メールアドレス（ログインID）' }).fill('hanako@example.invalid');
    await panel.getByRole('textbox', { name: '仮パスワード' }).fill('E2e-Temporary-Pass1');
    await panel.getByRole('button', { name: '作成', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText('このメールアドレスはすでに登録されています。');
  });
});

test.describe('a group administrator', () => {
  test.use({ user: GROUP_ADMIN });
  test.beforeEach(({ api }) => mockAdmin(api));

  test('sees the count of each of its tabs on opening, and asks nothing account-wide', async ({ page, api }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    await tabCounts(page, ['使用量', 'ユーザー管理', 'プロジェクト']);
    expect(api.all('GET', '/admin/groups')).toEqual([]);
  });

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

/*
 * Hundreds of accounts (2026-09-27). The users table drew every row with its
 * editors in one commit and joined each to its usage with a search of the whole
 * list — 1.6 s on a slower machine for 500 accounts. Rows are drawn a few
 * screens at a time now; what is asserted is that the list is still whole to
 * anyone who scrolls or searches.
 */
test.describe('an account with hundreds of users', () => {
  test.use({ user: SUPER_ADMIN });
  test.beforeEach(({ api }) => {
    mockAdmin(api);
    const usage = [], users = [];
    for (let i = 0; i < 300; i++) {
      usage.push({ ...ADMIN_USAGE[1], userId: `sub-${i}`, email: `u${i}@example.invalid`, displayName: `利用者 ${i}`, projectCount: 1 });
      users.push({ ...ADMIN_USERS[1], username: `u${i}@example.invalid`, email: `u${i}@example.invalid`, displayName: `利用者 ${i}` });
    }
    api.on('GET', '/admin/usage', { body: { users: usage } });
    api.on('GET', '/admin/users', { body: { users } });
  });

  test('the users table draws a few screens, the rest on scrolling, and search reaches all of them', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = page.getByRole('region', { name: '管理画面' });
    await expect(panel.getByRole('button', { name: /^ユーザー管理/ }).locator('.adm-tab-badge')).toHaveText('300');
    await panel.getByRole('button', { name: /^ユーザー管理/ }).click();
    const rows = panel.locator('tbody tr.adm-tr');
    await expect(rows.first()).toBeVisible();
    const first = await rows.count();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(300);

    // Every row is still there for whoever scrolls to it.
    await expect(async () => {
      await rows.last().scrollIntoViewIfNeeded();
      expect(await rows.count()).toBe(300);
    }).toPass({ timeout: 15_000 });

    // And a search looks through the whole list, not the rows drawn so far.
    await panel.getByRole('button', { name: /^使用量/ }).click();
    await panel.getByRole('button', { name: /^ユーザー管理/ }).click();
    await panel.getByPlaceholder(/検索/).first().fill('u299@');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('u299@example.invalid');
  });

  test('the usage table draws a few screens, the rest on scrolling', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const table = page.getByRole('table', { name: 'ユーザー使用量一覧' });
    const rows = table.locator('tbody tr.adm-tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThan(300);
    await expect(async () => {
      await rows.last().scrollIntoViewIfNeeded();
      expect(await rows.count()).toBe(300);
    }).toPass({ timeout: 15_000 });
  });
});
