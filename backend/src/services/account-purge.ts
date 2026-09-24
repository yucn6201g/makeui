/**
 * What is left behind when an account or a group is deleted, and removing it.
 *
 * Deleting either used to be a single Cognito call. The account or the group
 * went; every row written under it stayed — a whole `USER#<sub>` partition of
 * projects, versions, chats, events, the month aggregates and the configured
 * budget, plus every document those rows point at in S3. The rule this project
 * works to is that anything a user deleted, and anything no longer reachable,
 * goes with it.
 *
 * For a group the leftovers are worse than untidy. `GROUP#<name>` holds the
 * budget and the month's spend, and both are keyed by the NAME. Delete a group
 * and make another with the same name — which is the obvious thing to do after
 * a typo — and the new one opens with its predecessor's budget already set and
 * its predecessor's spending already counted against it.
 *
 * Everything here is best-effort and counted rather than thrown. The account is
 * already gone by the time any of it runs, so a route that reported failure
 * would be reporting it for a deletion that did happen; what the caller needs
 * is the count, in the log, to tell a clean purge from a partial one.
 */
import {
  DynamoDBClient,
  QueryCommand,
  BatchWriteItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { deletePrefix, ownersUnder } from './output-storage.js';
import { publishedSitesOf } from './published-sites.js';
import { deleteAllShares, revokeShare, sharedWith } from './project-shares.js';
import { listProjects } from './project-service.js';
import { logger } from '../utils/logger.js';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';

/** `BatchWriteItem` takes twenty-five requests per call, and refuses twenty-six. */
const BATCH_SIZE = 25;

export interface PurgeResult {
  rows: number;
  objects: number;
}

/**
 * Every row in one partition, deleted.
 *
 * Queried rather than scanned — the partition key is exactly what is being
 * removed — and projected down to the two key attributes, because `RCU` is
 * billed on the item as stored and a version row carries the metadata of a
 * document. Reading three hundred full rows to learn their keys would cost more
 * than deleting them.
 *
 * Unprocessed items are retried once. `BatchWriteItem` returns them instead of
 * failing when a partition throttles, and dropping them silently is how a purge
 * reports success while leaving rows behind.
 */
async function purgePartition(pk: string): Promise<number> {
  let deleted = 0;
  let lastKey: Record<string, any> | undefined;

  do {
    const page = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: pk } },
      ProjectionExpression: 'pk, sk',
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));

    const items = page.Items ?? [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);
      let requests = chunk.map((item) => ({
        DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
      }));
      for (let attempt = 0; attempt < 2 && requests.length > 0; attempt++) {
        const res = await client.send(new BatchWriteItemCommand({
          RequestItems: { [TABLE_NAME]: requests },
        }));
        deleted += requests.length;
        const left = (res.UnprocessedItems?.[TABLE_NAME] ?? []) as typeof requests;
        deleted -= left.length;
        requests = left;
      }
      if (requests.length > 0) {
        logger.warn('Rows survived a purge', { pk, left: requests.length });
      }
    }

    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return deleted;
}

/**
 * Everything stored under one account.
 *
 * `USER#<sub>` is the partition every one of this user's rows is written to —
 * `CONFIG`, `MONTH#…`, `PROJECT#…`, `VERSION#…`, `CHAT#…` and `EVENT#…` — so
 * one query removes all six kinds without this having to know the list, which
 * matters because a seventh would otherwise be missed silently.
 *
 * `RATE#<sub>` is the rate limiter's own partition. Its rows expire after two
 * days on their own; they are taken here anyway so that "the account is gone"
 * is true immediately rather than on Tuesday.
 *
 * The S3 prefixes are the ones documents live under. `outputs/` is included
 * because the measurement corpus keeps a copy of every generation there, and a
 * deleted account's share of it is data the rule says should not exist.
 */
