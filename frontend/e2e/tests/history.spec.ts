import { test, expect } from '../fixtures/test';
import { completedResult, type MockApi } from '../fixtures/api';
import { reactProject } from '../fixtures/project';
import { openProject, preview, send } from '../fixtures/screens';

/** A project with two runs: the first built the list, the second added a search. */
function seedHistory(api: MockApi) {
  const now = Date.now();
  const project = api.addProject({ name: '在庫管理', lastHtml: reactProject({ title: '在庫一覧（検索つき）' }) });
  api.versions.push(
    { versionId: 'v2', projectId: project.projectId, createdAt: new Date(now - 60_000).toISOString(), prompt: '一覧に検索欄を付けて', html: reactProject({ title: '在庫一覧（検索つき）' }), score: 88, preset: 'none', model: 'haiku' },
    { versionId: 'v1', projectId: project.projectId, createdAt: new Date(now - 600_000).toISOString(), prompt: '在庫一覧を作って', html: reactProject(), score: 80, preset: 'none', model: 'haiku' },
  );
  api.messages.set(project.projectId, [
    { id: 'm1', role: 'user', content: '在庫一覧を作って', timestamp: now - 600_000 },
    { id: 'm2', role: 'assistant', content: '在庫一覧の画面を作成しました。', timestamp: now - 590_000 },
  ]);
  return project;
}

test('the version menu lists every run, newest first, and choosing one shows it', async ({ page, api }) => {
  const project = seedHistory(api);
  await openProject(page, '在庫管理');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧（検索つき）' })).toBeVisible();

  await page.getByRole('button', { name: /^バージョン/ }).click();
  const options = page.getByRole('listbox', { name: 'バージョン' }).getByRole('option');
  await expect(options).toHaveText([/v2.*一覧に検索欄を付けて/, /v1.*在庫一覧を作って/]);
  await options.nth(1).click();

  await expect(preview(page).getByRole('heading', { name: '在庫一覧', exact: true })).toBeVisible();
  expect(api.last('GET', '/versions/v1')?.query.get('projectId')).toBe(project.projectId);
});

test('comparing shows two versions side by side, and one follows the other', async ({ page, api }) => {
  seedHistory(api);
  await openProject(page, '在庫管理');
  await page.getByRole('button', { name: '比較', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'バージョン比較' });
  const left = page.frameLocator('iframe[title="比較対象"]').first();
  const right = page.frameLocator('iframe[title="比較対象"]').last();
  await expect(left.getByRole('heading', { name: '在庫一覧', exact: true })).toBeVisible();
  await expect(right.getByRole('heading', { name: '在庫一覧（検索つき）' })).toBeVisible();
  await expect(dialog.getByText(/変更あり/)).toBeVisible();

  // 「画面を連動」 (reported broken 2026-09-25): a screen change on one side moves the other.
  await expect(dialog.getByRole('checkbox', { name: '画面を連動' })).toBeChecked();
  await left.getByRole('link', { name: '設定' }).click();
  await expect(left.getByRole('heading', { name: '設定' })).toBeVisible();
  await expect(right.getByRole('heading', { name: '設定' })).toBeVisible();

  // And a link to a screen stays inside the frame (the other half of that report).
  await expect(page).toHaveURL(/127\.0\.0\.1:4180\/?$/);

  await dialog.getByRole('tab', { name: 'コード' }).click();
  await expect(dialog.getByText('在庫一覧（検索つき）').first()).toBeVisible();

  await dialog.getByRole('button', { name: '閉じる' }).click();
  await expect(dialog).toHaveCount(0);
});

test('the conversation is read back when the project opens, and kept as it grows', async ({ page, api }) => {
  const project = seedHistory(api);
  // A result unlike every earlier version: the thread does not repeat a reply for a document it already has.
  api.nextJob = [{ status: 'completed', result: completedResult(reactProject({ title: '在庫一覧（大見出し）' })) }];
  await openProject(page, '在庫管理');

  const log = page.getByRole('log', { name: '会話履歴' });
  await expect(log.getByText('在庫一覧を作って')).toBeVisible();
  await expect(log.getByText('在庫一覧の画面を作成しました。')).toBeVisible();

  await send(page, '見出しを大きくしてください');
  await expect(log.getByText('見出しを大きくしてください')).toBeVisible();
  await expect.poll(() => (api.last('PUT', `/projects/${project.projectId}/messages`)?.body.messages ?? []).length).toBe(4);
  const saved = api.last('PUT', `/projects/${project.projectId}/messages`)?.body.messages;
  expect(saved.slice(0, 2).map((m: { content: string }) => m.content)).toEqual(['在庫一覧を作って', '在庫一覧の画面を作成しました。']);
  expect(saved.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
});
