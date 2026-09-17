// The run total answers "what did this cost" and nothing else. The next question
// is always "where did it go", and until now nothing could answer it: the job
// records that carry per-poll totals expire, and the ledger kept one number. Every
// estimate of where the input goes has been arithmetic over the file count.
//
// The two cache columns are here for a related reason. A prompt cache that is
// silently not working — a prefix under the model's minimum (4,096 tokens on
// Haiku 4.5), or one byte that moved — produces no error and no warning. It
// produces `cacheRead: 0`, forever, at full price.
//
//   node test/ledger-stages.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/services/token-ledger.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/tls.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { withTokenLedger, recordTokens, recordUnreportedCall, newLedger } =
  await import(pathToFileURL(path.join(root, 'dist/tls.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const run = async (fn) => { let out; await withTokenLedger(async (l) => { await fn(); out = l }); return out };

const fresh = newLedger();
check('a new ledger is empty',
  [fresh.inputTokens, fresh.outputTokens, fresh.calls, Object.keys(fresh.stages).length],
  [0, 0, 0, 0]);

const one = await run(async () => {
  recordTokens(1000, 200, 'build:per-file');
  recordTokens(1500, 300, 'build:per-file');
  recordTokens(9000, 4000, 'repair:whole-document');
});
check('the run total is the sum', [one.inputTokens, one.outputTokens, one.calls], [11500, 4500, 3]);
check('and it splits by stage', Object.keys(one.stages).sort(), ['build:per-file', 'repair:whole-document']);
check('calls are counted per stage', one.stages['build:per-file'].calls, 2);
check('with their own totals',
  [one.stages['build:per-file'].inputTokens, one.stages['build:per-file'].outputTokens], [2500, 500]);
// Which is the whole point: one whole-document repair is 13,000 tokens against
// two per-file calls at 3,000, and the single total says only 16,000.
check('a stage that dominates is visible',
  one.stages['repair:whole-document'].inputTokens > one.stages['build:per-file'].inputTokens, true);

// A call site that was never labelled shows up as a gap you can see, rather
// than vanishing into the total.
const unlabelled = await run(async () => { recordTokens(700, 100) });
check('an unlabelled call is attributed to nothing in particular',
  Object.keys(unlabelled.stages), ['unattributed']);

// --- the cache columns ---
const cached = await run(async () => {
  recordTokens(400, 100, 'build:per-file', { write: 5000 });
  recordTokens(400, 100, 'build:per-file', { read: 5000 });
  recordTokens(400, 100, 'build:per-file', { read: 5000 });
});
check('cache writes are counted', cached.cacheWriteTokens, 5000);
check('cache reads are counted', cached.cacheReadTokens, 10000);
check('and both land on the stage', 
  [cached.stages['build:per-file'].cacheWriteTokens, cached.stages['build:per-file'].cacheReadTokens],
  [5000, 10000]);
// The shape of a cache that is not working: everything written, nothing read.
const cold = await run(async () => {
  recordTokens(400, 100, 'build:per-file', { write: 5000 });
  recordTokens(400, 100, 'build:per-file', { write: 5000 });
});
check('a cache nobody reads is visible as reads of zero', cold.cacheReadTokens, 0);
check('while the writes are still billed', cold.cacheWriteTokens, 10000);
// No cache at all is not the same as a cache that is missing — absent counters
// stay zero rather than being invented.
const uncached = await run(async () => { recordTokens(400, 100, 'design:analyst') });
check('a call with no cache reports neither', [uncached.cacheReadTokens, uncached.cacheWriteTokens], [0, 0]);

// A call that reports nothing is a gap in the total, counted rather than guessed.
const gap = await run(async () => { recordTokens(100, 10, 'design:graph'); recordUnreportedCall('design:graph') });
check('unreported calls are counted separately', [gap.calls, gap.unreported], [1, 1]);

// Outside a run there is no ledger, and a pure helper must not have to make one.
let threw = false;
try { recordTokens(1, 1, 'nowhere') } catch { threw = true }
check('recording outside a run is silent', threw, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
