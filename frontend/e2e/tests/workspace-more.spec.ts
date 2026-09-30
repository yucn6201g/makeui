import { test, expect } from '../fixtures/test';
import { completedResult, type JobStep } from '../fixtures/api';
import { reactProject } from '../fixtures/project';
import { composer, openNewProject, openProject, preview, send, sendButton } from '../fixtures/screens';

/*
 * The workspace's remaining paths (2026-09-30): leaving for the list, stopping a
 * run, leaving a run and coming back to it, and the device frames.
 */

const running = (n: number): JobStep[] =>
  Array.from({ length: n }, () => ({ status: 'running' as const, streamPhase: 'code-assembler', streamTail: 'export default function App() {' }));

test('the MakeUI mark goes back to the project list', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await openProject(page, '在庫管理');
  await page.getByRole('button', { name: 'MakeUI' }).click();
  await expect(page.getByRole('tablist', { name: '表示するプロジェクト' })).toBeVisible();
  await expect(page.getByText('在庫管理', { exact: true })).toBeVisible();
});

test('stopping a run says so in the thread, and the composer is free again', async ({ page, api }) => {
  api.nextJob = running(200);
  await openNewProject(page);
  await send(page, '在庫一覧を作って');
  const stop = page.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.getByRole('log', { name: '会話履歴' }).getByText('生成を停止しました。')).toBeVisible();
  await expect(stop).toHaveCount(0);
  await composer(page).fill('もう一度作って');
  await expect(sendButton(page)).toBeEnabled();
});

test('a run left for the list is marked there, and picked up again on return', async ({ page, api }) => {
  api.nextJob = [...running(4), { status: 'completed', result: completedResult(reactProject({ title: '在庫一覧（戻ってから）' })) }];
  await openNewProject(page);
  await send(page, '在庫一覧を作って');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();

  // Away while it runs: the card says so.
  await page.getByRole('button', { name: 'MakeUI' }).click();
  const card = page.locator('.project-list__card').filter({ hasText: 'Untitled' });
  await expect(card.getByText('生成中')).toBeVisible();

  // Back: the same job is polled on to the end and its result drawn.
  const jobPolls = () => api.all('GET', /^\/jobs\//).length;
  const before = jobPolls();
  await card.getByRole('button', { name: 'Untitled', exact: true }).click();
  await expect(preview(page).getByRole('heading', { name: '在庫一覧（戻ってから）' })).toBeVisible({ timeout: 20_000 });
  expect(jobPolls()).toBeGreaterThan(before);
  expect(api.all('POST', '/generate')).toHaveLength(1);
});

test('the preview is shown in a tablet and a phone frame, and back', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await openProject(page, '在庫管理');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  await page.getByRole('button', { name: 'Tablet', exact: true }).click();
  await expect(page.locator('.preview__device--tablet')).toBeVisible();
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  await expect(page.locator('.preview__device--mobile')).toBeVisible();
  await page.getByRole('button', { name: 'Desktop', exact: true }).click();
  await expect(page.locator('.preview__device--mobile, .preview__device--tablet')).toHaveCount(0);
});
