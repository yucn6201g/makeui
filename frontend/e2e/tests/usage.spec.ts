import { test, expect } from '../fixtures/test';

const usage = (fields: Record<string, unknown>) => ({
  displayName: 'E2E 利用者', history: [], currentUsage: 0, limit: 10_000_000, tokensUsed: 0, cost: 0,
  costEstimated: false, requestsUsed: 0, group: null, groupBudget: null, allowedModels: ['auto', 'haiku', 'sonnet'],
  ...fields,
});

async function openUsage(page: import('@playwright/test').Page) {
  await page.goto('/');
  // The name comes from /usage; without it the button falls back to the address's local part.
  await page.getByRole('button', { name: /^(E2E 利用者|e2e-user)$/ }).click();
  return page.getByRole('dialog', { name: '今月の上限' });
}

test('the usage menu shows this month\'s spend against the budget', async ({ page, api }) => {
  api.on('GET', '/usage', { body: usage({ currentUsage: 2_500_000, cost: 2.5, tokensUsed: 120_000, requestsUsed: 12 }) });
  const dialog = await openUsage(page);
  await expect(dialog).toContainText('$2.50 USD');
  await expect(dialog).toContainText('予算 $10.00 USD');
  await expect(dialog.getByRole('progressbar', { name: 'あなたの利用金額の使用率' })).toHaveAttribute('aria-valuenow', '25');
  await expect(dialog).toContainText('残り $7.50 USD');
});

test('an unlimited account is told so rather than shown a bar', async ({ page, api }) => {
  api.on('GET', '/usage', { body: usage({ limit: -1, currentUsage: 1_000_000, cost: 1 }) });
  const dialog = await openUsage(page);
  await expect(dialog).toContainText('予算 無制限');
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
});

test('a usage the server cannot read is reported in the menu', async ({ page, api }) => {
  api.on('GET', '/usage', { status: 503, body: { error: '利用状況を確認できませんでした。しばらく待ってから、もう一度お試しください。' } });
  const dialog = await openUsage(page);
  await expect(dialog.getByRole('alert')).toHaveText('使用状況を読み込めませんでした。');
});
