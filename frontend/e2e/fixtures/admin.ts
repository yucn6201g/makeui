import type { MockApi } from './api';
import { reactProject } from './project';

/**
 * The admin routes, answered with a small account: two people, one group and one
 * month of spend across two models. The shapes follow src/hooks/useAdmin.ts and
 * the routes in backend/src/handlers/lambda-handler.ts. Made-up people only.
 */

/** This month as the app sees it: the browser runs in Asia/Tokyo (playwright.config.ts). */
export const THIS_MONTH = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date());
const MONTH = THIS_MONTH;

export const ADMIN_USAGE = [
  {
    userId: 'sub-taro', email: 'taro@example.invalid', displayName: '山田 太郎', month: MONTH,
    totalTokens: 120_000, inputTokens: 80_000, outputTokens: 40_000, requestCount: 12,
    cost: 1.8, monthlyLimit: 10_000_000, group: 'design', projectCount: 4, lastUpdated: new Date().toISOString(),
    byModel: [
      { model: 'haiku', inputTokens: 60_000, outputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 10, cost: 0.6 },
      { model: 'sonnet', inputTokens: 20_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 2, cost: 1.2 },
    ],
  },
  {
    userId: 'sub-hanako', email: 'hanako@example.invalid', displayName: '佐藤 花子', month: MONTH,
    totalTokens: 30_000, inputTokens: 20_000, outputTokens: 10_000, requestCount: 3,
    cost: 0.3, monthlyLimit: -1, group: null, projectCount: 1, lastUpdated: new Date().toISOString(),
  },
];

export const ADMIN_USERS = [
  { username: 'taro@example.invalid', email: 'taro@example.invalid', displayName: '山田 太郎', displayNameSet: true, group: 'design', isGroupAdmin: true, status: 'CONFIRMED', enabled: true, createdAt: new Date().toISOString() },
  { username: 'hanako@example.invalid', email: 'hanako@example.invalid', displayName: '佐藤 花子', displayNameSet: true, group: null, isGroupAdmin: false, status: 'CONFIRMED', enabled: true, createdAt: new Date().toISOString() },
];

/** A project of 山田 太郎's, with two versions, for the projects tab. */
export const ADMIN_PROJECT = {
  projectId: 'p-taro-1', userId: 'sub-taro', name: '在庫管理', createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  updatedAt: new Date().toISOString(), outputKind: 'react', preset: 'none', totalTokens: 90_000, requestCount: 2, hasDocument: true,
};
export const ADMIN_VERSIONS = [
  { versionId: 'tv2', projectId: 'p-taro-1', createdAt: new Date(Date.now() - 60_000).toISOString(), prompt: '検索欄を付けて', score: 88, preset: 'none', model: 'haiku', tokens: { input: 30_000, output: 15_000 } },
  { versionId: 'tv1', projectId: 'p-taro-1', createdAt: new Date(Date.now() - 600_000).toISOString(), prompt: '在庫一覧を作って', score: 80, preset: 'none', model: 'haiku', tokens: { input: 30_000, output: 15_000 } },
];

/**
 * The admin routes, stateful, answering as handlers/lambda-handler.ts does:
 * a write changes what the next read returns, so a test can check that the
 * screen shows what the server now holds rather than what it sent.
 */
