import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { logger } from '../utils/logger.js';

/**
 * A project shared with named MakeUI users, or with a whole user group.
 *
 * ## Roles
 *
 *   full  the owner's equivalent: everything, including adding people.
 *   edit  everything except adding people — prompts, edits, renaming, history.
 *   view  opening and reading: the preview, the conversation, the history.
 *
 * `owner` is not stored; it is the account whose partition holds the project.
 *
 * ## Where things live
 *
 * The project itself does not move. It stays in its owner's partition
 * (`USER#<owner>` / `PROJECT#…`), its document stays under the owner's key, and
 * so do its conversation and its versions — one project, one set of records,
 * whoever is looking at it. What sharing adds is who else may:
 *
 *   SHARE#<projectId>  OWNER                    ownerId, and the project's createdAt
 *   SHARE#<projectId>  USER#<sub>               a grant to one account
 *   SHARE#<projectId>  GROUP#<name>             a grant to a user group
 *   USER#<sub>         SHARED#<projectId>        the grantee's index: "shared with me"
 *   GROUPSHARE#<name>  SHARED#<projectId>        the group's index
 *
 * The project side answers "who may open this"; the grantee side answers "what
 * may I open" without scanning. Both are written together and removed
 * together.
 */

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

export type ShareRole = 'full' | 'edit' | 'view';
export type ProjectRole = 'owner' | ShareRole;
export const SHARE_ROLES: readonly ShareRole[] = ['full', 'edit', 'view'];

export function isShareRole(value: unknown): value is ShareRole {
  return typeof value === 'string' && (SHARE_ROLES as readonly string[]).includes(value);
}

/** Highest first: when a person holds a grant directly and through their group, the higher one counts. */
const RANK: Record<ProjectRole, number> = { owner: 4, full: 3, edit: 2, view: 1 };
function strongerRole<R extends ProjectRole>(a: R | null, b: R | null): R | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/** What a role may do. One table, so a route cannot ask a question of its own. */
export const CAN = {
  /** Open the project: its preview, conversation, history and members. */
  read: (r: ProjectRole | null): boolean => r !== null,
  /** Prompts, edits, renaming, archiving, saving versions — changing the project. */
  write: (r: ProjectRole | null): boolean => r === 'owner' || r === 'full' || r === 'edit',
  /** Deleting the project, which the written rule — "every operation except adding people" — gives an editor too. */
  delete: (r: ProjectRole | null): boolean => r === 'owner' || r === 'full' || r === 'edit',
  /** Adding people, changing their roles, removing them. */
  manage: (r: ProjectRole | null): boolean => r === 'owner' || r === 'full',
};

interface ShareTarget {
  type: 'user' | 'group';
  /** A Cognito `sub` for a user, the group's name for a group. */
  id: string;
  /** What to show: a display name, or the group's name. */
  label: string;
  /** A user's email, so two people with one display name can be told apart. */
  email?: string;
}

export interface ShareGrant extends ShareTarget {
  role: ShareRole;
  grantedBy: string;
  grantedByName: string;
  grantedAt: string;
}

interface SharedProjectRef {
  projectId: string;
  ownerId: string;
  role: ShareRole;
  /** 'user' when granted to this person, 'group' when through their group. */
  via: 'user' | 'group';
  grantedAt: string;
}

const targetSk = (t: Pick<ShareTarget, 'type' | 'id'>): string => (t.type === 'user' ? `USER#${t.id}` : `GROUP#${t.id}`);
const indexPk = (t: Pick<ShareTarget, 'type' | 'id'>): string => (t.type === 'user' ? `USER#${t.id}` : `GROUPSHARE#${t.id}`);

/** Every grant on a project, and its owner, from one query. */
export async function readShares(projectId: string): Promise<{ ownerId: string | null; projectCreatedAt: string | null; grants: ShareGrant[] }> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: `SHARE#${projectId}` } },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  const owner = items.find((i) => i.sk?.S === 'OWNER');
  const grants = items
    .filter((i) => i.sk?.S !== 'OWNER' && isShareRole(i.role?.S))
    .map((i) => ({
      type: (i.targetType?.S === 'group' ? 'group' : 'user') as ShareTarget['type'],
      id: i.targetId?.S ?? '',
      label: i.targetLabel?.S ?? '',
      email: i.targetEmail?.S || undefined,
      role: i.role!.S as ShareRole,
      grantedBy: i.grantedBy?.S ?? '',
      grantedByName: i.grantedByName?.S ?? '',
      grantedAt: i.grantedAt?.S ?? '',
    }));
  return { ownerId: owner?.ownerId?.S ?? null, projectCreatedAt: owner?.projectCreatedAt?.S ?? null, grants };
}

/**
 * A person's role on a project they do not own, or null.
 *
 * Direct grants and the group's grant both count, and the higher wins: someone
 * given view access by name who is in a group with edit access can edit.
 */
export function roleFromGrants(grants: readonly ShareGrant[], userId: string, group: string | null): ShareRole | null {
  let role: ShareRole | null = null;
  for (const g of grants) {
    if ((g.type === 'user' && g.id === userId) || (g.type === 'group' && group && g.id === group)) {
      role = strongerRole(role, g.role);
    }
  }
  return role;
}

