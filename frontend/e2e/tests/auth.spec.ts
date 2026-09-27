import { test, expect } from '../fixtures/test';
import { TEST_NEW_PASSWORD, TEST_PASSWORD, TEST_TOTP_CODE, USER } from '../fixtures/auth';
import { MFA_SECRET } from '../fixtures/cognito';
import type { Page } from '@playwright/test';

// Every test here starts signed out.
test.use({ user: null });

const projectList = (page: Page) => page.getByRole('tablist', { name: '表示するプロジェクト' });

async function submitCredentials(page: Page) {
  await page.goto('/');
  await page.getByLabel('メールアドレス').fill(USER.email);
  await page.getByLabel('パスワード', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();
}

test('signed out, the app opens on the sign-in form', async ({ page, api }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'ログイン' })).toBeVisible();
  // Nothing is asked of the API before there is a session to ask with.
  expect(api.calls).toEqual([]);
});

test('an ordinary sign-in asks for the authenticator code, then opens the project list', async ({ page, cognito }) => {
  cognito.flow = 'totp';
  await submitCredentials(page);

  await page.getByLabel('認証コード').fill(TEST_TOTP_CODE);
  await page.getByRole('button', { name: '確認', exact: true }).click();
  await expect(projectList(page)).toBeVisible();

  // SRP: the password itself never leaves the browser.
  const [initiate] = cognito.sent('InitiateAuth');
  expect(initiate.AuthFlow).toBe('USER_SRP_AUTH');
  expect((initiate.AuthParameters as Record<string, string>).USERNAME).toBe(USER.email);
  expect(JSON.stringify(cognito.calls)).not.toContain(TEST_PASSWORD);

  const answers = cognito.sent('RespondToAuthChallenge');
  expect(answers.map((a) => a.ChallengeName)).toEqual(['PASSWORD_VERIFIER', 'SOFTWARE_TOKEN_MFA']);
  expect((answers[1].ChallengeResponses as Record<string, string>).SOFTWARE_TOKEN_MFA_CODE).toBe(TEST_TOTP_CODE);
});

test('a first sign-in sets a new password, then sets up MFA with the secret shown', async ({ page, cognito }) => {
  cognito.flow = 'first-login';
  await submitCredentials(page);

  await page.getByLabel('新しいパスワード').fill(TEST_NEW_PASSWORD);
  await page.getByRole('button', { name: 'パスワードを設定' }).click();

  // The secret is shown for authenticator apps that cannot scan the QR code.
  await expect(page.getByLabel('MFAシークレットキー')).toHaveText(MFA_SECRET);
  await page.getByLabel('認証コード').fill(TEST_TOTP_CODE);
  await page.getByRole('button', { name: '確認して設定完了' }).click();
  await expect(projectList(page)).toBeVisible();

  const newPassword = cognito.sent('RespondToAuthChallenge').find((a) => a.ChallengeName === 'NEW_PASSWORD_REQUIRED');
  expect((newPassword?.ChallengeResponses as Record<string, string>).NEW_PASSWORD).toBe(TEST_NEW_PASSWORD);
  expect(cognito.sent('VerifySoftwareToken')[0].UserCode).toBe(TEST_TOTP_CODE);
});

test('a refused password is reported and the form stays', async ({ page, cognito }) => {
  cognito.flow = 'wrong-password';
  await submitCredentials(page);

  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ログイン' })).toBeEnabled();
  await expect(projectList(page)).toHaveCount(0);
});

test('signing out returns to the sign-in form, and stays there after a reload', async ({ page, cognito }) => {
  cognito.flow = 'tokens';
  await submitCredentials(page);
  await expect(projectList(page)).toBeVisible();

  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page.getByRole('button', { name: 'ログイン' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'ログイン' })).toBeVisible();
});
