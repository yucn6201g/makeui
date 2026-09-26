import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  GetItemCommand,
  BatchGetItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { logger } from '../utils/logger.js';
import { displayNameFor } from './display-name.js';

import { weighTokens, costOf, pricingTable, pricingEnforced } from '../config/pricing.js';

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';
/**
 * The month a new account gets before anybody sets one.
 *
 * It was 1,000,000, which is one and a half generations: a run measures 237,529
 * tokens and weighs 673,369 against the price table, so the first user to sign
 * up would have been refused partway through their second. Every existing
 * account is set to -1, which is what that default produced in practice — it was
 * never survivable, so it was never used.
 *
 * 10,000,000 is ten dollars a month, and a weighted token is a millionth of one:
 * about fifteen generations on Haiku, five on Sonnet, three on Opus.
 */
const DEFAULT_MONTHLY_TOKEN_LIMIT = parseInt(process.env.MONTHLY_TOKEN_LIMIT || '10000000', 10);

/**
 * A model name as a DynamoDB attribute name.
 *
 * The tiers are words — `haiku`, `sonnet`, `direct-edit` — and an attribute name
 * may not carry a hyphen without an expression alias. Rather than alias five
 * names per write, anything outside a word character becomes an underscore, and
 * an empty result becomes `unknown` so a missing model still lands somewhere
 * countable instead of producing `tok__in`.
 */
function safeModelKey(model: string): string {
  const key = (model || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return key || 'unknown';
}

/** How long a per-request usage event is kept. 13 months — see `recordUsage`. */
const EVENT_RETENTION_DAYS = 400;

interface UsageLimitResult {
  allowed: boolean;
  /**
   * Whether `currentUsage` is weighted by price rather than a plain token count.
   *
   * False when no `MODEL_PRICING` table is configured, and false for a month
   * recorded before the weighted column existed — those two look the same from
   * here and mean the same thing to the reader: this is the old number.
   */
  weighted?: boolean;
  /**
   * Whether the figures below were read, or stood in for figures that could not
   * be.
   *
   * This existed implicitly and answered wrong. A failed read returned
   * `allowed: true` with a zeroed ledger, so every caller spent on a limit it
   * had not checked — and the failure that produces it is a DynamoDB throttle,
   * which happens under load, which is when the limit is doing the most work. A
   * guard whose failure mode correlates with the thing it guards against is not
   * a guard.
   *
   * `false` means: refuse, and do not tell the user their limit was exceeded.
   * That is a different answer from "exceeded" and needs a different status.
   */
  known: boolean;
  currentUsage: number;
  limit: number;
  /**
   * How many requests this month. Reported, not capped.
   *
   * There was a `requestLimit` beside it, defaulting to unlimited and set on no
   * account. What it guarded was the per-request infrastructure — AgentCore,
   * DynamoDB, S3, API Gateway — which came to $0.24 over five days against
   * $18.44 of model spend: 1.3% of variable cost, and already implied by the
   * budget, since every request that costs anything costs money.
   */
  requestCount: number;
  /**
   * The plain token count, beside the figure the decision was made on.
   *
   * `currentUsage` is weighted once a price table is enforced, and a weighted
   * token is a millionth of a dollar — a true number that reads as a token count
   * and is not one. Anything showing a person "how many tokens" wants this.
   */
  totalTokens: number;
  /**
   * What the month has cost, or null with no price table. Read from the same
   * row the limit was, rather than a second query for the same item.
   */
  cost: number | null;
  /**
   * Whether `cost` is an estimate rather than a sum — see `splitCoverage`.
   *
   * True only for a month straddling the deploy that began recording which
   * model each request went to, where the uncounted requests are priced at the
   * counted ones' average. A figure a person is held to should say when it was
   * inferred, and this is the only case where it is.
   */
  estimated?: boolean;
  /**
   * The group's combined budget and what it has spent, when the account is in
   * one — and null when it is not.
   *
   * Present on every answer, refusal or not, because it is what every member of
   * a group is entitled to see: their own budget explains why THEY were
   * refused, and the group's explains why they were refused while still inside
   * it.
   */
  group: {
    name: string;
    limit: number;
    used: number;
    cost: number | null;
    /** True when the group's budget is what refused this request. */
    exceeded: boolean;
  } | null;
}

interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  /**
   * The cache halves, which are billed and were not being counted.
   *
   * `token-ledger.ts` has kept these apart from `inputTokens` since it was
   * written — Bedrock reports them as their own figures — and nothing carried
   * them this far, so they were spent and never recorded. Measured over 44 runs:
   * 417,685 read and 916,921 written, 12.8% of everything the limit saw.
   *
   * Optional because the edit and plan paths report a plain figure with no
   * cache in it, and absent is not zero to a reader of the row.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  /**
   * The group this request belongs to, when it belongs to one.
   *
   * Supplied by the caller because the caller already knows it. Looking it up
   * here would put a Cognito call on every recorded request to answer a question
   * the request already carried.
   */
  group?: string | null;
}

interface UsageHistoryEntry {
  month: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
}

/**
 * The month rows are keyed by, exported so nothing writes a second one.
 *
 * A report that computed its own default month from `new Date()` would agree
 * with this until the two disagreed about a timezone, and then disagree
 * silently — the table would simply look empty for a day at each boundary.
 */
export function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * This user's monthly token limit, or `null` when it could not be read.
 *
 * `null` is not the same as unset. Unset is a fact — no administrator has
 * changed this user, so the default applies. A failed read knows nothing, and
 * substituting the default there quietly RAISES the ceiling of anyone whose
 * limit was deliberately lowered, at exactly the moment DynamoDB is unhappy.
 * The two returned the same number before, so the difference never showed.
 */
async function getUserTokenLimit(userId: string): Promise<number | null> {
  try {
    const command = new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `USER#${userId}` },
        sk: { S: 'CONFIG' },
      },
    });
    const response = await client.send(command);
    if (response.Item?.monthlyTokenLimit?.N) {
      return parseInt(response.Item.monthlyTokenLimit.N, 10);
    }
    return DEFAULT_MONTHLY_TOKEN_LIMIT;
  } catch (error) {
    logger.warn('Failed to read user token limit', { userId, error: String(error) });
    return null;
  }
}

export async function setUserTokenLimit(userId: string, limit: number): Promise<void> {
  const now = new Date().toISOString();
  const command = new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: { S: `USER#${userId}` },
      sk: { S: 'CONFIG' },
    },
    UpdateExpression: 'SET monthlyTokenLimit = :limit, updatedAt = :now',
    ExpressionAttributeValues: {
      ':limit': { N: String(limit) },
      ':now': { S: now },
    },
  });
  await client.send(command);
  logger.info('User token limit updated', { userId, limit });
}

