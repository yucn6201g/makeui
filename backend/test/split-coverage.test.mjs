/**
 * A month can be short of its own per-model split, and the budget must not be.
 *
 * `recordUsage` writes two things about every request: the plain totals, and a
 * `tok_<model>_*` breakdown that everything priced is computed from. The
 * breakdown was added later, so the month the deploy landed in has requests
 * that contributed to the totals and to nothing else — September 2026 has three
 * requests and one recorded split.
 *
 * Which makes `weightedTokens` and the month's cost LOWER BOUNDS on such a
 * month, and a lower bound is the permissive direction for a budget: on the
 * real row, 809,547 of about 2,300,000. Enforcing prices that week would have
 * handed everyone roughly three times their allowance, on a row that reads as
 * complete.
 *
 * The fix is one ratio — requests over recorded requests — which is 1 for every
 * month written by one deployment, so this is a correction that costs nothing
 * to leave in and disappears when the month does.
 *
 *   node test/split-coverage.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'dist/ddb.stub.mjs');
const out = path.join(root, 'dist/split-coverage.test.mjs');
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
  'export class CognitoIdentityProviderClient { async send() { return {}; } }',
  'export class ListUsersCommand extends Cmd {}',
  'export class AdminGetUserCommand extends Cmd {}',
].join('\n'));

/*
 * The real table, and enforcement on.
 *
 * Both are needed: without a table nothing is weighed, and with a table but no
 * enforcement `checkUsageLimit` compares the plain count and the scaling never
 * reaches the decision. The prices are the ones deployed — Haiku at $1 in and
 * $5 out per million — because the arithmetic below is checked against the row
 * this was found on.
 */
process.env.MODEL_PRICING = JSON.stringify({
  currency: 'USD',
  models: {
    haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
    sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  },
});
process.env.MODEL_PRICING_ENFORCE = '1';

await esbuild.build({
  entryPoints: [path.join(root, 'src/services/token-usage.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  plugins: [{
    name: 'stub-aws',
    setup(b) { b.onResolve({ filter: /^@aws-sdk\// }, () => ({ path: stub })); },
  }],
});
const { checkUsageLimit } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const n = (v) => ({ N: String(v) });
const ledger = ({ config, month }) => (cmd) => {
  const sk = cmd.input?.Key?.sk?.S ?? '';
  return { Item: sk === 'CONFIG' ? config : month };
};

/** One Haiku request, recorded whole: 100k in, 100k out — $0.60. */
const ONE_RECORDED = {
  tok_haiku_in: n(100_000), tok_haiku_out: n(100_000),
  tok_haiku_cr: n(0), tok_haiku_cw: n(0), tok_haiku_req: n(1),
};

// --- a complete month is left alone ------------------------------------------
{
  globalThis.__ddb = ledger({
    config: { monthlyTokenLimit: n(-1) },
    month: {
      ...ONE_RECORDED,
      totalTokens: n(200_000), requestCount: n(1), weightedTokens: n(600_000),
    },
  });
  const r = await checkUsageLimit('u');
  check('a month whose split covers every request is unscaled', r.currentUsage, 600_000);
  check('and its cost is a sum, not an estimate', [r.cost, r.estimated], [0.6, false]);
}

// --- a month short of its split is scaled to the whole -------------------------
{
  /*
   * Three requests, one of them recorded — the shape of the real September row.
   * `totalTokens` counts all three; `weightedTokens` and every `tok_*` count
   * one. The uncounted two are priced at what the counted one cost.
   */
  globalThis.__ddb = ledger({
    config: { monthlyTokenLimit: n(-1) },
    month: {
      ...ONE_RECORDED,
      totalTokens: n(600_000), requestCount: n(3), weightedTokens: n(600_000),
    },
  });
  const r = await checkUsageLimit('u');
  check('a month missing two of three splits is scaled by three', r.currentUsage, 1_800_000);
  // To the cent: the cost is a float in dollars and 0.6 * 3 is not 1.8 in binary.
  check('the cost is scaled with it', Math.round(r.cost * 100) / 100, 1.8);
  check('and says it was inferred', r.estimated, true);
  // The plain count is never scaled: it was complete all along, and 「トークン数」
  // has to stay the tokens.
  check('the plain token count is untouched', r.totalTokens, 600_000);
}

// --- which is the whole point: the scaled figure is what refuses ----------------
{
  /*
   * A budget of $1. The stored weight is $0.60 and would pass; the month
   * actually cost $1.80. Before the ratio this request was allowed, and so were
   * the next several, because the row under-reported by exactly the factor it
   * was missing.
   */
  globalThis.__ddb = ledger({
    config: { monthlyTokenLimit: n(1_000_000) },
    month: {
      ...ONE_RECORDED,
      totalTokens: n(600_000), requestCount: n(3), weightedTokens: n(600_000),
    },
  });
  const r = await checkUsageLimit('u');
  check('a partial month past its budget is refused', [r.allowed, r.known], [false, true]);
}

// --- a month written entirely before the split has nothing to scale --------------
{
  /*
   * No `tok_*` at all, which is every August row. The ratio has no denominator,
   * so it is 1 and the stored figure stands — and `monthCost` reports null for
   * such a row anyway, because there is nothing to price.
   */
  globalThis.__ddb = ledger({
    config: { monthlyTokenLimit: n(-1) },
    month: { totalTokens: n(900_000), requestCount: n(4), weightedTokens: n(900_000) },
  });
  const r = await checkUsageLimit('u');
  check('a month with no split at all is not scaled', r.currentUsage, 900_000);
  check('and its cost is unknown rather than zero', [r.cost, r.estimated], [null, false]);
}

// --- and neither is a month that never ran -------------------------------------
{
  globalThis.__ddb = ledger({ config: { monthlyTokenLimit: n(-1) }, month: undefined });
  const r = await checkUsageLimit('u');
  check('an empty month is zero, not a division', [r.currentUsage, r.cost], [0, null]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
