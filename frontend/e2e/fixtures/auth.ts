import type { Page } from '@playwright/test';

/**
 * A signed-in browser without a user pool.
 *
 * amazon-cognito-identity-js keeps the session in localStorage and checks only
 * the tokens' `exp` locally — it never verifies a signature — so tokens made
 * here, with a dummy signature, read as a live session. The values match
 * .env.e2e; nothing here is a real identity.
 */
export const CLIENT_ID = 'e2etestclient000000000000';
export const COGNITO_HOST = 'cognito-idp.e2e-test-1.amazonaws.com';

export interface TestUser {
  email: string;
  /** `cognito:username`; the pool's username is the email address. */
  username: string;
  /** `cognito:groups`: `admin`, `grp:<name>`, `grpadm:<name>`. */
  groups: string[];
}

/**
 * What the sign-in tests type. Made up for these tests and meaningful only to the
 * mocked pool (fixtures/cognito.ts), which accepts any password.
 */
export const TEST_PASSWORD = 'e2e-Dummy-Passw0rd';
export const TEST_NEW_PASSWORD = 'e2e-Dummy-NewPassw0rd';
export const TEST_TOTP_CODE = '123456';

export const USER: TestUser ={ email: 'e2e-user@example.invalid', username: 'e2e-user@example.invalid', groups: [] };
export const SUPER_ADMIN: TestUser = { email: 'e2e-admin@example.invalid', username: 'e2e-admin@example.invalid', groups: ['admin'] };

const b64url = (value: object | string) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** An unsigned JWT that expires in an hour. */
export function makeJwt(user: TestUser, use: 'id' | 'access'): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: `sub-${user.username}`,
    email: user.email,
    'cognito:username': user.username,
    ...(user.groups.length ? { 'cognito:groups': user.groups } : {}),
    token_use: use,
    aud: CLIENT_ID,
    client_id: CLIENT_ID,
    iat: now,
    auth_time: now,
    exp: now + 3600,
  };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.${b64url('e2e-signature')}`;
}

/** The tokens a successful sign-in returns, in Cognito's response shape. */
export function authenticationResult(user: TestUser) {
  return {
    IdToken: makeJwt(user, 'id'),
    AccessToken: makeJwt(user, 'access'),
    RefreshToken: 'e2e-refresh-token',
    ExpiresIn: 3600,
    TokenType: 'Bearer',
  };
}

/** Writes the session into localStorage before the app's first script runs. */
export async function signIn(page: Page, user: TestUser = USER): Promise<void> {
  const prefix = `CognitoIdentityServiceProvider.${CLIENT_ID}`;
  const entries: Record<string, string> = {
    [`${prefix}.LastAuthUser`]: user.username,
    [`${prefix}.${user.username}.idToken`]: makeJwt(user, 'id'),
    [`${prefix}.${user.username}.accessToken`]: makeJwt(user, 'access'),
    [`${prefix}.${user.username}.refreshToken`]: 'e2e-refresh-token',
    [`${prefix}.${user.username}.clockDrift`]: '0',
  };
  await page.addInitScript((items) => {
    // Once per page, not per navigation: a test that signs out and reloads stays signed out.
    if (sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, entries);
}