export type ModelId = 'haiku' | 'sonnet' | 'opus' | 'auto';

/** Canonical order — what the admin panel draws and what gets stored. */
const MODEL_IDS: ModelId[] = ['haiku', 'sonnet', 'opus', 'auto'];

/** The three that are actually models. `auto` resolves to one of these. */
const MODEL_TIERS: Exclude<ModelId, 'auto'>[] = ['haiku', 'sonnet', 'opus'];

function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && MODEL_IDS.includes(value as ModelId);
}

/**
 * A set the pipeline can actually resolve: deduplicated, ordered, and holding at
 * least one real model.
 *
 * `auto` alone is not a permission, it is an unanswerable request — the router
 * would pick a tier the user may not use. Returns null for anything that cannot
 * be honoured so the caller can reject it rather than store it.
 */
export function normalizeModelSet(value: unknown): ModelId[] | null {
  if (!Array.isArray(value)) return null;
  const set = new Set<ModelId>();
  for (const v of value) {
    if (!isModelId(v)) return null;
    set.add(v);
  }
  if (!MODEL_TIERS.some((t) => set.has(t))) return null;
  return MODEL_IDS.filter((m) => set.has(m));
}

/**
 * The ladder settings this used to have, so records written under them keep working.
 *
 * Read, never written. A stored ladder expands to the set it always meant — the
 * rung and everything below it — so no user's permissions change on the day the
 * checkboxes ship. Rewriting every config to the new shape would be a migration
 * that can half-finish; expanding on read costs one function and cannot.
 */
const LADDER_TO_SET: Record<string, ModelId[]> = {
  haiku: ['haiku'],
  sonnet: ['haiku', 'sonnet'],
  opus: ['haiku', 'sonnet', 'opus'],
  auto: ['haiku', 'sonnet', 'opus', 'auto'],
  // The names before the rungs were renamed.
  'haiku-only': ['haiku'],
  'no-opus': ['haiku', 'sonnet'],
  all: ['haiku', 'sonnet', 'opus', 'auto'],
};

/**
 * Which models this user may pick, or `null` when the setting could not be read.
 *
 * `null` is not the same as unset, and the difference is expensive here. This
 * list is the CLAMP — `decideTier` rounds strictly into it — so returning
 * everything on a failed read did not merely lose a preference, it lifted the
 * restriction entirely. A user held to Haiku ran on Opus, and a user who picked
 * `auto` landed on the top of the set, which had just become Opus too.
 *
 * It also read the same CONFIG item as the two limit getters, which now
 * distinguish the same two cases. This was the third of three.
 */
export async function getUserAllowedModels(userId: string): Promise<ModelId[] | null> {
  try {
    const response = await client.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: `USER#${userId}` }, sk: { S: 'CONFIG' } },
      })
    );
    return allowedModelsOf(response.Item);
  } catch (error) {
    logger.warn('Failed to read allowed models', { userId, error: String(error) });
    return null;
  }
}

/**
 * Everything one CONFIG item says, read once.
 *
 * The two getters above each fetch `USER#<sub>` / `CONFIG` in full and read one
 * attribute out of it, which is correct where they are called on their own —
 * `/usage` reads the model set separately on purpose, so that failing to read it
 * refuses on its own rather than riding on the limit's success.
 *
 * It stops being correct in a listing. `getAllUsersUsage` called both for every
 * account, which is two GetItems of the SAME item per user: forty accounts, two
 * hundred milliseconds and eighty reads to answer what forty would.
 */
function allowedModelsOf(item: Record<string, any> | undefined): ModelId[] {
  const stored = normalizeModelSet(item?.allowedModels?.SS);
  if (stored) return stored;
  const ladder = item?.modelAllowance?.S;
  if (ladder && LADDER_TO_SET[ladder]) return LADDER_TO_SET[ladder];
  // Unset means unrestricted: existing users must not lose access because a
  // setting they never had did not default to permissive. That is a fact about
  // this user, read from the store — unlike a failed read, which knows nothing.
  return [...MODEL_IDS];
}

interface UserConfig {
  tokenLimit: number;
  allowedModels: ModelId[];
}

/**
 * The configuration of many accounts, in one call per hundred rather than two
 * per account.
 *
 * `BatchGetItem` takes a hundred keys and returns what it found; a key with no
 * item is simply absent, which is the unset case and carries the defaults. Keys
 * it could not read come back under `UnprocessedKeys` when the table throttles,
 * and those are retried once and then reported as unread — `null` for that
 * account, never a default, for the reason every getter here distinguishes the
 * two: substituting a default on a failed read raises the ceiling of anyone
 * whose limit was deliberately lowered, at the moment DynamoDB is unhappy.
 */
async function readUserConfigs(userIds: readonly string[]): Promise<Map<string, UserConfig | null>> {
  const out = new Map<string, UserConfig | null>();
  const unique = [...new Set(userIds)].filter(Boolean);
  for (const id of unique) out.set(id, null);

  for (let i = 0; i < unique.length; i += 100) {
    let keys = unique.slice(i, i + 100).map((id) => ({
      pk: { S: `USER#${id}` }, sk: { S: 'CONFIG' },
    }));
    const found = new Set<string>();
    try {
      for (let attempt = 0; attempt < 2 && keys.length > 0; attempt++) {
        const res = await client.send(new BatchGetItemCommand({
          RequestItems: { [TABLE_NAME]: { Keys: keys } },
        }));
        for (const item of res.Responses?.[TABLE_NAME] ?? []) {
          const id = item.pk?.S?.replace('USER#', '') ?? '';
          found.add(id);
          out.set(id, {
            tokenLimit: item.monthlyTokenLimit?.N
              ? parseInt(item.monthlyTokenLimit.N, 10)
              : DEFAULT_MONTHLY_TOKEN_LIMIT,
            allowedModels: allowedModelsOf(item),
          });
        }
        const asked = new Set(keys.map((k) => k.pk.S.replace('USER#', '')));
        keys = (res.UnprocessedKeys?.[TABLE_NAME]?.Keys ?? []) as typeof keys;
        // Absent from the response and not unprocessed means no row: unset, and
        // the defaults apply. That is an answer, unlike a key that never made it.
        const pending = new Set(keys.map((k) => k.pk.S?.replace('USER#', '') ?? ''));
        for (const id of asked) {
          if (!found.has(id) && !pending.has(id)) {
            out.set(id, { tokenLimit: DEFAULT_MONTHLY_TOKEN_LIMIT, allowedModels: [...MODEL_IDS] });
          }
        }
      }
      if (keys.length > 0) {
        logger.warn('Some user configurations could not be read', { unread: keys.length });
      }
    } catch (error) {
      logger.warn('Failed to read a batch of user configurations', { error: String(error) });
    }
  }
  return out;
}

