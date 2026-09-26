// Does the stylesheet-only conformance repair actually work?
//
// The unit test covers the splice and the arithmetic shows the payload: on three
// real generated projects the call now sends 17-27% of what it sent before. What
// neither can say is whether a model handed one stylesheet and a list of
// deviations returns a usable stylesheet — the old prompt described a whole
// document and asked for a whole document back.
//
// So this asks it, once, with a real project's real stylesheet and a real
// deviation, and measures conformance before and after. Two calls' worth of
// tokens rather than a generation's.
//
//   node test/stylesheet-repair.probe.mjs <document.html> [preset]
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REGION = 'ap-northeast-1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , docPath, presetName = 'digital-agency'] = process.argv;
if (!docPath) { console.error('usage: node test/stylesheet-repair.probe.mjs <document.html> [preset]'); process.exit(2); }

const entry = path.join(root, 'dist/ssp-entry.ts');
fs.writeFileSync(entry, [
  "export { stylesheetOf, spliceStylesheet } from '../src/tools/project/project-transport.js';",
  "export { presetConformance, getPresetSpec } from '../src/orchestration/presets/design-presets.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/ssp.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const m = await import(pathToFileURL(path.join(root, 'dist/ssp.mjs')).href);

let doc = fs.readFileSync(docPath, 'utf8');
const sheet = m.stylesheetOf(doc);
if (!sheet) { console.error('no stylesheet in that document'); process.exit(1); }

let before = m.presetConformance(doc, presetName);
/*
 * A clean document cannot exercise a repair. Rather than wait for a run that
 * drifts — two attempts did not — the drift is introduced, and it is introduced
 * the way real drift looks: a banned indigo written into the token that the
 * accent flows from.
 */
if (before.details.length === 0) {
  /*
   * A required value, removed — not a banned colour.
   *
   * The first attempt injected #6366f1 as an accent and conformance still read
   * 0 violations, because the digital-agency signature does not forbid indigo:
   * it REQUIRES its own #0017C1. So the deviation is made the way the check
   * actually measures one, and the probe refuses to go on if it still reads
   * clean rather than sending a model an empty list of things to fix — which is
   * the exact call the pipeline's own notes say was being made every run.
   */
  const required = ['#0017C1', '#3B5BDB', '#1A1A1C'];
  let injected = sheet.body;
  for (const hex of required) {
    if (new RegExp(hex, 'i').test(injected)) {
      injected = injected.replace(new RegExp(hex, 'gi'), '#6366f1');
      break;
    }
  }
  if (injected === sheet.body) { console.error('could not introduce a deviation to repair'); process.exit(1); }
  doc = m.spliceStylesheet(doc, sheet.path, injected);
  before = m.presetConformance(doc, presetName);
  console.log('replaced a required value with #6366f1 to give the repair something to do\n');
  if (before.details.length === 0) {
    console.error('conformance still reads clean — nothing to repair, and a model must not be sent an empty list');
    process.exit(1);
  }
}
const current = m.stylesheetOf(doc);
console.log(`document ${doc.length} chars, stylesheet ${current.body.length} (${Math.round(current.body.length / Math.min(doc.length, 90000) * 100)}% of what the old call sent)`);
console.log(`before: ratio ${before.ratio}, violations ${before.violations}`);
for (const d of before.details) console.log(`  - ${d.slice(0, 110)}`);

const presetSpec = m.getPresetSpec(presetName);
const modelId = (await new SSMClient({ region: REGION }).send(
  new GetParameterCommand({ Name: '/makeui/models/haiku' }))).Parameter.Value;

const res = await new BedrockRuntimeClient({ region: REGION }).send(new InvokeModelCommand({
  modelId,
  contentType: 'application/json',
  accept: 'application/json',
  body: JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 16000,
    system: `You repair design-system conformance in one stylesheet.

BINDING DESIGN SYSTEM:
${presetSpec}

Rules:
- Return the COMPLETE corrected stylesheet and nothing else. No markdown, no
  fences, no commentary.
- Change ONLY the values that deviate. Keep every selector, every rule and their
  order exactly as given — other files reference these class names.
- Define the system's values verbatim as custom properties in :root, then make
  every other rule reference them instead of hard-coded off-system values.`,
    messages: [{ role: 'user', content: `This stylesheet was written for the "${presetName}" design system but drifted from it.
検出された逸脱（これらを直してください。他は変更しないこと）:
${before.details.map((d, i) => `${i + 1}. ${d}`).join('\n')}

--- ${current.path} ---
${current.body}` }],
  }),
}));
const body = JSON.parse(new TextDecoder().decode(res.body));
const reply = body.content?.[0]?.text ?? '';
const u = body.usage ?? {};
console.log(`\ncall: in ${u.input_tokens}, out ${u.output_tokens}  (the old call measured 31,115 in / 19,019 out)`);

const spliced = m.spliceStylesheet(doc, current.path, reply.trim());
if (!spliced) { console.log('\nREJECTED: the reply is not a stylesheet'); process.exit(1); }
const after = m.presetConformance(spliced, presetName);
console.log(`after:  ratio ${after.ratio}, violations ${after.violations}`);

const improved = after.violations < before.violations || after.ratio > before.ratio;
const intact = spliced.length >= doc.length * 0.9;
console.log(`\nimproved: ${improved}   document intact: ${intact} (${spliced.length} vs ${doc.length})`);

// The whole safety claim of the change: a call given only the stylesheet cannot
// have touched the code.
const files = (s) => new Map([...s.matchAll(/@@@makeui:file (.+?)\r?\n([\s\S]*?)\r?\n@@@makeui:endfile/g)].map((x) => [x[1].trim(), x[2]]));
const b = files(doc), a = files(spliced);
const changed = [...b.keys()].filter((p) => b.get(p) !== a.get(p));
console.log(`files changed: ${changed.join(', ') || 'none'}`);
process.exit(improved && intact && changed.length === 1 ? 0 : 1);
