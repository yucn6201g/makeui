import { expect, type Page } from '@playwright/test';

/**
 * The parts of MakeUI's screens the specs talk to, found by their accessible
 * names — the names a screen reader announces — so a test breaks when a control
 * loses its name, not when a class is renamed.
 */
export const projectList = (page: Page) => page.getByRole('tablist', { name: '表示するプロジェクト' });
export const composer = (page: Page) => page.getByRole('textbox', { name: 'メッセージ入力' });
export const sendButton = (page: Page) => page.getByRole('button', { name: '送信', exact: true });
/** The generated app, running inside the preview's sandboxed frame. */
export const preview = (page: Page) => page.frameLocator('iframe[title="生成されたUIのプレビュー"]');

/** From the project list, a new project, ready for its first request. */
export async function openNewProject(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /新規プロジェクト/ }).click();
  await expect(composer(page)).toBeVisible();
}

/** From the project list, an existing project by name, on the tab it is listed under. */
export async function openProject(page: Page, name: string, tab: 'プロジェクト' | '共有' | 'アーカイブ' = 'プロジェクト'): Promise<void> {
  await page.goto('/');
  if (tab !== 'プロジェクト') await projectList(page).getByRole('tab', { name: tab }).click();
  await page.getByText(name, { exact: true }).click();
  await expect(page.getByRole('region', { name: 'プレビュー' })).toBeVisible();
}

export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await sendButton(page).click();
}

/** Opens one of the composer's menus (モード / モデル / デザイン / 形式) and picks an option. */
export async function choose(page: Page, menu: 'モード' | 'モデル' | 'デザイン' | '形式', option: RegExp | string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${menu} `) }).click();
  await page.getByRole('option', { name: option }).click();
}