/**
 * The set a run may pick from, with the answer for a setting that cannot be read.
 *
 * Haiku, not everything, because Haiku is the CHEAPEST tier — 1 against Opus's
 * 5 in the rate limiter's own costs. The guard exists to bound spend, so the
 * direction to fail is down. Returning everything failed upward, and did it at
 * the moment the table backing every spend guard was already unhappy.
 *
 * It is not a subset of every configured set. `normalizeModelSet` requires one
 * real tier, not Haiku specifically, so an administrator can store `opus` alone
 * — and such a user would be handed Haiku here, a tier they were not granted.
 * That is a quality choice being overridden, not a spend one: the run gets
 * worse, never more expensive, and says so at error level. Measured rather than
 * assumed; the first version of this comment claimed the subset property and
 * the test disproved it.
 *
 * The run continues rather than dying. By the time the pipeline reads this the
 * job has been accepted and someone is waiting on it; refusing mid-flight costs
 * them the request to save a difference in tier.
 */
export async function allowedModelsForRun(userId: string): Promise<ModelId[]> {
  const allowed = await getUserAllowedModels(userId);
  if (allowed) return allowed;
  logger.error('Allowed models unreadable, restricting this run to haiku', { userId });
  return ['haiku'];
}

/**
 * Records the set, and clears the ladder it replaces.
 *
 * Leaving the old attribute behind would leave two answers in one item, and the
 * next reader to consult them in the other order would silently apply the stale
 * one. One writer, one field.
 */
export async function setUserAllowedModels(userId: string, models: ModelId[]): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: `USER#${userId}` }, sk: { S: 'CONFIG' } },
      UpdateExpression: 'SET allowedModels = :m, updatedAt = :now REMOVE modelAllowance',
      ExpressionAttributeValues: {
        ':m': { SS: models },
        ':now': { S: new Date().toISOString() },
      },
    })
  );
  logger.info('User allowed models updated', { userId, models: models.join(',') });
}

/**
 * The answer when the ledger could not be read.
 *
 * `allowed: false`, because a limit that cannot be checked has not been checked,
 * and the caller is about to spend money. `known: false`, because the caller
 * must not report this as "limit exceeded" — that names a fact nobody
 * established. The numbers are placeholders and are marked as such by `known`;
 * nothing should read them.
 *
 * The retry that would make this rare is already there: the AWS SDK retries
 * throttles and 5xx on its own before this catch is ever reached, so anything
 * arriving here has already failed several times.
 */
function usageUnknown(): UsageLimitResult {
  return {
    allowed: false,
    known: false,
    currentUsage: 0,
    limit: DEFAULT_MONTHLY_TOKEN_LIMIT,
    requestCount: 0,
    totalTokens: 0,
    cost: null,
    group: null,
  };
}

export async function checkUsageLimit(userId: string, group: string | null = null): Promise<UsageLimitResult> {
  const monthKey = getCurrentMonthKey();

  try {
    const [usageResponse, userTokenLimit, groupLimit, groupMonth] = await Promise.all([
      client.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `USER#${userId}` },
          sk: { S: `MONTH#${monthKey}` },
        },
      })),
      getUserTokenLimit(userId),
      /*
       * The group's budget and month, in the same round trip as the user's.
       * Two GetItems in parallel rather than one after the other: this runs
       * before every build, and a tenant's ceiling is not worth a second
       * sequential read.
       */
      group ? getGroupLimit(group) : Promise.resolve(-1),
      group ? getGroupMonth(group) : Promise.resolve({ weighted: 0, total: 0, requests: 0, cost: null }),
    ]);

    /*
     * The weighted count, when there is a price table; the plain one otherwise.
     *
     * `weightedTokens` is what a request cost expressed in the cheapest input
     * token there is, so an account spending its month on Haiku input sees the
     * number it always saw and the stored 1,000,000 limits still mean what they
     * meant. Without a table the two are equal by construction and this reads
     * the same figure it read before.
     *
     * Falls back to `totalTokens` for a month written before the weighted column
     * existed — a stored month has no weighted figure, and reading zero from it
     * would hand that user an empty budget they had already spent.
     */
    /*
     * Having prices and refusing on them are different switches. See
     * `pricingEnforced`: the table alone reports, and moving the limit onto the
     * weighted figure changes every allowance by roughly threefold, which is a
     * decision rather than a consequence.
     */
    const priced = pricingEnforced();
    const item = usageResponse.Item;
    const plainUsage = item ? parseInt(item.totalTokens?.N ?? '0', 10) : 0;
    /*
     * Scaled to the whole month — see `splitCoverage`. The stored weight only
     * covers the requests that recorded a model, and comparing that lower bound
     * against the budget is the permissive direction.
     */
    const weightedUsage = item?.weightedTokens?.N
      ? Math.round(parseInt(item.weightedTokens.N, 10) * splitCoverage(item))
      : null;
    const currentUsage = priced && weightedUsage !== null ? weightedUsage : plainUsage;
    const currentRequests = usageResponse.Item
      ? parseInt(usageResponse.Item.requestCount?.N ?? '0', 10)
      : 0;

    // A limit that could not be read is not a limit of zero and not the default.
    // Nothing below can be computed without it.
    /*
     * Either budget being unreadable refuses, for the reason the user's own
     * always has: the failure that produces it is a throttle, which arrives
     * under load, which is when a limit is doing the most work.
     */
    if (userTokenLimit === null || groupLimit === null || groupMonth === null) {
      logger.error('Usage limits unreadable, refusing rather than allowing', { userId, group });
      return usageUnknown();
    }

    const tokenUnlimited = userTokenLimit === -1;
    const withinOwn = tokenUnlimited || currentUsage < userTokenLimit;

    /*
     * The group's ceiling, on the same figure the user's is checked on — the
     * weighted count where a price table is enforced, the plain one otherwise.
     * A tenant whose members are each inside their own budget can still be past
     * the one the account is billed against, and that is the whole point of
     * having it.
     */
    const groupUsed = priced ? groupMonth.weighted : groupMonth.total;
    const withinGroup = !group || groupLimit === -1 || groupUsed < groupLimit;

    const month = item ? monthCost(item) : null;
    return {
      allowed: withinOwn && withinGroup,
      known: true,
      currentUsage,
      limit: userTokenLimit,
      requestCount: currentRequests,
      totalTokens: plainUsage,
      cost: month?.cost ?? null,
      estimated: month?.estimated ?? false,
      group: group
        ? { name: group, limit: groupLimit, used: groupUsed, cost: groupMonth.cost, exceeded: !withinGroup }
        : null,
      /*
       * Which number the decision was made on. A user told they are at 900,000
       * of 1,000,000 deserves to know whether that is tokens or tokens weighted
       * by price, and an operator reading a refusal needs it more.
       */
      weighted: priced && weightedUsage !== null,
    };
  } catch (error) {
    logger.error('Failed to check usage limit', { userId, error: String(error) });
    return usageUnknown();
  }
}

