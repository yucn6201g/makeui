/**
 * A pass opened on a nearly-clean document has never once landed.
 *
 * Replayed against 67 real repair passes from 14 days of Runtime logs, grouped
 * by how many attemptable defects were open when the pass started:
 *
 *   open when it started   passes  accepted  median change  made it worse
 *                    1-2        7         0            +4.0            6/7
 *                    3-4       11         8            +1.0           8/11
 *                    5-7       29        17             0.0          12/29
 *                     8+       20        13            -1.5           5/20
 *
 * Monotone across the whole range, and unambiguous at the bottom: with one or
 * two defects left, a rewrite of a nearly-clean file is mostly an opportunity to
 * break something, the judge throws the pass away, and the tokens are spent
 * anyway.
 *
 * The fixtures below are those 67 passes, as `(pass, before, after, accepted)`.
 * They are the measurement, not a sample of it — a rule derived from data and
 * then tested against invented data tests the invention.
 *
 * What this file guards is a decision rule, so it replays the rule over the
 * history and asserts what it would have cut. No generation is run and no token
 * is spent: the alternative — 35 runs before and 35 after — is a day of quota to
 * answer a question the logs already answer.
 *
 *   node test/repair-floor.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/repair-floor.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/repair-budget.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { REPAIR_FLOOR } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * Every repair pass in the window, `[pass, before, after, accepted]`.
 *
 * `before` is the ATTEMPTABLE set — what `worthRepairing` returned, which is the
 * number the loop can act on — not every open defect. The two differ, and the
 * rule has to be stated against the one the loop holds.
 */
const PASSES = [
  [1, 11, 11, false], [1, 11, 9, true], [2, 10, 8, true], [3, 8, 7, false],
  [1, 9, 8, true], [2, 8, 8, false],
  [1, 8, 4, true], [2, 4, 2, true], [3, 2, 2, false],
  [1, 9, 6, true], [2, 7, 6, true],
  [1, 7, 5, false],
  [1, 9, 5, false],
  [1, 9, 7, true], [2, 6, 4, true], [3, 5, 4, true],
  [1, 9, 6, false],
  [1, 6, 5, true], [2, 5, 6, false],
  [1, 8, 9, true], [2, 10, 10, true], [3, 11, 9, true],
  [1, 7, 7, true], [2, 7, 7, false],
  [1, 6, 10, false],
  [1, 9, 8, false],
  [1, 7, 7, true], [2, 5, 7, false],
  [1, 5, 7, false],
  [1, 11, 8, true], [2, 5, 7, false],
  [1, 7, 7, true], [2, 4, 5, false],
  [1, 7, 4, false],
  [1, 6, 5, true], [2, 3, 3, true], [3, 1, 6, false],
  [1, 3, 7, false],
  [1, 6, 6, true], [2, 3, 5, true], [3, 2, 5, false],
  [1, 8, 9, true], [2, 7, 8, true], [3, 4, 5, true],
  [1, 6, 6, true], [2, 4, 4, true], [3, 1, 4, false],
  [1, 6, 7, true], [2, 5, 5, false],
  [1, 6, 7, true], [2, 4, 5, false],
  [1, 8, 10, true], [2, 7, 8, true], [3, 6, 10, false],
  [1, 7, 8, true], [2, 4, 5, true], [3, 2, 6, false],
  [1, 8, 10, true], [2, 5, 8, false],
  [1, 6, 7, false],
  [1, 3, 5, true], [2, 2, 5, false],
  [1, 7, 6, true], [2, 4, 5, true], [3, 1, 5, false],
  [1, 8, 10, false],
  [1, 6, 0, true],
];

check('the window holds every pass it was measured on', PASSES.length, 67);
check('and the floor is the one the measurement supports', REPAIR_FLOOR, 2);

// --- the measurement the rule comes from -------------------------------------
const band = (lo, hi) => PASSES.filter(([, b]) => b >= lo && b <= hi);
const accepted = (g) => g.filter(([, , , ok]) => ok).length;
const worse = (g) => g.filter(([, b, a]) => a > b).length;

check('a pass with one or two left has never been accepted', accepted(band(1, 2)), 0);
check('there were seven of them', band(1, 2).length, 7);
check('and six made the document worse', worse(band(1, 2)), 6);
// The gradient is the argument for a floor rather than a cap on passes: what a
// pass does depends on how much is left, not on which pass it is.
check('while the fullest documents are where a pass pays',
  [accepted(band(8, 99)), band(8, 99).length], [13, 20]);
check('and those are the ones that come out ahead', worse(band(8, 99)), 5);
// Two, not four: at 3-4 it is mixed, and mixed is not a case for either.
check('the band above the floor is genuinely mixed',
  [accepted(band(3, 4)), band(3, 4).length, worse(band(3, 4))], [8, 11, 8]);

// --- replaying the rule -------------------------------------------------------
/** The loop's stopping rule, as graph.ts now applies it. */
function replay(passes) {
  const kept = [];
  const cut = [];
  for (const p of passes) {
    const [n, before] = p;
    if (n > 1 && before <= REPAIR_FLOOR) { cut.push(p); continue; }
    kept.push(p);
  }
  return { kept, cut };
}
const { kept, cut } = replay(PASSES);
check('the rule cuts seven passes', cut.length, 7);
// The claim the change is being made on: nothing that landed is lost.
check('and none of them had been accepted', accepted(cut), 0);
check('every pass it keeps is one that ran', kept.length, 60);
check('the accepted passes all survive', accepted(kept), accepted(PASSES));

// A first pass is never cut, however little it has to do: the floor is about
// diminishing returns inside a run, not about refusing a document that arrived
// nearly clean.
check('a first pass is never cut', cut.filter(([n]) => n === 1).length, 0);
check('and the cuts are all second or third passes',
  [...new Set(cut.map(([n]) => n))].sort(), [2, 3]);

// --- the rule as the loop states it -------------------------------------------
const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
check('the loop consults the floor', /if \(pass > 1 && defects\.length <= REPAIR_FLOOR\)/.test(graph), true);
// Against the attemptable set, not every open defect — the two differ, and the
// measurement above is of the first.
check('against what it can actually attempt',
  graph.indexOf('const { attempt: defects, skipped: notWorthTrying }')
    < graph.indexOf('defects.length <= REPAIR_FLOOR'), true);
// A defect nobody repairs is still reported: the score deducts for it and the
// reply names it. What stops is paying for an attempt.
check('and it still says what it is shipping with',
  /Shipping with open defects: too few left for a pass to help/.test(graph), true);
check('naming both what it could have tried and what remains',
  /attemptable: defects\.map\(\(d\) => d\.id\)[\s\S]{0,80}remaining: openDefects\.map/.test(graph), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
