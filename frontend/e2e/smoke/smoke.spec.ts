import { test, expect, type Page } from '@playwright/test';
import { totp } from './totp';

/**
 * L3: the deployed MakeUI, signed in as a real test account (docs/09_e2e_testing.md).
 *
 * Nothing here is mocked. Run by a person, from their own machine, with the
 * account's details in the environment — never in a file, never in the repository:
 *
 *   MAKEUI_SMOKE_URL          the site, https://…
 *   MAKEUI_SMOKE_EMAIL        the test account's address
 *   MAKEUI_SMOKE_PASSWORD     its password (not a temporary one — see below)
 *   MAKEUI_SMOKE_TOTP_SECRET  the MFA secret shown when the account set up MFA
 *   MAKEUI_SMOKE_GENERATE=1   also run one generation (Haiku, 下書き: about $0.5)
 *
 * The account's first sign-in (replacing the temporary password and registering
 * MFA) is done once by hand in a browser, keeping the secret the setup screen
 * shows. The test stops with that instruction if it meets the first-login screen.
 */
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が設定されていません（docs/09_e2e_testing.md の L3 を参照）。`);
  return v;
};

async function signIn(page: Page) {
  env('MAKEUI_SMOKE_URL');
  await page.goto('/');
  await page.getByLabel('メールアドレス').fill(env('MAKEUI_SMOKE_EMAIL'));
  await page.getByLabel('パスワード', { exact: true }).fill(env('MAKEUI_SMOKE_PASSWORD'));
  await page.getByRole('button', { name: 'ログイン' }).click();

  const code = page.getByLabel('認証コード');
  const firstLogin = page.getByLabel('新しいパスワード');
  await expect(code.or(firstLogin)).toBeVisible({ timeout: 30_000 });
  if (await firstLogin.isVisible()) {
    throw new Error('このアカウントは初回ログインが済んでいません。ブラウザで一度ログインしてパスワードを変更し、MFA を登録してから実行してください。');
  }
  // A fresh code, not one about to expire mid-request.
  const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (secondsLeft < 5) await page.waitForTimeout(secondsLeft * 1000 + 500);
  await code.fill(totp(env('MAKEUI_SMOKE_TOTP_SECRET')));
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '表示するプロジェクト' })).toBeVisible({ timeout: 30_000 });
}

test('signs in, and the project list and usage load from the real API', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const usage = page.waitForResponse((r) => r.url().endsWith('/usage') && r.request().method() === 'GET');
  await page.reload();
  expect((await usage).status()).toBe(200);
});

test('one generation, end to end (only with MAKEUI_SMOKE_GENERATE=1)', async ({ page }) => {
  test.skip(process.env.MAKEUI_SMOKE_GENERATE !== '1', 'generation costs money; set MAKEUI_SMOKE_GENERATE=1 to run it');
  test.setTimeout(15 * 60_000);
  await signIn(page);

  await page.getByRole('button', { name: /新規プロジェクト/ }).click();
  const composer = page.getByRole('textbox', { name: 'メッセージ入力' });
  await expect(composer).toBeVisible();
  // The cheapest run there is: Haiku, one pass, no design phase or repair.
  await page.getByRole('button', { name: /^モード / }).click();
  await page.getByRole('option', { name: /^下書き/ }).click();
  await page.getByRole('button', { name: /^モデル / }).click();
  await page.getByRole('option', { name: /Haiku/ }).click();

  await composer.fill('【スモークテスト】「在庫一覧」という見出しと、品名と数量の表だけの1画面を作ってください。');
  await page.getByRole('button', { name: '送信', exact: true }).click();

  // The document arrives and runs in the preview.
  const frame = page.frameLocator('iframe[title="生成されたUIのプレビュー"]');
  await expect(frame.locator('body *').first()).toBeVisible({ timeout: 14 * 60_000 });
  await expect(frame.getByText('在庫一覧').first()).toBeVisible();
  await expect(page.getByRole('log', { name: '会話履歴' }).getByRole('alert')).toHaveCount(0);
});