/**
 * Backoff for the two writes below, on top of what the SDK already does.
 *
 * Reads elsewhere in this file get no extra retry, deliberately: a failed read
 * is repeated by the next request, so it heals itself. These writes do not.
 * This is the only moment this spend can be recorded — after it, the job is
 * finished, the process is gone, and nothing revisits the number. That is what
 * makes effort here worth spending that would be redundant on a read.
 *
 * Bounded because `recordUsage` is awaited before the job is marked completed,
 * so every second here is a second the user waits for a result they already
 * have. Two retries, ~2.5s worst case per write.
 */
const RECORD_RETRY_MS = [500, 2000];

/**
 * Send a write, with retries, reporting whether it landed.
 *
 * Takes a thunk rather than the command, so the two command types do not have
 * to be widened into a union the SDK's overloads reject. The command itself is
 * built once by the caller and closed over, which is what makes a retry
 * idempotent where it can be: the event's sort key is fixed, so a repeat
 * overwrites its own row instead of adding a second one.
 *
 * The aggregate's `ADD` is not idempotent — a retry after a write that actually
 * landed but reported a timeout counts the tokens twice. That is the acceptable
 * direction: over-counting makes a limit bind sooner, under-counting makes it
 * not bind at all, and only one of those is a spend guard failing.
 */
async function sendRecordWrite(send: () => Promise<unknown>, what: string, userId: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await send();
      return true;
    } catch (error) {
      if (attempt >= RECORD_RETRY_MS.length) {
        logger.error('Usage write failed after retries', { userId, what, attempts: attempt + 1, error: String(error) });
        return false;
      }
      await new Promise((r) => setTimeout(r, RECORD_RETRY_MS[attempt]));
    }
  }
}

/**
 * A group's budget, and the month it has spent against it.
 *
 * A group is a tenant, and a tenant is billed as one. Per-user budgets bound
 * what one person can do; they say nothing about what forty people can do
 * together, which is the number somebody paying for this account cares about.
 *
 * Stored the same way a user's is — `CONFIG` under the group's own partition —
 * so there is one shape for "a budget" and one for "a month", and the group
 * aggregate is a single GetItem rather than a scan over its members. It is
 * written by `recordUsage`, which knows whose request it is recording and can
 * ask which group they are in.
 */
export async function getGroupLimit(group: string): Promise<number | null> {
  if (!group) return -1;
  try {
    const response = await client.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: `GROUP#${group}` }, sk: { S: 'CONFIG' } },
    }));
    if (response.Item?.monthlyTokenLimit?.N) {
      return parseInt(response.Item.monthlyTokenLimit.N, 10);
    }
    // No row is no budget, which is unlimited — not the per-user default. A
    // group nobody has set a figure for must not inherit one.
    return -1;
  } catch (error) {
    // Null, not a default: an unreadable budget is a fact the caller has to be
    // able to act on — see `checkUsageLimit`.
    logger.warn('Failed to read group budget', { group, error: String(error) });
    return null;
  }
}

export async function setGroupLimit(group: string, limit: number): Promise<void> {
  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `GROUP#${group}` }, sk: { S: 'CONFIG' } },
    UpdateExpression: 'SET monthlyTokenLimit = :limit, updatedAt = :now',
    ExpressionAttributeValues: {
      ':limit': { N: String(limit) },
      ':now': { S: new Date().toISOString() },
    },
  }));
  logger.info('Group budget updated', { group, limit });
}

/** What a group has spent this month, weighted and plain. */
export async function getGroupMonth(group: string): Promise<{ weighted: number; total: number; requests: number; cost: number | null } | null> {
  if (!group) return { weighted: 0, total: 0, requests: 0, cost: null };
  try {
    const response = await client.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: `GROUP#${group}` }, sk: { S: `MONTH#${getCurrentMonthKey()}` } },
    }));
    const item = response.Item;
    if (!item) return { weighted: 0, total: 0, requests: 0, cost: null };
    const total = parseInt(item.totalTokens?.N ?? '0', 10);
    // Scaled the same way the user's own is — see `splitCoverage`. A group is
    // checked on the same figure, so it has to be short by the same amount.
    return {
      total,
      weighted: item.weightedTokens?.N
        ? Math.round(parseInt(item.weightedTokens.N, 10) * splitCoverage(item))
        : total,
      requests: parseInt(item.requestCount?.N ?? '0', 10),
      cost: monthCost(item).cost,
    };
  } catch (error) {
    logger.warn('Failed to read group usage', { group, error: String(error) });
    return null;
  }
}

