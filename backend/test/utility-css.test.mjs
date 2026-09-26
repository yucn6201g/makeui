// Utility classes that were written and never defined, given their CSS.
//
// Reported 2026-09-20: 「Tailwindなどのクラスを使っているが、プロジェクトでは効いて
// いないことが多発しています。それによってデザインが反映されておらず、チープなデザインに
// なってしまっている」.
//
// Measured over the last 102 stored documents: 23 (24%) ship with three or more
// dead utility classes, the worst carrying 95. The audit has reported this as
// `utility-classes` for weeks and a model is asked to rewrite the markup into
// component classes — and it is still 24%, which is the measurement that
// matters. So the classes are made to work instead.
//
// Run over the 23 documents that had them: 22 now have none (96%). The one left
// is `bg-gradient-to-br`, which needs colour stops that are not there — and a
// gradient is on the build's own BANNED list anyway.
//
//   node test/utility-css.test.mjs      (from backend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fixupsEntry, readFixups } from './lib/fixups-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/uc.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/tools/fixups/utility-css.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { utilityCss, definedClasses, paletteOf, UTILITY_CLASS } = await import(pathToFileURL(out).href);

const fx = path.join(root, 'dist/ucf.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, fixupsEntry())],
  bundle: true, platform: 'node', format: 'esm', outfile: fx,
  external: ['@aws-sdk/*', '@smithy/*'], logLevel: 'error',
});
const { fixDeadUtilityClasses } = await import(pathToFileURL(fx).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
/** The declaration block written for one class. */
const ruleFor = (css, cls) => {
  const line = css.split('\n').find((l) => l.startsWith(`.${cls.replace(/([.:])/g, '\\$1')} `) || l.startsWith(`.${cls.replace(/([.:])/g, '\\$1')}:`));
  return line ?? '';
};

// --- the scale is the scale ------------------------------------------------------
{
  const { css, handled, unhandled } = utilityCss(['p-4', 'px-6', 'mb-2', '-mt-1', 'gap-3', 'w-full', 'h-6', 'max-w-md']);
  check('spacing is four steps of a quarter rem', /\.p-4 \{ padding: 1rem; \}/.test(css), true);
  check('an axis writes both sides', /\.px-6 \{ padding-left: 1\.5rem; padding-right: 1\.5rem; \}/.test(css), true);
  check('a negative margin is negative', /\.-mt-1 \{ margin-top: -0\.25rem; \}/.test(css), true);
  check('sizing reads its keywords', /\.w-full \{ width: 100%; \}/.test(css), true);
  check('and its steps', /\.h-6 \{ height: 1\.5rem; \}/.test(css), true);
  check('max-width has its own scale', /\.max-w-md \{ max-width: 28rem; \}/.test(css), true);
  check('everything was understood', unhandled, []);
  check('and reported as handled', handled.length, 8);
}
// Type comes with its line-height, which is the half of the scale that is
// usually dropped.
{
  const { css } = utilityCss(['text-sm', 'text-2xl', 'font-semibold', 'leading-tight', 'tracking-wide']);
  check('a type size brings its line-height', /\.text-sm \{ font-size: 0\.875rem; line-height: 1\.25rem; \}/.test(css), true);
  check('and the larger steps too', /\.text-2xl \{ font-size: 1\.5rem; line-height: 2rem; \}/.test(css), true);
  check('weights are numbers', /\.font-semibold \{ font-weight: 600; \}/.test(css), true);
  check('leading is unitless', /\.leading-tight \{ line-height: 1\.25; \}/.test(css), true);
  check('tracking is in em', /\.tracking-wide \{ letter-spacing: 0\.025em; \}/.test(css), true);
}

// --- the design system's own: colour, corners, shadow ----------------------------
/*
 * This is the half that matters. A `rounded-lg` under Carbon is Carbon's
 * radius, which is zero, and a `text-gray-900` should be the ink this product
 * already uses rather than Tailwind's #111827.
 */
const TOKENS = `:root {
  --color-text-high-emphasis: #1a1a1a;
  --color-text-secondary: #6b6b6b;
  --color-surface-primary: #ffffff;
  --color-surface-secondary: #f5f5f5;
  --color-border: #d9d9d9;
  --color-danger: #d32f2f;
  --color-primary: #0b6;
  --radius-md: 4px;
  --radius-lg: 8px;
}`;
{
  const { css } = utilityCss(
    ['text-gray-900', 'text-gray-500', 'bg-white', 'bg-gray-50', 'border-gray-200', 'rounded-lg', 'rounded-md', 'text-red-600', 'text-blue-600'],
    TOKENS);
/*
 * No fallback inside the `var()`. The token exists by construction — it was
 * read out of this project's own `:root` a moment earlier — and a fallback
 * would put a colour into the stylesheet the design system never chose, which
 * `palette-size` and `preset-drift` both count.
 */
  check('dark ink is the product\'s ink', /color: var\(--color-text-high-emphasis\);/.test(css), true);
  check('mid ink is its quieter ink', /color: var\(--color-text-secondary\);/.test(css), true);
  check('white is its surface', /background-color: var\(--color-surface-primary\);/.test(css), true);
  check('a wash is its secondary surface', /background-color: var\(--color-surface-secondary\);/.test(css), true);
  check('a line is its border', /border-color: var\(--color-border\);/.test(css), true);
  check('corners come from its radius scale', /\.rounded-lg \{ border-radius: var\(--radius-lg\); \}/.test(css), true);
  check('each step from its own', /\.rounded-md \{ border-radius: var\(--radius-md\); \}/.test(css), true);
  // A family that means something resolves to the token for that meaning.
  check('a red is the product\'s danger colour', /color: var\(--color-danger\);/.test(css), true);
  check('a blue is its primary', /color: var\(--color-primary\);/.test(css), true);
}
// With no tokens to read, the literal is the honest answer.
{
  const { css } = utilityCss(['text-gray-900', 'rounded-lg', 'bg-white'], ':root { --x: 1px; }');
  check('no tokens means no var()', /var\(/.test(css), false);
  check('and the literal value instead', /\.text-gray-900 \{ color: #111827; \}/.test(css), true);
}
/*
 * A radius SCALE, not any token with "radius" in its name. A catch-all matched
 * `--radius-snackbar` on a real document and every `rounded-lg` in the project
 * became a snackbar's corner.
 */
check('a component\'s radius is not a scale',
  /border-radius: 0\.5rem;/.test(utilityCss(['rounded-lg'], ':root { --radius-snackbar: 6px; }').css), true);

// --- the states and the breakpoints ----------------------------------------------
{
  const { css, handled, unhandled } = utilityCss(['hover:bg-gray-50', 'focus:outline-none', 'sm:px-6', 'lg:grid-cols-3'], TOKENS);
  check('a hover is a rule on :hover', /\.hover\\:bg-gray-50:hover \{ background-color: var\(--color-surface-secondary\); \}/.test(css), true);
  // :focus-visible rather than :focus — a ring on a mouse click is the thing
  // every design system spends a paragraph asking people to turn off.
  check('a focus is a rule on :focus-visible', /\.focus\\:outline-none:focus-visible \{/.test(css), true);
  check('a breakpoint is a media query', /@media \(min-width: 640px\) \{\n {2}\.sm\\:px-6 \{/.test(css), true);
  check('and they are ordered smallest first',
    css.indexOf('min-width: 640px') < css.indexOf('min-width: 1024px'), true);
  check('all four understood', unhandled, []);
  check('and counted', handled.length, 4);
}

// --- what it refuses -------------------------------------------------------------
/*
 * Inventing a declaration for a class this does not understand would be worse
 * than a class that does nothing, because it would look deliberate.
 */
{
  const { css, handled, unhandled } = utilityCss(['bg-gradient-to-br', 'animate-spin', 'p-4']);
  check('a gradient is left alone', unhandled.includes('bg-gradient-to-br'), true);
  check('so is anything else unmapped', unhandled.includes('animate-spin'), true);
  check('and nothing is written for them', /gradient|animate/.test(css), false);
  check('what it does know is still written', handled, ['p-4']);
}
check('nothing at all writes nothing', utilityCss([]).css, '');

// --- a class name is not an identifier ---------------------------------------------
/*
 * `.hover\:bg-gray-50` and `.px-2\.5`. Reading selectors with
 * /\.([A-Za-z_][\w-]*)/ stops at the backslash and returns `hover`, so a class
 * just defined still read as undefined — the audit would report it and a repair
 * would be spent rewriting markup that already worked.
 */
{
  const found = definedClasses('.hover\\:bg-gray-50:hover { color: red; } .px-2\\.5 { padding: 1px; } .card { }');
  check('an escaped colon is read back whole', found.has('hover:bg-gray-50'), true);
  check('so is an escaped dot', found.has('px-2.5'), true);
  check('and a plain class still reads', found.has('card'), true);
  check('the pseudo-class is not a class', found.has('hover'), false);
}

// --- the palette reader -------------------------------------------------------------
{
  const p = paletteOf(TOKENS);
  check('the ink is found by what it is for', p.ink, '--color-text-high-emphasis');
  check('and the quieter ink is not mistaken for it', p.inkMuted, '--color-text-secondary');
  check('the surface too', p.surface, '--color-surface-primary');
  check('and the line', p.border, '--color-border');
}

// --- the repair ------------------------------------------------------------------
const project = (extra = {}) => new Map(Object.entries({
  'src/styles/globals.css': `${TOKENS}\n.card { padding: 16px; }`,
  'src/screens/HomeScreen.tsx': 'export default () => <div className="card flex items-center gap-4 p-6 rounded-lg">x</div>;',
  ...extra,
}));
{
  const r = fixDeadUtilityClasses(project());
  const css = r.files.get('src/styles/globals.css') ?? '';
  check('the stylesheet gains the rules', /\.flex \{ display: flex; \}/.test(css), true);
  check('the project\'s own classes are untouched', /\.card \{ padding: 16px; \}/.test(css), true);
  check('and its tokens are still above them', css.indexOf('--color-text-high-emphasis') < css.indexOf('.flex'), true);
  check('it says what it did', r.fixed.length, 1);
  // Running it again must do nothing: the classes are defined now, and
  // `fixupProject` runs after the build and again after the repair loop.
  check('running it again changes nothing', fixDeadUtilityClasses(r.files).fixed, []);
}
// Below the audit's own floor, a stray class or two is not this failure.
check('two stray classes are left to the audit',
  fixDeadUtilityClasses(project({
    'src/screens/HomeScreen.tsx': 'export default () => <div className="card flex p-6">x</div>;',
  })).fixed.length, 0);
// A class the project defines is not dead, however Tailwind-shaped it looks.
check('a class the project defines is not rewritten',
  fixDeadUtilityClasses(project({
    'src/styles/globals.css': `${TOKENS}\n.flex { display: flex; }\n.items-center { align-items: center; }\n.gap-4 { gap: 8px; }\n.p-6 { padding: 8px; }\n.rounded-lg { border-radius: 2px; }`,
  })).fixed, []);
// Vue keeps component CSS in the SFC, and a class defined there is defined.
check('a scoped style counts as a definition',
  fixDeadUtilityClasses(new Map([
    ['src/styles/globals.css', TOKENS],
    ['src/screens/HomeScreen.vue', '<template><div class="flex items-center gap-4" /></template>\n<style scoped>.flex { display: flex; } .items-center { align-items: center; } .gap-4 { gap: 4px; }</style>'],
  ])).fixed, []);

// --- the wiring ---------------------------------------------------------------------
const fixups = readFixups();
check('the project pass runs it', fixups.includes('apply(fixDeadUtilityClasses(files))'), true);
// After the repairs that write markup, because it reads the markup.
check('and after the repairs that add classes',
  fixups.indexOf('apply(fixDeadUtilityClasses(files))') > fixups.indexOf('apply(fixPlaceholderImageBoxes(files))'), false);
const audit = fs.readFileSync(path.join(root, 'src/orchestration/audit/design-audit.ts'), 'utf8');
const utilityCssSource = fs.readFileSync(path.join(root, 'src/tools/fixups/utility-css.ts'), 'utf8');
check('the audit reads the same definition of "defined"', /for \(const c of definedClasses\(css\)\) defined\.add\(c\)/.test(audit), true);
check('and the same detector', /import \{[^}]*\bUTILITY_CLASS\b[^}]*\} from '\.\.\/\.\.\/tools\/fixups\/utility-css\.js'/.test(audit), true);
/*
 * A stylesheet that is nothing but `flex` and `p-4` is exactly what
 * `thin-stylesheet` exists to find, and seventy appended rules would answer
 * "richly styled" for it. The block is marked, and the count stops there.
 */
check('the block is marked where it starts', /UTILITY_BLOCK_MARKER/.test(utilityCssSource), true);
check('and the rule count stops at the marker',
  /b\.includes\(UTILITY_BLOCK_MARKER\) \? b\.slice\(0, b\.indexOf\(UTILITY_BLOCK_MARKER\)\) : b/.test(audit), true);
// The detector's own rule: a project's own name must not read as a utility.
check('a project\'s own class is not a utility',
  ['my-reservations-screen', 'deck-card__header', 'text-muted', 'py-lg'].filter((c) => UTILITY_CLASS.test(c)), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
