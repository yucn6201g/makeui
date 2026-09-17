import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListGroupsCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  ListUsersInGroupCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { logger } from '../utils/logger.js';

/**
 * Who a signed-in person is allowed to be, and to whom.
 *
 * There were two roles: an administrator and everyone else, decided by
 * membership of the Cognito group `admin`. There are three now, because a
 * customer's own administrator needs the panel without needing the account's
 * spending controls.
 *
 *   super-admin  the existing `admin`. Unchanged, plus group management.
 *   group-admin  one per group. The panel, over their own group only.
 *   user         everyone else.
 *
 * ## Held in Cognito groups
 *
 * The claim is already in every token — `cognito:groups` is what the `admin`
 * check has always read — so a role costs no lookup and cannot go stale against
 * a directory that has moved on. The alternative was a custom attribute plus a
 * table, which is two sources for one fact and a migration to add the attribute.
 *
 * A group named `acme` is two Cognito groups:
 *
 *   grp:acme     everyone in it
 *   grpadm:acme  its administrator, who is also in grp:acme
 *
 * Two rather than one because "is an admin of" and "is a member of" are
 * different questions and both get asked. Counting the members of `grpadm:acme`
 * is also how "one admin per group" is enforced, which a flag on a user cannot
 * do without reading every user.
 *
 * ## Scoped, deliberately
 *
 * A group-admin sees their own group and nothing else — its usage rows, its
 * accounts, its projects and the prompts inside them. Anything wider would hand
 * one customer's administrator another customer's briefs and generated UI, which
 * is not a thing to arrive at by leaving a filter out.
 */

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const cognito = new CognitoIdentityProviderClient({});

/** Membership of a user group. */
export const GROUP_PREFIX = 'grp:';
/** Administration of one. A holder is always in `GROUP_PREFIX` too. */
export const GROUP_ADMIN_PREFIX = 'grpadm:';
/** The account-wide administrator. Predates all of this and is unchanged. */
export const SUPER_ADMIN_GROUP = 'admin';

export type Role = 'super-admin' | 'group-admin' | 'user';

export interface Membership {
  role: Role;
  /** The group this person belongs to, or null. A super-admin may have none. */
  group: string | null;
}

/**
 * Names a person types, so they are constrained here rather than at the Cognito
 * error. `:` is the delimiter and cannot appear in a name — otherwise `grp:a:b`
 * is ambiguous between a group called `a:b` and something with a prefix of its
 * own. Cognito's own group names allow far more than this; the narrower rule is
 * the one that keeps the encoding readable.
 */
export function isValidGroupName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/.test(value.trim());
}

/**
 * The role and group a token's claims describe.
 *
 * `admin` wins over everything. A super-admin who is also in a group is still a
 * super-admin — the account-wide role is not narrowed by a membership, and
 * reading it the other way would let anyone lock the last administrator out of
 * everything by putting them in a group.
 */
export function membershipOf(groups: readonly string[] = []): Membership {
  const adminOf = groups.find((g) => g.startsWith(GROUP_ADMIN_PREFIX))?.slice(GROUP_ADMIN_PREFIX.length);
  const memberOf = groups.find((g) => g.startsWith(GROUP_PREFIX))?.slice(GROUP_PREFIX.length);
  const group = adminOf || memberOf || null;
  if (groups.includes(SUPER_ADMIN_GROUP)) return { role: 'super-admin', group };
  if (adminOf) return { role: 'group-admin', group: adminOf };
  return { role: 'user', group };
}

/** Whether this membership may open the admin panel at all. */
export const canOpenAdminPanel = (m: Membership): boolean =>
  m.role === 'super-admin' || m.role === 'group-admin';

/**
 * Whether a super-admin-only action is permitted.
 *
 * The three the operator named — token limit, request limit, creating and
 * deleting accounts — plus group management itself. Everything else in the panel
 * is open to a group-admin within their own group, which is the literal reading
 * of "the panel works, except these".
 */
export const isSuperAdmin = (m: Membership): boolean => m.role === 'super-admin';

/**
 * Whether `m` may act on data belonging to `group`.
 *
 * A super-admin may act on anything, including rows whose owner has no group at
 * all. A group-admin may act only within their own, and never on an ungrouped
 * account: "not in a group" is not "in mine".
 */
export function mayActOn(m: Membership, group: string | null | undefined): boolean {
  if (m.role === 'super-admin') return true;
  if (m.role !== 'group-admin' || !m.group) return false;
  return group === m.group;
}

// --- the directory ------------------------------------------------------------

export interface UserGroup {
  name: string;
  description?: string;
  /** The single administrator's username, or null while the group has none. */
  admin: string | null;
  memberCount: number;
}