export async function recordUsage(userId: string, usage: UsageRecord): Promise<void> {
  const monthKey = getCurrentMonthKey();
  const now = new Date().toISOString();
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const split = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };
  /*
   * `totalTokens` keeps its meaning: input plus output, model-blind, the number
   * every stored month was measured in. `weightedTokens` is the new one, and it
   * is what the limit reads once a price table exists — see config/pricing.ts.
   * Both are written so a month can be read either way and the two can be
   * compared.
   */
  const weightedTokens = weighTokens(usage.model, split);
  /*
   * Per model, on the row the limit is enforced against.
   *
   * The model was recorded only on the EVENT rows, which nothing reads and
   * which have not survived — 170 requests are in the monthly aggregates and
   * nine events remain. So the one row that decides whether a user may run
   * could not say what the spend went to, and no report could be built from it
   * afterwards. `ADD` creates each attribute on first use, so a new tier needs
   * no migration.
   */
  const key = safeModelKey(usage.model);

  /*
   * The monthly aggregate is written FIRST, and the event second.
   *
   * It used to be the other way round, inside one try, which put the audit row
   * in front of the enforcement row: a transient failure writing the event —
   * a record nothing reads — skipped the aggregate entirely, and the aggregate
   * is the only thing `checkUsageLimit` and `getUsageHistory` consult. So a
   * failure in the write that does not matter silently discarded the write that
   * does, and the month under-counted for good.
   *
   * They are also independent now. Neither failing may cost the other.
   */
  const aggregateCommand = new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: { S: `USER#${userId}` },
      sk: { S: `MONTH#${monthKey}` },
    },
    UpdateExpression:
      'ADD totalTokens :total, inputTokens :input, outputTokens :output, requestCount :one'
      + ', cacheReadTokens :cread, cacheWriteTokens :cwrite, weightedTokens :weighted'
      + `, tok_${key}_in :input, tok_${key}_out :output`
      + `, tok_${key}_cr :cread, tok_${key}_cw :cwrite, tok_${key}_req :one`
      + ' SET lastUpdated = :now',
    ExpressionAttributeValues: {
      ':total': { N: String(totalTokens) },
      ':input': { N: String(usage.inputTokens) },
      ':output': { N: String(usage.outputTokens) },
      ':cread': { N: String(split.cacheReadTokens) },
      ':cwrite': { N: String(split.cacheWriteTokens) },
      ':weighted': { N: String(weightedTokens) },
      ':one': { N: '1' },
      ':now': { S: now },
    },
  });
  const eventCommand = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `USER#${userId}` },
      sk: { S: `EVENT#${now}#${crypto.randomUUID()}` },
      /*
       * These rows expire; the monthly aggregates beside them do not.
       *
       * An event is the per-request detail — which model, how many tokens, when
       * — and nothing reads it today. It is kept because it is the only thing
       * that could ever answer "which model is the spend going to", and that
       * only became true when the model column stopped naming the pipeline
       * instead of a model. Before that fix 361 of 417 rows named no model at
       * all, and keeping them would have been keeping nothing.
       *
       * 13 months rather than 12, so a comparison with the same month last year
       * still has both ends. The aggregate the limits are enforced against
       * carries no TTL and is unaffected.
       *
       * If nobody asks the per-model question inside this window, that is the
       * answer, and the write should go rather than the retention grow.
       */
      ttl: { N: String(Math.floor(Date.now() / 1000) + EVENT_RETENTION_DAYS * 86400) },
      inputTokens: { N: String(usage.inputTokens) },
      outputTokens: { N: String(usage.outputTokens) },
      cacheReadTokens: { N: String(split.cacheReadTokens) },
      cacheWriteTokens: { N: String(split.cacheWriteTokens) },
      totalTokens: { N: String(totalTokens) },
      weightedTokens: { N: String(weightedTokens) },
      model: { S: usage.model },
      timestamp: { S: now },
      month: { S: monthKey },
    },
  });

  /*
   * The group's month, written from the same figures.
   *
   * A second row rather than a sum over members: the group's budget is checked
   * on every request, and a scan of every member's month to answer it would put
   * the whole tenant's usage on the path of one person's build. One extra WCU
   * per request buys a GetItem.
   *
   * `usage.group` is passed in rather than looked up here, because the caller
   * already knows it — see the route — and this function must not start making
   * a Cognito call per recorded request.
   */
  const groupCommand = usage.group
    ? new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: `GROUP#${usage.group}` }, sk: { S: `MONTH#${monthKey}` } },
        UpdateExpression:
          'ADD totalTokens :total, inputTokens :input, outputTokens :output, requestCount :one'
          + ', cacheReadTokens :cread, cacheWriteTokens :cwrite, weightedTokens :weighted'
          + `, tok_${key}_in :input, tok_${key}_out :output`
          + `, tok_${key}_cr :cread, tok_${key}_cw :cwrite, tok_${key}_req :one`
          + ' SET lastUpdated = :now',
        ExpressionAttributeValues: aggregateCommand.input.ExpressionAttributeValues,
      })
    : null;

  const counted = await sendRecordWrite(() => client.send(aggregateCommand), 'monthly aggregate', userId);
  /*
   * Best-effort, and after the one that matters. A group total that misses a
   * request is a budget slightly too generous for a month; a USER total that
   * misses one is the guard everybody is actually held to.
   */
  if (groupCommand) {
    await sendRecordWrite(() => client.send(groupCommand), 'group aggregate', userId);
  }
  const logged = await sendRecordWrite(() => client.send(eventCommand), 'usage event', userId);

  if (counted && logged) {
    logger.info('Usage recorded', {
      userId, totalTokens, weightedTokens, model: usage.model,
      cacheReadTokens: split.cacheReadTokens, cacheWriteTokens: split.cacheWriteTokens,
    });
    return;
  }
  /*
   * Said in full, and said differently for the two.
   *
   * A missing aggregate means this month's limit is now looser than it is
   * supposed to be, by exactly these tokens, until the month rolls over —
   * nothing recomputes it. The figures are here so the row can be replayed by
   * hand; the previous message carried none of them, so a lost record left no
   * way to know what had been lost.
   */
  if (!counted) {
    logger.error('Usage NOT counted against the limit', {
      userId, monthKey, model: usage.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens,
      eventWritten: logged,
    });
  } else {
    logger.warn('Usage counted, but its audit event was not written', { userId, monthKey, totalTokens });
  }
}

export async function getUsageHistory(
  userId: string,
  months: number = 6
): Promise<UsageHistoryEntry[]> {
  try {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'MONTH#' },
      },
      ScanIndexForward: false,
      Limit: months,
    });

    const response = await client.send(command);
    const history: UsageHistoryEntry[] = (response.Items ?? []).map((item) => ({
      month: item.sk?.S?.replace('MONTH#', '') ?? '',
      totalInputTokens: parseInt(item.inputTokens?.N ?? '0', 10),
      totalOutputTokens: parseInt(item.outputTokens?.N ?? '0', 10),
      requestCount: parseInt(item.requestCount?.N ?? '0', 10),
    }));

    return history;
  } catch (error) {
    logger.error('Failed to get usage history', { userId, error: String(error) });
    return [];
  }
}

export interface UserUsageSummary {
  userId: string;
  email: string;
  /**
   * The name this account is shown by. Sign-in is still the email.
   *
   * Present on every row, derived where it is not stored — see
   * services/display-name.ts. The panel prints this and keeps the address as a
   * second line, because an administrator changing somebody's limits needs to
   * know which account it is and a chosen name is not unique.
   */
  displayName: string;
  /** `2026-09`, or `2026-07〜2026-09` when the period spans months. */
  month: string;
  /** The period the figures cover, so a client can label and compare them. */
  period: { from: string; to: string };
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Billed, and not counted in `totalTokens` — see `UsageRecord`. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** `totalTokens` priced. Equal to it while no price table is configured. */
  weightedTokens: number;
  /**
   * What the month cost, in the table's currency, or null without a table.
   *
   * Null rather than zero: a panel that printed 0 for "no prices configured"
   * would be reporting a free month, which is the one thing this column exists
   * to stop somebody believing.
   */
  cost: number | null;
  /** Whether `cost` is an estimate rather than a sum — see `splitCoverage`. */
  estimated: boolean;
  /** Per model, so the panel can say where the money went. */
  byModel: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requestCount: number; cost: number | null }[];
  requestCount: number;
  monthlyLimit: number;
  /**
   * The group this account belongs to, or null.
   *
   * Carried here so every tab that lists accounts can say it. The panel had
   * three screens that each listed people and only one of them showed which
   * tenant they were — so the same person read as unaffiliated on two screens
   * and as a member on the third.
   */
  group: string | null;
  /** Which models this user may pick, each independently on or off. */
  allowedModels: ModelId[];
  /**
   * How many projects this account holds, over all time.
   *
   * Not part of the period. Every other figure on this row is what the account
   * spent between `from` and `to`; this one is the size of their workspace now,
   * because that is the question the projects tab asks and narrowing it to a
   * month would make the badge disagree with the list underneath it.
   *
   * Counted the same way the projects route lists them — every `PROJECT#` row,
   * archived included — for the same reason: a count that does not match the
   * list it labels is worse than no count.
   */
  projectCount: number;
  lastUpdated: string;
}

