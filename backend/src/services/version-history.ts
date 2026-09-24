import { DynamoDBClient, PutItemCommand, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { putDocument, readDocument, deleteDocument, versionDocumentKey } from './output-storage.js';
import { logger } from '../utils/logger.js';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';

export interface VersionEntry {
  versionId: string;
  userId: string;
  projectId?: string;
  prompt: string;
  html: string;
  score: number;
  /**
   * Whether `score` includes what a browser measured.
   *
   * A generate scores the document after opening it; an edit scores it without,
   * because nothing renders on that path. The two are not on one scale — every
   * runtime deduction, up to 173 points of it, is unreachable without browser
   * facts — and the version list holds both, one row under the other.
   *
   * Nothing displays these today. The field is stored because the alternative is
   * that whatever displays them first shows the comparison and has no way to
   * know it is wrong; the chat chip already carries the same flag for the same
   * reason, after presenting an unverified score under 「ブラウザ実行の計測を含む
   * スコアです」.
   *
   * Optional: rows written before this exist and did not record it.
   */
  scoreVerified?: boolean;
  /**
   * Which scale `score` is on — see `SCORE_RUBRIC` in scoring.ts. Absent on rows
   * written before it was recorded, which are all on an older scale.
   */
  scoreRubric?: number;
  /**
   * The request's checkable requirements and how many the version meets, and the
   * findings it shipped with. Absent when not recorded — older rows, or a run
   * with no checkable requirement — which is not the same as zero.
   */
  requirementsMet?: number;
  requirementsChecked?: number;
  openFindings?: number;
  preset: string;
  model: string;
  /**
   * What this one generation or edit cost, in and out.
   *
   * Recorded per version rather than only per project. The project total already
   * existed and answers a different question: it is the sum over every run,
   * including the ones whose document was rejected and the ones that produced
   * the version before this. Reading a single row's cost off it is impossible.
   *
   * Optional because every row written before this has none, and those must read
   * as "not recorded" rather than as zero — a generation that cost nothing is
   * not a thing, and a column of honest zeros would be a column of lies.
   */
  tokens?: { input: number; output: number };
  /**
   * Who ran it, on a shared project. The row lives in the owner's partition
   * whoever acted, so `userId` names the partition and these name the person.
   * Absent on rows from before sharing, which were all the owner's own.
   */
  actorId?: string;
  actorName?: string;
  createdAt: string;
  thumbnail?: string;
}

/**
 * Strip machine-facing scaffolding from a stored prompt so history shows only what
 * the user typed.
 *
 * New writes already store the raw user prompt, but records created before that fix
 * embedded the internal instruction — the element-targeting wrapper the modify
 * endpoint adds, and the SPA scaffolding the old chat composer prepended. Cleaning
 * on read keeps existing history readable without rewriting stored data.
 */
function stripInternalPrompt(prompt: string): string {
  let out = prompt;

  // "Target element: <css selector>. <user instruction>" — added by /modify when an
  // element is selected. A CSS selector never contains ". ", so the first one is the
  // separator.
  out = out.replace(/^Target element:\s*[^\s].*?\.\s+/s, '');

  // Retired SPA composer prefixes: everything up to and including the hand-off marker.
  for (const marker of ['以上の構造で次の内容を実装: ', '以下の変更を適用してください: ', '変更内容: ']) {
    const i = out.indexOf(marker);
    if (i !== -1 && /SPA/i.test(out.slice(0, i))) {
      out = out.slice(i + marker.length);
    }
  }

  const trimmed = out.trim();
  // Never return empty — an unrecognised shape is better shown verbatim than blank.
  return trimmed || prompt;
}

/**
 * The document goes to S3; the item keeps a key.
 *
 * It used to be written inline, with no size check at all, into an item DynamoDB
 * caps at 400KB. Output was 50-100KB of markup so it held — until a document could
 * carry an embedded image, at which point the size of a picture decided whether the
 * run was recorded. The failure was silent from the user's side: `saveVersion`
 * throws, the caller logs a warning, and the run is simply missing from history.
 */
export async function saveVersion(entry: Omit<VersionEntry, 'versionId' | 'createdAt'>): Promise<VersionEntry> {
  const versionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const version: VersionEntry = { ...entry, versionId, createdAt };

  const htmlS3Key = versionDocumentKey(entry.userId, versionId);
  await putDocument(htmlS3Key, entry.html);

  const command = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `USER#${entry.userId}` },
      sk: { S: `VERSION#${createdAt}#${versionId}` },
      versionId: { S: versionId },
      prompt: { S: entry.prompt },
      htmlS3Key: { S: htmlS3Key },
      score: { N: String(entry.score) },
      // Written only when known, so a row from before this stays absent rather
      // than claiming false. Absent and false are different answers here: one is
      // 「not recorded」 and the other is 「nothing rendered」.
      ...(entry.scoreVerified === undefined ? {} : { scoreVerified: { BOOL: entry.scoreVerified } }),
      ...(entry.scoreRubric === undefined ? {} : { scoreRubric: { N: String(entry.scoreRubric) } }),
      ...(entry.requirementsChecked === undefined ? {} : {
        requirementsMet: { N: String(entry.requirementsMet ?? 0) },
        requirementsChecked: { N: String(entry.requirementsChecked) },
      }),
      ...(entry.openFindings === undefined ? {} : { openFindings: { N: String(entry.openFindings) } }),
      preset: { S: entry.preset },
      model: { S: entry.model },
      ...(entry.actorId ? { actorId: { S: entry.actorId } } : {}),
      ...(entry.actorName ? { actorName: { S: entry.actorName } } : {}),
      createdAt: { S: createdAt },
      // Same rule as scoreVerified: written only when known, so an older row
      // reads as "not recorded" rather than as a run that cost nothing.
      ...(entry.tokens
        ? {
            inputTokens: { N: String(entry.tokens.input) },
            outputTokens: { N: String(entry.tokens.output) },
          }
        : {}),
      ...(entry.projectId ? { projectId: { S: entry.projectId } } : {}),
    },
  });

  /*
   * The object goes down first, so the row never points at nothing. What that
   * leaves is the other direction: an object with no row, which nothing will
   * ever read and nothing was deleting.
   *
   * On 2026-09-02 a throughput burst threw on this write twenty-seven times in
   * one minute for a single account, and twenty-seven documents — 3MB — stayed
   * in the bucket unreferenced. Version history has no lifecycle rule, correctly,
   * because it is history; that makes an unreferenced object permanent.
   *
   * The delete is best-effort and its failure is not raised: the caller's problem
   * is that the version did not save, and replacing that with a tidying error
   * would hide it.
   */
  try {
    await client.send(command);
  } catch (error) {
    await deleteDocument(htmlS3Key).catch(() => {});
    throw error;
  }
  logger.info('Version saved', { userId: entry.userId, versionId, projectId: entry.projectId, htmlChars: entry.html.length });

  /*
   * And the oldest go once a project has more history than anybody reads.
   *
   * Nothing bounded this. Every generation and every edit writes a version, a
   * version is a DynamoDB row and a document in a bucket with no lifecycle rule
   * — correctly, because it is history — and one account already holds 284 of
   * them across ten projects. Unbounded growth in the one store that never
   * expires is a bill that only goes one way.
   *
   * Best-effort and after the save, never before and never in its way: the
   * caller's problem is whether this run was recorded, and failing that for a
   * tidying error would be the trade backwards.
   */
  if (entry.projectId) {
    pruneProjectVersions(entry.userId, entry.projectId).catch((error) => {
      logger.warn('Version pruning failed', { userId: entry.userId, projectId: entry.projectId, error: String(error) });
    });
  }
  return version;
}