export async function purgeAccount(userId: string): Promise<PurgeResult> {
  let rows = 0;
  let objects = 0;

  /*
   * The published pages FIRST, while the rows that name them still exist.
   *
   * `published/<siteId>/` is keyed by a random id and by nothing else, so the
   * `PUBLISH#` rows are the only link between a live public page and its owner.
   * Purge the partition before reading them and the pages become unreachable
   * from here and stay up — publicly — for the thirty days the bucket's
   * lifecycle rule gives them. This is the one prefix whose keys are not
   * derivable from the user id, and therefore the one that has to be read
   * before anything is deleted.
   */
  for (const siteId of await publishedSitesOf(userId)) {
    objects += await deletePrefix(`published/${siteId}/`);
  }

  /*
   * Sharing, before the partition goes. The account's own projects are shared
   * from rows outside its partition (`SHARE#<projectId>`, and each grantee's
   * index), and its grants on other people's projects sit in those projects'
   * rows — none of which the partition purge below would reach.
   */
  try {
    for (const p of await listProjects(userId)) {
      if (p.sharedAt) await deleteAllShares(p.projectId);
    }
    for (const ref of await sharedWith(userId, null)) {
      if (ref.via === 'user') await revokeShare(ref.projectId, { type: 'user', id: userId });
    }
  } catch (error) {
    logger.error("Failed to remove an account's shares", { userId, error: String(error) });
  }

  for (const pk of [`USER#${userId}`, `RATE#${userId}`]) {
    try {
      rows += await purgePartition(pk);
    } catch (error) {
      logger.error('Failed to purge a partition', { pk, error: String(error) });
    }
  }

  for (const prefix of [`projects/${userId}/`, `versions/${userId}/`, `outputs/${userId}/`]) {
    objects += await deletePrefix(prefix);
  }

  logger.info('Account storage purged', { userId, rows, objects });
  return { rows, objects };
}

/**
 * A group's budget and its month, which are keyed by its name.
 *
 * No S3: a group owns no documents. Its members' documents belong to the
 * members, who survive the group — deleting one is an administrative regrouping
 * and must never be a way to delete people or their work.
 */
export async function purgeGroup(group: string): Promise<number> {
  // The group's grants on projects, which live in the projects' rows and its own index.
  try {
    const { QueryCommand } = await import('@aws-sdk/client-dynamodb');
    const res = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': { S: `GROUPSHARE#${group}` } },
    }));
    for (const item of res.Items ?? []) {
      const projectId = item.projectId?.S;
      if (projectId) await revokeShare(projectId, { type: 'group', id: group });
    }
  } catch (error) {
    logger.error("Failed to remove a group's shares", { group, error: String(error) });
  }
  try {
    const rows = await purgePartition(`GROUP#${group}`);
    logger.info('Group storage purged', { group, rows });
    return rows;
  } catch (error) {
    logger.error('Failed to purge group storage', { group, error: String(error) });
    return 0;
  }
}

/**
 * Every account the directory currently knows, or null if it could not be asked.
 *
 * Null and empty are the whole safety of the sweep below and must never
 * collapse into each other. An empty pool is "nobody has an account, delete
 * everything"; a failed listing is "I don't know", and the two arrive through
 * the same call. This project has shipped that confusion once already — a
 * rejected `AttributesToGet` returned an empty map from a catch, the filter that
 * hides ownerless rows read it as "no accounts exist" and switched itself off,
 * and the whole failure looked like success.
 */
async function liveSubs(): Promise<Set<string> | null> {
  if (!USER_POOL_ID) return null;
  const out = new Set<string>();
  try {
    let token: string | undefined;
    do {
      const res = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        ...(token ? { PaginationToken: token } : {}),
      }));
      for (const u of res.Users ?? []) {
        const sub = u.Attributes?.find((a) => a.Name === 'sub')?.Value;
        if (sub) out.add(sub);
      }
      token = res.PaginationToken;
    } while (token);
  } catch (error) {
    logger.error('Could not list accounts; refusing to sweep', { error: String(error) });
    return null;
  }
  return out;
}

