/**
 * Two ways the walk reported a working control as dead.
 *
 * Found by replaying the 2026-09-13 run's shipped document through the walk in
 * a local browser, where both of its 「押しても何も起きません」 findings came
 * back exactly as production logged them — and neither was a defect:
 *
 *   「1Q84村上春樹913.6-M佐藤花子2」  a table row with role="button". The walk
 *       pressed it as a row (its modal opened), then pressed the same row again
 *       as an action; selecting what is already selected changes nothing.
 *   「貸出登録」  a button in that modal. The candidates were read with the modal
 *       open, 「×」 was pressed first and closed it, and 「貸出登録」 was then
 *       clicked while detached from the document.
 *
 * With the walk below, the same document reports no dead actions. The walk is a
 * string evaluated in the page, so these assertions read the built expression.
 *
 *   node test/dead-action-walk.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/dead-action-walk.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/browser/browser-verify.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*', '@strands-agents/*', 'esbuild'],
  loader: { '.txt': 'text' }, logLevel: 'error',
});
const { walkExpression } = await import(pathToFileURL(out).href);
const walk = walkExpression(['home']);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const tryActions = walk.slice(walk.indexOf('const tryActions = async'), walk.indexOf('await tryRow();'));
const tryRow = walk.slice(walk.indexOf('const tryRow = async'), walk.indexOf('const tryActions = async'));

check('the walk expression parses', (() => { try { new Function(`return ${walk}`); return true; } catch { return false; } })(), true);

// --- the detached control, and the one that appeared ------------------------------
check('the candidates are read again before every press',
  /for \(let pressedHere = 0; pressedHere < 2; pressedHere\+\+\) \{[\s\S]*?const el = collect\(\)\[0\];[\s\S]*?await press\(el, 'action'\)/.test(tryActions), true);
check('collect reads the page as it is now, not a list taken earlier',
  /const collect = \(\) => \{[\s\S]*?return \[\.\.\.host\.querySelectorAll\(ACTION_SELECTOR\)\]\.filter/.test(tryActions), true);
check('no longer a slice taken before anything was pressed', /candidates\.slice\(0, 2\)/.test(tryActions), false);
check('still at most two per screen, eight in all', /pressedHere < 2[\s\S]*?actionsTried >= 8/.test(tryActions), true);

// --- what a response is ----------------------------------------------------------------
const sig = walk.slice(walk.indexOf('const sig = () =>'), walk.indexOf('const thrown = [];'));
check('a class change is a response', /getAttribute\('class'\)/.test(sig), true);
check('and so is a field value', /querySelectorAll\('input, textarea, select'\)\]\.map\(\(e\) => e\.value/.test(sig), true);
check('a confirmation dialog is answered yes', /window\.confirm = \(\) => true;/.test(walk), true);

// --- already selected ---------------------------------------------------------------------
const probe = walk.slice(walk.indexOf('const probeSelected = async'), walk.indexOf('await tryRow();'));
check('a control that did nothing is probed before it is reported', /if \(!rec\.responded\) await probeSelected\(el, rec\);/.test(tryActions), true);
check('by pressing a sibling in its group', /\[\.\.\.parent\.children\]\.filter/.test(probe), true);
check('not a sibling that navigates away or does nothing', /if \(!moved\.responded \|\| moved\.changed \|\| !el\.isConnected\) return;/.test(probe), true);
check('then the control again, and a response clears it', /await press\(el, 'probe'\);\s*\n\s*if \(nav\[nav\.length - 1\]\.responded\) \{\s*\n\s*rec\.responded = true;/.test(probe), true);
check('probes are not actions, so they are never counted as dead', /await press\(other, 'probe'\)/.test(probe), true);

// --- the row pressed twice -------------------------------------------------------
check('a row pressed as a row is remembered', /pressedRows\.add\(row\);/.test(tryRow), true);
check('and its label, so an equal control elsewhere is not pressed as a fresh action',
  /actionLabels\.add\(\(\(row\.textContent \|\| ''\)\.trim\(\)\)\.slice\(0, 20\)\);/.test(tryRow), true);
check('the action candidates exclude it', /pressedRows\.has\(e\)/.test(tryActions), true);
check('recorded before the press, since the press can re-render the list',
  tryRow.indexOf('pressedRows.add(row)') < tryRow.indexOf("await press(row, 'row')"), true);

// --- a screen hidden behind a full-height shell ----------------------------------------
// Replayed on the carbon run of 2026-09-14 (three screens hidden by `.screen { display: none }`)
// and on 37 other stored projects, where no screen changed.
{
  const measure = walk.slice(walk.indexOf('const measure = ('), walk.indexOf('const screens = new Map();'));
  check('the content region is main when there is one', /const region = s\.querySelector\('main, \[role="main"\]'\) \|\| s;/.test(measure), true);
  check('without one, the shell landmarks are left out', /const outsideShell = \(el\) => region !== s \|\| !el\.closest\(SHELL\);/.test(measure) && /header, nav, aside, footer/.test(measure), true);
  check('only a content region that shows nothing moves the fill, and to 0', /if \(!contentShows && fill > 0\) \{\s*\n\s*fill = 0;/.test(measure), true);
  check('what hid it is named', /hiddenBy = outer\s*\n?\s*\? describe\(outer\)/.test(measure), true);
  check('the measurement returns it', /return \{ id, fill, emptyBoxes: empties\.slice\(0, 4\), fields, broken, hiddenBy, unstyledNav, oversizedIcons, layout \};/.test(measure), true);
  check('and the facts carry it', /\.\.\.\(m\.hiddenBy \? \{ hiddenBy: m\.hiddenBy \} : \{\}\)/.test(fs.readFileSync(path.join(root, 'src/tools/browser/browser-verify.ts'), 'utf8')), true);
}

// --- styling that never arrived, as it shows on screen -------------------------------------
{
  const measure = walk.slice(walk.indexOf('const measure = ('), walk.indexOf('const screens = new Map();'));
  check('a nav list still in bullets is measured from computed style',
    /lcs\.display === 'list-item' && lcs\.listStyleType !== 'none'/.test(measure), true);
  check('an icon is a small viewBox rendered past 96px', /vb\[2\] > 48 \|\| vb\[3\] > 48/.test(measure) && /r\.width > 96 \|\| r\.height > 96/.test(measure), true);
  check('both are returned', /hiddenBy, unstyledNav, oversizedIcons, layout \};/.test(measure), true);
  const src = fs.readFileSync(path.join(root, 'src/tools/browser/browser-verify.ts'), 'utf8');
  check('and carried into the facts, once each', /unstyledNav: \[\.\.\.new Set\(/.test(src) && /oversizedIcons: \[\.\.\.new Set\(/.test(src), true);
}

// --- a hash that changed while the page did not ---------------------------------------------------
// The spindle Vue run of 2026-09-15: every press changed the hash, nothing re-rendered, and the walk
// recorded six screens at fill 1.0 — all of them the home screen. Replayed on 36 stored projects:
// 32 unchanged, 4 losing screens that were confirmed by hand never to render.
{
  const pressFn = walk.slice(walk.indexOf('const press = async'), walk.indexOf('const tryRow = async'));
  check('a press counts as navigating only when the page changed', /const pageChanged = sig\(\) !== sigBefore;/.test(pressFn) && /changed: before !== after && pageChanged,/.test(pressFn), true);
  check('and as a response only when the page changed', /responded: pageChanged,/.test(pressFn), true);
  const recordFn = walk.slice(walk.indexOf('const firstIdByContent'), walk.indexOf('const key = () =>'));
  check('an unmarked screen showing content already recorded under another id is not a new screen',
    /if \(seenAs !== undefined && seenAs !== s\.id && !screens\.has\(s\.id\)\) continue;/.test(recordFn), true);
  check('marked [data-screen] screens are not subject to it', /const marked = s\.el\.hasAttribute && s\.el\.hasAttribute\('data-screen'\);/.test(recordFn), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
