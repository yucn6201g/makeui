// A contrast finding that says which colour would pass.
//
// "Change one of them to meet the ratio" leaves the model to solve a contrast
// equation — exact arithmetic, and the kind models get slightly wrong: the
// repair returns 3.9:1 where 4.5:1 was needed and the finding comes back next
// pass. Contrast was the largest runtime deduction of the last three rounds.
//
//   node test/contrast-suggestion.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/runtime-audit.ts')}" --bundle --platform=node ` +
    `--format=esm --loader:.txt=text --outfile="${path.join(root, 'dist/ras.test.mjs')}" ` +
    `--external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { passingPair } = await import(pathToFileURL(path.join(root, 'dist/ras.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The same relative-luminance formula the walk measures with, so the assertion
// is that the suggestion really passes rather than that it matches a string.
const lum = ([r, g, b]) => {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = (s) => s.match(/\d+/g).map(Number);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Every one of these is a pair a real run measured and deducted for.
const MEASURED = [
  ['rgb(5, 150, 105)', 'rgb(16, 185, 129)', 4.5, 'fg'],   // v197 Vue, green on green
  ['rgb(34, 197, 94)', 'rgb(250, 250, 248)', 4.5, 'fg'],  // v195 React
  ['rgb(154, 112, 80)', 'rgb(250, 250, 248)', 4.5, 'fg'], // v191 React
  ['rgb(139, 125, 115)', 'rgb(243, 237, 230)', 4.5, 'fg'],// v194 Vue
  ['rgb(255, 255, 255)', 'rgb(13, 148, 136)', 4.5, 'bg'], // v197 Svelte, white on teal
];
for (const [fg, bg, required, side] of MEASURED) {
  const fix = passingPair(fg, bg, required);
  check(`${fg} on ${bg} gets a suggestion`, Boolean(fix), true);
  check(`  and it moves the ${side}`, fix.side, side);
  const got = fix.side === 'fg' ? ratio(hex(fix.hex), rgb(bg)) : ratio(rgb(fg), hex(fix.hex));
  check(`  and the result actually passes`, got >= required, true);
}

// White or near-black text is ink — deliberate, and usually right. Suggesting
// black text on a teal button would meet the ratio and look wrong, so on a
// coloured surface it is the surface that moves.
check('near-black ink moves the surface too',
  passingPair('rgb(0, 0, 0)', 'rgb(60, 60, 60)', 4.5).side, 'bg');

// Nothing is invented where lightness alone cannot get there.
check('an impossible requirement declines',
  passingPair('rgb(128, 128, 128)', 'rgb(130, 130, 130)', 7), null);
check('an unparsable colour declines',
  passingPair('currentColor', 'rgb(0, 0, 0)', 4.5), null);

// A pair that already passes needs no change, and the first step out is enough.
const already = passingPair('rgb(0, 0, 0)', 'rgb(255, 255, 255)', 4.5);
check('a passing pair still answers with something that passes',
  ratio(hex(already.hex), [0, 0, 0]) >= 4.5 || ratio(hex(already.hex), [255, 255, 255]) >= 4.5, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
