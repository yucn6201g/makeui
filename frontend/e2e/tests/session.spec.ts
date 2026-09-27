import { test, expect } from '../fixtures/test';

test('signed in, the project list opens with the projects', async ({ page, api }) => {
  api.addProject({ name: '在庫管理' });
  await page.goto('/');
  await expect(page.getByText('在庫管理')).toBeVisible();
});
