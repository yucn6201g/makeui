// What a run actually spent, as opposed to what it used to guess.
//
// The pipeline estimated with `text.length / 4` at seven places, and between
// them they measured the output document and missed the four-agent design phase
// entirely — `runDesignSwarm` returns a string, so the graph's usage metrics
// were read for their text and dropped. That is the single most expensive stage
// in the product, costing the ledger nothing.
//
// It mattered once the build modes shipped: 節約 and 高速 exist to remove those
// stages, and the stages they removed were the ones never billed. Measured on
// one brief, economy reported 65,943 output tokens against standard's 59,810 —
// the cheap run appeared to cost MORE, because the quantity being reported was
// the size of the HTML, not the work.
//
//   node test/token-ledger.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/services/token-ledger.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/tl.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { withTokenLedger, recordTokens, recordUnreportedCall, usageFromStrandsResult } = await import(
  pathToFileURL(path.join(root, 'dist/tl.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- accumulation ----------------------------------------------------------
const totals = await withTokenLedger(async (ledger) => {
  recordTokens(100, 50);
  recordTokens(7, 3);
  return { ...ledger };
});
check('sums what the calls reported', [totals.inputTokens, totals.outputTokens], [107, 53]);
check('and counts them', totals.calls, 2);
check('with nothing missing', totals.unreported, 0);

// A call that reported nothing is COUNTED, not estimated. A guess mixed into a
// total of real numbers is worse than a gap, because nothing downstream can
// tell which is which — and a visible gap is what would have caught the missing
// design phase.
const withGap = await withTokenLedger(async (ledger) => {
  recordTokens(10, 5);
  recordUnreportedCall('somewhere');
  return { ...ledger };
});
check('an unreported call adds no tokens', [withGap.inputTokens, withGap.outputTokens], [10, 5]);
check('but is visible as a gap', withGap.unreported, 1);
check('and is not counted as a reporting call', withGap.calls, 1);

// --- isolation between runs ------------------------------------------------
// The worker Lambda can have two jobs in one process. A module-level counter
// would bill each of them for the other, which is why this is AsyncLocalStorage
// and not a variable.
const [a, b] = await Promise.all([
  withTokenLedger(async (ledger) => {
    recordTokens(1000, 100);
    await new Promise((r) => setTimeout(r, 20));
    recordTokens(1000, 100);
    return { ...ledger };
  }),
  withTokenLedger(async (ledger) => {
    await new Promise((r) => setTimeout(r, 10));
    recordTokens(7, 7);
    return { ...ledger };
  }),
]);
check('concurrent runs do not see each other (A)', [a.inputTokens, a.outputTokens], [2000, 200]);
check('concurrent runs do not see each other (B)', [b.inputTokens, b.outputTokens], [7, 7]);

// --- outside a run ---------------------------------------------------------
// Exported helpers are called from tests and from the API Lambda; neither should
// have to establish a billing context to run a pure function.
check('recording outside a ledger is silent', (() => { recordTokens(5, 5); return 'no throw'; })(), 'no throw');

// --- the Strands shapes ----------------------------------------------------
// The SDK reports through more than one shape depending on the primitive, and
// uses camelCase where Bedrock's wire format uses snake_case. Reading only one
// of them is how the design phase came to be billed at zero.
check('an Agent result (metrics.accumulatedUsage)',
  usageFromStrandsResult({ metrics: { accumulatedUsage: { inputTokens: 900, outputTokens: 400 } } }),
  { inputTokens: 900, outputTokens: 400 });
check('a Graph/Swarm result (usage)',
  usageFromStrandsResult({ usage: { inputTokens: 12, outputTokens: 34 } }),
  { inputTokens: 12, outputTokens: 34 });
check('a missing output count reads as zero, not undefined',
  usageFromStrandsResult({ usage: { inputTokens: 12 } }),
  { inputTokens: 12, outputTokens: 0 });
// Unrecognised shapes return null so the caller records a gap rather than a zero.
check('an unrecognised shape is null', usageFromStrandsResult({ tokens: 5 }), null);
check('snake_case alone is not accepted', usageFromStrandsResult({ usage: { input_tokens: 5 } }), null);
check('null is null', usageFromStrandsResult(null), null);
check('a string is null', usageFromStrandsResult('900 tokens'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
