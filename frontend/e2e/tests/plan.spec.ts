import { test, expect } from '../fixtures/test';
import { choose, openNewProject, preview, send } from '../fixtures/screens';

const PLAN = '## 構成案\n\n- 在庫一覧: 品目と数量の表\n- 設定: 通知の閾値';
const SPEC = '# 設計仕様\n\n画面: 在庫一覧、設定。';

test('plan mode proposes first, and approving builds from the approved specification', async ({ page, api }) => {
  api.nextJob = [{ status: 'running', streamPhase: 'plan-writer' }, { status: 'completed', result: { plan: PLAN, spec: SPEC, modelTier: 'haiku', preset: 'none' } }];
  await openNewProject(page);
  await choose(page, 'モード', /^プラン/);
  await send(page, '在庫管理の画面を作ってください');

  // A proposal, not a document.
  const log = page.getByRole('log', { name: '会話履歴' });
  await expect(log.getByText('在庫一覧: 品目と数量の表')).toBeVisible();
  expect(api.last('POST', '/plan')?.body).toMatchObject({ prompt: '在庫管理の画面を作ってください', preset: 'none', model: 'auto', outputKind: 'react' });
  expect(api.all('POST', '/generate')).toHaveLength(0);

  // Approving builds it, with the specification in place of a fresh design phase.
  api.nextJob = [{ status: 'completed', result: (await import('../fixtures/api')).completedResult() }];
  await log.getByRole('button', { name: 'このプランで作成' }).click();
  await expect(preview(page).getByRole('heading', { name: '在庫一覧' })).toBeVisible();
  expect(api.last('POST', '/generate')?.body).toMatchObject({ prompt: '在庫管理の画面を作ってください', approvedPlan: SPEC });
});

test('answering a proposal amends it rather than starting over', async ({ page, api }) => {
  api.nextJob = [{ status: 'completed', result: { plan: PLAN, spec: SPEC } }];
  await openNewProject(page);
  await choose(page, 'モード', /^プラン/);
  await send(page, '在庫管理の画面を作ってください');
  await expect(page.getByRole('log', { name: '会話履歴' }).getByText('在庫一覧: 品目と数量の表')).toBeVisible();

  await send(page, '設定画面はいりません');
  await expect.poll(() => api.all('POST', '/plan').length).toBe(2);
  expect(api.last('POST', '/plan')?.body.revision).toMatchObject({ spec: SPEC, plan: PLAN, prompt: '在庫管理の画面を作ってください' });
});
