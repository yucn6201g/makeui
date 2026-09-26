// Whether the framework-confusion repair actually repairs.
//
// `react-bundle.test.mjs` proves the detector: it fires on a Svelte or Vue
// script that returns JSX and stays silent on clean files of both kinds. That is
// the half a test can prove. The other half needs a model, because this is the
// one shape deliberately left to one — rewriting it means deciding where the
// conditional ends and what the other branch renders, and a wrong guess ships a
// wrong interface rather than a blank one.
//
// So the question here is not whether a model can be prompted into producing the
// defect. It is whether the repair works when the defect is present, and that
// input can be taken rather than waited for: scanning 633 generated documents in
// the output bucket turned up a real one, twice — a stored output and its
// version row, both carrying `EquipmentDetailScreen.svelte` with an early return
// of JSX from its `<script>`.
//
// Worth knowing about that document: it does not compile, and the compiler's
// message names a DIFFERENT file — a `$derived` placement error in
// `EquipmentListScreen.svelte`, because compilation stops at the first failure.
// The framework confusion appears nowhere in it. That is the whole argument for
// having a detector at all, sitting in the corpus by accident.
//
// The measure that matters is the last one. The cheap way to make this file
// compile is to delete the early return, which loses the empty state — a project
// that builds and has silently dropped a screen. 「備品が見つかりません」 exists
// only in that branch, so its survival, and its arrival in the markup rather
// than the script, is the difference between a repair and a deletion.
//
// Two model calls, about 10k tokens on Haiku, because the repair sends one file
// rather than a document.
//
//   node test/framework-confusion.probe.mjs      (from backend/)
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REGION = 'ap-northeast-1';
const BUCKET = 'makeui-outputs-123456789012';
// Found by scanning every document under versions/ and outputs/ with the
// detector. Hardcoded rather than rescanned: downloading 878 objects to
// rediscover the same one is minutes for no extra information, and if this key
// ever disappears the probe should say so rather than quietly test nothing.
const KEY = 'outputs/fw-bench/2026-08-14/46c72570-54a4-4834-8b7a-595ef8ffba8b.html';
const TARGET = 'src/screens/EquipmentDetailScreen.svelte';
const MODEL = 'arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/jp.anthropic.claude-haiku-4-5-20251001-v1:0';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/fc-probe-entry.mjs');
fs.writeFileSync(entry, [
  "export { frameworkConfusionDefects } from '../src/tools/project/react-bundle.js'",
  "export { planFileRepairs, repairFiles, sourceFiles, parses } from '../src/orchestration/repair/repair-files.js'",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --target=node22 ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/fc-probe.mjs')}" --external:@aws-sdk/*`,
  { stdio: 'pipe', cwd: root }
);
const m = await import(pathToFileURL(path.join(root, 'dist/fc-probe.mjs')).href);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
  ok ? pass++ : fail++;
};

const bedrock = new BedrockRuntimeClient({ region: REGION });
let calls = 0, inTok = 0, outTok = 0;
const invoke = (maxTokens) => async (system, user) => {
  calls++;
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    }),
  }));
  const parsed = JSON.parse(new TextDecoder().decode(res.body));
  inTok += parsed.usage?.input_tokens ?? 0;
  outTok += parsed.usage?.output_tokens ?? 0;
  return (parsed.content ?? []).map((c) => c.text ?? '').join('');
};

let doc;
try {
  doc = await (await new S3Client({ region: REGION })
    .send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }))).Body.transformToString();
} catch (e) {
  console.log(`FAIL  the corpus document is gone (${KEY})`);
  console.log(`      ${e}`);
  console.log('      rescan versions/ and outputs/ with frameworkConfusionDefects for another');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

// --- the defect is there to begin with -------------------------------------
const before = m.frameworkConfusionDefects(doc, 'svelte');
check('the corpus document still carries the defect',
  before.some((d) => d.id === 'framework-confusion'), before.map((d) => d.id).join(', ') || 'none');

const beforeBody = m.sourceFiles(doc).get(TARGET);
check('the affected file does not parse before the repair',
  typeof m.parses(TARGET, beforeBody) === 'string', m.parses(TARGET, beforeBody) ?? 'it parsed');

const EMPTY_STATE = '備品が見つかりません';
check('the empty state exists before the repair', beforeBody.includes(EMPTY_STATE));

// --- the repair, driven exactly as the pipeline drives it -------------------
const plans = await m.planFileRepairs(doc, before, invoke(2000));
check('the planner assigns the defect to the file that has it',
  plans.some((p) => p.path === TARGET), plans.map((p) => p.path).join(', ') || '(no plan)');
if (plans.length === 0) { console.log('\n0 passed, 1 failed'); process.exit(1); }

const { html, written } = await m.repairFiles(doc, plans, invoke(16000));
check('the file was rewritten', written.includes(TARGET), written.join(', ') || '(nothing written)');

// --- and it is a repair, not a deletion -------------------------------------
const after = m.frameworkConfusionDefects(html, 'svelte');
check('the detector goes quiet', after.length === 0, after.map((d) => d.id).join(', '));

const afterBody = m.sourceFiles(html).get(TARGET);
check('the file parses afterwards', m.parses(TARGET, afterBody) === null, m.parses(TARGET, afterBody));
check('no JSX is returned from the script any more',
  !/return\s*\(\s*</.test(afterBody.slice(0, afterBody.indexOf('</script>'))));

check('the empty state survived', afterBody.includes(EMPTY_STATE));
check('the empty state moved into the markup',
  afterBody.indexOf(EMPTY_STATE) > afterBody.indexOf('</script>'),
  `at ${afterBody.indexOf(EMPTY_STATE)}, script ends at ${afterBody.indexOf('</script>')}`);
check('the branch became Svelte control flow', /\{#if/.test(afterBody) && /\{:else\}/.test(afterBody));

console.log(`\ncalls=${calls} in=${inTok} out=${outTok}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