/**
 * sub -> the account's email and the name it is shown by.
 *
 * Both, from one listing. The email still decides which usage rows belong to a
 * live account — see the filter below — and the name is what the panel prints;
 * looking them up separately would be a second pass over the whole directory to
 * answer half of the same question.
 */
async function getCognitoEmailMap(): Promise<Map<string, { email: string; displayName: string }> | null> {
  const emailMap = new Map<string, { email: string; displayName: string }>();
  if (!USER_POOL_ID) return emailMap;
  try {
    let paginationToken: string | undefined;
    do {
      /*
       * No `AttributesToGet`. This pool refuses one containing `name` —
       * `InvalidParameterException: Input fails to satisfy the constraints`,
       * for `['sub','email','name']` and for `['name']` alone, while
       * `['sub','email']` is fine.
       *
       * That was shipped and broke two things at once, in the direction that
       * does not announce itself: the call is inside a try/catch that logs a
       * warning and returns an EMPTY map. So every usage row lost its email and
       * rendered as 「—」, and the filter below — which hides rows belonging to
       * no live account — reads an empty directory as "Cognito is down" and
       * stops filtering, so three synthetic probe users appeared in the panel.
       * One malformed parameter, two symptoms, no error anywhere the user could
       * see. 27 warnings in CloudWatch and a green deploy.
       *
       * Asking for everything is what /admin/users has always done over the same
       * directory, and it is a few hundred bytes per user.
       */
      const res = await cognitoClient.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
      }));
      for (const user of res.Users ?? []) {
        const sub = user.Attributes?.find(a => a.Name === 'sub')?.Value;
        const email = user.Attributes?.find(a => a.Name === 'email')?.Value;
        const name = user.Attributes?.find(a => a.Name === 'name')?.Value;
        if (sub && email) emailMap.set(sub, { email, displayName: displayNameFor(email, name) });
      }
      paginationToken = res.PaginationToken;
    } while (paginationToken);
  } catch (error) {
    /*
     * `null`, not an empty map.
     *
     * They meant the same thing until today, and that is exactly why a rejected
     * parameter went unnoticed: the caller reads an empty directory as "Cognito
     * is unreachable, do not filter", so a call that FAILED and a pool that is
     * genuinely empty produced the same, harmless-looking behaviour. Separating
     * them costs one type and makes the failure a thing the caller can act on.
     */
    logger.warn('Failed to fetch Cognito users', { error: String(error) });
    return null;
  }
  return emailMap;
}

/**
 * The per-model columns on a month, read back, with what each cost.
 *
 * `recordUsage` writes `tok_<model>_in` and its four siblings, so the models a
 * month used are whichever of those attributes exist — no list to keep in step,
 * and a tier added later appears here without a migration.
 */
/**
 * How much of a month the per-model split actually accounts for, as a factor.
 *
 * `tok_<model>_req` counts the requests that recorded which model they went to;
 * `requestCount` counts every request there was. The two agree for any month
 * written entirely by one deployment, and they diverge across the deploy that
 * introduced the split — the earlier requests added to the totals and to
 * nothing else. September 2026 has three requests and one recorded split, so
 * every figure derived from `tok_*` is a third of that month's.
 *
 * Which makes both the cost and the weighted total LOWER BOUNDS on such a
 * month, and a lower bound is the permissive direction for a budget: a user
 * would have been given roughly three times their allowance for the rest of the
 * month, on a row that looked complete.
 *
 * Scaling by the ratio spends the counted requests' own average on the
 * uncounted ones. It is the only estimate the row supports — the requests that
 * did not record a model did not record which one — and it is exact once every
 * request carries its split, because the ratio is then 1 and this multiplies by
 * one. It is not a migration: the divergence ends by itself when the month does.
 */
function splitCoverage(item: Record<string, any>): number {
  const requests = parseInt(item.requestCount?.N ?? '0', 10);
  let recorded = 0;
  for (const [key, value] of Object.entries(item)) {
    if (/^tok_.+_req$/.test(key)) recorded += parseInt((value as any)?.N ?? '0', 10);
  }
  // Nothing recorded is not a month priced at nothing — it is a month written
  // entirely before the split existed, where the plain columns are all there is
  // and scaling has nothing to scale. `monthCost` reports null for it either way.
  if (recorded <= 0 || requests <= recorded) return 1;
  return requests / recorded;
}

function monthCost(item: Record<string, any>): { cost: number | null; byModel: UserUsageSummary['byModel']; estimated: boolean } {
  const table = pricingTable();
  const models = new Set<string>();
  for (const key of Object.keys(item)) {
    const m = /^tok_(.+)_(in|out|cr|cw|req)$/.exec(key);
    if (m) models.add(m[1]);
  }

  const num = (key: string): number => parseInt(item[key]?.N ?? '0', 10);
  const byModel = [...models].sort().map((model) => {
    const split = {
      inputTokens: num(`tok_${model}_in`),
      outputTokens: num(`tok_${model}_out`),
      cacheReadTokens: num(`tok_${model}_cr`),
      cacheWriteTokens: num(`tok_${model}_cw`),
    };
    return {
      model,
      ...split,
      requestCount: num(`tok_${model}_req`),
      cost: costOf(model, split, table ?? undefined),
    };
  });

  /*
   * Null unless every model on the month has a price. A total that silently
   * omitted the one tier missing from the table would be an under-count
   * presented as a bill.
   */
  const priced = byModel.length > 0 && byModel.every((m) => m.cost !== null);
  /*
   * The total is scaled to the whole month; the per-model rows are not.
   *
   * A row under `byModel` is an exact statement about the requests that
   * recorded it, and stays one. The total claims to be the month, so it is the
   * only figure the uncounted requests belong in — and the only one that would
   * be wrong without them.
   */
  const coverage = splitCoverage(item);
  const recorded = byModel.reduce((a, m) => a + (m.cost ?? 0), 0);
  return {
    cost: priced ? recorded * coverage : null,
    byModel,
    estimated: priced && coverage > 1,
  };
}

/** `YYYY-MM`, which is the only granularity the store has. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Every month from `from` to `to` inclusive, oldest first. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Several months added into one row, so a period can be reported like a month.
 *
 * Every figure this file records is a counter, so a period is their sum — and
 * that includes the `tok_<model>_*` attributes, which is what makes `monthCost`
 * and `splitCoverage` work unchanged on the result. They take an item and read
 * counters off it; they do not care that this item was three.
 *
 * `lastUpdated` is the latest rather than a sum, being a timestamp.
 */
