// What the preview says while it is being built.
//
// The preview pane showed its idle placeholder for the whole of a run —
// 「プレビューがここに表示されます / 左のチャットからUIを生成してください」 — so the one
// moment the user is certainly looking at it was also the moment it told them to
// go and start the thing they had just started. Minutes of a real run, with the
// only sign of life in the other pane.
//
// The caption is the run's own step label rather than a fixed 「生成中…」, because
// the server already publishes one and it is the honest answer to "what is it
// doing". This is the only part of the new state with a decision in it, so it
// lives in a function that can be tested without a DOM.
//
//   node test/generating-caption.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/chat/generatingCaption.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/gc.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { generatingCaption } = await import(
  pathToFileURL(path.join(root, 'node_modules/.cache/gc.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const phase = (label) => ({ label, text: '', chars: 0 });

// A run that has been accepted but has not reported a step yet. Naming a step
// here would name one that has not started.
check('no phases yet', generatingCaption([]),
  { title: 'UIを生成しています', detail: 'まもなく開始します' });

// The live step is the last one reported, and it is the whole point of using the
// run's own labels: 「設計をレビュー中」 tells the user something a spinner cannot.
check('the newest phase is the caption',
  generatingCaption([phase('画面構成を設計中'), phase('設計をレビュー中')]),
  { title: '設計をレビュー中', detail: '1個のステップが完了' });

check('a single phase has nothing finished behind it',
  generatingCaption([phase('画面構成を設計中')]),
  { title: '画面構成を設計中', detail: 'まもなく開始します' });

check('finished steps are counted, not totalled',
  generatingCaption([phase('a'), phase('b'), phase('c'), phase('d')]).detail,
  '3個のステップが完了');

// A label that arrives blank must not blank the caption.
check('an empty label falls back',
  generatingCaption([phase('   ')]).title, 'UIを生成しています');

// The hook hands over whatever it has; undefined before the first poll resolves
// is normal and must not throw inside a render.
check('undefined is survivable', generatingCaption(undefined),
  { title: 'UIを生成しています', detail: 'まもなく開始します' });
check('null is survivable', generatingCaption(null).title, 'UIを生成しています');
// Defensive rather than theoretical: this value is parsed from a job record.
check('a non-array is survivable', generatingCaption({ label: 'x' }).title, 'UIを生成しています');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
