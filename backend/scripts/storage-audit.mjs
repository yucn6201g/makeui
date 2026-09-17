/**
 * What is stored that nothing can reach, and what is stored twice.
 *
 * The two backfill scripts beside this one each fixed one thing once. This one
 * asks the question they were written to answer, so it can be asked again: for
 * every kind of row and object, is there still something that would read it?
 *
 * It found four things on 2026-09-05, all since fixed in the write paths:
 *
 *   inline documents   151 version rows and 24 project rows held a copy of a
 *                      document that was also in S3, or only there — 8.0MB of an
 *                      11.4MB table, billed on every read of the row.
 *   orphaned objects   71 documents in `versions/` with no row pointing at them.
 *                      27 were written in one minute on 2026-09-02, when the row
 *                      write was throttled and the object it had already put was
 *                      left behind. `versions/` has no lifecycle rule — correctly,
 *                      it is history — so an unreferenced object is permanent.
 *   unreachable chats  70 of 93 threads belonged to deleted projects. Keyed by
 *                      project id, so nothing could open them again.
 *   immortal jobs      45 job records with no `ttl`, the oldest from 2026-08-07.
 *                      Every writer but `createJob` is an `UpdateItem`, which
 *                      creates the item when it is absent — without one.
 *   ownerless data     84 items under a user id with no Cognito account behind
 *                      it: 13 projects, 59 versions and 10 chats belonging to
 *                      somebody who no longer exists. Nothing can sign in as
 *                      them, so nothing can ever open it.
 *
 * Reporting and deleting are separate flags, and the default is neither.
 *
 *   node scripts/storage-audit.mjs                # report
 *   node scripts/storage-audit.mjs --fix-job-ttl  # give ttl-less job rows their hour back
 *   node scripts/storage-audit.mjs --purge        # delete what nothing can reach
 *
 * `--purge` deletes only what no code path can read: an object no row points at,
 * a chat thread keyed to a project that is gone, a version recorded against a
 * project that is gone. It does NOT touch a version carrying no `projectId` —
 * those predate projects and the global history panel still lists them — and it
 * never deletes a row that something still reads.
 *
 * The write paths were fixed first, so purging is for what was written before
 * them. The orphaned objects among them include 27 from 2026-09-02 that are the
 * only trace of generations the throttled row write never recorded; deleting
 * those was a decision, made explicitly, not a default.
 */
import { outputsBucket, userPoolId } from './lib/aws-env.mjs';
import { DynamoDBClient, ScanCommand, UpdateItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';
const BUCKET = outputsBucket();
const FIX_JOB_TTL = process.argv.includes('--fix-job-ttl');
const PURGE = process.argv.includes('--purge');

const POOL = userPoolId();

const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });

const items = [];
let startKey;
do {
  const page = await ddb.send(new ScanCommand({ TableName: TABLE, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
  items.push(...(page.Items ?? []));
  startKey = page.LastEvaluatedKey;
} while (startKey);

async function listPrefix(prefix) {
  const out = new Map();
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}),
    }));
    for (const o of page.Contents ?? []) out.set(o.Key, o.Size);
    token = page.NextContinuationToken;
  } while (token);
  return out;
}

const sk = (i) => i.sk?.S ?? '';
const versions = items.filter((i) => sk(i).startsWith('VERSION#'));
const projects = items.filter((i) => sk(i).startsWith('PROJECT#'));
const chats = items.filter((i) => sk(i).startsWith('CHAT#'));
const jobs = items.filter((i) => sk(i) === 'META');
const mb = (n) => (n / 1024 / 1024).toFixed(2) + 'MB';
const bytes = (rows) => rows.reduce((a, r) => a + JSON.stringify(r).length, 0);

console.log(`${items.length} items, ${mb(bytes(items))}\n`);

// --- a document stored in the row as well as, or instead of, S3 --------------------
{
  const vInline = versions.filter((v) => v.html?.S);
  const pInline = projects.filter((p) => p.lastHtml?.S);
  const inlineBytes = [...vInline, ...pInline].reduce((a, r) => a + (r.html?.S ?? r.lastHtml?.S ?? '').length, 0);
  console.log(`inline documents : ${vInline.length} version rows, ${pInline.length} project rows, ${mb(inlineBytes)}`);
  if (vInline.length) console.log('                   run scripts/backfill-version-s3.mjs');
  if (pInline.length) console.log('                   run scripts/backfill-project-s3.mjs');
}

// --- objects nothing points at, and rows pointing at nothing -------------------------
for (const [prefix, keyOf] of [
  ['versions/', (i) => i.htmlS3Key?.S],
  ['projects/', (i) => i.lastHtmlS3Key?.S],
]) {
  const objects = await listPrefix(prefix);
  const referenced = new Set(items.map(keyOf).filter(Boolean));
  const orphans = [...objects].filter(([k]) => !referenced.has(k));
  const dangling = [...referenced].filter((k) => !objects.has(k));
  const orphanBytes = orphans.reduce((a, [, size]) => a + size, 0);
  console.log(`${prefix.padEnd(17)}: ${objects.size} objects, ${referenced.size} referenced`
    + ` -> ${orphans.length} orphaned (${mb(orphanBytes)}), ${dangling.length} rows point at nothing`);
  /*
   * A row pointing at a missing object is the serious direction — that is a
   * version or a project that opens blank — so it is named rather than counted,
   * and it is never what `--purge` acts on.
   */
  for (const k of dangling.slice(0, 10)) console.log(`                   MISSING ${k}`);

  if (PURGE && orphans.length) {
    for (const [key] of orphans) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log(`                   deleted ${orphans.length} orphaned objects (${mb(orphanBytes)})`);
  }
}

