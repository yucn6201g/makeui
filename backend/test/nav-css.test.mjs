// A navigation left in the browser's bulleted list.
//
// Reported 2026-09-20: 「ナビゲーションが箇条書きのまま表示されている状態でUIが生成される
// ケースが多く…見栄えがかなり悪い」.
//
// Measured over 102 stored documents: 30 carry a list inside <nav>, and 17 of
// those (57%) render with a dot beside every item, no spacing, no hover and no
// current-page state. Two shapes, neither reachable by any rule the project
// wrote:
//
//   12   <nav className="app-nav"><ul><li><button>…   nothing has a class
//    5   <ul className="app-nav-list">                a class nothing defines
//
// The runtime audit has reported this as `nav-unstyled` since the browser walk
// could see it, and its own note already said the cause: 「every one used nav
// classes that no stylesheet defines」. A model is asked to write them, and it
// is still 57%.
//
// Run over the 19 documents whose navigation nothing could reach: 19 styled.
//
//   node test/nav-css.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fixupsEntry, readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = async (entry, out) => {
  await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, out), external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
  });
  return import(pathToFileURL(path.join(root, out)).href);
};
const { navCss, listIsStyled, commonRadius } = await build('src/tools/fixups/nav-css.ts', 'dist/nc.test.mjs');
const { fixUnstyledNav } = await build(fixupsEntry(), 'dist/ncf.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const TOKENS = `:root {
  --color-text: #1a1a1a;
  --color-text-secondary: #6b6b6b;
  --color-surface-secondary: #f5f5f5;
  --radius-md: 4px;
}
.card { border-radius: 4px; padding: 16px; }`;

// The document's own shape, from the run of 2026-09-20.
const APP = `export default function App(): JSX.Element {
  return (
    <nav className="app-nav">
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <button onClick={() => navigate(item.id)} aria-current={route.screen === item.id ? 'page' : undefined}>
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}`;
const project = (over = {}) => new Map(Object.entries({
  'src/styles/globals.css': TOKENS,
  'src/App.tsx': APP,
  ...over,
}));

// --- what gets written -------------------------------------------------------------
{
  const r = fixUnstyledNav(project());
  const css = r.files.get('src/styles/globals.css') ?? '';
  check('the marker goes first', /list-style/.test(css), true);
  /*
   * The list has no class to hang a rule on, so the selector descends from the
   * nav. That is what makes one generator cover both shapes, and it is why
   * this is safe: a rule under `.app-nav` cannot reach a list anywhere else.
   */
  check('the rule descends from the nav', /\.app-nav ul \{/.test(css), true);
  check('the marker is removed', /list-style: none;/.test(css), true);
  check('and the browser\'s indent with it', /margin: 0;\n {2}padding: 0;/.test(css), true);
  check('the items are laid out', /flex-direction: row;/.test(css), true);
  check('the control gets a hit area', /padding: 8px 12px;/.test(css), true);
  // The three states a default list has none of.
  check('hover', /\.app-nav a:hover, \.app-nav button:hover \{/.test(css), true);
  // :focus-visible rather than :focus — a ring on a mouse click is what every
  // design system asks people to turn off.
  check('focus, on :focus-visible', /\.app-nav a:focus-visible/.test(css), true);
  /*
   * The current page is read from `aria-current`, which the build contract
   * already requires — so this styles what is there rather than asking for a
   * class somebody would have to add.
   */
  check('and the current page', /\[aria-current="page"\]/.test(css), true);
  check('it says what it did', r.fixed.length, 1);
  check('running it again changes nothing', fixUnstyledNav(r.files).fixed, []);
}

// --- the values are the project's -----------------------------------------------
{
  const { css } = navCss([{ path: 'src/App.tsx', className: 'app-nav', tag: 'ul', listClasses: [], vertical: false }], TOKENS);
  check('the ink is the product\'s ink', /color: var\(--color-text\);/.test(css), true);
  check('the quieter ink too', /color: var\(--color-text-secondary\);/.test(css), true);
  check('and the corner is its radius token', /border-radius: var\(--radius-md\);/.test(css), true);
}
/*
 * A literal default was wrong in the one direction that shows: the first
 * document this ran on was Carbon, which is square and declares no radius
 * scale, so a 6px fallback rounded the navigation in a design system whose
 * whole character is that nothing is rounded.
 */
check('a square product keeps its corners',
  commonRadius('.a { border-radius: 0; } .b { border-radius: 0; } .c { border-radius: 4px; }'), '0');
check('a rounded one keeps its own', commonRadius('.a { border-radius: 8px; } .b { border-radius: 8px; }'), '8px');
check('a pill is a shape, not a corner', commonRadius('.pill { border-radius: 9999px; }'), '6px');
check('and nothing at all falls back', commonRadius('.a { color: red; }'), '6px');

// --- which way it runs ---------------------------------------------------------------
{
  const { css } = navCss([{ path: 'src/App.tsx', className: 'app-sidebar', tag: 'ul', listClasses: [], vertical: true }], TOKENS);
  check('a sidebar runs down', /flex-direction: column;/.test(css), true);
  check('and its items fill the width', /width: 100%;/.test(css), true);
}

// --- what it refuses -----------------------------------------------------------------
/*
 * Conservative: if anything might already be styling the list, this does
 * nothing. `display: flex` counts as well as `list-style`, because flex
 * blockifies the items and the markers stop rendering without `list-style`
 * being mentioned anywhere.
 */
check('a class the project defines is left alone',
  fixUnstyledNav(project({
    'src/App.tsx': APP.replace('<ul>', '<ul className="app-nav__list">'),
    'src/styles/globals.css': `${TOKENS}\n.app-nav__list { list-style: none; display: flex; }`,
  })).fixed, []);
check('a rule on the bare tag is left alone',
  fixUnstyledNav(project({ 'src/styles/globals.css': `${TOKENS}\n.app-nav ul { list-style: none; }` })).fixed, []);
check('so is a flex rule with no list-style in it',
  fixUnstyledNav(project({ 'src/styles/globals.css': `${TOKENS}\nnav ul { display: flex; }` })).fixed, []);
check('and a universal reset',
  fixUnstyledNav(project({ 'src/styles/globals.css': `${TOKENS}\n* { list-style: none; }` })).fixed, []);
check('a nav with no list is not this defect',
  fixUnstyledNav(project({ 'src/App.tsx': '<nav className="app-nav"><a href="#">x</a></nav>' })).fixed, []);
check('a project with no stylesheet is left alone',
  fixUnstyledNav(new Map([['src/App.tsx', APP]])).fixed, []);
// A Vue project keeps component CSS in the SFC, and a rule there styles the
// navigation just as well as one in the stylesheet.
check('a scoped style counts',
  fixUnstyledNav(new Map([
    ['src/styles/globals.css', TOKENS],
    ['src/App.vue', '<template><nav class="app-nav"><ul><li><a href="#">x</a></li></ul></nav></template>\n<style scoped>.app-nav ul { list-style: none; display: flex; }</style>'],
  ])).fixed, []);

// --- the reach test on its own ---------------------------------------------------
{
  const nav = { path: 'p', className: 'app-nav', tag: 'ul', listClasses: ['nav-list'], vertical: false };
  check('a selector ending in the tag reaches it', listIsStyled('.app-nav ul { list-style: none; }', nav), true);
  check('one ending in its class too', listIsStyled('.nav-list { display: flex; }', nav), true);
  check('a rule about something else does not', listIsStyled('.card ol { list-style: none; }', nav), false);
  // `.nav-list-item` ends with different text and must not count as `.nav-list`.
  check('nor does a longer name that starts the same', listIsStyled('.nav-list-item { display: flex; }', nav), false);
}

// --- the wiring -------------------------------------------------------------------
const fixups = readFixups();
check('the project pass runs it', fixups.includes('apply(fixUnstyledNav(files))'), true);
// Before the utility block, so the project's own rules stay above it.
check('and before the utility block',
  fixups.indexOf('apply(fixUnstyledNav(files))') < fixups.indexOf('apply(fixDeadUtilityClasses(files))'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
