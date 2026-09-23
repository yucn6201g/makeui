import { DynamoDBClient, PutItemCommand, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { logger } from '../utils/logger.js';
import type { ScoreParts } from '../orchestration/scoring.js';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

const MAX_MESSAGES = 200;

/**
 * Ceiling for the serialised thread, in BYTES.
 *
 * This was compared against `json.length` — a character count — against a limit
 * DynamoDB enforces in bytes, on the one payload in the system that is almost
 * entirely Japanese. Assistant reasoning is prose, and prose here is three bytes
 * per character, so a thread measuring 350,000 "characters" is roughly a
 * megabyte: comfortably past the 400KB item ceiling while passing the test.
 *
 * The truncation loop then never fired, `PutItem` threw, and the whole thread
 * failed to save — so a conversation silently stopped being recorded once it grew
 * past a certain length, which is the worst possible moment to lose it.
 */
const MAX_PAYLOAD_BYTES = 300_000;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  score?: number;
  toolsUsed?: string[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /**
   * No `unrepairedDefects` here, and it was removed rather than never added.
   *
   * It counted what the repair budget declined to spend a call on, and the chat
   * rendered it beside the score as 「未修正 N件」 — a centimetre from the reply's
   * own 「未解決の指摘 N件」, which counts what was still open when the run ended.
   * They answer different questions and disagreed on screen, which is how the
   * user met them. The list is the one a person can act on, so it is the one
   * that stays. The budget figure is still in the job metadata and in the log,
   * where the measurement it was taken for lives.
   */
  /**
   * Which model and design system produced the reply, for the thread to show.
   *
   * `effort` and `scoreVerified` belong here for the same reason the tier does:
   * the thread has to be able to say tomorrow what built each screen, and
   * `scoreVerified` decides whether its score is shown as comparable.
   */
  runInfo?: { modelTier: string; preset: string; effort?: string; scoreVerified?: boolean; scoreParts?: ScoreParts };
  /** A plan awaiting approval, with the specification an approval would build. */
  proposal?: { plan: string; spec: string; prompt: string };
  /**
   * The run that produced the reply, step by step. Trimmed by the client before
   * it gets here; dropped entirely rather than costing the thread its history.
   */
  phases?: unknown[];
  timestamp: number;
}

export async function saveChatMessages(userId: string, projectId: string, messages: StoredMessage[]): Promise<void> {
  let batch = messages.slice(-MAX_MESSAGES);
  let json = JSON.stringify(batch);

  /*
   * The transcripts go before the conversation does.
   *
   * Below, an oversized item is answered by halving the message list — which
   * is the right last resort but a poor first one now that replies carry a
   * per-step transcript. A transcript is a record of how a reply was produced;
   * the reply and the request are the thing itself, and only one of the two can
   * be reconstructed by looking at the project. So the working is dropped from
   * the oldest replies first, and the conversation is only cut if that was not
   * enough.
   */
  for (let i = 0; byteLength(json) > MAX_PAYLOAD_BYTES && i < batch.length; i++) {
    if (!batch[i].phases) continue;
    batch = batch.map((m, j) => (j === i ? { ...m, phases: undefined } : m));
    json = JSON.stringify(batch);
  }

  while (byteLength(json) > MAX_PAYLOAD_BYTES && batch.length > 1) {
    batch = batch.slice(Math.ceil(batch.length / 2));
    json = JSON.stringify(batch);
  }
  if (byteLength(json) > MAX_PAYLOAD_BYTES) {
    // One message on its own is over the limit. Saving nothing would drop the
    // whole thread, so keep the message and lose the tail of its content.
    logger.warn('Single chat message exceeds the item limit; truncating its content', {
      userId,
      projectId,
      bytes: byteLength(json),
    });
    batch = batch.map((m) => ({ ...m, content: m.content.slice(0, 2000) }));
    json = JSON.stringify(batch);
    if (byteLength(json) > MAX_PAYLOAD_BYTES) {
      logger.warn('Chat messages too large to save even after truncation', { userId, projectId });
      return;
    }
  }

  const command = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `USER#${userId}` },
      sk: { S: `CHAT#${projectId}` },
      messages: { S: json },
      updatedAt: { S: new Date().toISOString() },
    },
  });

  await client.send(command);
  logger.info('Chat messages saved', { userId, projectId, count: batch.length });
}

export async function getChatMessages(userId: string, projectId: string): Promise<StoredMessage[]> {
  const command = new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: { S: `USER#${userId}` },
      sk: { S: `CHAT#${projectId}` },
    },
  });

  const response = await client.send(command);
  if (!response.Item?.messages?.S) return [];

  try {
    return JSON.parse(response.Item.messages.S);
  } catch {
    return [];
  }
}

/**
 * Remove a project's conversation, when the project itself is removed.
 *
 * The thread is keyed by project, so it outlives nothing useful: after the
 * project is gone there is no screen that can ask for it and no id left to ask
 * with. Seventy of the ninety-three stored threads were in that state before
 * `deleteProject` started calling this.
 */
export async function deleteChatMessages(userId: string, projectId: string): Promise<void> {
  await client.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: { S: `USER#${userId}` },
      sk: { S: `CHAT#${projectId}` },
    },
  }));
  logger.info('Chat messages deleted', { userId, projectId });
}
