import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

/**
 * The name a person is shown by, everywhere they are shown.
 *
 * Sign-in is unchanged: Cognito's `Username` is the email address, and that is
 * what the login form sends. This is a separate, purely presentational name held
 * in the standard `name` attribute — mutable, not required, and writable only by
 * an administrator.
 *
 * ## Why a fallback rather than a migration
 *
 * Existing accounts have no `name`, and their name is to be the part of the
 * email before the `@`. That could have been a one-time backfill over the
 * directory. A rule applied on read is better here for two reasons that are not
 * about effort:
 *
 *   - a backfill is a write per account that can half-succeed, and the half that
 *     failed is invisible — the panel shows a name either way and nobody can
 *     tell which ones came from the migration.
 *   - it would have to be re-run for every account created outside this app, and
 *     the day it is forgotten a user appears with no name at all.
 *
 * With the rule here, "no `name` stored" has exactly one meaning and one answer,
 * for accounts that predate this and accounts that come after it.
 *
 * ## Why not `preferred_username`
 *
 * It is the attribute whose name matches the intent, and it is the wrong one:
 * Cognito treats it as an alias, so it must be unique across the pool and can be
 * used to sign in. Both are properties nobody asked for, and the second changes
 * what a login is. `name` carries no such meaning.
 */

/**
 * @param email the account's email address, which is also its Cognito username
 * @param name  the stored `name` attribute, if the account has one
 */
export function displayNameFor(email: string, name?: string | null): string {
  const given = (name ?? '').trim();
  if (given) return given;
  const local = (email ?? '').split('@')[0].trim();
  /*
   * The email itself is the last resort, not an empty string. A row with no
   * name at all is read as a rendering bug, and someone goes looking for one;
   * an address is at least an answer to "who is this".
   */
  return local || (email ?? '').trim();
}

/** The longest a name may be. Cognito's own ceiling for the attribute is 2048. */
export const DISPLAY_NAME_MAX = 64;

/**
 * Whether a name an administrator typed can be stored.
 *
 * Rejected rather than trimmed-and-accepted when it is empty: "" and "   " both
 * mean the account falls back to its email local part, and an admin who typed
 * spaces did not ask for that. Clearing a name is a real thing to want, and it
 * should be a deliberate action rather than a form that quietly did nothing.
 */
export function isValidDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= DISPLAY_NAME_MAX;
}

/*
 * ---------------------------------------------------------------------------
 * Resolving a signed-in user's own name.
 *
 * The obvious source is the ID token: Cognito puts readable standard attributes
 * in it, this pool's app client restricts none, so `name` should be there. That
 * "should" is the problem. The deployed app cannot be signed into from here, so
 * the claim cannot be checked — and if it is wrong, nothing breaks. The header
 * falls back to the email local part, which is a plausible name, and an
 * administrator who renames somebody sees the rename take effect everywhere
 * except on that person's own screen. That is the shape of defect this codebase
 * keeps finding late.
 *
 * So the name is read from the directory instead, which is true whatever the
 * token carries. A rename then takes effect on the next page load rather than on
 * the next token refresh, which is the better behaviour anyway.
 *
 * The cost is a Cognito call on an endpoint the client hits on load and on menu
 * open. A short cache removes almost all of them without making a rename take
 * noticeably longer to appear.
 */

/** Cognito username (this pool: the email) -> resolved name, and when. */
const cache = new Map<string, { name: string; at: number }>();

/**
 * Keyed by the Cognito username rather than by `sub`, because the rename
 * endpoint addresses users by username and has no `sub` to hand. A cache the
 * writer cannot invalidate is a cache that serves the old name for its whole
 * TTL after the one event that changes it.
 */
const CACHE_MS = 60_000;

/**
 * The name to show a signed-in user, resolved from the directory.
 *
 * Falls back to the token's own claims on any failure. A Cognito outage should
 * cost the header its freshness, not its contents — and what sits below that
 * fallback, the email local part, is what the account would be called anyway if
 * it has no stored name.
 */
export async function resolveDisplayName(
  email: string,
  nameFromToken: string,
  userPoolId: string
): Promise<string> {
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.name;
  if (!userPoolId || !email) return displayNameFor(email, nameFromToken);
  try {
    const res = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    const stored = res.UserAttributes?.find((a) => a.Name === 'name')?.Value;
    const name = displayNameFor(email, stored);
    cache.set(email, { name, at: Date.now() });
    return name;
  } catch {
    return displayNameFor(email, nameFromToken);
  }
}

/** Drops a cached name, so a rename shows on that user's very next request. */
export function forgetDisplayName(username: string): void {
  cache.delete(username);
}
