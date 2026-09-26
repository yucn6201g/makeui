/**
 * Free work, computed and then thrown away.
 *
 * `applyDeterministicFixes` recolours contrast faults arithmetically —
 * `passingPair` returns the exact hex that clears the ratio, so no model is
 * asked. It marks `contrast-low` fixed only when EVERY fault was recolourable,
 * which is right: a partial fix leaves the defect open and the repair
 * instruction still true.
 *
 * The caller then adopted the returned document only when something had been
 * marked. Those are different questions and they were one condition, so a pass
 * that cleared three of five faults for nothing had its stylesheet discarded and
 * the model was asked to redo all five.
 *
 * It is also why the stage read as idle. Over 30 days it logged three times, and
 * `contrast-low` shipped in 70 of 205 runs. A partial pass claims nothing, so it
 * logged nothing — three of five was invisible and total at the same time.
 *
 * What this file holds is the separation: the document is kept whenever the
 * stylesheet actually changed, and the defect is claimed only when it was
 * closed.
 *
 *   node test/deterministic-partial.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const out = path.join(root, 'dist/deterministic-partial.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/repair/deterministic-fixes.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*'],
});
const { applyDeterministicFixes } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/**
 * A project whose stylesheet holds one of the two offending colours.
 *
 * The colours are `rgb(...)`, not hex, because that is what the fixture is
 * modelling: these facts come from the browser reading computed styles, and
 * `parseRgb` accepts nothing else. A hex fixture returns null from `passingPair`
 * and the whole pass does nothing — which is what the first draft of this file
 * asserted was a bug in the code.
 *
 * `rgb(119,119,119)` on white is 4.48:1 and recolourable, because #777777 is in
 * the stylesheet and can be replaced. The second fault names a colour that
 * appears nowhere in the CSS — the case the module's own comment describes,
 * where the value was written into components and no token exists — so
 * `recolour` returns null for it and the fault stands.
 */
const doc = `@@@makeui:file src/styles/globals.css
.muted { color: #777777; background: #FFFFFF; }
.card { background: #FFFFFF; }
@@@makeui:endfile
@@@makeui:file src/screens/ListScreen.tsx
export default function ListScreen() { return <p className="muted">x</p>; }
@@@makeui:endfile`;

const fault = (fg, bg, ratio) => ({ fg, bg, ratio, required: 4.5, overImage: false });
const GREY = 'rgb(119, 119, 119)';      // #777777, in the stylesheet
const WHITE = 'rgb(255, 255, 255)';
const ABSENT = 'rgb(138, 138, 138)';    // #8A8A8A, nowhere in the stylesheet
const facts = (contrast) => ({ contrast, smallFields: [], screens: [] });

// --- one fault, fully recolourable -------------------------------------------
const full = applyDeterministicFixes(doc, facts([fault(GREY, WHITE, 4.48)]));
check('a fault it can reach is recoloured', full.html !== doc, true);
check('and the defect is claimed', full.fixed, ['contrast-low']);
check('the offending colour is gone from the stylesheet', full.html.includes('#777777'), false);

// --- two faults, one of them unreachable --------------------------------------
/*
 * The case the caller used to discard. One fault is recoloured, the other names
 * a colour the stylesheet does not contain, so `contrast-low` stays open.
 */
const partial = applyDeterministicFixes(doc, facts([
  fault(GREY, WHITE, 4.48),
  fault(ABSENT, WHITE, 3.9),
]));
check('the reachable half is still recoloured', partial.html !== doc, true);
check('the document carries that work', partial.html.includes('#777777'), false);
// The rule that was right and is unchanged: a partial fix is not a closed defect.
check('but the defect is NOT claimed', partial.fixed, []);
check('and what was done is still reported', partial.notes.length > 0, true);

// --- nothing to do ------------------------------------------------------------
const none = applyDeterministicFixes(doc, facts([]));
check('no faults means no change', none.html === doc, true);
check('and nothing claimed', [none.fixed, none.notes], [[], []]);
// A fault it cannot reach at all must not appear to have been handled.
const unreachable = applyDeterministicFixes(doc, facts([fault(ABSENT, WHITE, 3.9)]));
check('an unreachable fault changes nothing', unreachable.html === doc, true);
check('and claims nothing', unreachable.fixed, []);

