import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { putDocument, readDocument, deleteDocument, projectDocumentKey } from './output-storage.js';
import { deleteChatMessages } from './chat-history.js';
import { deleteProjectVersions, getVersionHistory, getVersion } from './version-history.js';
import { deleteAllShares } from './project-shares.js';
import { logger } from '../utils/logger.js';
import { detectKind } from '../tools/project/framework-compile.js';
import { readProjectFiles } from '../tools/project/project-transport.js';

/**
 * A stored `outputKind` value, kept only if it is one this build understands.
 *
 * Written as a list rather than a chain of ternaries because the chain is what
 * silently dropped `vue` when it was added: it named the values it knew and
 * returned `undefined` for everything else. `svelte` was removed from the list
 * when the framework was (2026-09-18); a project stored under it is filtered out
 * of the listing rather than shown with no framework at all.
 */
const OUTPUT_KINDS = ['html', 'react', 'vue'] as const;
function readOutputKind(value: string | undefined): ProjectRecord['outputKind'] {
  return (OUTPUT_KINDS as readonly string[]).includes(value ?? '')
    ? (value as ProjectRecord['outputKind'])
    : undefined;
}

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const TABLE_NAME = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';


export interface ProjectRecord {
  projectId: string;
  userId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The document — read from S3 by `getProject`, and absent from the list.
   *
   * `listProjects` deliberately does not populate it. See the note above
   * `updateProject`: a list of forty projects was forty documents nothing on
   * that screen renders. `hasDocument` is what the list answers instead.
   */
  lastHtml?: string;
  /** Whether a document exists to fetch. Set by the list; not stored. */
  hasDocument?: boolean;
  preset?: string;
  model?: string;
  /**
   * The framework the project's files are written in.
   *
   * `html` is only ever read, never written: nothing has been generated as a
   * single HTML document since the format was removed, but stored records still
   * carry it and the list has to be able to label them.
   */
  outputKind?: 'html' | 'react' | 'vue';
  /** Tokens this project has consumed across every run. */
  totalTokens?: number;
  /** Generations and edits run against this project. */
  requestCount?: number;
  /**
   * When the project was archived, or absent if it is not.
   *
   * A timestamp rather than a flag so the archive can be ordered by when things
   * were put in it, which is the order someone emptying it wants to see. Absent
   * is the only "not archived" — a stored `false` would be a second way to say
   * the same thing, and the list would have to handle both.
   */
  archivedAt?: string;
  /**
   * When the project was favourited, or absent if it is not.
   *
   * Same shape as `archivedAt` and for the same reason — absent is the only
   * "no", and the timestamp is worth keeping because favourites sort by when
   * they were marked when nothing else separates them.
   *
   * An archived project cannot be a favourite: the two say opposite things
   * about the same project, and letting both be true means every list that
   * reads one has to decide what the other means. Archiving clears it.
   */
  favouritedAt?: string;
  /**
   * While the project has any share grant, when the first was made — the owner's
   * list puts it on the 共有 tab. Maintained by services/project-shares.ts.
   */
  sharedAt?: string;
}

export async function createProject(userId: string, name: string): Promise<ProjectRecord> {
  const projectId = crypto.randomUUID();
  const now = new Date().toISOString();
  const record: ProjectRecord = { projectId, userId, name, createdAt: now, updatedAt: now };

  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: { S: `USER#${userId}` },
      sk: { S: `PROJECT#${now}#${projectId}` },
      projectId: { S: projectId },
      projectName: { S: name },
      createdAt: { S: now },
      updatedAt: { S: now },
    },
  }));

  logger.info('Project created', { userId, projectId, name });
  return record;
}

/**
 * Every project on the account, without their documents.
 *
 * `ProjectionExpression` names the attributes rather than taking the whole item,
 * so a row that still carries an inline `lastHtml` from before it was dropped
 * does not travel here to be discarded. That is the read cost this removes, and
 * it drops for existing rows immediately rather than on their next save.
 */
