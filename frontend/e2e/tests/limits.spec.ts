import { test, expect } from '../fixtures/test';
import { composer, openNewProject, send } from '../fixtures/screens';

// The composer refuses what the API would refuse, before anything is uploaded.
// The numbers are the API's: see src/utils/requests/requestLimits.ts.

test('a request over 2,000 characters is refused with the count, and not sent', async ({ page, api }) => {
  await openNewProject(page);
  await send(page, 'あ'.repeat(2001));

  await expect(page.getByRole('alert')).toContainText('2,000文字まで');
  await expect(page.getByRole('alert')).toContainText('2,001文字');
  expect(api.all('POST', '/generate')).toHaveLength(0);
  // What was typed is kept, so it can be shortened rather than retyped.
  await expect(composer(page)).toHaveValue('あ'.repeat(2001));
});

test('a request of exactly 2,000 characters is sent', async ({ page, api }) => {
  await openNewProject(page);
  await send(page, 'あ'.repeat(2000));
  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
});

test('a picture over 5MB is refused by name, and nothing is attached', async ({ page, api }) => {
  await openNewProject(page);
  await page.getByLabel('ファイルを添付').setInputFiles({
    name: 'large-photo.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole('alert')).toContainText('画像は1枚5MBまで');
  await expect(page.getByRole('alert')).toContainText('large-photo.png');

  await send(page, '在庫一覧の画面を作ってください');
  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  expect(api.last('POST', '/generate')?.body).not.toHaveProperty('image');
  expect(api.last('POST', '/generate')?.body).not.toHaveProperty('images');
});

test('an empty request cannot be sent', async ({ page }) => {
  await openNewProject(page);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  await composer(page).fill('   ');
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
});
