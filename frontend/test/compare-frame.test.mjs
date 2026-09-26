// The version comparison's frames, which run a generated app and follow each other.
//
// Reported 2026-09-25 twice over: 「画面を連動」 did nothing, and the link to the
// booking system's first screen showed 「（MakeUI のドメイン）で接続が拒否
// されました」. One cause. The frame's document is about:srcdoc but its base URL
// is MakeUI's own, so a generated `<a href="#/…">` resolves to MakeUI's host and
// navigates the whole frame out — taking the sync script with it. The editing
// preview had a guard that performs a fragment link in place; these frames did
// not. Measured in two sandboxed srcdoc frames with the real scripts: without
// the guard the first click replaced the document and nothing answered again;
// with it, each side followed the other in both directions.
//
//   node test/compare-frame.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const frame = read('src/components/version-diff/LiveFrame.tsx');
check('the comparison frame carries the preview\'s navigation guard', /import \{ PREVIEW_GUARD_SCRIPT \} from '\.\.\/\.\.\/utils\/preview\/previewGuard'/.test(frame), true);
check('ahead of the sync script, in every document it writes', /const FRAME_SCRIPTS = PREVIEW_GUARD_SCRIPT \+ SYNC_SCRIPT;/.test(frame), true);
check('head, body or neither', (frame.match(/FRAME_SCRIPTS/g) ?? []).length, 4);
check('nothing writes SYNC_SCRIPT alone any more', /\+ SYNC_SCRIPT\)|SYNC_SCRIPT \+ doc/.test(frame), false);
check('still sandboxed to an opaque origin', /sandbox="allow-scripts"/.test(frame), true);

const guard = read('src/utils/preview/previewGuard.ts');
check('the guard performs a fragment link in place', /if \(verdict === 'hash'\) \{\s*e\.preventDefault\(\);[\s\S]{0,300}location\.hash = frag;/.test(guard), true);

// Every frame that runs a generated app a person can click through has it.
check('the editing preview has it', /PREVIEW_GUARD_SCRIPT/.test(read('src/components/workspace/Preview.tsx')), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