export async function listProjects(userId: string): Promise<ProjectRecord[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const response = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'PROJECT#' },
      },
      // `#name` and `#model` are reserved words in DynamoDB; the others are not,
      // but naming all of them keeps the two lists readable against each other.
      ProjectionExpression: [
        'projectId', '#name', 'createdAt', 'updatedAt', 'preset', '#model',
        'outputKind', 'totalTokens', 'requestCount', 'archivedAt', 'favouritedAt',
        'lastHtmlS3Key', 'sharedAt',
      ].join(', '),
      ExpressionAttributeNames: { '#name': 'projectName', '#model': 'model' },
      ScanIndexForward: false,
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    items.push(...(response.Items ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  /**
   * A project built in a framework this build cannot open is not listed.
   *
   * Svelte was removed on 2026-09-18 — its compiler, its repairs and its
   * option are gone — and six stored projects were built with it. Listing one
   * would offer a door that opens on a blank page: nothing can compile it, and
   * an edit would be applied by a pipeline that no longer knows the language.
   *
   * The rows are left alone. Hiding costs nothing and is reversible; deleting
   * somebody's work to tidy a list is not, and two of the six belong to another
   * account.
   */
  const RETIRED = new Set(['svelte']);

  return items
    .filter((item) => !RETIRED.has(item.outputKind?.S ?? ''))
    .map(item => ({
    projectId: item.projectId?.S ?? '',
    userId,
    name: item.projectName?.S ?? 'Untitled',
    createdAt: item.createdAt?.S ?? '',
    updatedAt: item.updatedAt?.S ?? '',
    /*
     * Whether there is one, not what it is.
     *
     * `lastHtmlS3Key` is the single answer because every write that carries a
     * document sets it, and `scripts/backfill-project-s3.mjs` gave one to the
     * eleven rows that predated it. Two projects have neither — their only copy
     * is in version history — and they showed the empty mark before this too.
     */
    hasDocument: Boolean(item.lastHtmlS3Key?.S),
    preset: item.preset?.S,
    model: item.model?.S,
    outputKind: readOutputKind(item.outputKind?.S),
    totalTokens: item.totalTokens?.N ? parseInt(item.totalTokens.N, 10) : undefined,
    requestCount: item.requestCount?.N ? parseInt(item.requestCount.N, 10) : undefined,
    archivedAt: item.archivedAt?.S || undefined,
    favouritedAt: item.favouritedAt?.S || undefined,
    sharedAt: item.sharedAt?.S || undefined,
  }));
}

export async function getProject(
  userId: string,
  projectId: string,
  /** False skips the S3 read: an access check needs the row, not an 87KB document. */
  opts: { document?: boolean } = {}
): Promise<ProjectRecord | null> {
  let lastKey: Record<string, any> | undefined;

  do {
    const response = await client.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'projectId = :pid',
      ExpressionAttributeValues: {
        ':pk': { S: `USER#${userId}` },
        ':prefix': { S: 'PROJECT#' },
        ':pid': { S: projectId },
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));

    const item = response.Items?.[0];
    if (item) {
      /**
       * S3, with the inline copy only as a legacy fallback.
       *
       * The order is deliberately this way round now: nothing writes the inline
       * copy any more, so where both exist the inline one is the older of the
       * two. It is read only for rows that predate the S3 key and have not been
       * saved since — see the note above `updateProject`.
       */
      const stored = opts.document !== false && item.lastHtmlS3Key?.S ? (await readDocument(item.lastHtmlS3Key.S)) ?? undefined : undefined;
      const lastHtml = stored || item.lastHtml?.S;
      return {
        projectId: item.projectId?.S ?? '',
        userId,
        name: item.projectName?.S ?? 'Untitled',
        createdAt: item.createdAt?.S ?? '',
        updatedAt: item.updatedAt?.S ?? '',
        lastHtml,
        hasDocument: Boolean(item.lastHtmlS3Key?.S || item.lastHtml?.S),
        preset: item.preset?.S,
        model: item.model?.S,
        outputKind: readOutputKind(item.outputKind?.S),
        totalTokens: item.totalTokens?.N ? parseInt(item.totalTokens.N, 10) : undefined,
        requestCount: item.requestCount?.N ? parseInt(item.requestCount.N, 10) : undefined,
        archivedAt: item.archivedAt?.S || undefined,
        favouritedAt: item.favouritedAt?.S || undefined,
        sharedAt: item.sharedAt?.S || undefined,
      };
    }

    lastKey = response.LastEvaluatedKey;
  } while (lastKey);

  return null;
}

