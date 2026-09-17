/**
 * Move the project rows that still carry their document inline into S3.
 *
 * The project row stopped storing `lastHtml` (see the note above `updateProject`
 * in `src/services/project-service.ts`). New writes put the document in S3 and
 * REMOVE the attribute, so a row heals itself the next time it is saved — but a
 * project nobody opens again never gets that write, and until it does:
 *
 *   - `GET /projects` reports `hasDocument: false` for it, because that answer
 *     is `lastHtmlS3Key` and the row has none, so its card shows the empty mark;
 *   - and the card badge loses its framework, because `outputKind` was only
 *     recorded from the run and these rows predate it — the list used to derive
 *     it from the inline copy it no longer receives.
 *
 * Measured on the production table, 2026-09-05, 27 projects:
 *   13  an S3 key AND an inline duplicate — the duplicate removed, once the S3
 *                                            object was read back and matched
 *   11  inline only                        — copied to S3, then removed
 *    2  only in version history            — untouched; the preview route finds them
 *    1  no document anywhere               — untouched
 *
 * The thirteen matter as much as the eleven. Their write still cost a WCU per KB
 * of a copy nothing reads, so a hand edit on one of them was 87 WCU until it
 * happened to be saved again by the new code.
 *
 * All eleven turn out to be single-file HTML mocks predating the project
 * formats, so there is no framework in them to detect and none is invented —
 * they showed no badge before this and they show none after. The detection is
 * here for any row that turns up later carrying files.
 *
 *   node scripts/backfill-project-s3.mjs            # report only
 *   node scripts/backfill-project-s3.mjs --write    # do it
 */
import { outputsBucket } from './lib/aws-env.mjs';
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';
const BUCKET = outputsBucket();
const WRITE = process.argv.includes('--write');

const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

/**
 * The framework, from the file paths the document unpacks into.
 *
 * A deliberately small copy of the browser's `detectKind`: the extension of the
 * component files is the whole signal, and importing the frontend's module into
 * a backend script to get it would be worse than eight lines.
 */
function detectKind(html) {
  const paths = [...html.matchAll(/@@@makeui:file\s+([^\s@]+)/g)].map((m) => m[1]);
  if (paths.some((p) => p.endsWith('.vue'))) return 'vue';
  if (paths.some((p) => p.endsWith('.svelte'))) return 'svelte';
  if (paths.some((p) => p.endsWith('.tsx') || p.endsWith('.jsx'))) return 'react';
  return null;
}

const items = [];
let startKey;
do {
  const page = await ddb.send(new ScanCommand({
    TableName: TABLE,
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  }));
  items.push(...(page.Items ?? []));
  startKey = page.LastEvaluatedKey;
} while (startKey);

const projects = items.filter((i) => (i.sk?.S ?? '').startsWith('PROJECT#'));
const stale = projects.filter((p) => (p.lastHtml?.S ?? '') && !p.lastHtmlS3Key?.S);

console.log(`${projects.length} projects, ${stale.length} carrying only an inline document`);
if (!WRITE) console.log('(report only — pass --write to move them)\n');

let moved = 0;
let kinded = 0;
for (const p of stale) {
  const userId = (p.pk?.S ?? '').replace('USER#', '');
  const projectId = p.projectId?.S ?? '';
  const html = p.lastHtml.S;
  const key = `projects/${userId}/${projectId}.html`;
  const kind = p.outputKind?.S ? null : detectKind(html);

  console.log(
    `  ${projectId.slice(0, 8)}  ${(html.length / 1024).toFixed(0).padStart(4)} KB` +
    `  ${(p.projectName?.S ?? '').slice(0, 24).padEnd(26)}` +
    `  ${p.outputKind?.S ?? (kind ? `→ ${kind}` : '(kind unknown)')}`
  );
  if (!WRITE) continue;

  // S3 first. If the update below fails the row keeps its inline copy and this
  // script is safe to run again; the reverse order would lose the document.
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: html, ContentType: 'text/html',
  }));

  const sets = ['lastHtmlS3Key = :k'];
  const values = { ':k': { S: key } };
  if (kind) {
    sets.push('outputKind = :kind');
    values[':kind'] = { S: kind };
    kinded += 1;
  }
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: p.pk, sk: p.sk },
    UpdateExpression: `SET ${sets.join(', ')} REMOVE lastHtml`,
    ExpressionAttributeValues: values,
  }));
  moved += 1;
}

if (WRITE) console.log(`\nmoved ${moved}, of which ${kinded} also gained a framework`);

/*
 * The rows that have both: an S3 key and an inline copy of the same document.
 *
 * Every write path put the two down together, so they hold the same bytes — but
 * "so they should" is not a reason to delete one of them unread. The object is
 * fetched back and its length compared before the row gives up its copy, and a
 * row that does not match is left exactly as it is and named, because that is a
 * finding rather than a migration step.
 */
const duplicated = projects.filter((p) => (p.lastHtml?.S ?? '') && p.lastHtmlS3Key?.S);
console.log(`\n${duplicated.length} rows carry both an S3 key and a duplicate inline copy`);

let shed = 0;
for (const p of duplicated) {
  const key = p.lastHtmlS3Key.S;
  const inline = p.lastHtml.S;
  const id = (p.projectId?.S ?? '').slice(0, 8);
  let stored = null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    stored = await obj.Body.transformToString();
  } catch (e) {
    console.log(`  ${id}  S3 object unreadable — left alone (${e.name})`);
    continue;
  }
  if (stored.length !== inline.length) {
    console.log(
      `  ${id}  differs: S3 ${(stored.length / 1024).toFixed(0)}KB`
      + ` vs inline ${(inline.length / 1024).toFixed(0)}KB — left alone`
    );
    continue;
  }
  console.log(`  ${id}  ${(inline.length / 1024).toFixed(0).padStart(4)} KB  matches`);
  if (!WRITE) continue;
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: p.pk, sk: p.sk },
    UpdateExpression: 'REMOVE lastHtml',
  }));
  shed += 1;
}
if (WRITE) console.log(`\nshed ${shed} duplicate copies`);
