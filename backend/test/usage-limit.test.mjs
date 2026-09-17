// A limit that cannot be read is not a limit of zero, and not the default.
//
// `checkUsageLimit` used to answer a failed DynamoDB read with `allowed: true`
// and a zeroed ledger. Every caller then spent on a limit it had not checked —
// and the failure that produces it is a throttle, which arrives under load,
// which is exactly when the limit is doing the most work. A guard whose failure
// mode correlates with what it guards against is not a guard.
//
// Both directions are asserted, because only one of them was ever in doubt:
// that it still allows a normal request, and that it now refuses an unreadable
// one. The third case is the one that hid the bug for so long — an UNSET limit
// and an UNREADABLE limit returned the same number, so nothing could tell them
// apart.
//
//   node test/usage-limit.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'dist/ddb.stub.mjs');
const out = path.join(root, 'dist/usage-limit.test.mjs');
fs.mkdirSync(path.dirname(stub), { recursive: true });

// Commands carry their input so the fake `send` can tell the CONFIG read from
// the month read; everything else in the module is untouched.
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
  // token-usage now pulls in display-name.ts for the fallback rule, and that
  // module reaches Cognito to resolve a signed-in user's own name. Nothing
  // here calls it; the stub exists so the bundle resolves.
  'export class AdminGetUserCommand extends Cmd {}',
].join('\n'));

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

const CONFIG = 'CONFIG';
/** `config` and `month` are each an item, or a function that throws. */
const ledger = ({ config, month }) => (cmd) => {
  const sk = cmd.input?.Key?.sk?.S ?? '';
  const answer = sk === CONFIG ? config : month;
  if (typeof answer === 'function') return answer();
  return { Item: answer };
};
const boom = () => { throw Object.assign(new Error('ProvisionedThroughputExceededException'), { name: 'ProvisionedThroughputExceededException' }); };

// 1. The ordinary case still works.
globalThis.__ddb = ledger({
  config: { monthlyTokenLimit: { N: '1000000' }, monthlyRequestLimit: { N: '100' } },
  month: { totalTokens: { N: '250000' }, requestCount: { N: '12' } },
});
let r = await checkUsageLimit('u');
check('under the limit is allowed', [r.allowed, r.known], [true, true]);
check('the figures are the stored ones', [r.currentUsage, r.limit, r.requestCount],
  [250000, 1000000, 12]);

// 2. Over the limit is still refused, and still says so.
globalThis.__ddb = ledger({
  config: { monthlyTokenLimit: { N: '1000000' }, monthlyRequestLimit: { N: '100' } },
  month: { totalTokens: { N: '1000001' }, requestCount: { N: '12' } },
});
r = await checkUsageLimit('u');
check('over the token limit is refused as known', [r.allowed, r.known], [false, true]);

/*
 * The request count is reported and no longer capped.
 *
 * There was a `monthlyRequestLimit` beside the token one, unlimited by default
 * and set on no account. What it guarded is the per-request infrastructure —
 * AgentCore, DynamoDB, S3, API Gateway — which came to $0.24 over five days
 * against $18.44 of model spend: 1.3% of variable cost, and already implied by
 * a budget, since a request that costs anything costs money.
 */
globalThis.__ddb = ledger({
  config: { monthlyTokenLimit: { N: '1000000' } },
  month: { totalTokens: { N: '10' }, requestCount: { N: '100000' } },
});
r = await checkUsageLimit('u');
check('a large request count on its own is not a refusal', [r.allowed, r.known], [true, true]);
check('and the count is still reported', r.requestCount, 100000);

/*
 * 3. Unset is a fact: the default applies, and the answer is known.
 *
 * The default was 1,000,000, which is a generation and a half — a run measures
 * 237,529 tokens and weighs 673,369 against the price table — so the first
 * account to sign up would have been refused partway through its second. Every
 * existing account is set to -1, which is what that default produced in
 * practice. 10,000,000 is ten dollars a month, and a weighted token is a
 * millionth of one.
 */
globalThis.__ddb = ledger({ config: undefined, month: undefined });
r = await checkUsageLimit('u');
check('an unset limit is the default, and known', [r.allowed, r.known, r.limit, r.currentUsage],
  [true, true, 10000000, 0]);

// 4. Unreadable is not a fact. This is the change.
globalThis.__ddb = ledger({ config: boom, month: { totalTokens: { N: '10' }, requestCount: { N: '1' } } });
r = await checkUsageLimit('u');
check('an unreadable CONFIG refuses and says it does not know', [r.allowed, r.known], [false, false]);

