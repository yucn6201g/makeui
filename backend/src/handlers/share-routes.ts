import { listProjects, getProject, type ProjectRecord } from '../services/project-service.js';
import {
  CAN,
  grantShare,
  isShareRole,
  readShares,
  revokeShare,
  sharedWith,
  type ProjectRole,
  type ShareRole,
} from '../services/project-shares.js';
import { projectAccess } from '../services/project-access.js';
import { listUserGroups, groupOfSub } from '../services/user-groups.js';
import { searchUsers, userBySub, SEARCH_MIN_CHARS } from '../services/user-directory.js';
import { displayNameFor } from '../services/display-name.js';

/**
 * The sharing routes, and the project list that sharing changes.
 *
 *   GET    /projects                           owned and shared-with-me, each with `access`
 *   GET    /users/search?q=                    accounts to share with, by name or email
 *   GET    /share-groups                       user groups to share with
 *   GET    /projects/:id/shares                owner, grants, and the caller's role
 *   PUT    /projects/:id/shares                grant or change a role     (owner, full)
 *   DELETE /projects/:id/shares/:type/:id      remove a grant             (owner, full; or yourself)
 *
 * Returns null for any other path, so the main handler carries on.
 */

export interface Caller {
  userId: string;
  email: string;
  name: string;
  group: string | null;
  /** The account-wide administrator, who may share across groups. */
  superAdmin?: boolean;
}

/*
 * Who may be found and shared with.
 *
 * A user group here is a customer — a group-admin sees their own group and
 * nothing else (services/user-groups.ts) — so the directory is scoped the same
 * way: someone in a group finds the people in it and the group itself; someone
 * in none finds the others in none; the account-wide administrator finds
 * everyone. Without it any signed-in person could list another customer's
 * addresses two letters at a time.
 */
async function inScope(caller: Caller, userId: string): Promise<boolean> {
  if (caller.superAdmin) return true;
  return (await groupOfSub(userId)) === caller.group;
}
const groupInScope = (caller: Caller, name: string): boolean => Boolean(caller.superAdmin) || name === caller.group;

type Respond = (status: number, body: unknown) => unknown;

interface ProjectListItem extends ProjectRecord {
  /** The caller's relation to the project. */
  access: { role: ProjectRole; ownerId: string; ownerName: string; via?: 'user' | 'group' };
}

const nameOf = async (sub: string): Promise<string> => (await userBySub(sub))?.name ?? '（削除されたユーザー）';

export async function listProjectsFor(caller: Caller): Promise<ProjectListItem[]> {
  const ownName = displayNameFor(caller.email, caller.name);
  const own: ProjectListItem[] = (await listProjects(caller.userId)).map((p) => ({
    ...p,
    access: { role: 'owner', ownerId: caller.userId, ownerName: ownName },
  }));
  const refs = await sharedWith(caller.userId, caller.group);
  const shared = await Promise.all(refs.map(async (r): Promise<ProjectListItem | null> => {
    const p = await getProject(r.ownerId, r.projectId, { document: false }).catch(() => null);
    if (!p) return null;
    const { lastHtml: _doc, ...row } = p;
    return {
      ...row,
      userId: r.ownerId,
      hasDocument: Boolean(p.hasDocument),
      sharedAt: p.sharedAt ?? r.grantedAt,
      access: { role: r.role, ownerId: r.ownerId, ownerName: await nameOf(r.ownerId), via: r.via },
    };
  }));
  return [...own, ...shared.filter((p): p is ProjectListItem => p !== null)];
}

export async function handleShareRoutes(
  method: string,
  path: string,
  query: Record<string, string | undefined>,
  body: string,
  caller: Caller,
  respond: Respond
): Promise<unknown | null> {
  if (method === 'GET' && path === '/users/search') {
    const q = (query.q ?? '').trim();
    if (q.length < SEARCH_MIN_CHARS) return respond(200, { users: [] });
    const found = await searchUsers(q, caller.userId);
    const users = (await Promise.all(found.map(async (u) => ((await inScope(caller, u.userId)) ? u : null))))
      .filter((u) => u !== null);
    return respond(200, { users });
  }

  if (method === 'GET' && path === '/share-groups') {
    const groups = (await listUserGroups()).filter((g) => groupInScope(caller, g.name));
    return respond(200, { groups: groups.map((g) => ({ name: g.name, memberCount: g.memberCount })) });
  }

  const sharesMatch = path.match(/^\/projects\/([^/]+)\/shares$/);
  const revokeMatch = path.match(/^\/projects\/([^/]+)\/shares\/(user|group)\/([^/]+)$/);
  if (!sharesMatch && !revokeMatch) return null;

  const projectId = decodeURIComponent((sharesMatch ?? revokeMatch)![1]);
  const access = await projectAccess({ userId: caller.userId, group: caller.group }, projectId);
  if (!access) return respond(404, { error: 'Project not found' });

  if (sharesMatch && method === 'GET') {
    const { grants } = await readShares(projectId);
    return respond(200, {
      role: access.role,
      // The caller, so a member can find their own row to leave by.
      self: caller.userId,
      owner: { userId: access.ownerId, name: await nameOf(access.ownerId) },
      shares: grants,
    });
  }

  if (sharesMatch && method === 'PUT') {
    if (!CAN.manage(access.role)) return respond(403, { error: '共有ユーザーを追加できるのは所有者と全権限のユーザーだけです' });
    let input: { type?: unknown; id?: unknown; role?: unknown };
    try { input = JSON.parse(body); } catch { return respond(400, { error: 'Invalid JSON body' }); }
    if (input.type !== 'user' && input.type !== 'group') return respond(400, { error: 'type must be "user" or "group"' });
    if (typeof input.id !== 'string' || !input.id) return respond(400, { error: 'id is required' });
    if (!isShareRole(input.role)) return respond(400, { error: 'role must be "full", "edit" or "view"' });

    let label: string;
    let email: string | undefined;
    if (input.type === 'user') {
      if (input.id === access.ownerId) return respond(400, { error: '所有者とは共有できません' });
      const user = await userBySub(input.id);
      // Out of scope reads as absent, as it does in the search.
      if (!user || !(await inScope(caller, input.id))) return respond(404, { error: 'ユーザーが見つかりません' });
      label = user.name;
      email = user.email;
    } else {
      const group = (await listUserGroups()).find((g) => g.name === input.id);
      if (!group || !groupInScope(caller, group.name)) return respond(404, { error: 'グループが見つかりません' });
      label = group.name;
    }
    await grantShare({
      projectId,
      ownerId: access.ownerId,
      projectCreatedAt: access.project.createdAt,
      target: { type: input.type, id: input.id, label, email },
      role: input.role as ShareRole,
      grantedBy: caller.userId,
      grantedByName: displayNameFor(caller.email, caller.name),
    });
    const { grants } = await readShares(projectId);
    return respond(200, { shares: grants });
  }

  if (revokeMatch && method === 'DELETE') {
    const type = revokeMatch[2] as 'user' | 'group';
    const id = decodeURIComponent(revokeMatch[3]);
    const leaving = type === 'user' && id === caller.userId;
    if (!leaving && !CAN.manage(access.role)) return respond(403, { error: '共有を解除できるのは所有者と全権限のユーザーだけです' });
    await revokeShare(projectId, { type, id });
    const { grants } = await readShares(projectId);
    return respond(200, { shares: grants });
  }

  return respond(405, { error: 'Method not allowed' });
}