/**
 * Every owner id that appears in the table, from the partition keys alone.
 *
 * A Scan, and the one place in this codebase where that is the right call: the
 * question is "which partitions exist", which no key condition can answer and no
 * index would answer more cheaply than reading the keys. It runs on a schedule
 * rather than on a request, over 369 items today.
 */
async function storedOwners(): Promise<Set<string> | null> {
  const out = new Set<string>();
  try {
    let lastKey: Record<string, any> | undefined;
    do {
      const res = await client.send(new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: 'pk',
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of res.Items ?? []) {
        const pk = item.pk?.S ?? '';
        if (pk.startsWith('USER#')) out.add(pk.slice(5));
        else if (pk.startsWith('RATE#')) out.add(pk.slice(5));
      }
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  } catch (error) {
    logger.error('Could not list stored owners; refusing to sweep', { error: String(error) });
    return null;
  }
  return out;
}

/**
 * The most owners one sweep will remove before deciding it has misunderstood.
 *
 * Three accounts exist. A run that believes eleven of them are orphaned has not
 * found eleven orphans, it has misread the directory — and the difference
 * between those two readings is every project in the account. So the sweep stops
 * and says so, and a person decides.
 *
 * Raise it deliberately after a bulk deletion, not to make a red log go away.
 */
const MAX_ORPHANS_PER_SWEEP = 10;

export interface SweepResult {
  swept: string[];
  rows: number;
  objects: number;
  /** True when nothing was done because something could not be established. */
  refused: boolean;
}

/**
 * Storage under an id no account answers to, removed.
 *
 * The routes that create orphans were closed — deleting an account now takes its
 * partition and its documents — so this is the net under them, not the mechanism.
 * It finds what predates that fix, what a half-finished purge left when DynamoDB
 * threw partway, and anything a future path forgets.
 *
 * `outputs/` is deliberately not enumerated. That prefix holds the measurement
 * corpus and its owners are mostly not accounts at all — `fw-bench`,
 * `verify-svelte`, `probe-react` — so listing it would present the corpus itself
 * as forty orphaned users. It is still swept for an owner found by the other
 * two, because those objects do belong to a real deleted account.
 */
export async function sweepOrphans(dryRun = false): Promise<SweepResult> {
  const empty: SweepResult = { swept: [], rows: 0, objects: 0, refused: true };

  const [live, stored, projectOwners, versionOwners] = await Promise.all([
    liveSubs(),
    storedOwners(),
    ownersUnder('projects/'),
    ownersUnder('versions/'),
  ]);
  // Any one of the four being unknown makes the difference between them
  // meaningless, and the difference is what gets deleted.
  if (!live || !stored || !projectOwners || !versionOwners) return empty;
  if (live.size === 0) {
    logger.error('The directory reports no accounts at all; refusing to sweep');
    return empty;
  }

  const owners = new Set([...stored, ...projectOwners, ...versionOwners]);
  const orphans = [...owners].filter((id) => id && !live.has(id));

  if (orphans.length === 0) {
    logger.info('Orphan sweep found nothing', { accounts: live.size, owners: owners.size });
    return { swept: [], rows: 0, objects: 0, refused: false };
  }
  if (orphans.length > MAX_ORPHANS_PER_SWEEP) {
    logger.error('Too many owners look orphaned; refusing to sweep', {
      orphans: orphans.length, accounts: live.size, limit: MAX_ORPHANS_PER_SWEEP,
    });
    return empty;
  }

  logger.info('Orphan sweep starting', { orphans, dryRun, accounts: live.size });
  if (dryRun) return { swept: orphans, rows: 0, objects: 0, refused: false };

  let rows = 0, objects = 0;
  for (const id of orphans) {
    const r = await purgeAccount(id);
    rows += r.rows;
    objects += r.objects;
  }
  logger.info('Orphan sweep finished', { swept: orphans.length, rows, objects });
  return { swept: orphans, rows, objects, refused: false };
}