/** Every user group, with its administrator and size. */
export async function listUserGroups(): Promise<UserGroup[]> {
  if (!USER_POOL_ID) return [];
  const names: string[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListGroupsCommand({
      UserPoolId: USER_POOL_ID,
      ...(token ? { NextToken: token } : {}),
    }));
    for (const g of res.Groups ?? []) if (g.GroupName) names.push(g.GroupName);
    token = res.NextToken;
  } while (token);

  const groups = names.filter((n) => n.startsWith(GROUP_PREFIX)).map((n) => n.slice(GROUP_PREFIX.length));
  return Promise.all(groups.map(async (name) => {
    const [members, admins] = await Promise.all([
      usernamesIn(`${GROUP_PREFIX}${name}`),
      usernamesIn(`${GROUP_ADMIN_PREFIX}${name}`),
    ]);
    if (admins.length > 1) {
      // Not repaired here — a read should not quietly change the directory. The
      // write paths are what keep this at one, and this is where a break shows.
      logger.warn('A user group has more than one administrator', { group: name, admins });
    }
    return { name, admin: admins[0] ?? null, memberCount: members.length };
  }));
}

async function usernamesIn(groupName: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await cognito.send(new ListUsersInGroupCommand({
      UserPoolId: USER_POOL_ID,
      GroupName: groupName,
      ...(token ? { NextToken: token } : {}),
    }));
    for (const u of res.Users ?? []) if (u.Username) out.push(u.Username);
    token = res.NextToken;
  } while (token);
  return out;
}

/** The usernames in a group. Used to scope what a group-admin can see. */
export const membersOf = (name: string): Promise<string[]> => usernamesIn(`${GROUP_PREFIX}${name}`);

/** The role and group of a single account, read from the directory. */
async function membershipOfUser(username: string): Promise<Membership | null> {
  if (!USER_POOL_ID) return null;
  const res = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  const names = (res.Groups ?? []).map((g) => g.GroupName ?? '');
  return membershipOf(names);
}

export async function createUserGroup(name: string, description?: string): Promise<void> {
  await cognito.send(new CreateGroupCommand({
    UserPoolId: USER_POOL_ID,
    GroupName: `${GROUP_PREFIX}${name}`,
    ...(description ? { Description: description } : {}),
  }));
  /*
   * The admin group is created with it, empty. Creating it lazily on the first
   * appointment means the "one admin" count has no group to read until then, and
   * `ListUsersInGroup` on a group that does not exist is an error rather than an
   * empty list — a difference every caller would have to know about.
   */
  await cognito.send(new CreateGroupCommand({
    UserPoolId: USER_POOL_ID,
    GroupName: `${GROUP_ADMIN_PREFIX}${name}`,
    Description: `Administrator of ${name}`,
  }));
  logger.info('User group created', { group: name });
}

/**
 * Removes a group, and everyone's membership of it with it.
 *
 * Deleting a Cognito group removes the membership rows, so the accounts survive
 * and simply belong to nothing. That is the intended outcome: a group is an
 * administrative grouping, not an owner, and deleting one must not be a way to
 * delete people.
 */
export async function deleteUserGroup(name: string): Promise<void> {
  for (const g of [`${GROUP_ADMIN_PREFIX}${name}`, `${GROUP_PREFIX}${name}`]) {
    try {
      await cognito.send(new DeleteGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: g }));
    } catch (e) {
      // The admin half may not exist on a group made before it was paired.
      logger.warn('Could not delete a group half', { group: g, error: String(e) });
    }
  }
  logger.info('User group deleted', { group: name });
}

/**
 * Refused because it would leave a group nobody administers.
 *
 * Its own class so the route can answer 409 rather than 500: the request was
 * understood and is refusable, and the caller is told what to do instead.
 */
export class GroupWouldLoseAdminError extends Error {
  constructor(public readonly group: string, public readonly remaining: number) {
    super(
      `「${group}」の管理者は、グループから外せません。`
      + `ほかの${remaining}人が所属したままになり、管理者のいないグループになります。`
      + '先に別のメンバーを管理者にしてください。'
    );
    this.name = 'GroupWouldLoseAdminError';
  }
}

/**
 * Puts an account in a group, or in none.
 *
 * Membership is exclusive: one group at a time. Every prior membership is
 * removed first, including the administration of a group being left — an
 * administrator who is moved elsewhere must not keep the old group's panel.
 *
 * Except when that would strand the group. Removing the administrator of a group
 * that still has other members produced exactly what it says: a group with
 * people in it and nobody able to open the panel for them, from a button
 * labelled 「外す」 that said nothing about the second effect. The group has to
 * be handed over first — 「管理者にする」 on another member does that in one call,
 * and it leaves the outgoing administrator a plain member who can then be
 * removed.
 *
 * The last member is allowed to leave: the group becomes empty, and an empty
 * group has nothing to administer. That is the case where refusing would be a
 * dead end rather than a safeguard.
 */
