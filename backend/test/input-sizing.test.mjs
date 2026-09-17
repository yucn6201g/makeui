// `input-sizing` is two faults sharing one id, and they must not share an
// instruction: a document handed all five requirements when it satisfied four
// spends a repair call and is rejected as "no improvement".
//
// Both branches were wrong in their own way.
//
//   HEIGHT — the exclusion that keeps a 12px language <select> out of the
//   measurement ran over the whole selector text, so a rule styling both a
//   select and a text input was discarded entirely:
//
//     .form-group select, .form-group input[type="number"] {
//       padding: var(--space-md); font-size: 16px;
//     }
//
//   The input half went out with the select, the document read as having no
//   sizing at all, and it was told to add the padding it had already written.
//   44 of the corpus findings, 30 of them this.
//
//   FONT — the finding quoted the value and stopped, so 190 documents had to
//   search their own stylesheet for it. The rules are known; naming them costs
//   nothing.
//
//   node test/input-sizing.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/is.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { auditInteractivity } = await import(pathToFileURL(path.join(root, 'dist/is.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${got}\n      want ${want}`);
  ok ? pass++ : fail++;
};

const fence = (p, b) => `@@@makeui:file ${p}\n${b}\n@@@makeui:endfile\n`;
const FORM = fence('src/screens/FormScreen.tsx',
  'export default function FormScreen() {\n' +
  '  return <form className="form-group">\n' +
  '    <input type="text" className="field" />\n' +
  '    <input type="number" className="field" />\n' +
  '    <textarea className="field" />\n' +
  '  </form>;\n}');
const doc = (css) =>
  `<!DOCTYPE html><html><body><div id="root"></div>\n${FORM}${fence('src/styles/globals.css', css)}</body></html>`;
const sizing = (css) => auditInteractivity(doc(css), 'react').find((d) => d.id === 'input-sizing');

// --- height ---------------------------------------------------------------
// The rule styles a select and a text input together. It sizes both.
check('a select sharing a rule with an input does not hide the input',
  /高さの指定がありません/.test(
    sizing('.form-group select, .form-group input[type="text"] { padding: 12px 14px; font-size: 16px; }')
      ?.instruction ?? ''),
  false);
// The exclusion still does its job: a rule that is only about a select says
// nothing about what the user types into.
check('a select-only rule still does not count as sizing',
  /高さの指定がありません/.test(
    sizing('.form-group select { padding: 12px 14px; font-size: 16px; }')?.instruction ?? ''),
  true);

// --- font -----------------------------------------------------------------
const small = sizing('.field { min-height: 44px; font-size: 14px; }');
check('a small font is reported', /font-size が 14px/.test(small?.instruction ?? ''), true);
check('and the rule is named',
  /src\/styles\/globals\.css の `\.field`/.test(small?.instruction ?? ''), true);

// A token says nothing about whether it is under the threshold, and the repair
// has to choose between changing the token and using a different one.
const token = sizing(
  ':root { --font-size-sm: 13px; }\n.field { min-height: 44px; font-size: var(--font-size-sm); }');
check('a token is resolved and quoted', /--font-size-sm = 13px/.test(token?.instruction ?? ''), true);
check('and the repair is told not to change its value',
  /値を変えるのではなく/.test(token?.instruction ?? ''), true);

// 16px is the threshold, not a target to exceed.
check('16px is fine', sizing('.field { min-height: 44px; font-size: 16px; }'), undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
