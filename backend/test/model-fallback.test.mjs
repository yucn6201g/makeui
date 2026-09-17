// A model the account cannot invoke must not take the whole generation with it.
//
// 思考モード asks for Opus. Measured 2026-09-04: every Opus this account can
// reach is a `global.` inference profile, the runtime role permits only
// `inference-profile/jp.anthropic.*`, and the two `jp.` Opus profiles report
// `agreementAvailability: NOT_AVAILABLE`. So the first call throws
// `AccessDeniedException` and the run ends on 「サーバー側の設定に問題があり…」
// with no UI in it — for every 思考モード request, every time.
//
// The fallback is only worth having if it is narrow. A refusal of the MODEL is a
// standing fact about the account and there is nothing to do but use another
// one; a refusal of the REQUEST, or a throttle, or anything else, must still be
// thrown, because silently downgrading a run on a transient error would answer a
// rate limit by spending the rest of the day on the wrong model.
//
//   node test/model-fallback.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the classifier, against the message Bedrock actually sends ---------------
//
// Read out of the source rather than restated here. A copy of the regex would
// agree with itself forever.
const src = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
const body = /function isModelRefusal\(e: unknown\): boolean \{([\s\S]*?)\n\}/.exec(src);
check('the classifier is where the test thinks it is', Boolean(body), true);

const isModelRefusal = new Function('e', `
  const name = e?.name ?? '';
  const message = e instanceof Error ? e.message : String(e);
  ${body[1].split('return')[1].replace(/^\s*/, 'return ')}
`);

/** The exact text of the failure this exists for, from the CLI on 2026-09-04. */
const REAL = Object.assign(
  new Error('anthropic.claude-opus-4-8 is not available for this account. You can explore other available models on Amazon Bedrock.'),
  { name: 'AccessDeniedException' }
);
check('the measured refusal is recognised', isModelRefusal(REAL), true);

// The IAM half of the same failure: the role permits jp.anthropic.* only, so a
// global. profile is refused before Bedrock is asked. Different cause, same
// remedy, and the run must survive both.
check('an IAM refusal naming the profile is recognised', isModelRefusal(Object.assign(
  new Error('User is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/global.anthropic.claude-opus-4-5-20251101-v1:0'),
  { name: 'AccessDeniedException' }
)), true);

// --- and everything that must still be thrown ---------------------------------
//
// `Too many tokens per day` was 34 of the recorded failures. Answering it by
// moving to a cheaper model would hide the account's real limit behind quietly
// worse output, on every run for the rest of the day.
for (const [name, e] of [
  ['a daily token throttle', Object.assign(new Error('Too many tokens per day, please wait before trying again.'), { name: 'ThrottlingException' })],
  ['an ordinary throttle', Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' })],
  ['a bad request', Object.assign(new Error('max_tokens: 200000 exceeds the maximum'), { name: 'ValidationException' })],
  ['a timeout', Object.assign(new Error('socket hang up'), { name: 'TimeoutError' })],
  // Access denied on something that is not the model — S3, a guardrail, a KB.
  ['a denial that is not about a model', Object.assign(
    new Error('User is not authorized to perform: bedrock:ApplyGuardrail on resource: arn:aws:bedrock:ap-northeast-1:123456789012:guardrail/abc'),
    { name: 'AccessDeniedException' })],
]) check(`${name} is still thrown`, isModelRefusal(e), false);

// --- one step down, and only one ----------------------------------------------
execSync(
  `npx esbuild "${path.join(root, 'src/config/model-config.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/mc.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const mc = fs.readFileSync(path.join(root, 'dist/mc.test.mjs'), 'utf8');
// getModelConfig reads SSM; stub it rather than reach the network.
const stubbed = mc.replace(
  /async function getModelConfig\([\s\S]*?\n\}/,
  `async function getModelConfig() { return { opusId: 'OPUS', sonnetId: 'SONNET', haikuId: 'HAIKU', defaultModel: 'sonnet' }; }`
);
const stubPath = path.join(root, 'dist/mc.stub.test.mjs');
fs.writeFileSync(stubPath, stubbed);
const { nextModelDown } = await import(pathToFileURL(stubPath).href);

check('opus falls to sonnet', await nextModelDown('OPUS'), 'SONNET');
check('sonnet falls to haiku', await nextModelDown('SONNET'), 'HAIKU');
/*
 * Haiku has nowhere to go, and that is the answer rather than a gap. If the
 * cheapest model in the account is refused, the configuration is wrong and the
 * run should say so — inventing a further step would only mean failing later
 * with a less useful message.
 */
check('haiku falls nowhere', await nextModelDown('HAIKU'), null);
check('an unrecognised id falls nowhere', await nextModelDown('something-else'), null);

// --- the wiring ---------------------------------------------------------------
//
// The streaming path is the single call that assembles the whole document. A
// fallback covering only the other one would rescue every step of a run except
// the one that produces the UI, which is the failure mode worth a test.
// Whitespace-flattened rather than matched with a regex: this file is written
// through a heredoc often enough that a \\s in a pattern is a real hazard, and the
// thing being asserted is the shape of the call, not its indentation.
const flat = src.replace(/\s+/g, ' ');
for (const cmd of ['InvokeModelWithResponseStreamCommand', 'InvokeModelCommand']) {
  check(`${cmd} goes through the fallback`,
    flat.includes(`withModelFallback(modelId, where, (id) => bedrockClient.send(new ${cmd}({ modelId: id,`),
    true);
}
/*
 * And the refused id is not what gets sent. `modelId` inside the wrapper would
 * type-check, run, and quietly defeat the whole thing — the fallback would pick
 * a replacement and then ignore it.
 */
check('nothing inside the wrapper still sends the refused id',
  flat.includes('withModelFallback(modelId, where, (id) => bedrockClient.send(new InvokeModelCommand({ modelId,'),
  false);

// The run has to be able to say it happened. `modelTier` stays what was ASKED
// for, so without this a substituted run is indistinguishable from one that got
// what it asked for.
check('the substitution reaches the metadata',
  flat.includes('modelUnavailable?: { asked: string; used: string }'), true);
check('and is filled in from the map',
  flat.includes('modelUnavailable: { asked: selectedModel.modelId, used: modelSubstitution(selectedModel.modelId) as string,'),
  true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
