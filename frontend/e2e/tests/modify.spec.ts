import { test, expect } from '../fixtures/test';
import { completedResult } from '../fixtures/api';
import { reactProject } from '../fixtures/project';
import { openProject, preview, send } from '../fixtures/screens';

test('an existing project opens with its document running in the preview', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await openProject(page, '在庫管理');
  await expect(preview(page).getByRole('listitem')).toHaveText(['ボールペン', 'ノート', 'クリップ']);
});

test('an instruction on a project with a document is an edit of that document', async ({ page, api }) => {
  const project = api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  api.nextJob = [{ status: 'completed', result: completedResult(reactProject({ title: '在庫一覧（検索つき）' })) }];
  await openProject(page, '在庫管理');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();

  await send(page, '一覧の上に検索欄を付けてください');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧（検索つき）' })).toBeVisible();

  // An edit, not a new build: the current document goes with the instruction.
  expect(api.all('POST', '/generate')).toHaveLength(0);
  const edit = api.last('POST', '/modify')?.body;
  expect(edit).toMatchObject({ instruction: '一覧の上に検索欄を付けてください', projectId: project.projectId, preset: 'none' });
  expect(edit.html).toContain('@@@makeui:file src/App.tsx');
  await expect.poll(() => api.projects[0].lastHtml ?? '').toContain('在庫一覧（検索つき）');
});

test('a project shared for viewing shows the document and says why it cannot be edited', async ({ page, api }) => {
  api.addProject({
    name: '共有された在庫管理',
    lastHtml: reactProject(),
    access: { role: 'view', ownerId: 'sub-owner', ownerName: '所有者', via: 'user' },
  });
  await openProject(page, '共有された在庫管理', '共有');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  await expect(page.getByText('閲覧権限で共有されたプロジェクトです')).toBeVisible();
  await expect(page.getByText('所有者 さんが所有')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'メッセージ入力' })).toHaveCount(0);
  // Opening it writes nothing back: a viewer's visit is not an edit.
  expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
});
