// A show-or-hide by width that a later rule had already overruled.
//
// The Digital Agency storefront of 2026-09-23: a phones-only 「絞り込み」 button
// sat full-width across the desktop page because `.da-btn { display:
// inline-flex }` followed `.da-filter-toggle { display: none }`, and on a phone
// the filter panel could not be closed because `.da-filter-panel { display:
// flex }` followed the query that hid it.
//
//   node test/responsive-display.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/fixups/responsive-display.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: path.join(root, 'dist/responsive-display.test.mjs'), logLevel: 'error',
});
const { fixResponsiveDisplay } = await import(pathToFileURL(path.join(root, 'dist/responsive-display.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The reported stylesheet, in the order it was written.
const CSS = `/* Filter Section */
.da-filter-toggle {
  display: none;
}

@media (max-width: 767px) {
  .da-filter-toggle {
    display: inline-flex;
  }

  .da-filter-panel {
    display: none;
  }

  .da-filter-panel--open {
    display: flex;
  }
}

.da-filter-panel {
  display: flex;
  gap: 24px;
}

/* Buttons */
.da-btn {
  display: inline-flex;
  align-items: center;
}
`;
const SCREEN = `<button className="da-btn da-btn--text da-filter-toggle" onClick={toggle}>絞り込み</button>
<div className={\`da-filter-panel \${open ? 'da-filter-panel--open' : ''}\`} />`;

{
  const r = fixResponsiveDisplay(new Map([['src/styles/globals.css', CSS], ['src/screens/ProductsScreen.tsx', SCREEN]]));
  const css = r.files.get('src/styles/globals.css');
  check('the desktop hide now beats the button class', /\n\.da-filter-toggle\.da-filter-toggle \{\n  display: none;/.test(css), true);
  check('and the phone show beats the hide', /\.da-filter-toggle\.da-filter-toggle\.da-filter-toggle \{\n    display: inline-flex;/.test(css), true);
  check('the phone collapse beats the later panel rule', /\.da-filter-panel\.da-filter-panel \{\n    display: none;/.test(css), true);
  check('and opening it still beats the collapse', /\.da-filter-panel--open\.da-filter-panel--open\.da-filter-panel--open \{/.test(css), true);
  check('the later rules themselves are untouched', [/\n\.da-filter-panel \{\n  display: flex;/.test(css), /\n\.da-btn \{/.test(css)], [true, true]);
  check('comments stay where they were', [css.includes('/* Filter Section */\n.da-filter-toggle.da-filter-toggle {'), css.includes('/* Buttons */\n.da-btn {')], [true, true]);
  check('both are reported', r.fixed.length === 1 && /da-filter-toggle[\s\S]*da-filter-panel/.test(r.fixed[0]), true);
  check('once', fixResponsiveDisplay(r.files).fixed, []);
}
{
  // Nothing overruled, nothing touched.
  const fine = `.da-btn { display: inline-flex; }\n.toggle { display: none; }\n@media (max-width: 767px) { .toggle { display: inline-flex; } }`;
  check('a hide that wins is left alone',
    fixResponsiveDisplay(new Map([['src/styles/globals.css', fine], ['src/App.tsx', '<button className="da-btn toggle" />']])).fixed, []);
  // A class that is hidden and never shown again by width is not a responsive toggle.
  const hidden = `.sr-only { display: none; }\n.btn { display: inline-flex; }`;
  check('a plain hide is not one of these',
    fixResponsiveDisplay(new Map([['src/styles/globals.css', hidden], ['src/App.tsx', '<span className="sr-only btn" />']])).fixed, []);
  // A collapse followed by nothing that overrides it works already.
  const collapse = `.panel { display: flex; }\n@media (max-width: 767px) { .panel { display: none; } .panel--open { display: flex; } }`;
  check('a collapse that wins is left alone', fixResponsiveDisplay(new Map([['src/styles/globals.css', collapse]])).fixed, []);
}
const fx = readFixups();
check('fixupProject runs it', /apply\(fixResponsiveDisplay\(files\)\)/.test(fx), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
