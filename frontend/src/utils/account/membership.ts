/**
 * What the signed-in user is allowed to be, read from their own token.
 *
 * A mirror of `membershipOf` in backend/src/services/user-groups.ts, and a
 * deliberate one. The claim it reads — `cognito:groups` — is the same claim the
 * `admin` check has always used here, so it is known to arrive; and the panel
 * has to decide what to draw before any request is made, which a server answer
 * cannot do without a flash of the wrong UI.
 *
 * It decides what is DRAWN and nothing else. Every route applies the same rule
 * server-side, so a stale tab or a hand-made request is refused there — this is
 * the convenience, not the control. `backend/test/user-groups.test.mjs` reads
 * both files and checks they agree.
 */

export const GROUP_PREFIX = 'grp:';
export const GROUP_ADMIN_PREFIX = 'grpadm:';
export const SUPER_ADMIN_GROUP = 'admin';

export type Role = 'super-admin' | 'group-admin' | 'user';

export interface Membership {
  role: Role;
  group: string | null;
}

export function membershipOf(groups: readonly string[] = []): Membership {
  const adminOf = groups.find((g) => g.startsWith(GROUP_ADMIN_PREFIX))?.slice(GROUP_ADMIN_PREFIX.length);
  const memberOf = groups.find((g) => g.startsWith(GROUP_PREFIX))?.slice(GROUP_PREFIX.length);
  const group = adminOf || memberOf || null;
  if (groups.includes(SUPER_ADMIN_GROUP)) return { role: 'super-admin', group };
  if (adminOf) return { role: 'group-admin', group: adminOf };
  return { role: 'user', group };
}

/** Whether the Admin button and panel are drawn at all. */
export const canOpenAdminPanel = (m: Membership): boolean =>
  m.role === 'super-admin' || m.role === 'group-admin';

/**
 * Whether the account-wide controls are drawn: the token and request limits,
 * creating and deleting accounts, and the groups tab.
 *
 * A group administrator gets the panel without them — the limits are the
 * account's spending and the accounts are the account's people, and neither is
 * a tenant's to change.
 */
export const isSuperAdmin = (m: Membership): boolean => m.role === 'super-admin';
