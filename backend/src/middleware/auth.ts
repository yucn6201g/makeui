import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { logger } from '../utils/logger.js';
import { getParameter } from '../config/agentcore-config.js';
import { membershipOf, type Membership } from '../services/user-groups.js';

export interface AuthResult {
  userId: string;
  email: string;
  /**
   * The Cognito `name` attribute, or '' when the account has none.
   *
   * Not the sign-in identity — that is the email, which is also the Cognito
   * username. Empty is normal rather than exceptional: every account predating
   * this has no `name`, and services/display-name.ts is what turns that into
   * something to print.
   */
  name: string;
  groups: string[];
  /**
   * The role and group these claims describe — see services/user-groups.ts.
   *
   * Derived here rather than at each route, because every route that read
   * `groups.includes('admin')` is one that now has three answers to give and a
   * scope to apply. Deriving it once means a route cannot accidentally ask the
   * old question.
   */
  membership: Membership;
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

async function getVerifier() {
  if (verifier) return verifier;

  const userPoolId = process.env.COGNITO_USER_POOL_ID
    || await getParameter('/makeui/cognito/user-pool-id');
  const clientId = process.env.COGNITO_CLIENT_ID
    || await getParameter('/makeui/cognito/client-id');

  verifier = CognitoJwtVerifier.create({
    userPoolId,
    tokenUse: 'id',
    clientId,
  });
  return verifier;
}

export async function authenticateRequest(
  authorizationHeader: string | null | undefined
): Promise<AuthResult> {
  if (!authorizationHeader) {
    throw new AuthError('Missing Authorization header', 401);
  }

  const parts = authorizationHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    throw new AuthError('Invalid Authorization header format. Expected: Bearer <token>', 401);
  }

  const token = parts[1];

  try {
    const jwtVerifier = await getVerifier();
    const payload = await jwtVerifier.verify(token);

    return {
      userId: payload.sub,
      email: (payload as any).email ?? '',
      /*
       * The name the account is shown by, when it has one. Absent for every
       * account created before names existed, and for any token minted before
       * an administrator set one — `displayNameFor` is what turns either case
       * into something printable.
       */
      name: (payload as any).name ?? '',
      groups: (payload as any)['cognito:groups'] ?? [],
      membership: membershipOf((payload as any)['cognito:groups'] ?? []),
    };
  } catch (error) {
    logger.error('JWT verification failed', { error: String(error) });
    throw new AuthError('Invalid or expired token', 401);
  }
}

export class AuthError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}
