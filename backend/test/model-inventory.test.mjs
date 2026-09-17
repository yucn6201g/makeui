/**
 * What the deployment is configured to run, reported from where it is set.
 *
 * Every figure the usage tab shows is a consequence of three things stored
 * outside the code — which profile each tier resolves to, what the price table
 * says, and whether that table is enforced — and none of them was visible
 * anywhere. Answering 「今月なぜこの金額なのか」 meant an `aws ssm get-parameter`
 * on a machine with credentials.
 *
 * The fixtures below are full ARNs, because that is what the parameters hold.
 * They were bare profile ids when this was written, and that is exactly what let
 * a defect through: `describeModelId` read from the START of the string, so on
 * every real value `scope` and `vendor` came back null and the panel drew 「—」
 * for the provider. The test passed. A fixture that is not the shape of the real
 * data tests the fixture.
 *
 *   node test/model-inventory.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/model-inventory.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/services/model-inventory.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});

/** Exactly the form `/makeui/models/sonnet` holds — checked against the live value. */
const ARN = (id) => 'arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/' + id;

const PARAMS = {
  '/makeui/models/haiku': ARN('jp.anthropic.claude-haiku-4-5-20251001-v1:0'),
  '/makeui/models/sonnet': ARN('jp.anthropic.claude-sonnet-4-6'),
  '/makeui/models/opus': ARN('jp.anthropic.claude-opus-4-8'),
  '/makeui/models/default': 'sonnet',
};

const { SSMClient } = await import('@aws-sdk/client-ssm');
let asked = [];
SSMClient.prototype.send = async function stub(command) {
  const name = command.constructor.name;
  if (name === 'GetParameterCommand') {
    asked.push(command.input.Name);
    return { Parameter: { Value: PARAMS[command.input.Name] ?? '' } };
  }
  throw new Error(`unstubbed: ${name}`);
};

