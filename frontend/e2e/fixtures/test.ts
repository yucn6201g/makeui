import { test as base, expect } from '@playwright/test';
import { MockApi } from './api';
import { CognitoMock } from './cognito';
import { signIn, USER, type TestUser } from './auth';

/**
 * The `test` every spec imports.
 *
 *   api       the mocked MakeUI API (fixtures/api.ts), installed before the page opens
 *   cognito   the mocked user pool (fixtures/cognito.ts)
 *   user      who the test is signed in as; `null` starts signed out
 *
 * Any request that is neither to the app itself nor to one of the two mocks is
 * aborted and fails the test, as does an API route no mock answered: a test that
 * passes while the page reached for something unmocked has not tested that page.
 */
type Fixtures = {
  user: TestUser | null;
  api: MockApi;
  cognito: CognitoMock;
};

export const test = base.extend<Fixtures>({
  user: [USER, { option: true }],

  api: [async ({ page }, use) => {
    const api = new MockApi();
    await api.install(page);
    await use(api);
    expect(api.unhandled, 'API requests no mock answered').toEqual([]);
  }, { auto: true }],

  cognito: [async ({ page, user }, use) => {
    const cognito = new CognitoMock(user ?? USER);
    await cognito.install(page);
    await use(cognito);
  }, { auto: true }],

  page: async ({ page, user, baseURL }, use) => {
    const external: string[] = [];
    // Registered first, so the two mocks (registered later) take their own hosts.
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(baseURL!) || url.startsWith('data:') || url.startsWith('blob:')) return route.fallback();
      // MakeUI's own web fonts (src/index.css). Answered empty so no run depends on the network;
      // the fallback fonts render the same text.
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) {
        return route.fulfill({ status: 200, contentType: url.includes('googleapis') ? 'text/css' : 'font/woff2', body: '' });
      }
      external.push(url);
      return route.abort('blockedbyclient');
    });
    if (user) await signIn(page, user);
    await use(page);
    expect(external, 'requests to hosts outside the test').toEqual([]);
  },
});

export { expect };
