/**
 * A month was the only period the panel could report, because it was the only
 * one the code could ask for.
 *
 * The store keeps one row per account per MONTH, so a month is the finest
 * period there is: a day range would have to be rebuilt from the `EVENT#` rows,
 * which means a query per account to answer a report. What was missing was not
 * granularity but RANGE — 「先月は」 and 「四半期で」 are the questions an
 * administrator brings to this screen, and both were unanswerable.
 *
 * Every figure in a MONTH row is a counter, which is what makes a period their
 * sum — including the `tok_<model>_*` attributes, so `monthCost` and
 * `splitCoverage` work on the merged row unchanged. They read counters off an
 * item and do not care that this item was three.
 *
 *   node test/usage-period.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'dist/ddb.stub.mjs');
const out = path.join(root, 'dist/usage-period.test.mjs');
fs.mkdirSync(path.dirname(stub), { recursive: true });

fs.writeFileSync(stub, [
  'class Cmd { constructor(input) { this.input = input; } }',
  'export class GetItemCommand extends Cmd {}',
  'export class BatchGetItemCommand extends Cmd {}',
  'export class PutItemCommand extends Cmd {}',
  'export class UpdateItemCommand extends Cmd {}',
  'export class QueryCommand extends Cmd {}',
  'export class ScanCommand extends Cmd {}',
  'export class DynamoDBClient { async send(c) { return globalThis.__ddb(c); } }',
  'export class CognitoIdentityProviderClient { async send(c) { return globalThis.__cog(c); } }',
  'export class ListUsersCommand extends Cmd {}',
  'export class AdminGetUserCommand extends Cmd {}',
].join('\n'));

/*
 * Without a pool id `getCognitoEmailMap` returns an EMPTY map rather than
 * calling out, and an empty map means "the directory answered and nobody
 * exists" — so every row is filtered away and the table comes back blank. That
 * distinction is deliberate and documented there; it also means a test of this
 * function has to supply one.
 */
process.env.COGNITO_USER_POOL_ID = 'ap-northeast-1_test';
process.env.MODEL_PRICING = JSON.stringify({
  currency: 'USD',
  models: { haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
});

await esbuild.build({
  entryPoints: [path.join(root, 'src/services/token-usage.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  plugins: [{ name: 'stub-aws', setup(b) { b.onResolve({ filter: /^@aws-sdk\// }, () => ({ path: stub })); } }],
});
const { getAllUsersUsage, monthsBetween, isMonthKey } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const n = (v) => ({ N: String(v) });
const month = (mo, tokens, requests) => ({
  pk: { S: 'USER#u1' }, sk: { S: `MONTH#${mo}` },
  totalTokens: n(tokens), inputTokens: n(tokens / 2), outputTokens: n(tokens / 2),
  cacheReadTokens: n(0), cacheWriteTokens: n(0), requestCount: n(requests),
  weightedTokens: n(tokens), lastUpdated: { S: `${mo}-15T00:00:00Z` },
  tok_haiku_in: n(tokens / 2), tok_haiku_out: n(tokens / 2),
  tok_haiku_cr: n(0), tok_haiku_cw: n(0), tok_haiku_req: n(requests),
});
const STORED = [month('2026-07', 100_000, 2), month('2026-08', 200_000, 3), month('2026-09', 300_000, 5)];

globalThis.__cog = () => ({ Users: [{ Attributes: [
  { Name: 'sub', Value: 'u1' }, { Name: 'email', Value: 'a@example.com' },
] }] });

let asked = null;
globalThis.__ddb = (cmd) => {
  const i = cmd.input;
  if (i.FilterExpression?.includes('BETWEEN')) {
    asked = [i.ExpressionAttributeValues[':from'].S, i.ExpressionAttributeValues[':to'].S];
    return { Items: STORED.filter((it) => it.sk.S >= asked[0] && it.sk.S <= asked[1]) };
  }
  if (i.RequestItems) return { Responses: { [Object.keys(i.RequestItems)[0]]: [] } };
  return { Item: undefined };
};
const rowFor = async (from, to) => (await getAllUsersUsage(from, to)).find((u) => u.userId === 'u1');

// --- the range is a key range, not a filter over everything --------------------------
{
  await rowFor('2026-07', '2026-09');
  /*
   * `MONTH#` sorts clear of every other sort key this table uses — CHAT# and
   * CONFIG and EVENT# below it, PROJECT# and VERSION# above — so a BETWEEN over
   * the two bounds cannot pick up a row of another kind.
   */
  check('the scan asks for the months it was given', asked, ['MONTH#2026-07', 'MONTH#2026-09']);
  check('and the helpers agree about what a month is',
    [monthsBetween('2026-11', '2027-02'), isMonthKey('2026-13'), isMonthKey('2026-09')],
    [['2026-11', '2026-12', '2027-01', '2027-02'], false, true]);
}

// --- one month behaves exactly as it did ---------------------------------------------
{
  const r = await rowFor('2026-09', '2026-09');
  check('a single month is the month', [r.totalTokens, r.requestCount], [300_000, 5]);
  check('and is labelled as one', [r.month, r.period], ['2026-09', { from: '2026-09', to: '2026-09' }]);
  // 150k in at $1 and 150k out at $5, per million.
  check('priced from its own split', Math.round(r.cost * 100) / 100, 0.9);
}

// --- and several are added -------------------------------------------------------------
{
  const r = await rowFor('2026-07', '2026-09');
  check('the tokens are the sum', r.totalTokens, 600_000);
  check('the requests are the sum', r.requestCount, 10);
  /*
   * The money too, and this is the one that could not be done by adding up the
   * rendered rows: cost comes from the per-model counters, so the merge has to
   * carry `tok_haiku_*` or the total silently reports one month's.
   */
  check('so is the money', Math.round(r.cost * 100) / 100, 1.8);
  check('and the label says which months', r.month, '2026-07〜2026-09');

  // The timestamp is the latest of them rather than a sum, being a date.
  check('the last activity is the latest, not the total', r.lastUpdated, '2026-09-15T00:00:00Z');
}

// --- a partial range is only that range --------------------------------------------------
{
  const r = await rowFor('2026-07', '2026-08');
  check('a range that stops early stops early', [r.totalTokens, r.requestCount], [300_000, 5]);
}

// --- an account with nothing in the period still appears -----------------------------------
{
  const rows = await getAllUsersUsage('2026-01', '2026-01');
  const u = rows.find((x) => x.userId === 'u1');
  /*
   * The zero row is a real answer: this account exists and spent nothing then.
   * It is also the row an administrator most wants, because it is where a budget
   * is read — and before the listing pushed these, an account appeared only
   * after its first run.
   */
  check('a month it did not run in is zero, not absent', [Boolean(u), u?.totalTokens], [true, 0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
