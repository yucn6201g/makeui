// Whether a partial edit says it was partial.
//
// Everything the edit path checks afterwards is about defects the edit
// INTRODUCED — the tell audit diffed against before, the module defects diffed,
// the browser check for console errors and dead navigation. Nothing asked
// whether the instruction had been carried out. So an edit that applied three
// of a request's four parts came back with no new defects, a clean browser and
// the word "success", and the only trace of the missing part was a log line.
//
// The information was already there. `applyFileEdits` returns what it wrote and
// what it could not, and `plan.reason` carries the planner's own words for what
// each file was for — which is what makes an unapplied line legible as a
// missing REQUEST rather than as a filename that failed.
//
//
// Why this file is the whole verification, and no production run is owed:
// the ✓ and the × come out of ONE template line and travel in ONE summary
// string, through `onPlan`/`onDelta` — the channel that fires on every
// successful edit. So the only thing a real partial edit would exercise that
// a green run does not is the other side of `ok ? "✓" : "×"` and its suffix,
// and that is asserted below character for character. A partial edit was
// tracked as an open item for a while on the reasoning that it had "never
// fired in production"; it was never a gap. The signal that would matter is a
// user saying four files were claimed and three changed, which is a bug
// report, not a missing test.
//   node test/edit-outcome.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/edit-files.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/eo.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { describeEditOutcome } = await import(pathToFileURL(path.join(root, 'dist/eo.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// A four-part request, as the planner decomposed it into files.
const PLAN = [
  { path: 'src/screens/Inventory.tsx', create: true, reason: '在庫管理画面を追加' },
  { path: 'src/routes.tsx', create: false, reason: 'ダッシュボードからの遷移' },
  { path: 'src/styles/tokens.css', create: false, reason: 'ボタンをブランドカラーに' },
  { path: 'src/lib/export.ts', create: true, reason: 'CSVエクスポート' },
];

// --- the silent case -------------------------------------------------------
{
  const out = describeEditOutcome(PLAN, ['src/screens/Inventory.tsx', 'src/routes.tsx', 'src/styles/tokens.css'], ['src/lib/export.ts']);
  check('a partial edit is reported as partial', out.partial, true);
  check('and the missing part is named by what it was FOR',
    out.unapplied.map((p) => p.reason), ['CSVエクスポート']);
  check('the applied lines are marked applied',
    out.summary.split('\n').filter((l) => l.startsWith('✓')).length, 3);
  check('and the missing one says so in words',
    out.summary.includes('× 新規 src/lib/export.ts — CSVエクスポート（適用できませんでした）'), true);
}

// --- the two cases that are NOT partial ------------------------------------
{
  const out = describeEditOutcome(PLAN, PLAN.map((p) => p.path), []);
  check('a complete edit is not partial', out.partial, false);
  check('with nothing unapplied', out.unapplied, []);
  check('and every line marked', out.summary.split('\n').every((l) => l.startsWith('✓')), true);
}
{
  // Nothing written at all is a different outcome: the caller returns null and
  // the whole-document rewrite takes over, so this must not be reported as a
  // partial success on the way past.
  const out = describeEditOutcome(PLAN, [], PLAN.map((p) => p.path));
  check('an edit that wrote nothing is not "partial"', out.partial, false);
  check('though everything is still unapplied', out.unapplied.length, 4);
}

// --- what counts as unapplied ---------------------------------------------
{
  /*
   * A file can fall out of an edit several ways — an unparsable reply, a splice
   * that would not apply, a body rejected as too short — and not all of them
   * reach `skipped`. Planned-and-not-written is the honest set; trusting
   * `skipped` alone would let a file vanish while the summary called it done.
   */
  const out = describeEditOutcome(PLAN, ['src/routes.tsx'], []);
  check('planned but not written counts, even with an empty skipped list',
    out.unapplied.map((p) => p.path).sort(),
    ['src/lib/export.ts', 'src/screens/Inventory.tsx', 'src/styles/tokens.css']);
  check('and it is partial', out.partial, true);
}
{
  // And the other direction: a file dropped without ever being planned must not
  // disappear from the report just because the plan does not mention it.
  const out = describeEditOutcome(
    [PLAN[0]], ['src/screens/Inventory.tsx'], ['src/components/Sidebar.tsx']
  );
  check('an unplanned casualty is still shown',
    out.summary.includes('× 編集 src/components/Sidebar.tsx（適用できませんでした）'), true);
  check('but it does not become a fake plan entry', out.unapplied, []);
}

// --- the wording ----------------------------------------------------------
{
  const out = describeEditOutcome(
    [{ path: 'src/a.tsx', create: true, reason: undefined }], [], ['src/a.tsx']
  );
  check('a plan line with no reason still reads',
    out.summary, '× 新規 src/a.tsx（適用できませんでした）');
}
{
  const out = describeEditOutcome([{ path: 'src/a.tsx', create: false }], ['src/a.tsx'], []);
  check('新規 and 編集 are distinguished', out.summary, '✓ 編集 src/a.tsx');
}
check('an empty plan produces an empty summary',
  describeEditOutcome([], [], []), { summary: '', unapplied: [], partial: false });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
