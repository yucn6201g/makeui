/**
 * Who published what, which nothing recorded.
 *
 * `POST /publish` wrote a document to `published/<siteId>/index.html` and
 * returned the link. The only trace it left was a log line, so nothing could
 * say which account a live public page belonged to, and — the part that matters
 * — deleting an account could not take that page down with it. `published/` is
 * keyed by a random site id and nothing anywhere connected it to an owner, so a
 * deleted user's pages stayed up, publicly, for the thirty days the bucket's
 * lifecycle rule gives them.
 *
 * One row per publish, under the account that made it, so the link has an owner
 * for exactly as long as the link exists.
 */
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { logger } from '../utils/logger.js';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

/**
 * How long the row lives, against the thirty days the object gets.
 *
 * One day more, so the record never outlives what it records by much and never
 * expires while the page is still up. A row that survived its object would
 * describe a link that 404s; a row that died first would leave a live public
 * page with no owner, which is the whole defect this exists to close.
 */
const RECORD_TTL_DAYS = 31;

export async function recordPublish(userId: string, siteId: string, bytes: number): Promise<void> {
  const createdAt = new Date().toISOString();
  try {
    await client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: { S: `USER#${userId}` },
        // Time-ordered like every other sort key here, so the newest are the
        // tail of the partition and a listing needs no sort.
        sk: { S: `PUBLISH#${createdAt}#${siteId}` },
        siteId: { S: siteId },
        bytes: { N: String(bytes) },
        createdAt: { S: createdAt },
        ttl: { N: String(Math.floor(Date.now() / 1000) + RECORD_TTL_DAYS * 86400) },
      },
    }));
  } catch (error) {
    /*
     * Logged, not thrown. The document is already public by the time this runs,
     * and failing the request would tell the user their page did not publish
     * when it did — leaving them a live link they believe does not exist, which
     * is worse than the missing row.
     */
    logger.error('Published without a record of who published it', { userId, siteId, error: String(error) });
  }
}

/** The site ids this account has published, newest last. */
export async function publishedSitesOf(userId: string): Promise<string[]> {
  const out: string[] = [];
  let lastKey: Record<string, any> | undefined;
  try {
    do {
      const res = await client.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ProjectionExpression: 'siteId',
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userId}` },
          ':prefix': { S: 'PUBLISH#' },
        },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));
      for (const item of res.Items ?? []) if (item.siteId?.S) out.push(item.siteId.S);
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
  } catch (error) {
    logger.error('Could not list an account\'s published sites', { userId, error: String(error) });
  }
  return out;
}