/*
 * The document is not kept in the row.
 *
 * It used to be, inline, as a fast path for the project list's thumbnail — and
 * the authoritative copy went to S3 on the same write regardless, which the
 * comment above `MAX_INLINE_HTML_BYTES` said in as many words. So the row
 * carried a duplicate of an object that always exists.
 *
 * Measured across the 27 stored projects on 2026-09-05: 24 carried one, at a
 * mean of 87KB. That is what a project row costs to write — DynamoDB bills a
 * WCU per KB, so the median write was 86 WCU and the largest 134, against 1
 * without it. On 2026-09-02 sixty-five hand edits were lost inside one minute to
 * a throughput burst on exactly this write.
 *
 * And to read: one account's `GET /projects` transferred 992KB for ten
 * projects, of which 4KB was the projects and the rest was ten copies of a
 * document the client had not asked for.
 *
 * Nothing needed it. `getProject` already reads S3 when the inline copy is
 * absent; the workspace already refetches when it opens with no document, and
 * its format detection already has a second pass for exactly this case — both
 * written for the over-the-limit projects, both now the ordinary path. The one
 * thing that did need it is the list thumbnail, which fetches its own document
 * when the card comes near the viewport.
 */
export async function updateProject(
  userId: string,
  projectId: string,
  updates: {
    name?: string
    lastHtml?: string
    preset?: string
    model?: string
    archived?: boolean
    favourite?: boolean
  }
): Promise<void> {
  const project = await getProject(userId, projectId);
  if (!project) return;

  const sk = `PROJECT#${project.createdAt}#${projectId}`;
  const now = new Date().toISOString();

  const exprs: string[] = ['updatedAt = :now'];
  const values: Record<string, any> = { ':now': { S: now } };
  /** Attributes to clear on this write — see the note above `updateProject`. */
  const drop: string[] = [];

  if (updates.name !== undefined) {
    exprs.push('projectName = :name');
    values[':name'] = { S: updates.name };
  }
  if (updates.lastHtml !== undefined) {
    const key = projectDocumentKey(userId, projectId);
    await putDocument(key, updates.lastHtml);
    exprs.push('lastHtmlS3Key = :hkey');
    values[':hkey'] = { S: key };
    // Removed rather than merely not written, so a row that still carries one
    // from before this sheds it on its next save.
    drop.push('lastHtml');
  }
  if (updates.preset !== undefined) {
    exprs.push('preset = :preset');
    values[':preset'] = { S: updates.preset };
  }
  if (updates.model !== undefined) {
    exprs.push('model = :model');
    values[':model'] = { S: updates.model };
  }
  /*
   * Un-archiving removes the attribute rather than writing an empty one.
   *
   * `archivedAt: ''` would be a second spelling of "not archived", and every
   * reader would have to know about both. Removing it leaves exactly one.
   */
  const flags = flagUpdates(updates, now);
  exprs.push(...flags.sets);
  Object.assign(values, flags.values);

  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `USER#${userId}` }, sk: { S: sk } },
    UpdateExpression:
      `SET ${exprs.join(', ')}`
      + ([...flags.removals, ...drop].length ? ` REMOVE ${[...flags.removals, ...drop].join(', ')}` : ''),
    ExpressionAttributeValues: values,
  }));
}