/**
 * How much history one project keeps.
 *
 * Chosen so that it prunes nothing today: the busiest project in the store has
 * 28 versions and the busiest account 284 across ten. It is a ceiling on where
 * this goes, not a decision about what to throw away — a project would have to
 * be rebuilt a hundred times before the first row is dropped, and at that point
 * the hundredth-oldest is not history anybody is going to open.
 */
const MAX_VERSIONS_PER_PROJECT = 100;

/**
 * The oldest versions of one project, beyond what it keeps.
 *
 * `sk` is `VERSION#<createdAt>#<id>`, so the partition is already in
 * chronological order and the ones to drop are simply the front of it. Read
 * down to the key and the object key, because that is all a deletion needs and
 * a version row carries the metadata of a whole run.
 *
 * The row goes before the object, as everywhere else here: a row pointing at a
 * missing document renders as a blank entry in somebody's history, while an
 * object with no row is invisible and permanent.
 */
async function pruneProjectVersions(userId: string, projectId: string): Promise<void> {
  const doomed: Record<string, any>[] = [];
  let kept = 0;
  let lastKey: Record<string, any> | undefined;

  do {
    const response = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'projectId = :pid',
      ProjectionExpression: 'sk, htmlS3Key',
      // Newest first, so everything after the first hundred is what goes. The
      // other direction would need the whole partition read before the count is
      // known.
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'VERSION#' },
        ':pid': { S: projectId },
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));

    for (const item of response.Items ?? []) {
      if (kept < MAX_VERSIONS_PER_PROJECT) kept += 1;
      else doomed.push(item);
    }
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  if (doomed.length === 0) return;

  for (const item of doomed) {
    await client.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { pk: { S: `USER#${userId}` }, sk: item.sk },
    }));
    if (item.htmlS3Key?.S) await deleteDocument(item.htmlS3Key.S).catch(() => {});
  }
  logger.info('Old versions pruned', { userId, projectId, pruned: doomed.length, kept });
}

