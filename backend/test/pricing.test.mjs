/**
 * The limit counts tokens; AWS bills money. This is the gap, and what closes it.
 *
 * Measured on this account before any of it existed:
 *
 *   input 5,954,020 / output 4,497,258 over 44 runs — output is 43% of what the
 *     limit counts, and does not cost what input costs;
 *   cache read 417,685 + write 916,921 — billed, and counted by nothing. 12.8%
 *     of the tokens the limit saw, spent invisibly;
 *   170 requests in the monthly aggregates against nine surviving EVENT rows —
 *     the model was recorded only on the row that expires, so the row the limit
 *     is enforced against could not say what the spend went to.
 *
 * The prices themselves are not in the repository and are not in here. AWS's
 * Pricing API returns Claude 2.0, 2.1, 3 Haiku and 3 Sonnet for ap-northeast-1
 * and none of the models this project runs, so a table written from memory would
 * age silently and need a deploy to correct. `MODEL_PRICING` is configuration,
 * and with none set every weight is 1 and nothing moves.
 *
 *   node test/pricing.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/pricing-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, "export { pricingTable, forgetPricing, costOf, weighTokens, pricingEnforced, limitAsCurrency, currencyAsLimit } from '../src/config/pricing.js';\n");
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/pricing.test.mjs')}" --external:@aws-sdk/*`,
  { stdio: 'pipe', cwd: root }
);
const { pricingTable, forgetPricing, costOf, weighTokens, pricingEnforced, limitAsCurrency, currencyAsLimit } = await import(
  pathToFileURL(path.join(root, 'dist/pricing.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const set = (value) => {
  if (value === undefined) delete process.env.MODEL_PRICING;
  else process.env.MODEL_PRICING = value;
  forgetPricing();
};

/** A table whose numbers are invented for the test and are not anybody's prices. */
const TABLE = JSON.stringify({
  currency: 'USD',
  models: {
    cheap: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    dear: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
});

const split = (i, o, cr = 0, cw = 0) => ({
  inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw,
});

// --- with no table, nothing moves ----------------------------------------------------
{
  set(undefined);
  check('no table is null, not an empty one', pricingTable(), null);
  check('and a request has no cost', costOf('cheap', split(100, 10)), null);
  /*
   * The weight is exactly what the limit counted before: input plus output, and
   * cache excluded. Adding 12.8% to everybody on a weight of 1 would tighten
   * every limit by that much without anyone deciding to.
   */
  check('the weight is the old count', weighTokens('cheap', split(1000, 100, 500, 200)), 1100);
}

// --- a malformed table is no table ----------------------------------------------------
{
  set('not json at all');
  check('unparsable is null', pricingTable(), null);

  set(JSON.stringify({ models: { cheap: { input: 1, output: 5 } } }));
  check('a model missing a price is dropped', pricingTable(), null);

  set(JSON.stringify({ models: { cheap: { input: 1, output: 5, cacheRead: -1, cacheWrite: 1 } } }));
  check('and a negative price is not a price', pricingTable(), null);

  set(JSON.stringify({ models: {} }));
  check('an empty model list is null', pricingTable(), null);
}

// --- with a table, the four kinds are priced apart --------------------------------------
{
  set(TABLE);
  check('the currency is carried', pricingTable().currency, 'USD');

  // 1,000,000 input at 1 per million.
  check('input is priced', costOf('cheap', split(1_000_000, 0)), 1);
  check('output is priced separately', costOf('cheap', split(0, 1_000_000)), 5);
  check('and so is each half of the cache',
    [costOf('cheap', split(0, 0, 1_000_000, 0)), costOf('cheap', split(0, 0, 0, 1_000_000))], [0.1, 1.25]);
  check('a model with no price has no cost', costOf('unknown-tier', split(1_000_000, 0)), null);
}

// --- the weight keeps the meaning of an existing limit ------------------------------------
{
  set(TABLE);
  /*
   * One weighted token is one millionth of a unit of currency, fixed. It was
   * "the cheapest input in the table", which happened to equal this and would
   * have stopped the day that model was repriced — moving what every stored
   * limit meant without anybody editing one.
   */
  check('a dollar of input weighs a million', weighTokens('cheap', split(1_000_000, 0)), 1_000_000);
  check('five dollars of output weighs five million', weighTokens('cheap', split(0, 1_000_000)), 5_000_000);
  check('the dearer model costs three times as much', weighTokens('dear', split(1_000_000, 0)), 3_000_000);
  check('and cache is now counted', weighTokens('cheap', split(0, 0, 1_000_000, 1_000_000)), 1_350_000);

  /*
   * The identity that makes a limit readable: the weight IS the cost, in
   * millionths. A repricing must not change it.
   */
  check('the weight is the cost in millionths',
    weighTokens('dear', split(1_000_000, 1_000_000)), Math.round(costOf('dear', split(1_000_000, 1_000_000)) * 1e6));
  check('and a limit converts both ways',
    [limitAsCurrency(10_000_000), currencyAsLimit(10)], [10, 10_000_000]);

  /*
   * A tier the table does not price falls back to the plain count rather than to
   * zero. Free is the one answer that must not be produced by a missing row.
   */
  check('an unpriced tier falls back to the plain count',
    weighTokens('unknown-tier', split(1000, 100, 500, 200)), 1100);
}

// --- having prices and refusing on them are two switches -------------------------------
{
  const enforce = (on) => {
    if (on) process.env.MODEL_PRICING_ENFORCE = '1';
    else delete process.env.MODEL_PRICING_ENFORCE;
  };

  set(TABLE); enforce(false);
  check('a table alone does not move the limit', pricingEnforced(), false);
  check('but it still prices', typeof costOf('cheap', split(1000, 100)), 'number');

  enforce(true);
  check('the flag with a table enforces', pricingEnforced(), true);

  /*
   * The flag without a table is nothing. Enforcing on a weighted count that
   * equals the plain one would be the old behaviour wearing a new name, and a
   * mistyped table would look like it had been applied.
   */
  set(undefined);
  check('the flag alone does not', pricingEnforced(), false);
  enforce(false); set(TABLE);
}

// --- the recording path carries all four, and the row remembers the model ---------------
{
  const usage = fs.readFileSync(path.join(root, 'src/services/token-usage.ts'), 'utf8');

  check('the record accepts the cache halves',
    /cacheReadTokens\?: number;\s*cacheWriteTokens\?: number;/.test(usage), true);
  check('the aggregate stores them', /cacheReadTokens :cread, cacheWriteTokens :cwrite/.test(usage), true);
  check('and the weighted count beside them', /weightedTokens :weighted/.test(usage), true);

  /*
   * Per model, on the row the limit is read from. `ADD` on an attribute named
   * after the model creates it on first use, so a new tier needs no migration —
   * and the model is no longer knowable only from the row that expires.
   */
  check('the aggregate counts per model', /tok_\$\{key\}_in :input/.test(usage), true);
  check('including its requests', /tok_\$\{key\}_req :one/.test(usage), true);
  check('through a name DynamoDB accepts', /function safeModelKey/.test(usage), true);

  /*
   * `totalTokens` is untouched. Every stored month was measured in it, and a
   * column that changes meaning is a column no comparison can use.
   */
  check('totalTokens is still input plus output',
    /const totalTokens = usage\.inputTokens \+ usage\.outputTokens;/.test(usage), true);

  // And enforcement reads the weighted figure only when there is a table.
  check('the limit prefers the weighted count', /priced && weightedUsage !== null \? weightedUsage : plainUsage/.test(usage), true);
  check('and only when enforcement is switched on', /const priced = pricingEnforced\(\);/.test(usage), true);
  check('and says which it used', /weighted: priced && weightedUsage !== null/.test(usage), true);
  /*
   * A month stored before the weighted column exists has none. Reading zero from
   * it would hand that user a fresh budget they had already spent.
   */
  check('a month without one falls back rather than reading zero',
    /weightedUsage = item\?\.weightedTokens\?\.N\s*\?\s*Math\.round\(parseInt/.test(usage), true);
  /*
   * And a month that HAS one, but only for some of its requests, is scaled up
   * to all of them — see `splitCoverage` and split-coverage.test.mjs. The
   * stored weight only covers the requests that recorded a model, and comparing
   * that lower bound against the budget is the permissive direction.
   */
  check('a partially recorded month is scaled to the whole',
    /\* splitCoverage\(item\)/.test(usage), true);
}

// --- the ledger's cache figures actually reach it ------------------------------------------
{
  const runner = fs.readFileSync(path.join(root, 'src/handlers/job-runner.ts'), 'utf8');
  const calls = [...runner.matchAll(/recordUsage\(userId, \{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  check('every recordUsage call was found', calls.length, 3);
  check('and every one passes the cache halves',
    calls.filter((c) => !/cacheReadTokens/.test(c) || !/cacheWriteTokens/.test(c)), []);

  const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
  check('which the run reports from its ledger',
    /cacheReadTokens: ledger\.cacheReadTokens, cacheWriteTokens: ledger\.cacheWriteTokens/.test(graph), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