// --- chat threads for projects that no longer exist -----------------------------------
{
  /*
   * Keyed by owner as well as by project. Two accounts cannot collide on a v4
   * uuid in practice, but "in practice" is not the standard for deciding whether
   * to delete somebody's data.
   */
  const live = new Set(projects.map((p) => `${p.pk?.S}|${p.projectId?.S}`));
  const dead = chats.filter((c) => !live.has(`${c.pk?.S}|${sk(c).slice('CHAT#'.length)}`));
  console.log(`chat threads     : ${chats.length}, ${dead.length} for a project that is gone (${mb(bytes(dead))})`);

  if (PURGE && dead.length) {
    for (const c of dead) {
      await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: c.pk, sk: c.sk } }));
    }
    console.log(`                   deleted ${dead.length} threads`);
  }
}

// --- versions recorded against a project that is gone -----------------------------------
{
  const live = new Set(projects.map((p) => `${p.pk?.S}|${p.projectId?.S}`));
  const dead = versions.filter((v) => v.projectId?.S && !live.has(`${v.pk?.S}|${v.projectId.S}`));
  const unattributed = versions.filter((v) => !v.projectId?.S);
  console.log(`versions         : ${versions.length}, ${dead.length} for a project that is gone`
    + ` (${mb(bytes(dead))}), ${unattributed.length} carry no projectId and are KEPT`);

  /*
   * The ones with no `projectId` predate projects entirely. They are listed by
   * the global history panel and belong to nothing that could have been deleted,
   * so no reading of "delete what the user deleted" reaches them.
   */
  if (PURGE && dead.length) {
    for (const v of dead) {
      await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: v.pk, sk: v.sk } }));
      // After the row, so a surviving row never points at a deleted object. The
      // reverse leaves a version that opens blank, which is the failure nobody
      // can explain; an object outliving its row is swept by the next run.
      if (v.htmlS3Key?.S) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: v.htmlS3Key.S })).catch(() => {});
      }
    }
    console.log(`                   deleted ${dead.length} versions and their documents`);
  }
}

// --- data under a user id that no account answers to -------------------------------------
{
  /*
   * A partition is a Cognito `sub`. When the account is gone there is no way to
   * hold a token for it, so every row under it is unreachable by construction —
   * not merely unused.
   *
   * Read from the pool rather than inferred, and the listing has to have
   * succeeded: an empty user list from a throttled call would condemn every
   * partition in the table. Nothing is deleted if the pool cannot be read.
   */
  let accounts = null;
  try {
    const found = [];
    let token;
    do {
      const page = await idp.send(new ListUsersCommand({ UserPoolId: POOL, ...(token ? { PaginationToken: token } : {}) }));
      found.push(...(page.Users ?? []));
      token = page.PaginationToken;
    } while (token);
    if (found.length) accounts = new Set(found.map((u) => (u.Attributes ?? []).find((a) => a.Name === 'sub')?.Value).filter(Boolean));
  } catch (e) {
    console.log(`ownerless data   : the user pool could not be read (${e.name}) — skipped`);
  }

  if (accounts) {
    const owned = (pk) => accounts.has(pk.replace(/^(USER|RATE)#/, ''));
    const ownerless = items.filter((i) => /^(USER|RATE)#/.test(i.pk?.S ?? '') && !owned(i.pk.S));
    const who = new Set(ownerless.map((i) => i.pk.S));
    console.log(`ownerless data   : ${ownerless.length} items under ${who.size} user ids with no account`
      + ` (${mb(bytes(ownerless))})`);
    for (const pk of [...who].sort()) {
      const rows = ownerless.filter((i) => i.pk.S === pk);
      const kinds = {};
      for (const r of rows) { const k = sk(r).split('#')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
      console.log(`                   ${pk}  ${JSON.stringify(kinds)}`);
    }

    if (PURGE && ownerless.length) {
      let objects = 0;
      for (const i of ownerless) {
        await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
        // Row first, so nothing survives pointing at a deleted document.
        for (const key of [i.htmlS3Key?.S, i.lastHtmlS3Key?.S].filter(Boolean)) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
          objects += 1;
        }
      }
      console.log(`                   deleted ${ownerless.length} items and ${objects} documents`);
    }
  }
}

// --- job records that will never expire ------------------------------------------------
{
  const immortal = jobs.filter((j) => !j.ttl);
  const dates = immortal.map((j) => j.updatedAt?.S).filter(Boolean).sort();
  console.log(`job records      : ${jobs.length}, ${immortal.length} with no ttl (${mb(bytes(immortal))})`
    + (dates.length ? `, oldest ${dates[0].slice(0, 10)}` : ''));

  if (immortal.length && FIX_JOB_TTL) {
    /*
     * An hour from now, not an hour from when the job ran. Backdating would ask
     * DynamoDB to delete rows it has already passed over, which it does honour —
     * but a stamp in the past reads as a mistake to anyone who scans this table
     * before the sweep gets to it.
     */
    const ttl = String(Math.floor(Date.now() / 1000) + 3600);
    for (const j of immortal) {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { pk: j.pk, sk: j.sk },
        UpdateExpression: 'SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ttl': { N: ttl } },
      }));
    }
    console.log(`                   stamped ${immortal.length} of them to expire in an hour`);
  } else if (immortal.length) {
    console.log('                   pass --fix-job-ttl to give them the lifetime they were meant to have');
  }
}
