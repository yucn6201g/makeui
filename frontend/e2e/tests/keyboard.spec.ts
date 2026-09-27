import { test, expect } from '../fixtures/test';
import { TEST_PASSWORD, TEST_TOTP_CODE, USER } from '../fixtures/auth';
import { reactProject } from '../fixtures/project';
import { composer, openNewProject, openProject, preview } from '../fixtures/screens';

// Everything here is done with the keyboard alone.

test.describe('signed out', () => {
  test.use({ user: null });

  test('signing in: Tab between the fields, Enter to submit', async ({ page, cognito }) => {
    cognito.flow = 'totp';
    await page.goto('/');
    await page.getByLabel('メールアドレス').focus();
    await page.keyboard.type(USER.email);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('パスワード', { exact: true })).toBeFocused();
    await page.keyboard.type(TEST_PASSWORD);
    await page.keyboard.press('Enter');
    // The code field takes the focus when it appears.
    await expect(page.getByLabel('認証コード')).toBeFocused();
    await page.keyboard.type(TEST_TOTP_CODE);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tablist', { name: '表示するプロジェクト' })).toBeVisible();
  });
});

test('a project card opens with Enter, and every card control is reachable by Tab', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await page.goto('/');
  const open = page.getByRole('button', { name: '在庫管理', exact: true });
  await open.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '在庫管理 をお気に入りに追加' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '在庫管理 をアーカイブ', exact: true })).toBeFocused();
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
});

test('Enter sends, Shift+Enter starts a new line', async ({ page, api }) => {
  await openNewProject(page);
  await composer(page).focus();
  await page.keyboard.type('在庫一覧の画面');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('品目と数量を表で');
  await expect(composer(page)).toHaveValue('在庫一覧の画面\n品目と数量を表で');
  expect(api.all('POST', '/generate')).toHaveLength(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => api.all('POST', '/generate').length).toBe(1);
  expect(api.last('POST', '/generate')?.body.prompt).toBe('在庫一覧の画面\n品目と数量を表で');
});

test('the Enter that confirms a Japanese conversion does not send', async ({ page, api }) => {
  await openNewProject(page);
  await composer(page).fill('ざいこ');
  // What an IME sends when Enter picks a candidate: a keydown flagged as composing.
  await composer(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await page.waitForTimeout(300);
  expect(api.all('POST', '/generate')).toHaveLength(0);
  await expect(composer(page)).toHaveValue('ざいこ');
});

test('a composer menu opens, moves and chooses with the keyboard', async ({ page, api }) => {
  await openNewProject(page);
  const trigger = page.getByRole('button', { name: /^デザイン / });
  await trigger.focus();
  await page.keyboard.press('Enter');
  // Opening puts the focus on the chosen option, so one step down is the next one.
  await expect(page.getByRole('option', { name: /プリセットなし/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: /デジタル庁/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'デザイン' })).toHaveCount(0);
  await expect(trigger).toHaveText(/デジタル庁/);
  // And the focus comes back to the trigger rather than falling to the page.
  await expect(trigger).toBeFocused();

  await composer(page).fill('在庫一覧の画面');
  await composer(page).press('Enter');
  await expect.poll(() => api.last('POST', '/generate')?.body.preset).toBe('digital-agency');
});

test('the chat column is resized with the arrow keys', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await openProject(page, '在庫管理');
  const handle = page.getByRole('separator', { name: 'チャット幅を調整' });
  await expect(handle).toHaveAttribute('aria-valuenow', '420');
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '460');
  const chat = (await page.getByRole('region', { name: 'チャット' }).boundingBox())!;
  expect(Math.round(chat.width)).toBe(460);
});

test('a code tab closes with Delete', async ({ page, api }) => {
  api.addProject({ name: '在庫管理', lastHtml: reactProject() });
  await openProject(page, '在庫管理');
  await page.getByRole('tab', { name: 'Code' }).click();
  await page.getByRole('treeitem', { name: 'App.tsx' }).click();
  const tab = page.getByRole('tab', { name: 'App.tsx' });
  await tab.focus();
  await page.keyboard.press('Delete');
  await expect(tab).toHaveCount(0);
});

test('Escape closes a menu without choosing, and the focus returns to it', async ({ page }) => {
  await openNewProject(page);
  const trigger = page.getByRole('button', { name: /^モデル / });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'モデル' })).toHaveCount(0);
  await expect(trigger).toHaveText(/自動/);
  await expect(trigger).toBeFocused();
});
