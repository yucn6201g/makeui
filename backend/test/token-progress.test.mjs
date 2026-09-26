// Every step of a run shows what it spent.
//
// The progress transcript prices a step by differencing the run's total at the
// step's boundaries, and the total reaches the job record only when something
// writes it. Three gaps left steps with no figure:
//
//   - the design specialists (画面構成を設計中, コンテンツを作成中…): the SDK
//     reports the graph's usage only when the whole graph returns, so every
//     design step was priced at nothing and the last absorbed all of it;
//   - non-streaming steps (N個のファイルを修正中, the critic): nothing wrote the
//     total while they ran, and the last step of a run, which no later step
//     closes, never received its figure;
//   - plan mode: its poll never passed the total to the transcript at all.
//
//   node test/token-progress.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
await esbuild.build({
  entryPoints: [path.join(root, 'src/services/token-ledger.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: path.join(root, 'dist/token-progress.test.mjs'), logLevel: 'error',
});
const tl = await import(pathToFileURL(path.join(root, 'dist/token-progress.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the ledger says when it moved -----------------------------------------------
{
  const seen = [];
  await tl.withTokenLedger(async (ledger) => {
    ledger.onRecord = () => seen.push(ledger.inputTokens + ledger.outputTokens);
    tl.recordTokens(100, 20, 'repair:per-file');
    tl.recordTokens(50, 5, 'critic:visual');
  });
  check('every recorded call is announced, with the total already updated', seen, [120, 175]);
  // A listener that throws must not fail the model call it describes.
  let total = 0;
  await tl.withTokenLedger(async (ledger) => {
    ledger.onRecord = () => { throw new Error('dynamo down'); };
    tl.recordTokens(10, 1);
    total = ledger.inputTokens + ledger.outputTokens;
  });
  check('a failing listener does not lose the figure', total, 11);
}

// --- each job publishes its total while it runs, and once more at the end -----------
const jobs = read('src/services/job-service.ts');
check('the heartbeat writes the total and nothing else',
  /UpdateExpression: 'SET streamTokens = :t, updatedAt = :now, #ttl = :ttl'/.test(jobs), true);
check('reading the total when the write is sent', /inFlight = inFlight\s*\.then\(async \(\) => \{[\s\S]{0,300}const spent = total\(\)/.test(jobs), true);
for (const [file, run] of [['src/orchestration/generate/graph.ts', 'runGeneration'], ['src/orchestration/generate/plan.ts', 'runPlan'], ['src/orchestration/edit/meta-orchestrator.ts', 'runModify']]) {
  const src = read(file);
  const at = src.indexOf(`return await ${run}(options, ledger)`);
  const around = src.slice(at - 400, at + 200);
  check(`${run} attaches it to the ledger`, /ledger\.onRecord = heartbeat\.notify/.test(around), true);
  check(`${run} flushes it before the job is marked done`, /finally \{\s*if \(heartbeat\) await heartbeat\.flush\(\)/.test(around), true);
}

// --- the design specialists are charged as each call ends --------------------------
const design = read('src/orchestration/generate/strands-design.ts');
check('the stream\'s metadata events are recorded per node',
  /inner\.event\?\.type === 'modelMetadataEvent'[\s\S]{0,1400}recordTokens\(u\.inputTokens \?\? 0, u\.outputTokens \?\? 0, `design:\$\{id\}`/.test(design), true);
check('and the node figures record only what the stream missed',
  /const restIn = Math\.max\(0, usage\.inputTokens - s\.input\)/.test(design), true);
check('as does the graph total', /graphUsage\.inputTokens - streamedIn/.test(design), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