function mergeMonths(items: Record<string, any>[]): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const item of items) {
    for (const [k, v] of Object.entries(item)) {
      if (k === 'pk' || k === 'sk') { merged[k] = merged[k] ?? v; continue; }
      if ((v as any)?.N !== undefined) {
        const n = parseInt((v as any).N, 10) || 0;
        merged[k] = { N: String((parseInt(merged[k]?.N ?? '0', 10) || 0) + n) };
      } else if (k === 'lastUpdated' && (v as any)?.S) {
        if (!merged[k]?.S || (v as any).S > merged[k].S) merged[k] = v;
      } else {
        merged[k] = merged[k] ?? v;
      }
    }
  }
  return merged;
}

/**
 * How many projects each account holds, keyed by sub.
 *
 * A scan rather than a query per account: the panel wants this for everybody at
 * once, and a query apiece is one round trip per row of the table it is about
 * to draw. `ProjectionExpression: 'pk'` because only the owner is wanted — a
 * project row carries a name, a preset and a key, none of which is being asked
 * for here.
 *
 * Every `PROJECT#` row, with no filtering on `archivedAt`, because that is
 * exactly what `listProjects` returns to the tab this number labels. A badge
 * that counts differently from the list under it is the defect, not the fix.
 *
 * Failure is an empty map, not a throw: this is a decoration on a usage table
 * that has to render either way, and the callers below treat a missing entry as
 * zero — which is also the honest answer for an account with no projects.
 */
async function getProjectCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    let lastKey: Record<string, any> | undefined;
    do {
      const response = await client.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(sk, :p)',
        ExpressionAttributeValues: { ':p': { S: 'PROJECT#' } },
        ProjectionExpression: 'pk',
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of response.Items ?? []) {
        const sub = item.pk?.S?.replace('USER#', '') ?? '';
        if (sub) counts.set(sub, (counts.get(sub) ?? 0) + 1);
      }
      lastKey = response.LastEvaluatedKey;
    } while (lastKey);
  } catch (error) {
    logger.error('Failed to count projects per account', { error: String(error) });
  }
  return counts;
}

/** One month of the whole account, for a chart with time along the bottom. */
interface MonthTotals {
  /** `2026-09`. */
  month: string;
  totalTokens: number;
  requestCount: number;
  /** The month's cost, or null when the price table does not cover it. */
  cost: number | null;
  byModel: NonNullable<UserUsageSummary['byModel']>;
  /**
   * How much of the month has a model recorded against it.
   *
   * Not decoration. `tok_<model>_*` began part-way through the product's life,
   * so a month can have a complete total and no attribution at all — measured
   * 2026-09-10: August is 0 of 165 requests, September 3 of 8. A chart drawn
   * from `byModel` alone would show the attributed sliver and read as the whole
   * month, and the reader has no way to notice.
   */
  attributed: { tokens: number; requests: number };
  /**
   * Whether `cost` is a sum or an inference — see `splitCoverage`.
   *
   * A month straddling the deploy that began recording the model prices its
   * uncounted requests at the counted ones' average, because that is the only
   * estimate the row supports. On a chart of money that has to be visible: a bar
   * drawn from three requests standing for eight is a different claim from a bar
   * drawn from eight.
   */
  estimated: boolean;
}

/**
 * Each month in the period, for the whole account.
 *
 * `getAllUsersUsage` reads the same rows and merges a range into one line per
 * ACCOUNT, which answers "who spent what". This groups the other way — one line
 * per MONTH, all accounts together — which is what a graph with time along the
 * bottom needs. The same scan either way; the store keeps one row per account
 * per month and a month is the finest period it can answer.
 */
export async function getMonthlySeries(
  from: string = getCurrentMonthKey(),
  to: string = from,
): Promise<MonthTotals[]> {
  try {
    const items: Record<string, any>[] = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const response = await client.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':from': { S: `MONTH#${from}` },
          ':to': { S: `MONTH#${to}` },
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      items.push(...(response.Items ?? []));
      lastKey = response.LastEvaluatedKey;
    } while (lastKey);

    /*
     * Only rows that belong to somebody, on the same rule the account listing
     * uses: a usage row outlives the account it was written for, and a run made
     * against the pipeline directly carries a synthetic id. Unfiltered when the
     * directory itself could not be read, because treating a Cognito outage as
     * "nobody exists" would empty the chart.
     */
    const emailMap = await getCognitoEmailMap();
    const owned = emailMap
      ? items.filter((i) => emailMap.has(i.pk?.S?.replace('USER#', '') ?? ''))
      : items;

    const byMonth = new Map<string, MonthTotals>();
    for (const item of owned) {
      const month = (item.sk?.S ?? '').replace('MONTH#', '');
      if (!month) continue;
      const entry: MonthTotals = byMonth.get(month) ?? {
        month,
        totalTokens: 0,
        requestCount: 0,
        cost: null,
        byModel: [],
        attributed: { tokens: 0, requests: 0 },
        estimated: false,
      };
      entry.totalTokens += parseInt(item.totalTokens?.N ?? '0', 10);
      entry.requestCount += parseInt(item.requestCount?.N ?? '0', 10);

      const { cost, byModel, estimated } = monthCost(item);
      // One inferred account makes the month's figure inferred. It is a sum of
      // accounts, and a sum containing an estimate is an estimate.
      if (estimated) entry.estimated = true;
      // Null and 0 are different answers: null is "no price table covers this",
      // and adding it as zero would report a month as free.
      if (cost !== null) entry.cost = (entry.cost ?? 0) + cost;
      for (const m of byModel ?? []) {
        const tokens = m.inputTokens + m.outputTokens;
        entry.attributed.tokens += tokens;
        entry.attributed.requests += m.requestCount;
        const found = entry.byModel.find((x) => x.model === m.model);
        if (!found) { entry.byModel.push({ ...m }); continue; }
        found.inputTokens += m.inputTokens;
        found.outputTokens += m.outputTokens;
        found.cacheReadTokens += m.cacheReadTokens;
        found.cacheWriteTokens += m.cacheWriteTokens;
        found.requestCount += m.requestCount;
        // One unpriced model in the month leaves the model unpriced, which is
        // the rule the panel's totals already use.
        found.cost = found.cost === null || m.cost === null ? null : found.cost + m.cost;
      }
      byMonth.set(month, entry);
    }

    /*
     * Every month in the range, including the ones nobody ran in.
     *
     * A chart that skips an empty month draws a line straight from one busy
     * month to the next and reads as continuous use. The gap is the fact.
     */
    return monthsBetween(from, to).map((month) => byMonth.get(month) ?? {
      month,
      totalTokens: 0,
      requestCount: 0,
      cost: null,
      byModel: [],
      attributed: { tokens: 0, requests: 0 },
      estimated: false,
    });
  } catch (error) {
    logger.error('Failed to read the monthly series', { error: String(error) });
    return [];
  }
}

