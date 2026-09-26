// The way out of a preview that would not start.
//
// The frame catches the error that stops a generated app before it renders and
// showed it in a banner — a message, and nothing to do with it. On 下書き, where
// nothing else in the pipeline ever runs the document, that banner was the end
// of the run for the user: the app was broken and the only move was to describe
// the error back to the chat by hand.
//
// Two things are asserted here. The instruction, which has a decision in it and
// is a pure function; and the wiring, which is JSX and is read from source —
// a banner with no button, or a button on a run already in flight, is the bug.
//
//   node test/runtime-repair.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/chat/runtimeRepair.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'node_modules/.cache/rr.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { runtimeRepairInstruction, runtimeRepairMessage, DETAIL_FOR_MODEL, DETAIL_FOR_TRANSCRIPT } =
  await import(pathToFileURL(path.join(root, 'node_modules/.cache/rr.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const STACK = "Uncaught ReferenceError: EmptyCartIllustration is not defined\n    at Cart (blob:…:1421:9)";

// --- the instruction -----------------------------------------------------
const instruction = runtimeRepairInstruction(STACK);

check('the error itself is carried, not a summary of it', instruction.includes(STACK), true);
// The point of the whole button. A repair pass left to itself deletes the screen
// that threw, reports success, and the feature the user asked for is gone.
check('and it forbids removing the feature to make the error go away',
  instruction.includes('画面や機能を削って回避するのではなく'), true);
check('it says the app stops at startup, which is what distinguishes this from an edit',
  instruction.includes('起動時にエラーで停止'), true);
// This one is only interesting because it was wrong: a heredoc ate the escape
// and the two sentences ran together on one line in the shipped string.
check('the two sentences are separate lines',
  instruction.split('\n')[0].endsWith('解消してください。'), true);
check('and the stack is separated from them by a blank line',
  instruction.includes('直してください。\n\n'), true);

// A browser stack is unbounded and mostly frames from the bundle.
const long = 'x'.repeat(DETAIL_FOR_MODEL + 500);
check('a long stack is clipped for the model', runtimeRepairInstruction(long).endsWith('…'), true);
check('to the stated budget',
  runtimeRepairInstruction(long).length - instruction.indexOf(STACK), DETAIL_FOR_MODEL + 1);
check('a short one is not clipped', instruction.endsWith('…'), false);
check('surrounding whitespace is not sent', runtimeRepairInstruction(`  ${STACK}  `), instruction);

// Nothing to act on is not an edit. The button must not spend a run on it.
check('no error text means no instruction', runtimeRepairInstruction(''), null);
check('and neither does whitespace', runtimeRepairInstruction('\n \t'), null);

// --- what the user sees --------------------------------------------------
const message = runtimeRepairMessage(STACK);
check('the transcript says a repair was asked for', message.startsWith('起動エラーの修復を依頼しました。'), true);
check('and shows the error under it', message.includes(STACK), true);
check('the transcript budget is smaller than the model budget',
  DETAIL_FOR_TRANSCRIPT < DETAIL_FOR_MODEL, true);
check('a long stack is clipped there too', runtimeRepairMessage(long).endsWith('…'), true);
check('and more tightly', runtimeRepairMessage(long).length < runtimeRepairInstruction(long).length, true);

// --- the wiring ----------------------------------------------------------
const preview = fs.readFileSync(path.join(root, 'src/components/workspace/Preview.tsx'), 'utf8');
const app = readApp();
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');

check('the banner carries a button', /preview__runtime-fix/.test(preview), true);
// The banner is rendered in contexts that have no handler to give it; a button
// there would be a dead control.
check('which is rendered only when a handler was passed',
  /\{onRepairRuntimeError && \(/.test(preview), true);
check('and calls it with the error the user is looking at',
  /onRepairRuntimeError\(reactRuntimeError\)/.test(preview), true);
// A run already in flight owns the document; a second edit against the same
// error would race it, and the second result would overwrite the first.
const fixButton = preview.slice(preview.indexOf('preview__runtime-fix'), preview.indexOf('preview__runtime-fix') + 400);
check('the button is disabled while a run is in flight', /disabled=\{isGenerating\}/.test(fixButton), true);
check('the prop is optional', /onRepairRuntimeError\?:/.test(preview), true);

check('App passes its handler down', /onRepairRuntimeError=\{repairRuntimeError\}/.test(app), true);
check('the handler refuses to run without a document', /if \(!displayHtml \|\| isProcessing\) return;/.test(app), true);
// The repair edits the document that is on screen, so the same ref every other
// edit sets has to be set here — without it a failed repair cannot be rolled back.
const handler = app.slice(app.indexOf('const repairRuntimeError'), app.indexOf('const handleSend'));
check('and records the attempt for rollback', /modifyAttemptHtmlRef\.current = displayHtml;/.test(handler), true);
check('it goes through modify, not generate', /\bmodify\(displayHtml,/.test(handler), true);
check('and it does not build the instruction inline any more',
  handler.includes('生成されたアプリが'), false);

// A stack long enough to scroll is exactly the case where the button is wanted.
// With the overflow on the banner, the button scrolled out of the banner with it.
const rule = (sel) => {
  const i = css.indexOf(`\n${sel} {`);
  return i === -1 ? '' : css.slice(i, css.indexOf('}', i));
};
check('the rules were found', [rule('.preview__runtime-error'), rule('.preview__runtime-error-text')].every(Boolean), true);
check('the banner itself does not scroll', /overflow/.test(rule('.preview__runtime-error')), false);
check('the text does', /overflow: auto/.test(rule('.preview__runtime-error-text')), true);
check('and the height cap moved with it',
  /max-height/.test(rule('.preview__runtime-error-text')), true);

check('the button has a style', /\.preview__runtime-fix \{/.test(css), true);
check('and a disabled one', /\.preview__runtime-fix:disabled/.test(css), true);
// Split across 6,000 lines, the second copy silently won for every property the
// first also set. One rule, one place.
check('the banner rule is not written twice',
  (css.match(/^\.preview__runtime-error \{/gm) ?? []).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
