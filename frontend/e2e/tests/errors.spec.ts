import { test, expect } from '../fixtures/test';
import { composer, openNewProject, send } from '../fixtures/screens';

// Each way a request can fail says something a person can act on, and leaves
// the composer usable for the next attempt.

const PROMPT = '在庫一覧の画面を作ってください';

async function expectRecovered(page: import('@playwright/test').Page) {
  await expect(composer(page)).toBeEditable();
  await composer(page).fill(PROMPT);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
}

test("a server error is reported in the server's words", async ({ page, api }) => {
  api.on('POST', '/generate', { status: 500, body: { error: 'サーバーでエラーが起きました。しばらく待ってから、もう一度お試しください。' } });
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(page.getByText('サーバーでエラーが起きました。しばらく待ってから、もう一度お試しください。')).toBeVisible();
  await expectRecovered(page);
});

test("an answer that is not written for a reader is replaced by the screen's own sentence", async ({ page, api }) => {
  // An older API, a proxy, anything that answers in English or in HTTP words.
  api.on('POST', '/generate', { status: 502, body: { message: 'Bad Gateway' } });
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(page.getByText('生成を開始できませんでした。もう一度お試しください。')).toBeVisible();
  await expect(page.getByText(/Bad Gateway|HTTP 502/)).toHaveCount(0);
  await expectRecovered(page);
});

test("the monthly budget running out is reported in the server's words", async ({ page, api }) => {
  api.on('POST', '/generate', {
    status: 403,
    body: { error: '今月の予算を使い切りました。管理者にお問い合わせください。', currentUsage: 10_000_000, limit: 10_000_000, scope: 'user' },
  });
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(page.getByText('今月の予算を使い切りました。管理者にお問い合わせください。')).toBeVisible();
  await expectRecovered(page);
});

test('the rate limit says to wait', async ({ page, api }) => {
  api.on('POST', '/generate', { status: 429, body: { error: 'リクエストが多すぎます。しばらく待ってから、もう一度お試しください。', retryAfter: 30 } });
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(page.getByText('リクエストが多すぎます。しばらく待ってから、もう一度お試しください。')).toBeVisible();
});

test("a job that fails reports why, and nothing is saved as the project's document", async ({ page, api }) => {
  api.nextJob = [
    { status: 'running', streamPhase: 'code-assembler' },
    { status: 'failed', error: 'モデルとの通信が途中で切れました。もう一度お試しください。' },
  ];
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(page.getByText('モデルとの通信が途中で切れました。もう一度お試しください。')).toBeVisible();
  expect(api.projects[0].lastHtml).toBeUndefined();
  await expectRecovered(page);
});

test('the network failing is reported as the network', async ({ page }) => {
  await openNewProject(page);
  // Registered after the mock, so it is consulted first.
  await page.route('http://api.e2e.test/generate', (route) => route.abort('internetdisconnected'));
  await send(page, PROMPT);
  await expect(page.getByText('通信できませんでした。接続を確認して、もう一度お試しください。')).toBeVisible();
  await expectRecovered(page);
});

test("a job failing with a message not written for a reader shows the screen's own sentence", async ({ page, api }) => {
  api.nextJob = [{ status: 'failed', error: 'ThrottlingException: Rate exceeded' }];
  await openNewProject(page);
  await send(page, PROMPT);
  await expect(page.getByText('生成できませんでした。もう一度お試しください。')).toBeVisible();
  await expect(page.getByText(/ThrottlingException/)).toHaveCount(0);
});
