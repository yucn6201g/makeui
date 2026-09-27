import { test, expect } from '../fixtures/test';
import { reactProject } from '../fixtures/project';
import { choose, composer, openNewProject, openProject, send } from '../fixtures/screens';

test.describe('an existing project', () => {
  test.beforeEach(({ api }) => {
    const project = api.addProject({ name: '在庫管理', lastHtml: reactProject() });
    api.messages.set(project.projectId, [
      { id: 'm1', role: 'user', content: '在庫一覧を作って', timestamp: Date.now() - 60_000 },
      { id: 'm2', role: 'assistant', content: '在庫一覧の画面を作成しました。', timestamp: Date.now() - 50_000 },
    ]);
  });

  // This was 「New Chat」, which also deleted the conversation. Choosing another
  // format is the request to rebuild now, and it destroys nothing.
  test('choosing another format makes the next message a new build in it, and keeps the conversation', async ({ page, api }) => {
    await openProject(page, '在庫管理');
    await choose(page, '形式', /Vue/);
    await send(page, '同じ画面を作ってください');

    await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
    expect(api.last('POST', '/generate')?.body.outputKind).toBe('vue');
    expect(api.all('POST', '/modify')).toEqual([]);
    await expect(page.getByRole('log', { name: '会話履歴' }).getByText('在庫一覧を作って')).toBeVisible();
    expect(api.all('DELETE', /./)).toEqual([]);
  });

  test('the code tab lists the project\'s files and shows one', async ({ page }) => {
    await openProject(page, '在庫管理');
    await page.getByRole('tab', { name: 'Code' }).click();
    const tree = page.getByRole('complementary', { name: 'エクスプローラー' }).getByRole('tree');
    await expect(tree.getByRole('treeitem', { name: 'App.tsx' })).toBeVisible();
    await tree.getByRole('treeitem', { name: 'App.tsx' }).click();
    await expect(page.getByRole('tab', { name: /App\.tsx/ })).toBeVisible();
    await expect(page.getByText('export default function App()').first()).toBeVisible();
  });

  test('the project downloads as a ZIP that holds its files', async ({ page }) => {
    await openProject(page, '在庫管理');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'ZIPでダウンロード' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const bytes = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks));
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    // Stored, not compressed (utils/preview/zip.ts), so the names are plain in the archive.
    for (const name of ['src/App.tsx', 'src/main.tsx', 'package.json', 'index.html']) expect(bytes.includes(Buffer.from(name))).toBe(true);
  });

  test('renaming the project saves the name', async ({ page, api }) => {
    await openProject(page, '在庫管理');
    const title = page.getByRole('textbox', { name: 'プロジェクト名' });
    await title.fill('倉庫の在庫');
    await title.press('Enter');
    await expect.poll(() => api.last('PUT', '/projects/p-e2e-1')?.body.name).toBe('倉庫の在庫');
  });

  test('Escape puts the name back without saving', async ({ page, api }) => {
    await openProject(page, '在庫管理');
    const title = page.getByRole('textbox', { name: 'プロジェクト名' });
    await title.fill('書きかけの名前');
    await title.press('Escape');
    await expect(title).toHaveValue('在庫管理');
    expect(api.all('PUT', '/projects/p-e2e-1').filter((c) => 'name' in (c.body ?? {}))).toEqual([]);
  });
});

test('refining a brief proposes a rewrite, says what it added, and replaces it only when asked', async ({ page, api }) => {
  await openNewProject(page);
  await composer(page).fill('在庫管理の画面');
  await page.getByRole('button', { name: 'プロンプトを添削' }).click();

  const suggestion = page.getByRole('status').filter({ hasText: '添削案' });
  await expect(suggestion).toContainText('画面: 一覧・詳細・設定の3画面。');
  await expect(suggestion.getByRole('listitem')).toHaveText(['画面の一覧を明記しました']);
  expect(api.last('POST', '/refine-prompt')?.body).toEqual({ prompt: '在庫管理の画面' });
  await expect(composer(page)).toHaveValue('在庫管理の画面');

  await suggestion.getByRole('button', { name: '置き換える' }).click();
  await expect(composer(page)).toHaveValue('在庫管理の画面\n\n画面: 一覧・詳細・設定の3画面。');
});

test('a template fills the composer with its brief', async ({ page }) => {
  await openNewProject(page);
  await page.getByRole('button', { name: 'テンプレートを入力: 予約システム' }).click();
  await expect(composer(page)).not.toHaveValue('');
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
});
