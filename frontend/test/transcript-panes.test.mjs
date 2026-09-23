// A step of the run scrolls once, not twice.
//
// Prose and code were each a bounded, self-scrolling pane, so a step that wrote
// both — the reasoning, then the file it decided to write — put two scrollbars
// inside one card and following the output meant working out which of them was
// moving. Reported as 「スクロールバーが2つあってややこしい」.
//
//   node test/transcript-panes.test.mjs      (from frontend/)
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');
const tsx = fs.readFileSync(path.join(root, 'src/components/ReasoningTranscript.tsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const rule = (sel) => {
  const out = [];
  const needle = `\n${sel} {`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    out.push(css.slice(i + needle.length, css.indexOf('}', i)));
  }
  return out.join('\n');
};

// --- one scroller, and it belongs to the step -------------------------------
const body = rule('.rt__body');
check('the step\'s pane is bounded', /max-height:\s*\d+px/.test(body), true);
check('and it is the thing that scrolls', /overflow:\s*auto/.test(body), true);
check('a wheel at its end does not scroll the thread behind it',
  /overscroll-behavior:\s*contain/.test(body), true);

for (const half of ['.rt__prose', '.rt__code']) {
  const r = rule(half);
  check(`${half} does not scroll on its own`, /overflow:\s*auto|overflow-y:\s*auto/.test(r), false);
  check(`${half} is not bounded on its own`, /max-height/.test(r), false);
}

// --- and the component agrees -----------------------------------------------
check('only one element is given the following behaviour', (tsx.match(/<Tail\b/g) ?? []).length, 1);
check('it is the step\'s pane', /<Tail className="rt__body"/.test(tsx), true);
check('both halves are plain blocks inside it',
  /<div className="rt__prose">/.test(tsx) && /<div className="rt__code">/.test(tsx), true);
// The pane has to catch up when either half grows, not only when one does.
check('it follows whichever half changed', /watch=\{`\$\{prose\.length\}:\$\{code\.length\}`\}/.test(tsx), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