// --- the same pair on several elements, and the literal in a screen's sheet ------
/*
 * The 2026-09-13 run: three faults at 4.37:1, one colour, a token in globals.css
 * and a literal in AlertsScreen.css. It recoloured the token, left the literal,
 * and reported the fix as partial.
 */
{
  const MUTED = 'rgb(122, 112, 102)';     // #7a7066
  const SURFACE = 'rgb(245, 243, 240)';
  const project = `@@@makeui:file src/styles/globals.css
:root { --color-text-muted: #7a7066; }
@@@makeui:endfile
@@@makeui:file src/screens/AlertsScreen.css
.filter-legend { color: #7a7066; }
@@@makeui:endfile
@@@makeui:file src/screens/AlertsScreen.tsx
export default function AlertsScreen() { return <p className="filter-legend">x</p>; }
@@@makeui:endfile`;
  const r = applyDeterministicFixes(project, facts([fault(MUTED, SURFACE, 4.37), fault(MUTED, SURFACE, 4.37), fault(MUTED, SURFACE, 4.37)]));
  check('three faults of one pair are one recolour and a closed defect', r.fixed, ['contrast-low']);
  check('logged once', r.notes.length, 1);
  check('the literal in the screen sheet moves with the token', r.html.toLowerCase().includes('#7a7066'), false);
  check('and the component source is untouched', r.html.includes('return <p className="filter-legend">x</p>'), true);

  // A second fault needing a DIFFERENT colour from the same one is not addressed by the first.
  const DARK = 'rgb(200, 200, 200)';
  const split = applyDeterministicFixes(project, facts([fault(MUTED, SURFACE, 4.37), fault(MUTED, DARK, 2.0)]));
  check('the same colour needing another value elsewhere keeps the defect open', split.fixed, []);
}

// --- and what the user is shown follows what shipped ---------------------------
/*
 * The fixes change the document after it was measured. When no repair pass is
 * accepted, nothing renders it again — the end-of-run re-walk compared against
 * the document after the loop, which already had the fixes, and did not run.
 * The 2026-09-13 reply listed a contrast fault in a colour the shipped document
 * no longer contained.
 */
{
  const g = read('src/orchestration/generate/graph.ts');
  check('the measured document is recorded with the first render',
    /let facts = await verify\(finalHtml\)\s*\n\s*measuredHtml = finalHtml/.test(g), true);
  check('and when an empty-container fill is adopted with its render',
    /facts = refacts\s*\n\s*measuredHtml = attempt\.html/.test(g), true);
  check('and when an accepted pass brings its own render',
    /scoredFacts = repairedFacts\s*\n\s*measuredHtml = candidate/.test(g), true);
  check('never beside the deterministic fixes, which are not a render',
    /if \(changed\) finalHtml = settled\.html\s*\n\s*measuredHtml/.test(g), false);
  check('the re-walk fires on any difference from what was measured',
    g.includes('if (scoredFacts && finalHtml !== measuredHtml) {'), true);
  check('not on the post-loop snapshot that already held the fixes', /verifiedHtml/.test(g), false);
}

// --- the caller keeps them apart ----------------------------------------------
/*
 * Stated against the source: the property is that adopting the document and
 * claiming the defect are two conditions. Collapsing them again is the bug.
 */
const graph = read('src/orchestration/generate/graph.ts');
const site = graph.slice(graph.indexOf('const settled = applyDeterministicFixes'),
  graph.indexOf('scoredFacts = facts'));
check('the caller adopts on change, not on a claim',
  /const changed = settled\.html !== finalHtml\s*\n\s*if \(changed\) finalHtml = settled\.html/.test(site), true);
check('and still passes on only what was closed',
  /settledIds = settled\.fixed/.test(site), true);
// The old shape, which must not come back.
check('adoption is not gated on the claim',
  /if \(settled\.fixed\.length > 0\) \{\s*\n\s*finalHtml = settled\.html/.test(site), false);
// A partial pass claims nothing, so without this it is absent from the log the
// measurement is taken from — which is how it read as three passes in 30 days.
check('a partial pass is logged', /partial: changed && settled\.fixed\.length === 0/.test(site), true);
check('and the log says how many it closed', /closed: settled\.fixed\.length/.test(site), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