/**
 * The archive and favourite flags, as an update expression.
 *
 * Pure and exported so the one rule that has to hold between them can be tested
 * without a table: **an archived project is never a favourite.** They say
 * opposite things about the same project, and if both could be set then every
 * list that reads one would have to decide what the other means.
 *
 * The clearing happens here rather than in a caller so it holds however the
 * project got archived, and archiving wins when a single request asks for both
 * — DynamoDB rejects an expression that SETs and REMOVEs one attribute, so
 * something has to, and of the two the archive is the instruction that matters.
 *
 * Un-archiving REMOVEs rather than writing an empty string: `archivedAt: ''`
 * would be a second spelling of "not archived" and every reader would need to
 * know both.
 */
export function flagUpdates(
  updates: { archived?: boolean; favourite?: boolean },
  now: string
): { sets: string[]; removals: string[]; values: Record<string, any> } {
  const sets: string[] = [];
  const removals: string[] = [];
  const values: Record<string, any> = {};

  if (updates.archived === true) {
    sets.push('archivedAt = :archivedAt');
    values[':archivedAt'] = { S: now };
    removals.push('favouritedAt');
  } else if (updates.archived === false) {
    removals.push('archivedAt');
  }

  if (updates.favourite === true && updates.archived !== true) {
    sets.push('favouritedAt = :favouritedAt');
    values[':favouritedAt'] = { S: now };
  } else if (updates.favourite === false && !removals.includes('favouritedAt')) {
    removals.push('favouritedAt');
  }

  return { sets, removals, values };
}

/**
 * Record a completed run against its project.
 *
 * `lastHtml` used to be written only by the browser, from the effect that fires
 * when a run completes — so a job that finished while the user was on another
 * screen left the project with no preview at all, and opening it showed an empty
 * canvas. That is the "sometimes there is no preview" report: it depended on
 * whether anyone was watching. The job knows the document and the project, so it
 * writes both here and the outcome no longer depends on the client being present.
 *
 * The usage counters ride along because they are the same event: one run, one
 * request, N tokens. Counting them anywhere else would mean reconciling two
 * sources that can disagree.
 */
export async function recordProjectRun(
  userId: string,
  projectId: string,
  run: { html: string; tokens: number }
): Promise<void> {
  const project = await getProject(userId, projectId);
  if (!project) return;

  const sk = `PROJECT#${project.createdAt}#${projectId}`;
  const now = new Date().toISOString();

  /**
   * The framework, read from the paths the document actually carries.
   *
   * This used to test for `<script type="text/jsx">` — the transport React
   * projects travelled in before components with their own `<script>` forced
   * the move to line fences. Nothing has emitted that attribute since, so the
   * test was false for every run and every project was recorded as `html`,
   * including the React ones it was written for. That is the 「分類がHTML」 the
   * project list showed on a freshly generated Vue or Svelte project.
   *
   * `detectKind` reads the extensions instead, which is the same thing the
   * bundler, the preview and the edit path decide from — one answer, from one
   * place. A document it cannot classify keeps whatever the record already had
   * rather than being relabelled: an edit that returns something unreadable is
   * not evidence the project changed framework.
   */
  const detected = detectKind(readProjectFiles(run.html).keys())
  const outputKind = detected ?? project.outputKind ?? 'html';

  const exprs = [
    'updatedAt = :now',
    'outputKind = :kind',
    'totalTokens = if_not_exists(totalTokens, :zero) + :tokens',
    'requestCount = if_not_exists(requestCount, :zero) + :one',
  ];
  const values: Record<string, any> = {
    ':now': { S: now },
    ':kind': { S: outputKind },
    ':zero': { N: '0' },
    ':tokens': { N: String(Math.max(0, Math.round(run.tokens))) },
    ':one': { N: '1' },
  };
  /** Attributes to clear on this write — see the note above `updateProject`. */
  const drop: string[] = [];

  if (run.html) {
    const key = projectDocumentKey(userId, projectId);
    await putDocument(key, run.html);
    exprs.push('lastHtmlS3Key = :hkey');
    values[':hkey'] = { S: key };
    drop.push('lastHtml');
  }

  await client.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `USER#${userId}` }, sk: { S: sk } },
    UpdateExpression: `SET ${exprs.join(', ')}` + (drop.length ? ` REMOVE ${drop.join(', ')}` : ''),
    ExpressionAttributeValues: values,
  }));

  logger.info('Project run recorded', { userId, projectId, outputKind, tokens: run.tokens });
}

