// A shadow is decoration or it is elevation, and the test must say which by
// measuring the shadow rather than by counting the characters it was typed in.
//
// The rule this replaces exempted a tinted shadow whose alpha matched
// `0?\.0?[0-9]` — one digit after the point, or two starting with a zero. That
// is a test of notation. `rgba(212, 175, 55, 0.6)` passed it, a gold glow at
// 60%; `rgba(26, 24, 21, 0.12)` failed it, a near-black shadow at 12%. Of 94
// tinted shadows in 70 stored documents it exempted 65, most of them exactly the
// decorative glow the rule exists to catch.
//
// The consequence was not only a wrong number. `Preset drift detected` fired,
// the conformance repair was handed 「影が強すぎます: 0 4px 8px rgba(42, 42, 40,
// 0.12)」, and a model was paid to make subtler a shadow that already was —
// twice on 2026-09-03, both rejected 「no improvement」.
//
// The blur half failed differently and more quietly: `blur[2] > 12` over lengths
// matched as `([\d.]+)px` needs the offset-x to carry a unit, so `0 8px 32px`
// produced two lengths, `blur[2]` was undefined, and the comparison was false
// for every shadow in all 70 documents.
//
//   node test/decorative-shadow.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { completeProject, documentOf, fence } from './fixtures/complete-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist/shadow-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { isDecorativeShadow } from '../src/orchestration/preset-conformance.js';",
  "export { clampDecorativeShadows } from '../src/orchestration/deterministic-fixes.js';",
  "export { presetConformance } from '../src/orchestration/design-presets.js';",
].join('\n'));
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${path.join(root, 'dist/shadow.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/*`,
  { stdio: 'pipe', cwd: root }
);
const { isDecorativeShadow, clampDecorativeShadows, presetConformance } = await import(
  pathToFileURL(path.join(root, 'dist/shadow.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the two the old rule had backwards -------------------------------------------
check('a gold glow at 60% is decoration',
  isDecorativeShadow('0 0 20px rgba(212, 175, 55, 0.6)'), true);
check('a near-black shadow at 12% is not',
  isDecorativeShadow('0 4px 8px rgba(26, 24, 21, 0.12)'), false);

// Same alpha, two spellings. The old rule read these differently — `.3` matched
// its exemption and `0.30` did not — which is the whole defect in one line.
check('notation does not change the answer',
  ['rgba(99, 102, 241, .3)', 'rgba(99, 102, 241, 0.3)', 'rgba(99, 102, 241, 0.30)']
    .map((c) => isDecorativeShadow(`0 4px 12px ${c}`)),
  [true, true, true]);

// --- neutral is unrestricted by alpha ------------------------------------------------
//
// Black at 30% is elevation and colour at 30% is a glow. That asymmetry is the
// rule, and it is the one thing the old test had right.
check('a black shadow is elevation at any strength',
  ['0 2px 4px rgba(0, 0, 0, 0.3)', '0 4px 12px rgba(0,0,0,0.5)'].map(isDecorativeShadow),
  [false, false]);

// --- the blur half, which never once fired --------------------------------------------
check('a 32px blur is decoration even in black',
  isDecorativeShadow('0 8px 32px rgba(0, 0, 0, 0.1)'), true);
check('and the zero does not need a unit for it to be seen',
  [isDecorativeShadow('0 8px 32px rgba(0,0,0,0.1)'), isDecorativeShadow('0px 8px 32px rgba(0,0,0,0.1)')],
  [true, true]);
check('ordinary modal elevation is left alone',
  ['0 4px 12px rgba(0,0,0,0.1)', '0 8px 24px rgba(0,0,0,0.12)'].map(isDecorativeShadow),
  [false, false]);

// --- and the fix is arithmetic --------------------------------------------------------
//
// Two numbers move; the colour, the offsets and the selector do not, because
// which colour a shadow should be is a judgement and clamping it is not.
{
  const css = [
    '.card { box-shadow: 0 8px 32px rgba(99, 102, 241, 0.55); }',
    '.modal { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); }',
    '.chip { box-shadow: 0 2px 4px rgba(26, 24, 21, 0.12); }',
  ].join('\n');
  const files = completeProject();
  files.set('src/styles/globals.css', css);
  const doc = documentOf(files);
  const out = clampDecorativeShadows(doc);

  check('the decorative one is reported as fixed', out.fixed, ['preset-drift']);
  check('the glow is brought back to the ceiling',
    /box-shadow:\s*0 8px 24px rgba\(99, 102, 241, 0\.25\)/.test(out.html), true);
  check('and its colour is untouched', out.html.includes('rgba(99, 102, 241'), true);
  check('the black shadow is left exactly as written',
    out.html.includes('0 4px 12px rgba(0, 0, 0, 0.1)'), true);
  check('so is the subtle tinted one',
    out.html.includes('0 2px 4px rgba(26, 24, 21, 0.12)'), true);

  /*
   * The point of the pass: what it produces measures clean, so no model call is
   * made for it. A deterministic fix that merely changes something and leaves
   * the violation standing costs a rewrite and buys nothing.
   */
  check('the document had a violation before',
    presetConformance(doc, 'none').violations > 0, true);
  check('and none after', presetConformance(out.html, 'none').violations, 0);
}

// A document with nothing to clamp must come back untouched rather than
// rewritten — a pass that always edits is a pass that always risks.
{
  const clean = documentOf(completeProject(), fence('src/styles/extra.css', '.a { box-shadow: none; }'));
  const out = clampDecorativeShadows(clean);
  check('a clean document is returned unchanged', out.html === clean && out.fixed.length === 0, true);
}

/*
 * A shadow declared as a token, which is how the stylesheets actually write it.
 *
 * The run of 2026-09-04 drifted on 「影が強すぎます: 0 10px 25px rgba(0,0,0,0.1)」
 * while this pass reported nothing to clamp: the value lives in `--shadow-lg`
 * and `box-shadow: var(--shadow-lg)` is what sits next to the word. The check
 * sees it because `presetConformance` resolves var() first — a fix reading the
 * raw stylesheet and a check reading the resolved one disagree about every
 * tokenised value.
 */
{
  const files = completeProject();
  files.set('src/styles/globals.css', [
    ':root {',
    '  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);',
    '  --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.1);',
    '  --space-6: 24px;',
    '  --radius-lg: 12px;',
    '}',
    '.card { box-shadow: var(--shadow-lg); }',
  ].join(String.fromCharCode(10)));
  const doc = documentOf(files);
  check('the document is in violation before', presetConformance(doc, 'none').violations, 1);

  const out = clampDecorativeShadows(doc);
  check('a shadow written as a token is clamped', out.fixed, ['preset-drift']);
  check('and the token now holds the ceiling',
    /--shadow-lg:\s*0 10px 24px/.test(out.html), true);
  check('and the document measures clean', presetConformance(out.html, 'none').violations, 0);

  /*
   * The guard that keeps this from clamping arithmetic that is not a shadow.
   * `isDecorativeShadow` needs two or more lengths AND either a blur past the
   * ceiling or a tinted colour, so a spacing or radius token cannot match.
   */
  check('a spacing token is untouched', out.html.includes('--space-6: 24px'), true);
  check('a radius token is untouched', out.html.includes('--radius-lg: 12px'), true);
  check('and a shadow already inside the ceiling is untouched',
    out.html.includes('--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05)'), true);
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