process.env.MODEL_PRICING = JSON.stringify({
  currency: 'USD',
  models: {
    haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
});
process.env.AWS_REGION = 'ap-northeast-1';

const { getModelInventory, describeModelId } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- reading what Parameter Store actually holds ----------------------------
check('an ARN, which is what the parameters hold',
  describeModelId(ARN('jp.anthropic.claude-sonnet-4-6')),
  { scope: 'jp', vendor: 'anthropic', version: '4.6' });
check('and one carrying the snapshot too',
  describeModelId(ARN('jp.anthropic.claude-haiku-4-5-20251001-v1:0')),
  { scope: 'jp', vendor: 'anthropic', version: '4.5' });
// The scope is the difference between inference that stays in Japan and
// inference that does not — a policy question, not a configuration detail. It is
// the reason a working Opus profile was not adopted; see config/withdrawn.ts.
check('a global profile is not a jp one',
  describeModelId(ARN('global.anthropic.claude-opus-4-6-v1')).scope, 'global');
// The bare form still reads: the same field accepts either, and both have been
// in Parameter Store.
check('a bare profile id', describeModelId('jp.anthropic.claude-sonnet-4-6'),
  { scope: 'jp', vendor: 'anthropic', version: '4.6' });
check('and a bare model id with no scope', describeModelId('anthropic.claude-haiku-4-5-20251001-v1:0'),
  { scope: null, vendor: 'anthropic', version: '4.5' });
// Both spellings of a version: major-minor, and major alone. The minor is
// bounded at two digits because the snapshot date sits in the same position with
// the same separator — `claude-opus-5-20260601` once read as 5.20260601, and it
// labelled the composer's model chips.
check('a major-only version', describeModelId(ARN('jp.anthropic.claude-opus-5-20260601-v1:0')).version, '5');
check('something that is not a Claude id at all',
  describeModelId('amazon.titan-text-v1'), { scope: null, vendor: 'amazon', version: null });
check('an empty id', describeModelId(''), { scope: null, vendor: null, version: null });

// --- the inventory -----------------------------------------------------------
const inv = await getModelInventory();
check('one row per tier', inv.tiers.map((t) => t.id), ['haiku', 'sonnet', 'opus']);
/*
 * The profile Parameter Store holds, with the account id taken out before it
 * leaves the server — see utils/mask-account.ts. This asserted the raw ARN,
 * which is the assertion that would have kept the account id in the response.
 */
check('each carrying the profile Parameter Store holds, masked',
  inv.tiers.find((t) => t.id === 'sonnet').profile,
  ARN('jp.anthropic.claude-sonnet-4-6').replace(/:\d{12}:/, ':************:'));
check('and no account id reaches the response',
  inv.tiers.some((t) => /:\d{12}:/.test(t.profile)), false);
check('the version is read off it', inv.tiers.map((t) => t.version), ['4.5', '4.6', '4.8']);
// The half that was null on every real value before the ARN prefix was stripped.
check('and so is the vendor', inv.tiers.map((t) => t.vendor), ['anthropic', 'anthropic', 'anthropic']);
check('and the region scope', inv.tiers.map((t) => t.scope), ['jp', 'jp', 'jp']);
check('the default tier is marked', inv.tiers.filter((t) => t.isDefault).map((t) => t.id), ['sonnet']);
// A withdrawn tier keeps its row: removing it would answer
// 「Opusはどうなっているのか」 with silence, which is what the tab is for.
check('a withdrawn tier is still listed', inv.tiers.some((t) => t.id === 'opus'), true);
check('and flagged rather than dropped', inv.tiers.find((t) => t.id === 'opus').withdrawn, true);
check('the list of them is reported too', inv.withdrawn, ['opus']);
check('the provider is named rather than left to the reader', inv.provider, 'Amazon Bedrock');
check('with the region the profiles resolve in', inv.region, 'ap-northeast-1');

check('prices come from the table', inv.tiers.find((t) => t.id === 'haiku').prices,
  { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
// A tier the table does not cover is null, not zero: zero is a free model.
check('a tier the table does not cover has no prices',
  inv.tiers.find((t) => t.id === 'opus').prices, null);
check('the currency is reported', inv.pricing.currency, 'USD');
// Reported or enforced is the whole question when an account is over budget and
// still running — the flag is read in `checkUsageLimit` and nowhere else.
check('and whether the prices actually gate anything', typeof inv.pricing.enforced, 'boolean');

// --- nothing more than the four named reads ---------------------------------
/*
 * A Parameter Store listing sat here and is gone: it answered a question nobody
 * asks on this screen, and it cost `ssm:GetParametersByPath` — revoked with it,
 * on the live role as well as in the template, because the pipeline deploys code
 * and not CloudFormation.
 *
 * Asserted rather than assumed, because the permission is the thing that would
 * be quietly missing again if a listing came back.
 */
check('only the model parameters are read', [...new Set(asked)].sort(), [
  '/makeui/models/default', '/makeui/models/haiku', '/makeui/models/opus', '/makeui/models/sonnet',
]);
const service = fs.readFileSync(path.join(root, 'src/services/model-inventory.ts'), 'utf8');
check('the service no longer lists a path', /GetParametersByPath/.test(service), false);
check('nor reports parameters at all', /parameters:/.test(service), false);

// Comments stripped: the note explaining why the action went names it, and a
// check that cannot tell a grant from a sentence about a grant fails on its own
// explanation.
const infra = fs.readFileSync(path.join(root, '../infrastructure/template.yaml'), 'utf8')
  .replace(/^\s*#.*$/gm, '');
check('and the role no longer grants the listing', /ssm:GetParametersByPath/.test(infra), false);
// The account-wide listing call was never the alternative: it takes no resource,
// so granting it grants a listing of every parameter in the account.
check('nor the one that cannot be scoped', /ssm:DescribeParameters/.test(infra), false);
check('the named reads remain', /- ssm:GetParameter\n/.test(infra), true);

// --- and the route is super-admin only ---------------------------------------
const handler = fs.readFileSync(path.join(root, 'src/handlers/lambda-handler.ts'), 'utf8');
const route = handler.slice(handler.indexOf("path === '/admin/models'"), handler.indexOf("path === '/admin/models'") + 500);
check('the route exists', route.length > 0, true);
// It reports the account's own infrastructure, which is not a group
// administrator's business — their panel is scoped to their own people.
check('and refuses a group administrator', /isSuperAdmin\(auth\.membership\)/.test(route), true);
check('with 403', /jsonResponse\(403/.test(route), true);
// One reader for a model id, shared with the composer's chips.
check('the handler uses the same parser', /describeModelId\(modelId\)\.version/.test(handler), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
