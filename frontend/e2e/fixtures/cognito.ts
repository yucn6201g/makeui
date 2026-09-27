import { randomBytes } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { authenticationResult, COGNITO_HOST, type TestUser } from './auth';
import { CORS_HEADERS } from './http';

/**
 * The Cognito user pool, answered in the test.
 *
 * The app signs in with SRP (the library's default): InitiateAuth returns a
 * PASSWORD_VERIFIER challenge, the browser does the SRP arithmetic and answers
 * it. The arithmetic only needs a server value that is not a multiple of the
 * group modulus, so random bytes are enough; the answer is accepted as long as it
 * arrives. What happens next is the flow chosen for the test:
 *
 *   'tokens'        signed in straight away
 *   'totp'          asks for the authenticator code (an ordinary sign-in)
 *   'first-login'   asks for a new password, then for MFA to be set up
 *   'wrong-password' refuses the password
 */
export type SignInFlow = 'tokens' | 'totp' | 'first-login' | 'wrong-password';

/** The secret the MFA set-up screen shows. A made-up base32 string. */
export const MFA_SECRET = 'E2ETESTSECRETAAAAAAAAAAAAAAAAAAA';

export interface CognitoCall {
  operation: string;
  body: Record<string, unknown>;
}

export class CognitoMock {
  readonly calls: CognitoCall[] = [];
  flow: SignInFlow = 'tokens';
  /** Refuse the authenticator code, as Cognito does for a wrong one. */
  refuseCode = false;

  constructor(private readonly user: TestUser) {}

  async install(page: Page): Promise<void> {
    await page.route(`https://${COGNITO_HOST}/**`, (route) => this.handle(route));
  }

  /** The request bodies sent for one operation, in order. */
  sent(operation: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.operation === operation).map((c) => c.body);
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS });
    const operation = (request.headers()['x-amz-target'] ?? '').split('.').pop() ?? '';
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    this.calls.push({ operation, body });
    const reply = this.answer(operation, body);
    await route.fulfill({
      status: reply.status ?? 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/x-amz-json-1.1' },
      body: JSON.stringify(reply.body),
    });
  }

  private answer(operation: string, body: Record<string, unknown>): { status?: number; body: unknown } {
    const tokens = { AuthenticationResult: authenticationResult(this.user), ChallengeParameters: {} };
    const session = 'e2e-session';
    switch (operation) {
      case 'InitiateAuth':
        return {
          body: {
            ChallengeName: 'PASSWORD_VERIFIER',
            ChallengeParameters: {
              SALT: randomBytes(16).toString('hex'),
              SECRET_BLOCK: randomBytes(64).toString('base64'),
              SRP_B: randomBytes(384).toString('hex'),
              USERNAME: this.user.username,
              USER_ID_FOR_SRP: this.user.username,
            },
          },
        };
      case 'RespondToAuthChallenge': {
        const challenge = body.ChallengeName;
        if (challenge === 'PASSWORD_VERIFIER') {
          if (this.flow === 'wrong-password') {
            return { status: 400, body: { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' } };
          }
          if (this.flow === 'totp') return { body: { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: session, ChallengeParameters: {} } };
          if (this.flow === 'first-login') {
            return {
              body: {
                ChallengeName: 'NEW_PASSWORD_REQUIRED',
                Session: session,
                ChallengeParameters: { userAttributes: JSON.stringify({ email: this.user.email }), requiredAttributes: '[]' },
              },
            };
          }
          return { body: tokens };
        }
        if (challenge === 'NEW_PASSWORD_REQUIRED') return { body: { ChallengeName: 'MFA_SETUP', Session: session, ChallengeParameters: {} } };
        if (challenge === 'SOFTWARE_TOKEN_MFA' && this.refuseCode) {
          return { status: 400, body: { __type: 'CodeMismatchException', message: 'Invalid code received for user' } };
        }
        // SOFTWARE_TOKEN_MFA after the code, MFA_SETUP after the device was verified.
        return { body: tokens };
      }
      case 'AssociateSoftwareToken':
        return { body: { SecretCode: MFA_SECRET, Session: session } };
      case 'VerifySoftwareToken':
        return { body: { Status: 'SUCCESS', Session: session } };
      case 'RevokeToken':
      case 'GlobalSignOut':
        return { body: {} };
      default:
        return { status: 400, body: { __type: 'InvalidParameterException', message: `e2e: ${operation} is not mocked` } };
    }
  }
}
