/**
 * `auto` must not choose a model this account cannot invoke.
 *
 * Opus is withdrawn — the account's throughput allocation for it is zero, see
 * config/withdrawn.ts — and the classifier was still shown all three tiers. It
 * would answer `opus`, `decideTier` would clamp that to Sonnet, and the sentence
 * the user read was the classifier's own with a parenthesis stapled on:
 *
 *   「品質重視の依頼と判断し、最高品質のモデルを選びました（管理者の設定により
 *    sonnet に制限）」
 *
 * Every clause of which is wrong. No administrator set anything; the model that
 * ran was not the highest quality; and somebody acting on it would go looking at
 * a setting that has nothing to do with the cause. The clamp was where it became
 * visible, not where it went wrong — asking a question whose answer cannot be
 * honoured is the defect.
 *
 * So the router is told what can be run. Bedrock is stubbed at the prototype, so
 * the real prompt is built, the real reply is parsed, and the assertions are
 * about what came back rather than about the shape of the source.
 *
 *   node test/auto-model-tiers.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/auto-tiers.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/generate/workflow-router.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});

const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
/** What the classifier will answer, and the system prompt it was given. */
let reply = '{"tier":"opus","reason":"大規模な依頼です"}';
let lastSystem = '';
let calls = 0;
BedrockRuntimeClient.prototype.send = async function stub(command) {
  calls += 1;
  const body = JSON.parse(command.input.body);
  lastSystem = body.system;
  if (reply === null) throw new Error('AccessDeniedException');
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: reply }] })) };
};

const { selectModelForPrompt } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const OFFERED = ['haiku', 'sonnet'];

// --- the prompt names only what can be run ---------------------------------
reply = '{"tier":"sonnet","reason":"標準的な依頼です"}';
await selectModelForPrompt('在庫管理アプリを作って', 'model-x', OFFERED);
check('a withdrawn tier is not described to the classifier', /opus/i.test(lastSystem), false);
check('the ones that remain are', [/haiku/.test(lastSystem), /sonnet/.test(lastSystem)], [true, true]);
// The JSON contract has to match the list, or the model answers outside it.
check('and the reply schema lists exactly those', /\{"tier":"haiku\|sonnet"/.test(lastSystem), true);
// The "high bar" rule pointed at opus by name. Left alone it asks for a tier
// that was just removed from the list above it.
check('the quality signal points at the top of what is offered',
  /naming a high bar is a signal for "sonnet"/.test(lastSystem), true);

// With everything available the prompt is the one it always was.
await selectModelForPrompt('在庫管理アプリを作って', 'model-x', ['haiku', 'sonnet', 'opus']);
check('all three are described when all three can run', /opus    Slowest/.test(lastSystem), true);
check('and the schema says so', /\{"tier":"haiku\|sonnet\|opus"/.test(lastSystem), true);

// --- an answer outside the offered set is not honoured ----------------------
// A model told to choose from two can still say the third; honouring it would
// put the clamp — and the sentence that goes with it — straight back.
reply = '{"tier":"opus","reason":"大規模な依頼と判断しました"}';
const rogue = await selectModelForPrompt('大規模な業務システムを作って', 'model-x', OFFERED);
check('a classifier that answers opus anyway is refused', rogue.tier === 'opus', false);
check('and the offered set is what it lands in', OFFERED.includes(rogue.tier), true);
check('falling back rather than clamping', rogue.routed, false);

// --- the keyword fallback, for when the classifier is unavailable ----------
reply = null; // the call throws; `classify` catches and returns null
const roughAsk = await selectModelForPrompt('ざっくりでいいので作って', 'model-x', OFFERED);
check('a rough brief still lands on haiku', roughAsk.tier, 'haiku');
const qualityAsk = await selectModelForPrompt('本番で使うので作り込んでください', 'model-x', OFFERED);
check('a quality brief lands on the top of what is offered', qualityAsk.tier, 'sonnet');
// The sentence, which is the half that was lying.
check('and does not call sonnet the highest-quality model',
  qualityAsk.reason.includes('最高品質'), false);
check('it says what it actually did',
  qualityAsk.reason.includes('利用できる中で最も品質の高いモデル'), true);
// With Opus available the original wording is unchanged.
const qualityAll = await selectModelForPrompt('本番で使うので作り込んでください', 'model-x', ['haiku', 'sonnet', 'opus']);
check('with opus offered, the quality brief still reaches it', qualityAll.tier, 'opus');
check('and keeps the sentence it always had', qualityAll.reason.includes('最高品質'), true);
const plainAsk = await selectModelForPrompt('ダッシュボードを作って', 'model-x', OFFERED);
check('an ordinary brief is sonnet', plainAsk.tier, 'sonnet');

// A single-tier deployment must still answer rather than reach for a tier that
// is not there.
const onlyHaiku = await selectModelForPrompt('本番で使うので作り込んでください', 'model-x', ['haiku']);
check('one tier offered is the only possible answer', onlyHaiku.tier, 'haiku');

// --- and the resolver hands the offered set over ---------------------------
const cfg = fs.readFileSync(path.join(root, 'src/config/model-config.ts'), 'utf8');
check('resolveModelForPrompt passes what this build offers',
  /selectModelForPrompt\(prompt, config\.haikuId, offeredTiers\(\)\)/.test(cfg), true);
// `offeredTiers` is the one place a withdrawal is read, and it already filters.
check('and that set is filtered by the withdrawal list',
  /\(\['haiku', 'sonnet', 'opus'\] as Tier\[\]\)\.filter\(\(t\) => !isWithdrawnModel\(t\)\)/.test(cfg), true);
// The clamp stays: an administrator's permitted set is a different thing, and
// its message — 「管理者の設定により」 — is true.
check('the permitted-set clamp is untouched', /const decided = decideTier\(model, allowed, selection\.tier\)/.test(cfg), true);

check('every case above actually called the router', calls > 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