/**
 * Grants `target` the role on a project, or changes the role it has.
 *
 * The OWNER row is written with every grant, so the first grant creates it and
 * a project's owner is never unknown to its share rows.
 */
export async function grantShare(input: {
  projectId: string;
  ownerId: string;
  projectCreatedAt: string;
  target: ShareTarget;
  role: ShareRole;
  grantedBy: string;
  grantedByName: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { projectId, ownerId, target, role } = input;
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `SHARE#${projectId}` },
      sk: { S: 'OWNER' },
      ownerId: { S: ownerId },
      projectCreatedAt: { S: input.projectCreatedAt },
    },
  }));
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `SHARE#${projectId}` },
      sk: { S: targetSk(target) },
      projectId: { S: projectId },
      ownerId: { S: ownerId },
      targetType: { S: target.type },
      targetId: { S: target.id },
      targetLabel: { S: target.label || target.id },
      ...(target.email ? { targetEmail: { S: target.email } } : {}),
      role: { S: role },
      grantedBy: { S: input.grantedBy },
      grantedByName: { S: input.grantedByName },
      grantedAt: { S: now },
    },
  }));
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: indexPk(target) },
      sk: { S: `SHARED#${projectId}` },
      projectId: { S: projectId },
      ownerId: { S: ownerId },
      role: { S: role },
      grantedAt: { S: now },
    },
  }));
  await setOwnerRowShared(ownerId, input.projectCreatedAt, projectId, now);
  logger.info('Project shared', { projectId, ownerId, target: `${target.type}:${target.id}`, role, by: input.grantedBy });
}

/** Removes one grant. Clears the owner's shared mark when it was the last. */
export async function revokeShare(projectId: string, target: Pick<ShareTarget, 'type' | 'id'>): Promise<void> {
  await client.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `SHARE#${projectId}` }, sk: { S: targetSk(target) } },
  }));
  await client.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: indexPk(target) }, sk: { S: `SHARED#${projectId}` } },
  }));
  const after = await readShares(projectId);
  if (after.grants.length === 0 && after.ownerId && after.projectCreatedAt) {
    await setOwnerRowShared(after.ownerId, after.projectCreatedAt, projectId, null);
  }
  logger.info('Project share removed', { projectId, target: `${target.type}:${target.id}` });
}

/** Every share row of a project, for when the project itself is deleted. */
export async function deleteAllShares(projectId: string): Promise<void> {
  const { grants } = await readShares(projectId);
  const keys = [
    { pk: `SHARE#${projectId}`, sk: 'OWNER' },
    ...grants.flatMap((g) => [
      { pk: `SHARE#${projectId}`, sk: targetSk(g) },
      { pk: indexPk(g), sk: `SHARED#${projectId}` },
    ]),
  ];
  for (let i = 0; i < keys.length; i += 25) {
    await client.send(new BatchWriteItemCommand({
      RequestItems: {
        [TABLE_NAME]: keys.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { pk: { S: k.pk }, sk: { S: k.sk } } } })),
      },
    }));
  }
}

/**
 * The owner's row carries `sharedAt` while the project has any grant, so the
 * owner's own list can put it on the 共有 tab without reading the share rows.
 */
async function setOwnerRowShared(ownerId: string, projectCreatedAt: string, projectId: string, at: string | null): Promise<void> {
  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `USER#${ownerId}` }, sk: { S: `PROJECT#${projectCreatedAt}#${projectId}` } },
    ...(at
      ? { UpdateExpression: 'SET sharedAt = if_not_exists(sharedAt, :at)', ExpressionAttributeValues: { ':at': { S: at } } }
      : { UpdateExpression: 'REMOVE sharedAt' }),
    // Only an existing project: a revoke racing a delete must not resurrect the row.
    ConditionExpression: 'attribute_exists(pk)',
  })).catch((e) => {
    if (String(e).includes('ConditionalCheckFailed')) return;
    throw e;
  });
}

/** The projects shared with a person, directly and through their group. */
export async function sharedWith(userId: string, group: string | null): Promise<SharedProjectRef[]> {
  const read = async (pk: string, via: 'user' | 'group'): Promise<SharedProjectRef[]> => {
    const out: SharedProjectRef[] = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const res = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': { S: pk }, ':p': { S: 'SHARED#' } },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const i of res.Items ?? []) {
        if (!isShareRole(i.role?.S)) continue;
        out.push({ projectId: i.projectId?.S ?? '', ownerId: i.ownerId?.S ?? '', role: i.role!.S as ShareRole, via, grantedAt: i.grantedAt?.S ?? '' });
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return out;
  };
  const refs = [...(await read(`USER#${userId}`, 'user')), ...(group ? await read(`GROUPSHARE#${group}`, 'group') : [])];
  // One entry per project, at the higher role; and never a project the person owns.
  const byProject = new Map<string, SharedProjectRef>();
  for (const r of refs) {
    if (!r.projectId || r.ownerId === userId) continue;
    const had = byProject.get(r.projectId);
    if (!had || strongerRole(had.role, r.role) !== had.role) byProject.set(r.projectId, r);
  }
  return [...byProject.values()];
}
