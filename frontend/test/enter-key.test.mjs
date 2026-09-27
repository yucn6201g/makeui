// Every Enter handler goes through isCommitEnter (src/utils/editing/enterKey.ts).
//
// An Enter handler that checks only `e.key === 'Enter'` also fires on the Enter
// that confirms a Japanese conversion: typing 「ざいこ」 and pressing Enter to
// make it 「在庫」 sent the request half-written. Six handlers did it on
// 2026-09-27; this keeps a seventh from being written the old way.
//
//   node test/enter-key.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
})(path.join(root, 'src'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const helper = path.join(root, 'src/utils/editing/enterKey.ts');
const raw = files.filter((f) => f !== helper).flatMap((f) => {
  const src = fs.readFileSync(f, 'utf8');
  return [...src.matchAll(/key === ['"]Enter['"]/g)].map(() => path.relative(root, f).split(path.sep).join('/'));
});
check('no Enter handler outside the helper reads the key alone', raw, []);
check('the helper refuses a composing Enter', /isComposing/.test(fs.readFileSync(helper, 'utf8')) && /keyCode !== 229/.test(fs.readFileSync(helper, 'utf8')), true);
const users = files.filter((f) => /isCommitEnter\(e\)/.test(fs.readFileSync(f, 'utf8'))).length;
check('and the handlers use it', users >= 4, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
