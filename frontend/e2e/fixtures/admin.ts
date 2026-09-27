import type { MockApi } from './api';

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

export function mockAdmin(api: MockApi): void {
  const users = ADMIN_USERS.map((u) => ({ ...u }));
  api.on('GET', '/admin/usage', { body: { users: ADMIN_USAGE } });
  api.on('GET', '/admin/users', () => ({ body: { users } }));
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
  api.on('GET', '/admin/groups', {
    body: { groups: [{ name: 'design', admin: 'taro@example.invalid', memberCount: 1, monthlyLimit: null, usedTokens: 120_000, cost: 1.8 }] },
  });
  api.on('GET', /^\/admin\/projects\/[^/]+$/, { body: { projects: [] } });
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
