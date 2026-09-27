// Every rule that sets both a text colour and a solid background reads at 4.5:1.
//
// axe in the E2E suite checks what is on screen, and on 2026-09-27 it passed
// locally and failed in CodeBuild twice in a row — two badges at 4.36:1 and
// 4.35:1, which the local browser left undetermined. The colours were short in
// both places; only the measurement differed. This reads the stylesheet
// instead, so a pair under the line fails here, wherever it runs.
//
// Exempt, each with its reason: a disabled control (WCAG 1.4.3 does not apply)
// and an icon, which needs 3:1 as a graphic, not 4.5:1 as text.
//
//   node test/css-contrast.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const tokens = {};
for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
  for (const m of block[1].matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) tokens[m[1]] = m[2];
}
const resolve = (v) => {
  v = v.trim();
  const ref = /^var\((--[\w-]+)(?:,\s*([^)]+))?\)/.exec(v);
  if (ref) return resolve(tokens[ref[1]] ?? ref[2] ?? '');
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.exec(v);
  if (!hex) return null;
  const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
  return `#${h.toLowerCase()}`;
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Icons drawn in currentColor: a graphic needs 3:1. */
const ICONS = new Set(['.project-list__check', '.project-list__card-star--on']);

const low = [];
let measured = 0;
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = m[1].trim().split('\n').pop().trim();
  const body = m[2];
  const color = /(?<![-\w])color:\s*([^;]+);/.exec(body);
  const bg = /background(?:-color)?:\s*([^;]+);/.exec(body);
  if (!color || !bg) continue;
  const [c, b] = [resolve(color[1]), resolve(bg[1])];
  if (!c || !b) continue;
  measured++;
  const r = ratio(c, b);
  const needed = ICONS.has(selector) ? (c === b ? 0 : 3) : /:disabled/.test(selector) ? 0 : 4.5;
  if (r < needed) low.push(`${selector}: ${c} on ${b} = ${r.toFixed(2)}:1`);
}
check('the pairs were found', measured > 40, true);
check('every text colour on its own background reads at 4.5:1', low, []);
check('the icon list names rules that exist', [...ICONS].filter((s) => !css.includes(`${s} {`)), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
