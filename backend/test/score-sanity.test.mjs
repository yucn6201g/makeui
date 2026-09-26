// The score has to be able to see the thing it is scoring.
//
// It stopped being able to once already, silently, and the note in scoring.ts
// records it: the file list was read with `/data-file="([^"]+)"/`, the attribute
// projects travelled in before components carrying their own `<script>` forced
// whole-line fences. Nothing had emitted it since, so `paths` was EMPTY on every
// scored project and 80 of 100 points were unreachable by construction. A real,
// complete, nine-screen project scored 30, and that number was shown to the user
// as a judgement about their UI.
//
// It was the fourth detector broken by that one transport change. All four failed
// the same way: silently, and in the direction that looks like a quality problem
// rather than a plumbing one.
//
// So the property asserted here is not "a good project scores 84". It is that the
// score MOVES with what it claims to measure. A scorer that cannot read the
// document produces a constant, and a constant passes every test that only checks
// one document at a time.
//
// The fixtures are built with `writeProjectDocument` — the transport's own writer
// — rather than with a hand-written string. If the transport changes again, the
// fixture changes with it and this test keeps asking the real question instead of
// asking yesterday's.
//
//   node test/score-sanity.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { completeProject, documentOf } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/score-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { scoreHtml, scoreBreakdown } from '../src/orchestration/audit/scoring.js';",
  "export { writeProjectDocument } from '../src/tools/project/project-transport.js';",
  "export { FRAMEWORKS } from '../src/config/frameworks.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/score.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { scoreHtml, scoreBreakdown, writeProjectDocument, FRAMEWORKS } = await import(
  pathToFileURL(path.join(root, 'dist/score.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const complete = writeProjectDocument(completeProject(FRAMEWORKS.react));
const scoreOf = (files) => scoreHtml(writeProjectDocument(files), undefined, 'react');

/*
 * The fixture is shared with the tests that do not bundle the transport, and
 * they render it with a hand-written fence writer. If that shortcut ever drifts
 * from the real one they would be asserting things about a format nothing
 * produces, so the two renderings are required to score the same.
 */
check('the shared fixture renders the same either way',
  scoreHtml(documentOf(completeProject(FRAMEWORKS.react)), undefined, 'react'),
  scoreHtml(complete, undefined, 'react'));

// --- the scale is used, not collapsed --------------------------------------------
const good = scoreHtml(complete, undefined, 'react');
const empty = scoreHtml('<html><body></body></html>', undefined, 'react');
console.log(`\n  complete project ${good} / empty document ${empty}\n`);

check('a complete project scores well above the floor', good >= 70, true);
check('an empty document is at the floor', empty, 30);
check('and the two are far apart', good - empty >= 30, true);

// --- the guard the silent break needed --------------------------------------------
//
// Each of these removes ONE thing the rubric claims to reward. If the scorer
// cannot read the file list — which is exactly what happened — every one of them
// scores the same as the complete project, and every other assertion here still
// passes.
const without = (drop) => {
  const files = completeProject(FRAMEWORKS.react);
  for (const p of [...files.keys()]) if (drop.test(p)) files.delete(p);
  return scoreOf(files);
};
for (const [name, re] of [
  ['icons', /^src\/components\/icons\//],
  ['illustrations', /^src\/components\/illustrations\//],
  ['the store', /^src\/store\//],
  ['the routes file', /^src\/routes\.ts$/],
  ['every screen', /^src\/screens\//],
]) {
  const got = without(re);
  check(`removing ${name} costs points (${good} -> ${got})`, got < good, true);
}

// --- and the runtime half moves too ------------------------------------------------
//
// The deductions and the checklist are summed, so a scorer that reads one and not
// the other still produces a number. Both halves get a pair.
const runtime = (over) => scoreHtml(complete, undefined, 'react', {
  fills: [0.8, 0.8, 0.8, 0.8, 0.8],
  declaredScreens: 5,
  emptyBoxes: 0, consoleErrors: 0, deadNav: 0, deadActions: 0, throwingControls: 0,
  stubbedComponents: 0, smallFields: 0, unreachableScreens: 0, contrastFaults: 0,
  mobileOverflowPx: 0, truncated: false,
  ...over,
});
const clean = runtime({});
console.log(`
  with a clean render ${clean}
`);

/*
 * The whole point of the runtime half is that it can only be earned by a
 * document that was actually opened. A NaN here is not hypothetical: the first
 * version of this test passed `unreachable` where the field is
 * `unreachableScreens`, every arithmetic term went undefined, and `scoreHtml`
 * returned NaN for all four cases — which compares false against everything and
 * would have read as "the deductions do not fire".
 */
check('the runtime score is a number', Number.isFinite(clean), true);
check('a clean render scores at least as well as no render', clean >= good, true);
check('a throwing control costs points', runtime({ throwingControls: 2 }) < clean, true);
check('an unreachable screen costs points', runtime({ fills: [0.8, 0.8] }) < clean, true);
check('console errors cost points', runtime({ consoleErrors: 2 }) < clean, true);

// --- the split is arithmetic, not a second opinion ---------------------------------
//
// One score summing a file-layout checklist and a browser's findings has been
// read as a judgement about the UI, and it cannot carry that. So the parts are
// reported. What must stay true is that they are the SAME number taken apart: a
// breakdown computed independently would be a third measurement to keep in step
// with the other two, which is how the audit and the score ended up on opposite
// sides of the same document over the login gate.
{
  const b = scoreBreakdown(complete, undefined, 'react');
  check('the total is the score, unchanged', b.total, good);
  check('the contract half is the whole checklist when nothing rendered', b.contract.possible > 0, true);
  check('and the runtime half is null rather than zero', b.runtime, null);

  const facts = {
    fills: [0.8, 0.8, 0.8, 0.8, 0.8], declaredScreens: 5,
    emptyBoxes: 0, consoleErrors: 0, deadNav: 0, deadActions: 0, throwingControls: 0,
    stubbedComponents: 0, smallFields: 0, unreachableScreens: 0, contrastFaults: 0,
    mobileOverflowPx: 0, truncated: false,
  };
  const withRun = scoreBreakdown(complete, undefined, 'react', facts);
  check('with a render the total still matches the score', withRun.total, clean);
  check('the runtime half is now reported', withRun.runtime !== null, true);
  /*
   * To a hundredth, not exactly.
   *
   * `contract.earned` is `whole.earned - runtime.earned`, so without facts it is
   * a sum and with them it is that sum plus the runtime terms, minus them again.
   * `(x + r) - r` is not `x` in binary floating point, and the difference here is
   * 7e-15 — the assertion passed for as long as the score happened to land on a
   * number with an exact representation, and failed the first time a term made it
   * 419/7. Nothing about the contract half changed; the comparison was reading
   * the last bit of a double as a finding.
   */
  const near = (a, b2) => Math.abs(a - b2) < 0.005;
  check('and the contract half is unchanged by rendering',
    near(withRun.contract.earned, b.contract.earned) && withRun.contract.possible === b.contract.possible,
    true);
  console.log(`\n  contract ${withRun.contract.earned}/${withRun.contract.possible}` +
    ` | runtime ${withRun.runtime.earned}/${withRun.runtime.possible} -${withRun.runtime.penalty}` +
    ` | total ${withRun.total}\n`);

  // The deductions have to land in the runtime half, or the split says nothing.
  const broken = scoreBreakdown(complete, undefined, 'react',
    { ...facts, consoleErrors: 2, throwingControls: 2 });
  check('a broken render is charged to the runtime half',
    broken.runtime.penalty > withRun.runtime.penalty, true);
  check('and the contract half does not move', broken.contract, withRun.contract);
}

// --- the one failure the number cannot express ------------------------------------
//
// A project whose fences stopped being readable falls through `scoreProject`
// into the rubric for a single interactive page, and comes back 30 — the floor,
// and the same number an empty document gets. There is no arrangement of one
// number that separates 「this could not be read」 from 「this was bad」, which is
// why the pipeline logs an error on it instead.
//
// What is asserted here is that the EVIDENCE survives: on that path the contract
// half is 0/0, and every output kind MakeUI has is a project, so a zero there
// can only mean the transport failed. If a future change gives the single-page
// path a non-empty contract half, the check in graph.ts goes quiet and this
// says so.
{
  const unreadable = complete.replaceAll('@@@makeui:file ', '@@@makeui:files ');
  check('an unreadable document scores the same as an empty one',
    scoreHtml(unreadable, 'none', 'react'), 30);
  const b = scoreBreakdown(unreadable, 'none', 'react');
  check('but the contract half is 0/0, which is the signal',
    [b.contract.earned, b.contract.possible], [0, 0]);
  check('and a readable one is not', scoreBreakdown(complete, 'none', 'react').contract.possible > 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