globalThis.__ddb = ledger({ config: { monthlyTokenLimit: { N: '1000000' } }, month: boom });
r = await checkUsageLimit('u');
check('an unreadable month refuses and says it does not know', [r.allowed, r.known], [false, false]);

globalThis.__ddb = boom;
r = await checkUsageLimit('u');
check('a table that is entirely unreachable refuses', [r.allowed, r.known], [false, false]);

// The distinction the whole change rests on: these two used to be identical.
globalThis.__ddb = ledger({ config: undefined, month: undefined });
const unset = await checkUsageLimit('u');
globalThis.__ddb = ledger({ config: boom, month: undefined });
const unreadable = await checkUsageLimit('u');
check('unset and unreadable are now distinguishable', unset.known === unreadable.known, false);

// --- The other guard on the same table ---------------------------------------
//
// `checkRateLimit` reads `makeui-token-usage` too, and failed open in the same
// way. Together that meant ONE table failure removed every spend guard the
// product has — and the failure most likely to happen is a throttle, which
// happens under load. Fixing only one of them would have left the endpoints that
// rate-limit WITHOUT a usage check — `/design-system/upload` and
// `/design-system/import` — with no guard at all.
const rlOut = path.join(root, 'dist/rate-limit.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/middleware/rate-limiter.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: rlOut,
  plugins: [{ name: 'stub-aws', setup(b) { b.onResolve({ filter: /^@aws-sdk\// }, () => ({ path: stub })); } }],
});
const { checkRateLimit } = await import(pathToFileURL(rlOut).href);

// A fresh bucket: no stored item, so the module starts the user at capacity.
globalThis.__ddb = () => ({});
let rl = await checkRateLimit('u', 'haiku');
check('a fresh bucket allows', [rl.allowed, rl.known ?? true], [true, true]);

// An exhausted daily budget is still a refusal the caller can explain.
globalThis.__ddb = (cmd) => {
  if (cmd.input?.UpdateExpression) return {};
  return { Item: { dailySpent: { N: '999999' }, points: { N: '100' }, lastRefill: { N: String(Date.now()) } } };
};
rl = await checkRateLimit('u', 'haiku');
check('an exhausted budget refuses as known', [rl.allowed, rl.known ?? true], [false, true]);

globalThis.__ddb = boom;
rl = await checkRateLimit('u', 'haiku');
check('an unreadable bucket refuses and says it does not know', [rl.allowed, rl.known], [false, false]);

// --- The third guard on the same item ----------------------------------------
//
// `getUserAllowedModels` reads the SAME CONFIG item as the two limit getters,
// and failed open to every model including Opus. It is not a preference: it is
// the clamp `decideTier` rounds into, so a failed read did not lose a setting,
// it removed the restriction. A user held to Haiku ran on Opus — and so did a
// user who simply picked `auto`, because with the clamp gone the top of the set
// was Opus.
//
// The fallback is Haiku rather than a refusal because Haiku is the cheapest
// tier, and a spend guard should fail downward. The subset claim that would
// have been stronger — "Haiku is in every storable set" — is FALSE, and the
// assertion below is what disproved it.
const { getUserAllowedModels, allowedModelsForRun } = await import(pathToFileURL(out).href);
const ALL = ['haiku', 'sonnet', 'opus', 'auto'];

globalThis.__ddb = ledger({ config: { allowedModels: { SS: ['haiku', 'sonnet'] } }, month: undefined });
check('a stored set is returned', await getUserAllowedModels('u'), ['haiku', 'sonnet']);

globalThis.__ddb = ledger({ config: { modelAllowance: { S: 'no-opus' } }, month: undefined });
check('a legacy ladder still expands', await getUserAllowedModels('u'), ['haiku', 'sonnet']);

// Unset is a fact about this user, read from the store.
globalThis.__ddb = ledger({ config: undefined, month: undefined });
check('unset is unrestricted', await getUserAllowedModels('u'), ALL);
check('unset runs unrestricted', await allowedModelsForRun('u'), ALL);

// Unreadable is not.
globalThis.__ddb = ledger({ config: boom, month: undefined });
check('unreadable is null, not a set', await getUserAllowedModels('u'), null);
check('an unreadable clamp falls to haiku, not to everything', await allowedModelsForRun('u'), ['haiku']);

/*
 * Every ladder contains Haiku. A checkbox set need not — `normalizeModelSet`
 * requires one real tier, not Haiku — so `opus` alone is storable, and that
 * user is handed Haiku by the fallback: a tier they were not granted.
 *
 * Recorded rather than fixed. What the guard bounds is spend, and Haiku is the
 * cheapest tier, so the substitution can only make a run worse and never more
 * expensive. This assertion exists so the exceptions stay a known list: if a
 * tier CHEAPER than Haiku is ever added, the fallback has to move with it.
 */
const withoutHaiku = [];
for (const config of [
  { allowedModels: { SS: ['opus'] } },
  { allowedModels: { SS: ['sonnet', 'opus'] } },
  { modelAllowance: { S: 'haiku' } },
  { modelAllowance: { S: 'opus' } },
  { modelAllowance: { S: 'all' } },
]) {
  globalThis.__ddb = ledger({ config, month: undefined });
  const set = await getUserAllowedModels('u');
  if (!set || !set.includes('haiku')) withoutHaiku.push(JSON.stringify(config));
}
check('only checkbox sets can exclude haiku; every ladder includes it', withoutHaiku,
  ['{"allowedModels":{"SS":["opus"]}}', '{"allowedModels":{"SS":["sonnet","opus"]}}']);

// --- Recording the spend, which happens once and cannot be redone ------------
//
// The two writes were in one try, event first, aggregate second. That put the
// audit row in front of the enforcement row: a transient failure writing the
// event — which nothing reads — skipped the aggregate entirely, and the
// aggregate is the only thing `checkUsageLimit` and `getUsageHistory` consult.
// A failure in the write that does not matter discarded the write that does,
// and the month under-counted for good.
const { recordUsage } = await import(pathToFileURL(out).href);

/** Records every send, and fails the named kind for its first `failures` tries. */
const recorder = (failures = {}) => {
  const calls = [];
  const seen = { aggregate: 0, event: 0 };
  const fn = (cmd) => {
    const item = cmd.input?.Item?.sk?.S;
    const key = cmd.input?.Key?.sk?.S;
    const kind = item?.startsWith('EVENT#') ? 'event' : key?.startsWith('MONTH#') ? 'aggregate' : 'other';
    calls.push({ kind, sk: item ?? key, ttl: cmd.input?.Item?.ttl?.N });
    seen[kind] = (seen[kind] ?? 0) + 1;
    if ((failures[kind] ?? 0) >= seen[kind]) throw new Error('ProvisionedThroughputExceededException');
    return {};
  };
  fn.calls = calls;
  return fn;
};
const USE = { inputTokens: 1000, outputTokens: 500, model: 'haiku' };

let rec = recorder();
globalThis.__ddb = rec;
await recordUsage('u', USE);
check('one aggregate and one event', rec.calls.map((c) => c.kind), ['aggregate', 'event']);
/*
 * The event expires; the aggregate does not.
 *
 * An event is per-request detail nothing reads today, kept only because it is
 * the one thing that could answer "which model is the spend going to" — and
 * only since the model column stopped naming the pipeline. The aggregate is
 * what the limits are enforced against, so a TTL on it would delete the ledger.
 */
const evCall = rec.calls.find((c) => c.kind === 'event');
const agCall = rec.calls.find((c) => c.kind === 'aggregate');
check('the event carries a ttl', typeof evCall.ttl, 'string');
check('and the aggregate carries none', agCall.ttl, undefined);
// 13 months, so the same month last year still has both ends.
const days = (Number(evCall.ttl) - Date.now() / 1000) / 86400;
check('the ttl is about 400 days out', Math.round(days / 10) * 10, 400);
check('the aggregate goes first, because it is the one that gates', rec.calls[0].kind, 'aggregate');

// The old bug, reversed: the audit row must not be able to cost the ledger row.
rec = recorder({ event: 99 });
globalThis.__ddb = rec;
await recordUsage('u', USE);
check('a failing event still leaves the aggregate written',
  rec.calls.filter((c) => c.kind === 'aggregate').length, 1);
// Retried, and each retry writes the SAME row rather than a second one.
const eventSks = new Set(rec.calls.filter((c) => c.kind === 'event').map((c) => c.sk));
check('the event was retried', rec.calls.filter((c) => c.kind === 'event').length, 3);
check('every event retry writes the same key', eventSks.size, 1);

// And the other direction.
rec = recorder({ aggregate: 99 });
globalThis.__ddb = rec;
await recordUsage('u', USE);
check('a failing aggregate still leaves the event written',
  rec.calls.filter((c) => c.kind === 'event').length, 1);

// A throttle that passes is a throttle that cost nothing.
rec = recorder({ aggregate: 1 });
globalThis.__ddb = rec;
await recordUsage('u', USE);
check('an aggregate that fails once is retried and lands',
  rec.calls.filter((c) => c.kind === 'aggregate').length, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