/**
 * What every account spent over a period, defaulting to this month.
 *
 * The store keeps one row per account per MONTH, so a month is the finest
 * period this can answer and a longer one is their sum — see `mergeMonths`.
 * There is no day-level aggregate to build a finer range from: the `EVENT#`
 * rows carry per-request detail but reading them for a report would mean
 * scanning a partition per account.
 */
export async function getAllUsersUsage(
  from: string = getCurrentMonthKey(),
  to: string = from,
): Promise<UserUsageSummary[]> {
  const period = { from, to };
  const monthKey = from === to ? from : `${from}〜${to}`;

  try {
    const allItems: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const command = new ScanCommand({
        TableName: TABLE_NAME,
        /*
         * A range rather than one key. `MONTH#` sorts clear of every other sort
         * key this table uses — CHAT#, CONFIG and EVENT# below it, PROJECT# and
         * VERSION# above — so a BETWEEN over `MONTH#<from>`..`MONTH#<to>`
         * cannot pick up a row of another kind.
         */
        FilterExpression: 'sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':from': { S: `MONTH#${from}` },
          ':to': { S: `MONTH#${to}` },
        },
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      });

      const response = await client.send(command);
      allItems.push(...(response.Items ?? []));
      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const emailMap = await getCognitoEmailMap();

    /**
     * Only rows that belong to somebody.
     *
     * A usage row outlives the account it was written for — a deleted user, or a
     * job run against the pipeline directly with a synthetic id — and those rows
     * reached the panel as a user named "—" with limits nobody could meaningfully
     * set. Three of them were the verification harness's own.
     *
     * Filtered only when the directory actually answered — `null` is the lookup
     * having failed, and treating that as "nobody exists" would blank the whole
     * table on a Cognito outage.
     *
     * It used to be an empty map for both, and that ambiguity is what let a
     * rejected `AttributesToGet` ship: the listing threw, the map came back
     * empty, the filter turned itself off, and three probe users walked into the
     * panel while every real row lost its email. The failure looked exactly like
     * an outage, and an outage looks exactly like success with no users.
     */
    const known = emailMap !== null;
    const owned = emailMap
      ? allItems.filter((item) => emailMap.has(item.pk?.S?.replace('USER#', '') ?? ''))
      : allItems;
    /*
     * One row per ACCOUNT, not per account per month.
     *
     * A range returns a row for every month a person ran in, and the table
     * below has one line per person — so the months are added together here.
     * Identical to the old behaviour when the range is a single month, which is
     * the default and by far the common case.
     */
    const byUser = new Map<string, Record<string, any>[]>();
    for (const item of owned) {
      const sub = item.pk?.S?.replace('USER#', '') ?? '';
      const list = byUser.get(sub);
      if (list) list.push(item);
      else byUser.set(sub, [item]);
    }
    const rows = [...byUser.values()].map((months) => months.length === 1 ? months[0] : mergeMonths(months));
    // Against what was SCANNED, not against the merged rows — those are one per
    // account by construction, so comparing them to the account count would
    // never be true and the log line would never appear.
    if (known && owned.length < allItems.length) {
      logger.info('Usage rows without a Cognito account hidden', {
        hidden: allItems.length - owned.length,
      });
    }

    /*
     * Every account, not only the ones that spent something this month.
     *
     * This listed the MONTH rows and nothing else, so an account appeared only
     * after its first run — and the people an administrator most wants to
     * configure are the ones who have not run yet. A user created this morning
     * was invisible on the screen where their budget is set.
     *
     * The zero row is a real answer: this account exists and has spent nothing.
     * It carries the same limits as any other, because those are stored per
     * account and not per month.
     */
    const seen = new Set(rows.map((item) => item.pk?.S?.replace('USER#', '') ?? ''));
    if (emailMap) {
      for (const sub of emailMap.keys()) {
        if (!seen.has(sub)) rows.push({ pk: { S: `USER#${sub}` } });
      }
    }

    const userIds = rows.map(item => item.pk?.S?.replace('USER#', '') ?? '');
    /*
     * One read per account, batched — not two each. Both settings live on the
     * same CONFIG item, and this listed them with a GetItem apiece.
     */
    const configs = await readUserConfigs(userIds);
    const projectCounts = await getProjectCounts();

    const users: UserUsageSummary[] = rows.map((item, i) => ({
      userId: userIds[i],
      email: emailMap?.get(userIds[i])?.email ?? '',
      displayName: emailMap?.get(userIds[i])?.displayName ?? '',
      month: monthKey,
      period,
      totalTokens: parseInt(item.totalTokens?.N ?? '0', 10),
      inputTokens: parseInt(item.inputTokens?.N ?? '0', 10),
      outputTokens: parseInt(item.outputTokens?.N ?? '0', 10),
      cacheReadTokens: parseInt(item.cacheReadTokens?.N ?? '0', 10),
      cacheWriteTokens: parseInt(item.cacheWriteTokens?.N ?? '0', 10),
      /*
       * The stored weight, or the plain total for a month written before the
       * column existed. Zero would read as a month that cost nothing.
       */
      weightedTokens: item.weightedTokens?.N
        ? Math.round(parseInt(item.weightedTokens.N, 10) * splitCoverage(item))
        : parseInt(item.totalTokens?.N ?? '0', 10),
      ...monthCost(item),
      requestCount: parseInt(item.requestCount?.N ?? '0', 10),
      // The listing is informational and already wrapped in its own catch: a
      // row showing the default beats a page that fails to render. The gate is
      // where an unreadable limit has to be refused, not here.
      monthlyLimit: configs.get(userIds[i])?.tokenLimit ?? DEFAULT_MONTHLY_TOKEN_LIMIT,
      // Filled in by the route, which already lists the groups for its own
      // scope check — see `groupByUsername`.
      group: null,
      // Informational, like the two limits above: a row showing the permissive
      // default beats a page that fails to render.
      allowedModels: configs.get(userIds[i])?.allowedModels ?? [...MODEL_IDS],
      // Absent means none. The scan reads every project row there is, so an
      // account missing from the map has no projects — unlike the token
      // columns, there is no "recorded before the counter existed" case.
      projectCount: projectCounts.get(userIds[i]) ?? 0,
      lastUpdated: item.lastUpdated?.S ?? '',
    }));

    users.sort((a, b) => b.totalTokens - a.totalTokens);
    return users;
  } catch (error) {
    logger.error('Failed to get all users usage', { error: String(error) });
    return [];
  }
}
