// A defect that names a string must name the file that contains it.
//
// The repair planner is a model call that sees the project's file PATHS and the
// defect sentences, and not one byte of any file. So for 「#6366f1 が使われてい
// ます」 it is being asked which file holds a hex colour, from the filenames. It
// cannot know. It guesses, and the guess is the stylesheet.
//
// Measured over 14 days on the deployed Runtime: 53 repair passes were handed
// `default-palette`, and it was fixed 0 times. In the four stored documents that
// still carry the colour it lives in CategoryPieChart.vue,
// DataGraphIllustration.vue and DealScreen.svelte — never in the stylesheet.
//
// That reads in the yield table as "a model cannot fix this", and the yield
// table decides what the loop stops paying for. A defect dropped for a planning
// failure would be dropped for the wrong reason and never come back.
//
//   node test/located-defects.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { completeProject, documentOf } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/located-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { auditAiTells } from '../src/orchestration/audit/design-audit.js';",
  "export { planFileRepairs } from '../src/orchestration/repair/repair-files.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/located.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { auditAiTells, planFileRepairs } = await import(
  pathToFileURL(path.join(root, 'dist/located.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * The colour where it actually turns up: a chart component, not the stylesheet.
 *
 * This is the shape of all four stored documents that still carry it, and it is
 * the shape a planner reading filenames gets wrong.
 */
const withPalette = () => {
  const files = completeProject();
  files.set('src/components/ui/CategoryPieChart.tsx',
    'const SLICES = ["#6366f1", "#8b5cf6", "#a855f7"];\n' +
    'export function CategoryPieChart() { return <svg viewBox="0 0 24 24">{SLICES.map((c) => <circle key={c} fill={c} />)}</svg> }');
  return files;
};

// --- the audit says where -----------------------------------------------------------
{
  const defects = auditAiTells(documentOf(withPalette()), 'none', 'react');
  const palette = defects.find((d) => d.id === 'default-palette');
  check('the palette defect fires', Boolean(palette), true);
  check('and it names the file that holds the colour',
    palette.paths, ['src/components/ui/CategoryPieChart.tsx']);
  check('not the stylesheet', palette.paths.includes('src/styles/globals.css'), false);
}

// Emoji in one component, and only that component.
{
  const files = completeProject();
  files.set('src/screens/ListScreen.tsx',
    'export default function ListScreen() { return <button>🚀 送信</button> }');
  const defects = auditAiTells(documentOf(files), 'none', 'react');
  const emoji = defects.find((d) => d.id === 'emoji');
  check('the emoji defect names its one file', emoji.paths, ['src/screens/ListScreen.tsx']);
}

/*
 * A rule the guidelines file would otherwise trip.
 *
 * docs/design-guidelines.md ships with every project and restates this ban list
 * — 「回避: #6366f1, #8b5cf6」 — so a per-file scan that included prose would name
 * the markdown as the place to fix, and the repair would be asked to edit the
 * document telling it not to do the thing.
 */
{
  const files = completeProject();
  files.set('docs/design-guidelines.md', '# Design\n回避する色: #6366f1, #8b5cf6');
  const defects = auditAiTells(documentOf(files), 'none', 'react');
  check('the guidelines file cannot be the culprit',
    defects.some((d) => d.id === 'default-palette'), false);
}

// --- and the planner is not asked ------------------------------------------------------
{
  const doc = documentOf(withPalette());
  /*
   * The palette defect alone, not everything the audit finds. `auditAiTells`
   * also reports the fixture's thin stylesheet, which is a real finding with
   * nothing to grep for, and mixing it in would test the planner rather than
   * the skip.
   */
  const defects = auditAiTells(doc, 'none', 'react').filter((d) => d.id === 'default-palette');
  let calls = 0;
  const plans = await planFileRepairs(doc, defects, async () => { calls += 1; return '{"assignments":[]}'; });
  check('every located defect means no planner call', calls, 0);
  check('and the plan targets the file with the colour',
    plans.map((p) => p.path), ['src/components/ui/CategoryPieChart.tsx']);
}

// A defect with no `paths` still goes to the planner, or a new audit's findings
// would silently stop being repaired the day it ships.
{
  const doc = documentOf(completeProject());
  let asked = null;
  const plans = await planFileRepairs(
    doc,
    [{ id: 'something-new', instruction: 'fix it' }],
    async (_system, user) => { asked = user; return '{"assignments":[{"defect":1,"paths":["src/App.tsx"]}]}'; }
  );
  check('an unlocated defect is still planned for', plans.map((p) => p.path), ['src/App.tsx']);
  check('and it was the one sent', asked.includes('something-new'), true);
}

// Mixed: the planner sees only what grep could not place, and its answers are
// numbered against that shorter list — an off-by-one here would attach the
// planner's file to the wrong defect.
{
  const doc = documentOf(withPalette());
  const defects = [
    ...auditAiTells(doc, 'none', 'react').filter((d) => d.id === 'default-palette'),
    { id: 'something-new', instruction: 'fix the new thing' },
  ];
  let sent = null;
  const plans = await planFileRepairs(doc, defects, async (_s, user) => {
    sent = user;
    return '{"assignments":[{"defect":1,"paths":["src/App.tsx"]}]}';
  });
  check('the planner is asked only about what grep could not place',
    [sent.includes('something-new'), sent.includes('default-palette')], [true, false]);
  const app = plans.find((p) => p.path === 'src/App.tsx');
  check('and its answer lands on the defect it was numbered against',
    app.defects.map((d) => d.id), ['something-new']);
  check('while the located one keeps its own file',
    plans.find((p) => p.path === 'src/components/ui/CategoryPieChart.tsx').defects.map((d) => d.id),
    ['default-palette']);
}

// A planner that returns nothing usable must not discard what grep located.
{
  const doc = documentOf(withPalette());
  const defects = [
    ...auditAiTells(doc, 'none', 'react').filter((d) => d.id === 'default-palette'),
    { id: 'something-new', instruction: 'fix the new thing' },
  ];
  const plans = await planFileRepairs(doc, defects, async () => 'sorry, no idea');
  check('a broken planner reply keeps the located work',
    plans.map((p) => p.path), ['src/components/ui/CategoryPieChart.tsx']);
}

// --- how much of a real defect list this covers -------------------------------------
//
// Measured over 40 stored project documents: 29 findings of these kinds, 16 of
// which carried their files before the design-system half was included and 25
// after - 86%. Documents where EVERY finding is located, and the planner call
// therefore never happens at all, went from 13 of 21 to 17 of 21.
//
// What is asserted here is narrower and does not drift: a finding whose file the
// audit already computed must carry it. Both of these were found by that
// measurement, and both name the file in their own instruction.
{
  const files = completeProject();
  files.set('src/screens/ListScreen.tsx',
    'export default function ListScreen(){ return (<div>' +
    Array.from({ length: 14 }, (_, i) => `<span style={{ color: '#33${i}${i}44', padding: 4 }} />`).join('') +
    '</div>) }');
  files.set('src/styles/globals.css', ':root { --a: #0017c1 }');
  const found = auditAiTells(documentOf(files), 'none', 'react');
  const inline = found.find((d) => d.id === 'inline-styling');
  check('inline-styling names the screens holding the inline styles',
    inline?.paths, ['src/screens/ListScreen.tsx']);
  const thin = found.find((d) => d.id === 'thin-stylesheet');
  check('thin-stylesheet names the stylesheet it asks to be written',
    thin?.paths, ['src/styles/globals.css']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
