import { test, expect } from '../fixtures/test';
import { csv, png } from '../fixtures/files';
import { openNewProject, send } from '../fixtures/screens';

const PROMPT = '商品一覧の画面を作ってください';

test('one picture is a reference, sent with its description', async ({ page, api }) => {
  await openNewProject(page);
  await page.getByLabel('ファイルを添付').setInputFiles(png('reference.png'));
  await page.getByRole('textbox', { name: '添付画像 1 の説明' }).fill('この配色に合わせる');
  await send(page, PROMPT);

  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  const body = api.last('POST', '/generate')?.body;
  expect(body.image).toMatch(/^data:image\/(png|jpeg|webp);base64,/);
  expect(body).not.toHaveProperty('images');
  expect(body.imageCaptions).toEqual(['この配色に合わせる']);
});

test('several pictures go into the UI, each with its own description', async ({ page, api }) => {
  await openNewProject(page);
  await page.getByLabel('ファイルを添付').setInputFiles([png('shoes.png'), png('bag.png')]);
  await page.getByRole('textbox', { name: '添付画像 2 の説明' }).fill('バッグの写真');
  await send(page, PROMPT);

  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  const body = api.last('POST', '/generate')?.body;
  expect(body.images).toHaveLength(2);
  expect(body).not.toHaveProperty('image');
  expect(body.imageCaptions).toEqual(['', 'バッグの写真']);
});

test('a removed picture is not sent', async ({ page, api }) => {
  await openNewProject(page);
  await page.getByLabel('ファイルを添付').setInputFiles(png('reference.png'));
  await page.getByRole('button', { name: '画像を削除' }).click();
  await send(page, PROMPT);
  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  expect(api.last('POST', '/generate')?.body).not.toHaveProperty('image');
});

test('a data file is sent whole, by name, and only with the message it was attached to', async ({ page, api }) => {
  await openNewProject(page);
  await page.getByLabel('ファイルを添付').setInputFiles(csv('items.csv', [['品名', '在庫'], ['ボールペン', '120'], ['ノート', '45']]));
  await expect(page.getByText('items.csv')).toBeVisible();
  await send(page, PROMPT);

  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  expect(api.last('POST', '/generate')?.body.attachment).toEqual({ name: 'items.csv', content: '品名,在庫\nボールペン,120\nノート,45' });
  await expect(page.getByText('items.csv')).toHaveCount(0);
});

test('a data file can be taken off before sending', async ({ page, api }) => {
  await openNewProject(page);
  await page.getByLabel('ファイルを添付').setInputFiles(csv('items.csv', [['品名'], ['ノート']]));
  await page.getByRole('button', { name: 'データファイルを削除' }).click();
  await send(page, PROMPT);
  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  expect(api.last('POST', '/generate')?.body).not.toHaveProperty('attachment');
});
