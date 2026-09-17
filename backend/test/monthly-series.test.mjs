/**
 * Each month of the period, for the whole account.
 *
 * `getAllUsersUsage` reads the same rows and merges a range into one line per
 * ACCOUNT — "who spent what". This groups the other way, one line per MONTH with
 * every account together, which is what a chart with time along the bottom
 * needs. A month is the finest period either can answer: the store keeps one row
 * per account per month.
 *
 * The rule that matters is `attributed`. `tok_<model>_*` began part-way through
 * the product's life, so a month can carry a complete total and no attribution
 * at all — measured against the live table on 2026-09-10, August is 0 of 165
 * requests and September 3 of 8. A chart drawn from the split alone would show
 * August as a month with nothing in it.
 *
 *   node test/monthly-series.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/monthly-series.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/services/token-usage.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});

const N = (n) => ({ N: String(n) });
const S = (v) => ({ S: v });

/** A month row, in the shape the table stores. */
const row = (sub, month, total, requests, per = {}) => ({
  pk: S(`USER#${sub}`),
  sk: S(`MONTH#${month}`),
  totalTokens: N(total),
  requestCount: N(requests),
  ...Object.fromEntries(Object.entries(per).map(([k, v]) => [k, N(v)])),
});

let items = [];
let directory = ['alice', 'bob'];

const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
DynamoDBClient.prototype.send = async function stub(command) {
  const name = command.constructor.name;
  if (name === 'ScanCommand') {
    const from = command.input.ExpressionAttributeValues[':from'].S;
    const to = command.input.ExpressionAttributeValues[':to'].S;
    return { Items: items.filter((i) => i.sk.S >= from && i.sk.S <= to) };
  }
  throw new Error(`unstubbed dynamo: ${name}`);
};

const { CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');
CognitoIdentityProviderClient.prototype.send = async function stub() {
  return {
    Users: directory.map((u) => ({
      Attributes: [{ Name: 'sub', Value: u }, { Name: 'email', Value: `${u}@example.com` }],
    })),
  };
};

process.env.COGNITO_USER_POOL_ID = 'ap-northeast-1_test';
process.env.MODEL_PRICING = JSON.stringify({
  currency: 'USD',
  models: {
    haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
});

const { getMonthlySeries } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- accounts add up within a month, months stay apart ----------------------
items = [
  row('alice', '2026-08', 1000, 10),
  row('bob', '2026-08', 500, 5),
  row('alice', '2026-09', 300, 3),
];
let series = await getMonthlySeries('2026-08', '2026-09');
check('one entry per month', series.map((m) => m.month), ['2026-08', '2026-09']);
check('every account in the month is added up', series[0].totalTokens, 1500);
check('and their requests', series[0].requestCount, 15);
check('the next month is its own', [series[1].totalTokens, series[1].requestCount], [300, 3]);

// --- a month nobody ran in is a gap, not a missing bar ----------------------
/*
 * A chart that skips an empty month draws a line straight from one busy month to
 * the next and reads as continuous use. The gap is the fact.
 */
series = await getMonthlySeries('2026-07', '2026-09');
check('every month in the range is present', series.map((m) => m.month),
  ['2026-07', '2026-08', '2026-09']);
check('an empty one is zero rather than absent',
  [series[0].totalTokens, series[0].requestCount], [0, 0]);
check('and carries no models', series[0].byModel, []);

// --- how much of the month has a model against it ---------------------------
items = [
  // Three requests recorded with a model, five without: September, as it is.
  row('alice', '2026-09', 1837269, 8, {
    tok_haiku_in: 167578, tok_haiku_out: 180868, tok_haiku_req: 2,
    tok_sonnet_in: 79138, tok_sonnet_out: 103102, tok_sonnet_req: 1,
  }),
  // And a month from before the split existed at all: August.
  row('bob', '2026-08', 17616592, 165),
];
series = await getMonthlySeries('2026-08', '2026-09');
const aug = series.find((m) => m.month === '2026-08');
const sep = series.find((m) => m.month === '2026-09');
check('a month with no split reports a complete total', aug.totalTokens, 17616592);
check('and no attribution', aug.attributed, { tokens: 0, requests: 0 });
// The whole reason the field exists: the bar must be the total, and the caption
// must be able to say how little of it is attributed.
check('the total is not reduced to the attributed part', aug.requestCount, 165);
check('a partly attributed month says how much', sep.attributed, { tokens: 530686, requests: 3 });
check('while its total stays whole', [sep.totalTokens, sep.requestCount], [1837269, 8]);
check('and its models are listed', sep.byModel.map((m) => m.model).sort(), ['haiku', 'sonnet']);
check('with their own figures', sep.byModel.find((m) => m.model === 'haiku').requestCount, 2);

// --- money -------------------------------------------------------------------
/*
 * The recorded requests, priced, and then scaled to cover the ones that recorded
 * no model — see `splitCoverage`. September has 8 requests and 3 with a split,
 * so the figure is the split's own average spent on the other five.
 *
 * Recorded: haiku 167578 in at $1/M + 180868 out at $5/M = 1.071918
 *           sonnet 79138 in at $3/M + 103102 out at $15/M = 1.783944
 *           2.855862, times 8/3.
 *
 * The scaling is not this function's — it comes from `monthCost` and gates every
 * budget in the product. Asserted here because a chart of money must draw the
 * same number the limit is enforced on, and the two are computed in different
 * files.
 */
check('the month is priced from the split, scaled to the whole month',
  Math.round(sep.cost * 10000) / 10000, Math.round(2.855862 * 8 / 3 * 10000) / 10000);
// And says so. A bar drawn from three requests standing for eight is a
// different claim from a bar drawn from eight.
check('and is marked as inferred', sep.estimated, true);
// Null and 0 are different answers, and adding null as zero would report a month
// as free rather than as unpriced.
check('a month with nothing to price has no cost', aug.cost, null);
check('and is not marked inferred either — there was nothing to infer from', aug.estimated, false);
// A month where every request recorded its model is a sum, not an estimate.
items = [row('alice', '2026-09', 200, 1, { tok_haiku_in: 100, tok_haiku_out: 100, tok_haiku_req: 1 })];
const exact = await getMonthlySeries('2026-09', '2026-09');
check('a fully recorded month is a sum', exact[0].estimated, false);

// --- two accounts, both with models, merge per model ------------------------
items = [
  row('alice', '2026-09', 400, 4, { tok_haiku_in: 100, tok_haiku_out: 100, tok_haiku_req: 2 }),
  row('bob', '2026-09', 400, 4, { tok_haiku_in: 100, tok_haiku_out: 100, tok_haiku_req: 2 }),
];
series = await getMonthlySeries('2026-09', '2026-09');
check('one model row for the month, not one per account', series[0].byModel.length, 1);
check('summed across accounts', series[0].byModel[0].requestCount, 4);
check('and the attribution with it', series[0].attributed, { tokens: 400, requests: 4 });

// --- rows whose account no longer exists ------------------------------------
/*
 * A usage row outlives the account it was written for, and a run made against
 * the pipeline directly carries a synthetic id. Those reached the account table
 * as a user named 「—」 and they would reach a chart as spend nobody made.
 */
items = [
  row('alice', '2026-09', 100, 1),
  row('ghost', '2026-09', 9999, 99),
];
series = await getMonthlySeries('2026-09', '2026-09');
check('a row with no account behind it is not counted', series[0].totalTokens, 100);

// Unless the directory itself could not be read — treating a Cognito outage as
// "nobody exists" would empty the chart rather than report a problem.
directory = [];
const CognitoErr = (await import('@aws-sdk/client-cognito-identity-provider')).CognitoIdentityProviderClient;
CognitoErr.prototype.send = async function () { throw new Error('ServiceUnavailable'); };
series = await getMonthlySeries('2026-09', '2026-09');
check('a directory that cannot be read does not empty the chart', series[0].totalTokens, 10099);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
