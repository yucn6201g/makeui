import { CognitoIdentityProviderClient, ListUsersCommand, type UserType } from '@aws-sdk/client-cognito-identity-provider';
import { displayNameFor } from './display-name.js';
import { logger } from '../utils/logger.js';

/**
 * Finding another MakeUI account, to share a project with it.
 *
 * Cognito's `ListUsers` filters on one attribute at a time and only by equality
 * or prefix, so a search is two prefix queries — the display name and the email
 * — merged. The Cognito username is the email for this pool; the `sub` is the
 * id every row in the table is keyed by.
 *
 * A search needs two characters and returns at most `SEARCH_LIMIT` accounts:
 * enough to pick a colleague, not a way to page through the directory.
 */

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';

export interface DirectoryUser {
  userId: string;
  email: string;
  name: string;
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_LIMIT = 8;

function toUser(u: UserType): DirectoryUser | null {
  const attr = (n: string) => u.Attributes?.find((a) => a.Name === n)?.Value ?? '';
  const sub = attr('sub');
  const email = attr('email') || u.Username || '';
  if (!sub || u.Enabled === false) return null;
  return { userId: sub, email, name: displayNameFor(email, attr('name')) };
}

/** Cognito's filter syntax takes the value in double quotes; a quote inside it would end the filter. */
const quoted = (s: string) => s.replace(/["\\]/g, '');

async function listBy(filter: string): Promise<DirectoryUser[]> {
  if (!USER_POOL_ID) return [];
  const res = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: filter, Limit: SEARCH_LIMIT * 2 }));
  return (res.Users ?? []).map(toUser).filter((u): u is DirectoryUser => u !== null);
}

export async function searchUsers(query: string, excludeUserId?: string): Promise<DirectoryUser[]> {
  const q = quoted(query.trim());
  if (q.length < SEARCH_MIN_CHARS) return [];
  const [byName, byEmail] = await Promise.all([
    listBy(`name ^= "${q}"`).catch(() => []),
    // Addresses are stored in lower case; a person types them however they like.
    listBy(`email ^= "${q.toLowerCase()}"`).catch(() => []),
  ]);
  const seen = new Set<string>();
  const out: DirectoryUser[] = [];
  for (const u of [...byName, ...byEmail]) {
    if (seen.has(u.userId) || u.userId === excludeUserId) continue;
    seen.add(u.userId);
    out.push(u);
  }
  return out.slice(0, SEARCH_LIMIT);
}

const bySubCache = new Map<string, { user: DirectoryUser | null; at: number }>();
const CACHE_MS = 5 * 60_000;

/** An account by its `sub`, for naming owners and grantees. Null when it no longer exists. */
export async function userBySub(sub: string): Promise<DirectoryUser | null> {
  const hit = bySubCache.get(sub);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  try {
    const [user] = await listBy(`sub = "${quoted(sub)}"`);
    bySubCache.set(sub, { user: user ?? null, at: Date.now() });
    return user ?? null;
  } catch (e) {
    logger.warn('Could not resolve an account by sub', { error: String(e) });
    return null;
  }
}