export function mockAdmin(api: MockApi): void {
  const users = ADMIN_USERS.map((u) => ({ ...u, group: u.group as string | null, isGroupAdmin: u.isGroupAdmin as boolean }));
  const usage = ADMIN_USAGE.map((u) => ({ ...u, allowedModels: ['haiku', 'sonnet', 'opus', 'auto'] as string[] }));
  const groups: Array<{ name: string; admin: string | null; memberCount: number; monthlyLimit: number; usedTokens: number; cost: number }> = [
    { name: 'design', admin: 'taro@example.invalid', memberCount: 1, monthlyLimit: -1, usedTokens: 120_000, cost: 1.8 },
  ];
  const recount = () => { for (const g of groups) g.memberCount = users.filter((u) => u.group === g.name).length; };
  api.on('GET', '/admin/usage', () => ({ body: { users: usage.map((u) => ({ ...u, group: users.find((x) => x.email === u.email)?.group ?? null })) } }));
  api.on('GET', '/admin/users', () => ({ body: { users } }));

  // Limits and models, per account.
  api.on('POST', '/admin/usage/limit', (req) => {
    const row = usage.find((u) => u.userId === req.body?.userId);
    if (!row) return { status: 404, body: { error: 'ユーザーが見つかりません。' } };
    const limit = req.body?.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || (limit !== -1 && limit < 1)) return { status: 400, body: { error: '予算の値が正しくありません。' } };
    row.monthlyLimit = limit;
    return { body: { message: `Limit for ${row.userId} set to ${limit}` } };
  });
  api.on('POST', '/admin/usage/model-allowance', (req) => {
    const row = usage.find((u) => u.userId === req.body?.userId);
    if (!row) return { status: 404, body: { error: 'ユーザーが見つかりません。' } };
    row.allowedModels = req.body?.models ?? [];
    return { body: { message: `Allowed models for ${row.userId} set to ${row.allowedModels.join(', ')}` } };
  });

  // Accounts: rename, enable or disable, delete.
  api.on('PATCH', /^\/admin\/users\/([^/]+)$/, (req, m) => {
    const user = users.find((u) => u.username === decodeURIComponent(m[1]));
    if (!user) return { status: 404, body: { error: 'ユーザーが見つかりません。' } };
    if (req.body?.displayName !== undefined) {
      const name = String(req.body.displayName).trim();
      if (!name || name.length > 64) return { status: 400, body: { error: 'ユーザー名は1〜64文字で入力してください。' } };
      user.displayName = name;
      return { body: { success: true, displayName: name } };
    }
    user.enabled = Boolean(req.body?.enabled);
    return { body: { success: true, enabled: user.enabled } };
  });
  api.on('DELETE', /^\/admin\/users\/([^/]+)$/, (_req, m) => {
    const at = users.findIndex((u) => u.username === decodeURIComponent(m[1]));
    if (at < 0) return { status: 404, body: { error: 'ユーザーが見つかりません。' } };
    users.splice(at, 1);
    recount();
    return { body: { success: true, purged: { projects: 0, versions: 0 } } };
  });
  // Creating an account, as the handler answers it (201 and the new user).
  api.on('POST', '/admin/users', (req) => {
    if (users.some((u) => u.email === req.body?.email)) return { status: 409, body: { error: 'このメールアドレスはすでに登録されています。' } };
    const user = {
      username: req.body.email, email: req.body.email, displayName: req.body.displayName, displayNameSet: true,
      group: null, isGroupAdmin: false, status: 'FORCE_CHANGE_PASSWORD', enabled: true, createdAt: new Date().toISOString(),
    };
    users.push(user);
    return { status: 201, body: { user } };
  });
  // Groups: create, delete, membership, administrator and budget.
  api.on('GET', '/admin/groups', () => ({ body: { groups } }));
  api.on('POST', '/admin/groups', (req) => {
    const name = String(req.body?.name ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/.test(name)) return { status: 400, body: { error: 'グループ名は英数字で始まる63文字以内（英数字・空白・_ . -）で入力してください。' } };
    if (groups.some((g) => g.name === name)) return { status: 409, body: { error: 'その名前のグループはすでにあります。' } };
    groups.push({ name, admin: null, memberCount: 0, monthlyLimit: -1, usedTokens: 0, cost: 0 });
    return { status: 201, body: { group: { name, admin: null, memberCount: 0 } } };
  });
  api.on('DELETE', /^\/admin\/groups\/([^/]+)$/, (_req, m) => {
    const name = decodeURIComponent(m[1]);
    const at = groups.findIndex((g) => g.name === name);
    if (at < 0) return { status: 404, body: { error: 'そのグループは見つかりません。' } };
    groups.splice(at, 1);
    for (const u of users) if (u.group === name) { u.group = null; u.isGroupAdmin = false; }
    return { body: { success: true } };
  });
  api.on('POST', '/admin/groups/membership', (req) => {
    const user = users.find((u) => u.username === req.body?.username);
    if (!user) return { status: 404, body: { error: 'ユーザーが見つかりません。' } };
    user.group = req.body?.group ?? null;
    if (!user.group) user.isGroupAdmin = false;
    recount();
    return { body: { success: true } };
  });
  api.on('POST', '/admin/groups/admin', (req) => {
    const group = groups.find((g) => g.name === req.body?.group);
    if (!group) return { status: 404, body: { error: 'そのグループは見つかりません。' } };
    for (const u of users) if (u.group === group.name) u.isGroupAdmin = u.username === req.body?.username;
    group.admin = req.body?.username ?? null;
    return { body: { success: true } };
  });
  api.on('POST', '/admin/groups/limit', (req) => {
    const group = groups.find((g) => g.name === req.body?.group);
    if (!group) return { status: 404, body: { error: 'そのグループは見つかりません。' } };
    group.monthlyLimit = req.body?.limit;
    return { body: { message: `Budget for ${group.name} set to ${group.monthlyLimit}` } };
  });

  // One account's projects, a project's versions, and one version.
  api.on('GET', /^\/admin\/projects\/([^/]+)$/, (_req, m) => ({
    body: { userId: decodeURIComponent(m[1]), projects: decodeURIComponent(m[1]) === 'sub-taro' ? [ADMIN_PROJECT] : [] },
  }));
  api.on('GET', /^\/admin\/projects\/([^/]+)\/([^/]+)\/versions$/, (_req, m) => ({
    body: { userId: decodeURIComponent(m[1]), projectId: decodeURIComponent(m[2]), versions: m[2] === 'p-taro-1' ? ADMIN_VERSIONS : [] },
  }));
  api.on('GET', /^\/admin\/versions\/([^/]+)\/([^/]+)$/, (_req, m) => {
    const v = ADMIN_VERSIONS.find((x) => x.versionId === m[2]);
    if (!v) return { status: 404, body: { error: 'バージョンが見つかりません。' } };
    return { body: { ...v, html: reactProject({ title: v.versionId === 'tv2' ? '在庫一覧（検索つき）' : '在庫一覧' }) } };
  });
  api.on('GET', '/admin/models', (req) => {
    const from = req.query.get('from') ?? MONTH;
    const to = req.query.get('to') ?? from;
    const tier = (id: string, label: string, isDefault = false) => ({
      id, label, profile: `e2e-profile-${id}`, scope: 'jp', vendor: 'anthropic', version: null, withdrawn: false, isDefault,
      prices: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    });
    return {
      body: {
        provider: 'bedrock',
        region: 'e2e-test-1',
        tiers: [tier('haiku', 'Haiku', true), tier('sonnet', 'Sonnet')],
        withdrawn: [],
        pricing: { currency: 'USD', enforced: true },
        period: { from, to },
        series: [{
          month: MONTH, totalTokens: 150_000, requestCount: 15, cost: 2.1, estimated: false,
          attributed: { tokens: 150_000, requests: 15 },
          byModel: [
            { model: 'haiku', inputTokens: 80_000, outputTokens: 40_000, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 13, cost: 0.9 },
            { model: 'sonnet', inputTokens: 20_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 2, cost: 1.2 },
          ],
        }],
      },
    };
  });
}
