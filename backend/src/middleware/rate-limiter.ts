import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { logger } from '../utils/logger.js';
import { pricingTable } from '../config/pricing.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  remainingPoints?: number;
  /**
   * Whether the bucket was actually read.
   *
   * `false` means the answer is a refusal made without evidence, and the caller
   * must say 503 rather than 429 — "too fast" is a claim about the user that
   * nothing established.
   *
   * Absent means true. Every path that reads the bucket omits it, which keeps
   * this to one addition rather than seven.
   */
  known?: boolean;
}

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

/**
 * What a request of each tier spends out of the daily budget.
 *
 * The ratios are the models' own, derived from `MODEL_PRICING` rather than
 * written here. They were written here — 1, 2 and 5 — and the price table says
 * 1, 3 and 5: Sonnet was charged two thirds of what it costs, so a day of
 * Sonnet spent a third less budget than a day of the tier it is priced beside.
 * A hand-copied ratio beside a configured one drifts the moment either moves,
 * and the drift is invisible because both numbers stay plausible.
 *
 * Input price, normalised to the cheapest tier and rounded up. Input rather
 * than a blend of input and output because this budget rations REQUESTS, and
 * what a request will emit is not known when the gate runs — the ladder is
 * expressing "an Opus run is worth five Haiku runs", which is what the input
 * column already says.
 *
 * The fallback below is the same ladder with Sonnet corrected, for a deployment
 * with no table configured.
 */
const FALLBACK_COSTS: Record<string, number> = { haiku: 1, sonnet: 3, opus: 5 };

function modelCosts(): Record<string, number> {
  const table = pricingTable();
  const tiers = ['haiku', 'sonnet', 'opus'];
  let costs = { ...FALLBACK_COSTS };
  if (table) {
    const inputs = tiers.map((t) => table.models[t]?.input);
    if (inputs.every((v) => typeof v === 'number' && v > 0)) {
      const cheapest = Math.min(...(inputs as number[]));
      costs = Object.fromEntries(
        tiers.map((t, i) => [t, Math.max(1, Math.ceil((inputs[i] as number) / cheapest))])
      );
    }
  }
  /*
   * The gate runs before the tier is known — the router only decides once the
   * job starts — so `auto` is charged as sonnet, the tier it lands on for the
   * overwhelming majority of briefs. Set explicitly rather than left to the
   * `?? costs.sonnet` fallback, which would have made the default model's cost
   * an accident of the lookup miss.
   */
  return { ...costs, auto: costs.sonnet };
}

const BUCKET_CAPACITY = 10;
const REFILL_RATE = 10;
const REFILL_INTERVAL_MS = 60 * 1000;
const DAILY_BUDGET = 200;

function getCurrentWindowKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

function getTTL(): number {
  return Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
}

export async function checkRateLimit(userId: string, model: string = 'sonnet', _retryCount: number = 0): Promise<RateLimitResult> {
  const costs = modelCosts();
  const cost = costs[model] ?? costs.sonnet;
  const dayKey = getCurrentWindowKey();
  const now = Date.now();

  try {
    const pk = `RATE#${userId}`;
    const sk = `DAY#${dayKey}`;

    const getResult = await client.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: pk },
        sk: { S: sk },
      },
    }));

    const item = getResult.Item;
    let dailySpent = item?.dailySpent?.N ? parseInt(item.dailySpent.N, 10) : 0;
    let points = item?.points?.N ? parseFloat(item.points.N) : BUCKET_CAPACITY;
    const lastRefill = item?.lastRefill?.N ? parseInt(item.lastRefill.N, 10) : now;

    const elapsed = now - lastRefill;
    const refillAmount = (elapsed / REFILL_INTERVAL_MS) * REFILL_RATE;
    points = Math.min(BUCKET_CAPACITY, points + refillAmount);

    if (dailySpent + cost > DAILY_BUDGET) {
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      const retryAfter = Math.ceil((midnight.getTime() - now) / 1000);
      logger.warn('Rate limit exceeded (daily budget)', { userId, model, dailySpent });
      return { allowed: false, retryAfter, remainingPoints: 0 };
    }

    if (points < cost) {
      const deficit = cost - points;
      const retryAfter = Math.ceil((deficit / REFILL_RATE) * (REFILL_INTERVAL_MS / 1000));
      logger.warn('Rate limit exceeded (burst)', { userId, model, points, cost });
      return { allowed: false, retryAfter, remainingPoints: Math.floor(points) };
    }

    const newPoints = points - cost;
    const newDailySpent = dailySpent + cost;

    try {
      await client.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
        UpdateExpression: 'SET points = :p, dailySpent = :d, lastRefill = :t, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(dailySpent) OR dailySpent = :prevD',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':p': { N: String(newPoints) },
          ':d': { N: String(newDailySpent) },
          ':t': { N: String(now) },
          ':ttl': { N: String(getTTL()) },
          ':prevD': { N: String(dailySpent) },
        },
      }));
    } catch (condErr: any) {
      if (condErr.name === 'ConditionalCheckFailedException') {
        if (_retryCount >= 3) {
          // Deliberately still allows: the bucket was read and was within
          // budget, so what failed is recording the spend, not checking it.
          // Under-counting a busy user beats refusing one who is under budget.
          logger.warn('Rate limiter max retries exceeded, allowing request', { userId });
          return { allowed: true, remainingPoints: Math.floor(points) };
        }
        // Concurrent update detected - retry by re-reading
        logger.warn('Rate limiter concurrent update, retrying', { userId, attempt: _retryCount + 1 });
        return checkRateLimit(userId, model, _retryCount + 1);
      }
      throw condErr;
    }

    return { allowed: true, remainingPoints: Math.floor(newPoints) };
  } catch (error) {
    /*
     * Refuse, rather than allow.
     *
     * This is the same table `checkUsageLimit` reads, so a failure here is a
     * failure there — and this used to mean BOTH spend guards disappeared at
     * once, for the duration, on the failure most likely to be a throttle. A
     * throttle arrives under load. Load is when the guards matter.
     *
     * Note the contrast with the ConditionalCheckFailed path above, which does
     * still allow: there the bucket WAS read and was within budget, and only
     * recording the spend lost a race. That under-counts; this would have
     * bypassed.
     */
    logger.error('Rate limiter DynamoDB error, refusing rather than allowing', { userId, error: String(error) });
    return { allowed: false, known: false, retryAfter: 30, remainingPoints: 0 };
  }
}