/**
 * The document for a stored version, from wherever that version put it.
 *
 * Rows written before this change hold the markup inline, and they stay valid —
 * dropping the inline read would blank every existing entry in the user's history.
 */
async function hydrateHtml(item: Record<string, any>): Promise<string> {
  if (item.htmlS3Key?.S) return (await readDocument(item.htmlS3Key.S)) ?? '';
  return item.html?.S ?? '';
}

export async function getVersionHistory(userId: string, limit: number = 20, projectId?: string): Promise<VersionEntry[]> {
  const expressionValues: Record<string, any> = {
    ':pk': { S: `USER#${userId}` },
    ':prefix': { S: 'VERSION#' },
  };

  if (projectId) {
    expressionValues[':projectId'] = { S: projectId };
  }

  /**
   * The list is metadata. It does not carry the documents.
   *
   * Both callers — the history panel and the diff view — fetch the document they
   * want through `GET /versions/:id`, so hydrating every row here fetched up to 20
   * documents from S3 that nobody read. Worse, the projectId branch below scans in
   * pages of 100, so a `getLatestProjectHtml` asking for ONE version could pull a
   * hundred documents to answer it. `html` stays on the type because the shape is
   * shared with `getVersion`, which does carry it.
   */
  /*
   * Named rather than taken whole, for the same reason the mapper drops `html`.
   *
   * This does NOT reduce what DynamoDB charges — a Query is billed on the size
   * of the items it processes, before any projection — so it is not the fix for
   * the old rows that hold their document inline; `scripts/backfill-version-s3.mjs`
   * is. What it does is stop those documents crossing the wire into a Lambda that
   * parses them and throws them away, which for one account was 945KB per opening
   * of the history panel.
   */
  const PROJECTION = [
    'versionId', 'projectId', 'prompt', 'score', 'scoreVerified', 'scoreRubric', 'requirementsMet', 'requirementsChecked', 'openFindings',
    'preset', 'model', 'inputTokens', 'outputTokens', 'createdAt', 'actorId', 'actorName',
  ].join(', ');

  const mapItem = (item: Record<string, any>): VersionEntry => ({
    versionId: item.versionId?.S ?? '',
    userId,
    projectId: item.projectId?.S,
    prompt: stripInternalPrompt(item.prompt?.S ?? ''),
    html: '',
    score: parseInt(item.score?.N ?? '0', 10),
    ...(item.scoreVerified === undefined ? {} : { scoreVerified: item.scoreVerified.BOOL }),
    ...(item.scoreRubric?.N === undefined ? {} : { scoreRubric: Number(item.scoreRubric.N) }),
    ...(item.requirementsChecked?.N === undefined ? {} : {
      requirementsMet: Number(item.requirementsMet?.N ?? 0),
      requirementsChecked: Number(item.requirementsChecked.N),
    }),
    ...(item.openFindings?.N === undefined ? {} : { openFindings: Number(item.openFindings.N) }),
    preset: item.preset?.S ?? '',
    model: item.model?.S ?? '',
    ...(item.inputTokens || item.outputTokens
      ? {
          tokens: {
            input: parseInt(item.inputTokens?.N ?? '0', 10),
            output: parseInt(item.outputTokens?.N ?? '0', 10),
          },
        }
      : {}),
    actorId: item.actorId?.S || undefined,
    actorName: item.actorName?.S || undefined,
    createdAt: item.createdAt?.S ?? '',
  });

  if (!projectId) {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ProjectionExpression: PROJECTION,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: false,
      Limit: limit,
    });
    const response = await client.send(command);
    return (response.Items ?? []).map(mapItem);
  }

  /*
   * With a projectId, the filter runs AFTER the read, so this pages until it has
   * enough — bounded, the way `getVersion` below is bounded and this was not.
   *
   * The bound matters because of what the unbounded version does on the case it
   * is most often asked about: a project with FEWER than `limit` versions never
   * satisfies the early exit, so it reads the user's entire VERSION# partition,
   * a hundred rows at a time, on one partition key. DynamoDB bills a Query on
   * the items it processed before the filter, and the older rows still carry
   * their document inline — so the cheapest question in the product ("show me
   * this project's three versions") was the most expensive one to answer.
   *
   * Ten pages is a thousand versions scanned, against 345 in the whole table
   * today. A project whose versions are all older than that is one where the
   * history panel shows the newest it found; it is not a correctness question,
   * because the panel is a list of recent versions and the rows are read newest
   * first.
   */
  const MAX_PAGES = 10;
  const results: VersionEntry[] = [];
  let lastKey: Record<string, any> | undefined;
  let pagesScanned = 0;

  do {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'projectId = :projectId',
      ProjectionExpression: PROJECTION,
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward: false,
      Limit: 100,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    });

    const response = await client.send(command);
    results.push(...(response.Items ?? []).map(mapItem));
    lastKey = response.LastEvaluatedKey;
    pagesScanned++;

    if (results.length >= limit) break;
  } while (lastKey && pagesScanned < MAX_PAGES);

  if (lastKey && pagesScanned >= MAX_PAGES) {
    logger.info('Version history stopped at the page cap', {
      projectId, found: results.length, pagesScanned,
    });
  }

  return results.slice(0, limit);
}

