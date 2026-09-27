import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test';
import { reactProject } from '../fixtures/project';
import { SUPER_ADMIN, TEST_PASSWORD, USER } from '../fixtures/auth';
import { mockAdmin } from '../fixtures/admin';
import type { MockApi } from '../fixtures/api';

/**
 * No axe violation of any impact on MakeUI's own screens.
 *
 * The generated app inside the preview frames is excluded: it is the user's
 * product, audited by the pipeline's own checks, not part of MakeUI's UI.
 * Animations are finished first — a card caught half-faded measures as low
 * contrast that nobody ever sees (measured: 2.53:1 mid-entry, passing after).
 *
 * Fixed on 2026-09-27 to reach zero: a project card that was a button holding
 * buttons, a dropdown option holding a button, a code tab holding its close
 * button, a tablist holding the copy and save buttons, separators without a
 * value, three greys under 4.5:1, content outside any landmark, and no h1.
 */
async function expectAccessible(page: Page) {
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()));
  const { violations } = await new AxeBuilder({ page }).exclude('iframe').analyze();
  expect(violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

function seed(api: MockApi) {
  const project = api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  api.versions.push({ versionId: 'v1', projectId: project.projectId, createdAt: new Date(Date.now() - 600_000).toISOString(), prompt: '在庫一覧を作って', html: reactProject({ title: '在庫一覧（旧）' }), score: 80, preset: 'none', model: 'haiku' });
  api.messages.set(project.projectId, [
    { id: 'm1', role: 'user', content: '在庫一覧を作って', timestamp: Date.now() - 60_000 },
    { id: 'm2', role: 'assistant', content: '在庫一覧の画面を作成しました。', timestamp: Date.now() - 50_000 },
  ]);
}

test.describe('signed out', () => {
  test.use({ user: null });

  test('the sign-in screens', async ({ page, cognito }) => {
    cognito.flow = 'first-login';
    await page.goto('/');
    await expectAccessible(page);
    await page.getByLabel('メールアドレス').fill(USER.email);
    await page.getByLabel('パスワード', { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.getByLabel('新しいパスワード')).toBeVisible();
    await expectAccessible(page);
  });
});

test('the project list', async ({ page, api }) => {
  seed(api);
  await page.goto('/');
  await expect(page.getByText('在庫管理', { exact: true })).toBeVisible();
  await expectAccessible(page);
});

test('the workspace, its menus and dialogs', async ({ page, api }) => {
  seed(api);
  await page.goto('/');
  await page.getByText('在庫管理', { exact: true }).click();
  await expect(page.getByRole('log', { name: '会話履歴' }).getByText('在庫一覧を作って')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: /^デザイン / }).click();
  await expectAccessible(page);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^バージョン/ }).click();
  await expectAccessible(page);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '共有', exact: true }).click();
  await expectAccessible(page);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '比較', exact: true }).click();
  await expectAccessible(page);
  await page.getByRole('dialog', { name: 'バージョン比較' }).getByRole('button', { name: '閉じる' }).click();

  await page.getByRole('button', { name: 'Select' }).click();
  await page.frameLocator('iframe[title="生成されたUIのプレビュー"]').getByRole('heading', { name: '在庫一覧' }).click();
  await expect(page.getByRole('region', { name: 'CSS インスペクター' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Code' }).click();
  await expect(page.getByRole('tablist', { name: '開いているファイル' })).toBeVisible();
  await expectAccessible(page);
});

test.describe('the admin panel', () => {
  test.use({ user: SUPER_ADMIN });

  test('every tab', async ({ page, api }) => {
    mockAdmin(api);
    await page.goto('/');
    await page.getByRole('button', { name: '管理画面を開く' }).click();
    const panel = page.getByRole('region', { name: '管理画面' });
    await expect(panel.getByRole('table', { name: 'ユーザー使用量一覧' })).toBeVisible();
    await expectAccessible(page);
    for (const tab of [/^モデル/, /^ユーザー管理/, /^プロジェクト/, /^グループ/]) {
      await panel.getByRole('button', { name: tab }).click();
      await expectAccessible(page);
    }
  });
});
