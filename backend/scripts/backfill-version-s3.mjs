/**
 * Move the version rows that still carry their document inline into S3.
 *
 * `saveVersion` has written the document to S3 and kept a key for a while now —
 * 550 of the 701 stored versions are that shape. The other 151 predate it and
 * hold the markup in the DynamoDB item, which is 8.0MB of an 11.4MB table.
 *
 * What that costs is a read, and it is charged per item read rather than per
 * byte returned: `getVersionHistory` asks for 20 rows of metadata, and where
 * those rows are the old shape it is billed for the documents inside them.
 * Measured on the production table, 2026-09-05:
 *
 *   opening the history panel        945 KB  = 119 RCU   (one account)
 *   the same panel, rows migrated    7.4 KB  =   1 RCU
 *   the per-project branch, one page 3.6 MB  = 450 RCU
 *   the same page, rows migrated      47 KB  =   6 RCU
 *
 * The per-project branch is the worse of the two because it reads pages of 100
 * and applies its `projectId` filter afterwards, so it pays for every row in the
 * range whether or not the row belongs to the project asked about — and
 * `getLatestProjectHtml` goes through it asking for exactly one version.
 *
 * The read path already prefers the key and falls back to the inline copy
 * (`hydrateHtml`), so a migrated row and an unmigrated one both work; this only
 * decides which one is being paid for.
 *
 *   node scripts/backfill-version-s3.mjs            # report only
 *   node scripts/backfill-version-s3.mjs --write    # do it
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

const versions = items.filter((i) => (i.sk?.S ?? '').startsWith('VERSION#'));
const inlineOnly = versions.filter((v) => (v.html?.S ?? '') && !v.htmlS3Key?.S);
const duplicated = versions.filter((v) => (v.html?.S ?? '') && v.htmlS3Key?.S);

const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB';
console.log(`${versions.length} versions: ${inlineOnly.length} inline only, ${duplicated.length} duplicated, `
  + `${versions.filter((v) => !v.html?.S && v.htmlS3Key?.S).length} already moved`);
console.log(`inline bytes: ${(versions.reduce((a, v) => a + (v.html?.S ?? '').length, 0) / 1024 / 1024).toFixed(1)} MB`);
if (!WRITE) console.log('(report only — pass --write to move them)');

let moved = 0;
for (const v of inlineOnly) {
  const userId = (v.pk?.S ?? '').replace('USER#', '');
  const versionId = v.versionId?.S ?? '';
  const html = v.html.S;
  if (!versionId) {
    console.log(`  ${(v.sk?.S ?? '').slice(0, 40)}  no versionId — left alone`);
    continue;
  }
  const key = `versions/${userId}/${versionId}.html`;
  if (!WRITE) continue;

  // S3 first, so a failure on the row update leaves the inline copy in place and
  // this script safe to run again. The reverse order would lose the document.
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: html, ContentType: 'text/html' }));
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: v.pk, sk: v.sk },
    UpdateExpression: 'SET htmlS3Key = :k REMOVE html',
    ExpressionAttributeValues: { ':k': { S: key } },
  }));
  moved += 1;
}
console.log(`\n${WRITE ? `moved ${moved}` : `${inlineOnly.length} would move`}`
  + ` (${kb(inlineOnly.reduce((a, v) => a + v.html.S.length, 0))} of markup)`);

/*
 * And the rows that have both, if any turn up. The document is read back from S3
 * and its length compared before the row gives up its copy — "they were written
 * together so they must match" is a reason to expect the comparison to pass, not
 * a reason to skip it.
 */
if (duplicated.length) {
  console.log(`\n${duplicated.length} rows carry both:`);
  let shed = 0;
  for (const v of duplicated) {
    const inline = v.html.S;
    let stored;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: v.htmlS3Key.S }));
      stored = await obj.Body.transformToString();
    } catch (e) {
      console.log(`  ${(v.versionId?.S ?? '').slice(0, 8)}  S3 object unreadable — left alone (${e.name})`);
      continue;
    }
    if (stored.length !== inline.length) {
      console.log(`  ${(v.versionId?.S ?? '').slice(0, 8)}  differs — left alone`);
      continue;
    }
    console.log(`  ${(v.versionId?.S ?? '').slice(0, 8)}  ${kb(inline.length)}  matches`);
    if (!WRITE) continue;
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: v.pk, sk: v.sk },
      UpdateExpression: 'REMOVE html',
    }));
    shed += 1;
  }
  if (WRITE) console.log(`shed ${shed} duplicate copies`);
}
