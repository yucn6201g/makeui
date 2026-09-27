import { test, expect } from '../fixtures/test';
import { choose, openNewProject, preview, send } from '../fixtures/screens';

const PROMPT = '在庫一覧の画面を作ってください';

test('a request is sent as the composer shows it, and the result runs in the preview', async ({ page, api }) => {
  await openNewProject(page);
  await send(page, PROMPT);

  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();

  const request = api.last('POST', '/generate');
  expect(request?.body).toMatchObject({
    prompt: PROMPT,
    preset: 'none',
    model: 'auto',
    outputKind: 'react',
    effort: 'checked',
    projectId: api.projects[0].projectId,
  });
  // Nothing attached, so nothing about attachments is sent.
  expect(request?.body).not.toHaveProperty('images');
  expect(request?.body).not.toHaveProperty('image');
  expect(request?.headers.authorization).toMatch(/^Bearer ey/);

  // It is an app, not a picture of one: its own navigation works.
  await preview(page).getByRole('link', { name: '設定' }).click();
  await expect(preview(page).getByRole('heading', { name: '設定' })).toBeVisible();
});

test('the finished document and the conversation are saved to the project', async ({ page, api }) => {
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();

  const projectId = api.projects[0].projectId;
  await expect.poll(() => api.projects[0].lastHtml ?? '').toContain('@@@makeui:file src/App.tsx');
  // An untitled project is named after its first request.
  await expect.poll(() => api.projects[0].name).toBe(PROMPT);
  await expect.poll(() => (api.last('PUT', `/projects/${projectId}/messages`)?.body.messages ?? []).map((m: { role: string }) => m.role))
    .toEqual(['user', 'assistant']);
});

test('the job is polled until it finishes, and the step it is on is shown meanwhile', async ({ page, api }) => {
  api.nextJob = [
    { status: 'pending' },
    { status: 'running', streamPhase: 'code-assembler', streamTail: 'export default function App() {' },
    ...api.nextJob.slice(-1),
  ];
  await openNewProject(page);
  await send(page, PROMPT);

  // While it runs, the preview says so — announced, not only drawn.
  await expect(page.getByRole('region', { name: 'プレビュー' }).getByRole('status')).toBeVisible();
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'プレビュー' }).getByRole('status')).toHaveCount(0);
  expect(api.all('GET', /^\/jobs\//).length).toBeGreaterThanOrEqual(3);
});

test.describe('the composer menus decide what is sent', () => {
  test('design system', async ({ page, api }) => {
    await openNewProject(page);
    await page.getByRole('button', { name: /^デザイン / }).click();
    // The five on offer: none, and the four systems a build can be bound to.
    await expect(page.getByRole('option')).toHaveText([
      /プリセットなし/, /デジタル庁/, /Carbon/, /Spindle/, /Material Design 3/,
    ]);
    await page.getByRole('option', { name: /Carbon/ }).click();
    await send(page, PROMPT);
    await expect.poll(() => api.last('POST', '/generate')?.body.preset).toBe('carbon');
  });

  test('model', async ({ page, api }) => {
    await openNewProject(page);
    await choose(page, 'モデル', /Haiku/);
    await send(page, PROMPT);
    await expect.poll(() => api.last('POST', '/generate')?.body.model).toBe('haiku');
  });

  test('framework', async ({ page, api }) => {
    await openNewProject(page);
    await choose(page, '形式', /Vue/);
    await send(page, PROMPT);
    await expect.poll(() => api.last('POST', '/generate')?.body.outputKind).toBe('vue');
  });
});
