// Does Bedrock actually cache the assembler's contract? Ask it twice.
//
// A probe, not a test: it spends tokens. The unit test proves the request shape;
// only Bedrock can say whether the breakpoint is honoured, and the failure it is
// checking for is silent — a prefix under the floor, or a block form the model
// does not accept, produces a normal answer with `cache_read_input_tokens: 0`.
//
//   node test/prompt-cache.probe.mjs      (from backend/)
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const REGION = 'ap-northeast-1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The real contract, built the way graph.ts builds it. A synthetic string of the
// same length would answer a different question: whether Bedrock caches, rather
// than whether it caches THIS.
const entry = path.join(root, 'dist/pc-probe-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { outputSpecFor, projectContract, stylesheetContract, SCREEN_COMPLETENESS, FORM_CONTROL_SIZING } from '../src/orchestration/prompt-contracts.js';",
  "export { FRAMEWORKS } from '../src/config/frameworks.js';",
  "export { systemField } from '../src/orchestration/prompt-cache.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/pc-probe.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const m = await import(pathToFileURL(path.join(root, 'dist/pc-probe.mjs')).href);

const contract = [
  'You are a senior frontend engineer. You build production TypeScript React applications.',
  m.outputSpecFor('react'),
  m.FRAMEWORKS.react.layout,
  m.projectContract('react'),
  m.stylesheetContract('react'),
  m.SCREEN_COMPLETENESS,
  m.FORM_CONTROL_SIZING,
].join('\n');

const ssm = new SSMClient({ region: REGION });
const modelId = (await ssm.send(new GetParameterCommand({ Name: '/makeui/models/haiku' }))).Parameter.Value;
const bedrock = new BedrockRuntimeClient({ region: REGION });

/** One call, reporting only what the cache columns say. */
async function ask(label) {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 16,
      system: m.systemField({ cached: contract, tail: '\n\nAnswer in one word.' }),
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    }),
  }));
  const u = JSON.parse(new TextDecoder().decode(res.body)).usage ?? {};
  console.log(
    `${label.padEnd(8)} input ${String(u.input_tokens ?? 0).padStart(6)}  ` +
    `cacheWrite ${String(u.cache_creation_input_tokens ?? 0).padStart(6)}  ` +
    `cacheRead ${String(u.cache_read_input_tokens ?? 0).padStart(6)}`
  );
  return u;
}

console.log(`contract ${contract.length} chars, model ${modelId}\n`);
const first = await ask('first');
const second = await ask('second');

const wrote = (first.cache_creation_input_tokens ?? 0) > 0;
const read = (second.cache_read_input_tokens ?? 0) > 0;
console.log(`\nwrote a cache entry: ${wrote}`);
console.log(`second call read it: ${read}`);
console.log(read
  ? `saved ${second.cache_read_input_tokens} input tokens on the second call, billed at ~0.1x`
  : 'NOT CACHED — the breakpoint was ignored, or the prefix is under the floor');
process.exit(wrote && read ? 0 : 1);
