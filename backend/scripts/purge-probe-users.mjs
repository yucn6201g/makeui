/**
 * Remove the verification harness's users from the production table.
 *
 * Every probe run invents a user id and writes real rows under it — versions, a
 * monthly ledger, sometimes a config and a rate bucket. `verify.probe.mjs` uses
 * `verify-<framework>`, and the ones before it used `probe-*`, `fw-bench`,
 * `variance-probe`. On 2026-09-05 that was 15 partitions and 244 items sitting
 * beside three real accounts.
 *
 * The selector is the id's SHAPE, and it is safe for one reason worth stating
 * plainly: a real user id is the Cognito `sub`, which is always a v4 uuid. The
 * harness's ids are words. Checked against the pool the same day — three users,
 * three uuid subs, no exceptions — and the script refuses to run if it ever
 * finds a Cognito user whose sub is not a uuid, because that is the one thing
 * that would make this rule delete somebody's work.
 *
 * The S3 documents go with the rows. Deleting rows alone would leave the
 * objects unreferenced, which is exactly the state `storage-audit.mjs` reports
 * and cannot then tell apart from a throttled write.
 *
 * What is lost: these version rows are the measurement corpus — the framework
 * score comparison, the fix rates, the compile survey all read them. The numbers
 * those produced are recorded where they were acted on (frameworks.ts, scoring.ts,
 * the test headers); the documents themselves are not kept. Run this when the
 * measurements are banked, not in the middle of one.
 *
 *   node scripts/purge-probe-users.mjs            # report only
 *   node scripts/purge-probe-users.mjs --write    # do it
 */
import { outputsBucket, userPoolId } from './lib/aws-env.mjs';
import { DynamoDBClient, ScanCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE = process.env.USAGE_TABLE_NAME || 'makeui-token-usage';
const BUCKET = outputsBucket();
const POOL = userPoolId();
const WRITE = process.argv.includes('--write');

const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const idp = new CognitoIdentityProviderClient({ region: REGION });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * The premise, checked rather than assumed. If a real account ever had a
 * non-uuid id this whole selector would delete it, so the run stops instead.
 */
{
  const users = [];
  let token;
  do {
    const page = await idp.send(new ListUsersCommand({ UserPoolId: POOL, ...(token ? { PaginationToken: token } : {}) }));
    users.push(...(page.Users ?? []));
    token = page.PaginationToken;
  } while (token);
  const odd = users.filter((u) => !UUID.test((u.Attributes ?? []).find((a) => a.Name === 'sub')?.Value ?? ''));
  console.log(`${users.length} Cognito users, ${odd.length} whose sub is not a uuid`);
  if (odd.length) {
    console.error('Refusing to run: a real account does not match the shape this script relies on.');
    process.exit(1);
  }
}

const items = [];
let startKey;
do {
  const page = await ddb.send(new ScanCommand({ TableName: TABLE, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
  items.push(...(page.Items ?? []));
  startKey = page.LastEvaluatedKey;
} while (startKey);

/*
 * `USER#` and `RATE#` only. A `JOB#` partition is keyed by a job id, not by a
 * user, and job records expire on their own ttl — matching them here would be
 * matching a different thing that happens to share the shape.
 */
const isProbe = (pk) => /^(USER|RATE)#/.test(pk) && !UUID.test(pk.replace(/^(USER|RATE)#/, ''));
const doomed = items.filter((i) => isProbe(i.pk?.S ?? ''));

const byPk = new Map();
for (const i of doomed) {
  const e = byPk.get(i.pk.S) ?? { n: 0, bytes: 0, docs: 0 };
  e.n += 1;
  e.bytes += JSON.stringify(i).length;
  if (i.htmlS3Key?.S || i.lastHtmlS3Key?.S) e.docs += 1;
  byPk.set(i.pk.S, e);
}

console.log(`\n${byPk.size} probe partitions, ${doomed.length} items, `
  + `${(doomed.reduce((a, i) => a + JSON.stringify(i).length, 0) / 1024).toFixed(0)}KB`);
for (const [pk, e] of [...byPk].sort())
  console.log(`  ${pk.padEnd(34)} ${String(e.n).padStart(4)} items  ${String(e.docs).padStart(4)} documents`);
if (!WRITE) {
  console.log('\n(report only — pass --write to delete)');
  process.exit(0);
}

let rows = 0;
let objects = 0;
for (const i of doomed) {
  await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: i.pk, sk: i.sk } }));
  rows += 1;
  // After the row, so nothing survives pointing at a deleted object.
  for (const key of [i.htmlS3Key?.S, i.lastHtmlS3Key?.S].filter(Boolean)) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
    objects += 1;
  }
}
console.log(`\ndeleted ${rows} rows and ${objects} documents`);