export async function deleteProject(userId: string, projectId: string): Promise<void> {
  const project = await getProject(userId, projectId);
  if (!project) return;

  const sk = `PROJECT#${project.createdAt}#${projectId}`;
  await client.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { pk: { S: `USER#${userId}` }, sk: { S: sk } },
  }));
  // The document lives outside the record now, so deleting the record alone would
  // leave it in the bucket forever. Version history is deliberately not touched —
  // it is per-user history, not project-owned.
  await deleteDocument(projectDocumentKey(userId, projectId));
  /*
   * The conversation is project-owned, and was not being deleted.
   *
   * It is keyed `CHAT#<projectId>`, so once the project is gone nothing can ever
   * read it again — it is not history the way version history is, it is a row
   * with no door. Seventy of the ninety-three stored threads were for projects
   * that no longer existed, which is also seventy conversations someone believed
   * they had deleted.
   *
   * Best-effort: the project is already gone by the time this runs, and failing
   * the request now would tell the caller a delete failed that did not.
   */
  await deleteChatMessages(userId, projectId).catch((error) => {
    logger.warn('Project deleted but its chat was not', { userId, projectId, error: String(error) });
  });
  /*
   * And the versions recorded against it, with their documents.
   *
   * These were kept, on the argument that version history is per-user rather
   * than project-owned. That argument holds for the rows carrying no
   * `projectId` — from before projects existed, reachable only through the
   * global history panel — and not for a run recorded against a project: 117
   * of the stored versions belonged to projects that had been deleted, so a
   * user who deleted a project still found its screens in their history.
   *
   * Best-effort for the same reason as the chat: the project is already gone.
   */
  await deleteProjectVersions(userId, projectId).catch((error) => {
    logger.warn('Project deleted but its versions were not', { userId, projectId, error: String(error) });
  });
  /*
   * And who it was shared with, on both sides — a grantee's index pointing at a
   * project that no longer exists would list a card that opens on nothing.
   */
  await deleteAllShares(projectId).catch((error) => {
    logger.warn('Project deleted but its shares were not', { userId, projectId, error: String(error) });
  });
  logger.info('Project deleted', { userId, projectId });
}

/**
 * The most recent document generated for a project, from whichever store still has it.
 *
 * Used to recover a project that opens blank. There are two independent copies —
 * the project's own `lastHtml`/`lastHtmlS3Key`, and version history — and each
 * has its own way of going missing:
 *
 *   - the project copy is written by the run, but a run that failed *after*
 *     generating (an S3 write error, say) leaves the record pointing at nothing;
 *   - the version copy is only written when the output passed its audits.
 *
 * This used to consult version history alone, so a project holding a perfectly
 * good document still answered `null` whenever its version write had not landed.
 * Asking both, project copy first, means the canvas is blank only when every
 * copy is genuinely gone.
 */
export async function getLatestProjectHtml(userId: string, projectId: string): Promise<string | null> {
  const usable = (html: string | null | undefined): string | null =>
    html && html.trim() ? html : null;

  const own = await getProject(userId, projectId).catch(() => null);
  const fromProject = usable(own?.lastHtml);
  if (fromProject) return fromProject;

  const versions = await getVersionHistory(userId, 1, projectId);
  const newest = versions[0];
  if (!newest) return null;
  // The list is metadata only, so the one document actually wanted is fetched here.
  const full = await getVersion(userId, newest.versionId);
  return usable(full?.html);
}
