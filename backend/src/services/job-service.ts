import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { currentUsage } from './token-ledger.js';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface JobRecord {
  jobId: string;
  userId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  ttl: number;
  events?: Array<{ agent: string; status: 'started' | 'completed'; t: string }>;
  /** Trailing slice of the model output produced so far, for live display. */
  streamTail?: string;
  /** Total characters generated, so the client can show real progress. */
  streamChars?: number;
  /**
   * Tokens this RUN has spent when the poll was written — cumulative, not
   * per-step. The transcript differences it across a step's boundaries, which is
   * what lets a step's own cost be shown without the pipeline having to attribute
   * every model call to a label.
   */
  streamTokens?: number;
  /** Label for whatever step is currently producing output. */
  streamPhase?: string;
}

/**
 * How long a job record outlives its last sign of life.
 *
 * Stamped by every writer, not only by `createJob`, and refreshed on each write.
 * Two reasons, and the second is the one that had gone wrong:
 *
 *   - a run that is still producing output should not have its record expire
 *     underneath it, and only the writes know it is still alive;
 *   - `UpdateItem` CREATES the item when it is absent. Every updater here is an
 *     `UpdateItem`, so a job whose `createJob` did not land — or one driven
 *     directly, as the verification harness does — was written into existence
 *     with no `ttl` at all, and nothing would ever delete it. Forty-five such
 *     rows had accumulated, the oldest from 2026-08-07.
 */
const JOB_TTL_SECONDS = 3600;
const jobTtl = (): string => String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS);

export async function createJob(jobId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `JOB#${jobId}` },
      sk: { S: 'META' },
      userId: { S: userId },
      status: { S: 'pending' },
      createdAt: { S: now },
      updatedAt: { S: now },
      ttl: { N: jobTtl() },
    },
  }));
}

export async function appendJobEvent(jobId: string, agent: string, status: 'started' | 'completed'): Promise<void> {
  const now = new Date().toISOString();
  const event = JSON.stringify({ agent, status, t: now });
  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } },
    UpdateExpression: 'SET events = list_append(if_not_exists(events, :empty), :evt), updatedAt = :now, #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':evt': { L: [{ S: event }] },
      ':empty': { L: [] },
      ':now': { S: now },
      ':ttl': { N: jobTtl() },
    },
  }));
}

/**
 * Store a tail of the model's in-flight output so the client can show the response
 * as it is written rather than only a progress bar.
 *
 * Only a tail is kept: the full document can be hundreds of KB and DynamoDB items
 * cap at 400KB, while the UI only ever shows the trailing lines of the stream.
 */
export const STREAM_TAIL_CHARS = 6000;

export async function updateJobStream(
  jobId: string,
  text: string,
  charsWritten: number,
  /** Human-readable name of the step producing this text, shown as the label. */
  phase?: string
): Promise<void> {
  /**
   * Read here rather than passed in, so every existing call site stamps the
   * running total without being touched. Outside a ledger scope this is null and
   * the field is simply omitted — a step that spent nothing measurable shows no
   * figure rather than a zero it did not earn.
   */
  const usage = currentUsage();
  const spent = usage ? usage.inputTokens + usage.outputTokens : null;

  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } },
    UpdateExpression:
      'SET streamTail = :s, streamChars = :n, streamPhase = :p, updatedAt = :now, #ttl = :ttl' +
      (spent === null ? '' : ', streamTokens = :t'),
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':s': { S: text.slice(-STREAM_TAIL_CHARS) },
      ':n': { N: String(charsWritten) },
      ':p': { S: phase ?? '' },
      ':now': { S: new Date().toISOString() },
      ':ttl': { N: jobTtl() },
      ...(spent === null ? {} : { ':t': { N: String(spent) } }),
    },
  }));
}

/**
 * The running token total alone, for steps that write no text.
 *
 * `updateJobStream` stamps the total on every text write, which covers the steps
 * that stream. This covers the rest: it is attached to the ledger for the length
 * of a job and writes at most once per `TOKEN_WRITE_MS`, with a trailing write so
 * the last call of a step is never the one left out. Only `streamTokens` and
 * `updatedAt` move — the tail and the label belong to the step's own writes.
 */
const TOKEN_WRITE_MS = 2000

export function tokenHeartbeat(jobId: string, total: () => number): { notify: () => void; flush: () => Promise<void> } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let written = -1
  let inFlight: Promise<void> = Promise.resolve()
  const write = (): Promise<void> => {
    timer = null
    last = Date.now()
    inFlight = inFlight
      .then(async () => {
        // Read when sent, not when queued: a write that waited behind another
        // must not land an older total over a newer one.
        const spent = total()
        if (spent === written) return
        written = spent
        await client.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } },
          // The ttl too: an UpdateItem creates the row when it is absent, and a
          // row without one never expires.
          UpdateExpression: 'SET streamTokens = :t, updatedAt = :now, #ttl = :ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':t': { N: String(spent) }, ':now': { S: new Date().toISOString() }, ':ttl': { N: jobTtl() } },
        }))
      })
      .catch(() => undefined)
    return inFlight
  }
  return {
    notify: () => {
      if (timer) return
      const wait = Math.max(0, TOKEN_WRITE_MS - (Date.now() - last))
      timer = setTimeout(() => { void write() }, wait)
    },
    /** Written before the job's final status, so the last step closes on the true total. */
    flush: () => {
      if (timer) clearTimeout(timer)
      return write()
    },
  }
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  result?: unknown,
  error?: string
): Promise<void> {
  const now = new Date().toISOString();
  let updateExpr = 'SET #s = :status, updatedAt = :now, #ttl = :ttl';
  const attrNames: Record<string, string> = { '#s': 'status', '#ttl': 'ttl' };
  const attrValues: Record<string, AttributeValue> = {
    ':status': { S: status },
    ':now': { S: now },
    ':ttl': { N: jobTtl() },
  };
  if (result !== undefined) {
    updateExpr += ', resultJson = :result';
    attrValues[':result'] = { S: JSON.stringify(result) };
  }
  if (error !== undefined) {
    updateExpr += ', errorMsg = :error';
    attrValues[':error'] = { S: error };
  }
  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: attrValues,
  }));
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const response = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `JOB#${jobId}` }, sk: { S: 'META' } },
  }));
  if (!response.Item) return null;
  const item = response.Item;
  return {
    jobId,
    userId: item.userId?.S ?? '',
    status: (item.status?.S ?? 'pending') as JobStatus,
    createdAt: item.createdAt?.S ?? '',
    updatedAt: item.updatedAt?.S ?? '',
    result: item.resultJson?.S ? JSON.parse(item.resultJson.S) : undefined,
    error: item.errorMsg?.S,
    ttl: parseInt(item.ttl?.N ?? '0', 10),
    events: item.events?.L?.map((e) => {
      try { return JSON.parse(e.S ?? '{}'); } catch { return null; }
    }).filter(Boolean) ?? [],
    streamTail: item.streamTail?.S,
    streamChars: item.streamChars?.N ? parseInt(item.streamChars.N, 10) : undefined,
    streamTokens: item.streamTokens?.N ? parseInt(item.streamTokens.N, 10) : undefined,
    streamPhase: item.streamPhase?.S,
  };
}