export async function setUserGroup(username: string, name: string | null): Promise<void> {
  const res = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  const adminOf = (res.Groups ?? [])
    .map((g) => g.GroupName ?? '')
    .find((n) => n.startsWith(GROUP_ADMIN_PREFIX))
    ?.slice(GROUP_ADMIN_PREFIX.length);
  if (adminOf && adminOf !== name) {
    const others = (await membersOf(adminOf)).filter((u) => u !== username);
    if (others.length > 0) throw new GroupWouldLoseAdminError(adminOf, others.length);
  }
  for (const g of res.Groups ?? []) {
    const n = g.GroupName ?? '';
    if (!n.startsWith(GROUP_PREFIX) && !n.startsWith(GROUP_ADMIN_PREFIX)) continue;
    await cognito.send(new AdminRemoveUserFromGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: n,
    }));
  }
  if (name) {
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: `${GROUP_PREFIX}${name}`,
    }));
  }
  logger.info('User group membership set', { username, group: name });
}

/**
 * Appoints the group's administrator, replacing whoever held it.
 *
 * The replacement is the reason this is one operation rather than an add and a
 * remove the caller sequences: "one admin per group" is a property of the group,
 * and a caller that forgets the removal leaves two. Passing null clears it.
 */
export async function setGroupAdmin(name: string, username: string | null): Promise<void> {
  const groupName = `${GROUP_ADMIN_PREFIX}${name}`;
  for (const existing of await usernamesIn(groupName)) {
    if (existing === username) continue;
    await cognito.send(new AdminRemoveUserFromGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: existing,
      GroupName: groupName,
    }));
  }
  if (username) {
    /*
     * A group's administrator is a member of it. Added rather than required of
     * the caller, because the alternative is an administrator of a group they
     * are not in — which reads as a bug wherever it surfaces.
     */
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: `${GROUP_PREFIX}${name}`,
    }));
    await cognito.send(new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: groupName,
    }));
  }
  logger.info('Group administrator set', { group: name, username });
}

/**
 * The group an account belongs to, found by its `sub`.
 *
 * Every admin route addresses a user by `sub` — that is what a usage row and a
 * project are keyed by — while group membership is recorded against the Cognito
 * username, which for this pool is the email address. One of those has to be
 * translated, and `ListUsers` with a filter is the precise way: a `sub` is
 * unique, so the answer is one user or none.
 *
 * Cached briefly. Every project drill-down asks this twice — once for the list,
 * once for the version — and the answer cannot change between them.
 */
const subCache = new Map<string, { membership: Membership | null; at: number }>();
const SUB_CACHE_MS = 60_000;

/**
 * The whole membership behind a `sub`, not only its group.
 *
 * The role matters as well as the group wherever a group-admin acts on somebody
 * else: a super-admin who happens to be in a group is still a super-admin, and
 * the routes a group-admin may reach within their own group must not become a
 * way to configure the person who administers the account.
 */
export async function membershipOfSub(sub: string): Promise<Membership | null> {
  const hit = subCache.get(sub);
  if (hit && Date.now() - hit.at < SUB_CACHE_MS) return hit.membership;
  if (!USER_POOL_ID || !sub) return null;
  try {
    const res = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${sub.replace(/"/g, '')}"`,
      Limit: 1,
    }));
    const username = res.Users?.[0]?.Username;
    /*
     * No such account is `null`, which `mayActOn` refuses for a group-admin.
     * A usage row can outlive the account it was written for, and a deleted
     * user's rows must not become everybody's.
     */
    const membership = username ? await membershipOfUser(username) : null;
    subCache.set(sub, { membership, at: Date.now() });
    return membership;
  } catch (e) {
    logger.warn('Could not resolve a user group by sub', { error: String(e) });
    return null;
  }
}

export async function groupOfSub(sub: string): Promise<string | null> {
  return (await membershipOfSub(sub))?.group ?? null;
}

/**
 * Every account's group, from one listing rather than a lookup per account.
 *
 * `AdminListGroupsForUser` over forty accounts is forty calls to answer what
 * three already contain. Keyed by Cognito's username — which for this pool is
 * the email address — because that is what membership is recorded against,
 * while a usage row is keyed by `sub`.
 */
export async function groupByUsername(): Promise<Map<string, { group: string; isAdmin: boolean }>> {
  const out = new Map<string, { group: string; isAdmin: boolean }>();
  for (const g of await listUserGroups()) {
    for (const member of await membersOf(g.name)) {
      out.set(member, { group: g.name, isAdmin: member === g.admin });
    }
  }
  return out;
}