export async function getVersion(userId: string, versionId: string): Promise<VersionEntry | null> {
  // Validate versionId format to prevent injection
  if (!/^[0-9a-f\-]{36}$/.test(versionId)) {
    return null;
  }

  // Use FilterExpression to find the specific version.
  // Note: DynamoDB Limit applies before FilterExpression, so we paginate
  // to ensure we find the item even if it's not in the first page of results.
  let lastEvaluatedKey: Record<string, any> | undefined;
  let item: Record<string, any> | undefined;
  let pagesScanned = 0;
  const MAX_PAGES = 10;

  do {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'versionId = :vid',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'VERSION#' },
        ':vid': { S: versionId },
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });

    const response = await client.send(command);
    item = (response.Items ?? [])[0];
    if (item) break;
    lastEvaluatedKey = response.LastEvaluatedKey;
    pagesScanned++;
  } while (lastEvaluatedKey && pagesScanned < MAX_PAGES);

  if (!item) return null;

  return {
    versionId: item.versionId?.S ?? '',
    userId,
    prompt: stripInternalPrompt(item.prompt?.S ?? ''),
    html: await hydrateHtml(item),
    score: parseInt(item.score?.N ?? '0', 10),
    ...(item.scoreVerified === undefined ? {} : { scoreVerified: item.scoreVerified.BOOL }),
    ...(item.scoreRubric?.N === undefined ? {} : { scoreRubric: Number(item.scoreRubric.N) }),
    ...(item.requirementsChecked?.N === undefined ? {} : {
      requirementsMet: Number(item.requirementsMet?.N ?? 0),
      requirementsChecked: Number(item.requirementsChecked.N),
    }),
    ...(item.openFindings?.N === undefined ? {} : { openFindings: Number(item.openFindings.N) }),
    preset: item.preset?.S ?? '',
    model: item.model?.S ?? '',
    ...(item.inputTokens || item.outputTokens
      ? {
          tokens: {
            input: parseInt(item.inputTokens?.N ?? '0', 10),
            output: parseInt(item.outputTokens?.N ?? '0', 10),
          },
        }
      : {}),
    actorId: item.actorId?.S || undefined,
    actorName: item.actorName?.S || undefined,
    createdAt: item.createdAt?.S ?? '',
  };
}

/**
 * Every version of one project, and the documents they point at.
 *
 * Called when the project is deleted. This used to be deliberately skipped —
 * "version history is per-user history, not project-owned" — which is true of
 * the rows that carry no `projectId` at all, from before projects existed, and
 * not true of the rest: a run recorded against a project belongs to it, and
 * leaving it behind means a user who deleted a project still finds its screens
 * in their history.
 *
 * The document goes after the row, not before. A row pointing at a deleted
 * object opens blank, which is the failure that cannot be explained; an object
 * outliving its row by a moment costs nothing and is swept by
 * `scripts/storage-audit.mjs`.
 *
 * Deletes one at a time rather than in batches of 25. A project has tens of
 * versions, not thousands, and `BatchWriteItem` reports partial failure by
 * handing back unprocessed keys that then have to be retried with backoff —
 * more machinery than the volume justifies, and the kind that is written once
 * and never exercised.
 */
export async function deleteProjectVersions(userId: string, projectId: string): Promise<number> {
  let lastKey: Record<string, any> | undefined;
  let deleted = 0;

  do {
    const response = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'projectId = :pid',
      // The key to delete by and the object to delete after — nothing else is
      // read, so a page costs what its metadata costs.
      ProjectionExpression: 'sk, htmlS3Key',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'VERSION#' },
        ':pid': { S: projectId },
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));

    for (const item of response.Items ?? []) {
      await client.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: `USER#${userId}` }, sk: item.sk },
      }));
      if (item.htmlS3Key?.S) await deleteDocument(item.htmlS3Key.S).catch(() => {});
      deleted += 1;
    }
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  logger.info('Project versions deleted', { userId, projectId, deleted });
  return deleted;
}
