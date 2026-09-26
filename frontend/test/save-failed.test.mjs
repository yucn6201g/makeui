// A hand edit that did not reach the server has to say so, wherever you are.
//
// Measured on 2026-09-02: sixty-five saves of `POST /versions` failed inside one
// minute to a DynamoDB throughput burst, and every one of them was a hand edit
// the user still had on screen and no longer had stored.
//
// The message existed. It was inside the selection panel, which is drawn only
// when an element is selected AND the preview tab is showing — so an edit made
// in the code editor, or one where the selection had been cleared, failed in
// silence. And it said 「保存に失敗しました」, which answers neither of the two
// questions somebody has at that moment: whether their work is gone, and whether
// trying again is worth anything.
//
// Source-read rather than rendered: what is asserted is where the element sits
// in the tree relative to two conditionals, which is the thing that was wrong.
//
//   node test/save-failed.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_FILES, readApp } from './lib/app-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = readApp();
const hook = fs.readFileSync(path.join(root, 'src/hooks/useDirectEdit.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- where it is drawn -----------------------------------------------------------
{
  const at = app.indexOf('app__save-failed');
  check('the bar exists', at > 0, true);

  /*
   * The two gates it must NOT be inside. `selectedSelector` is an element having
   * been clicked; `previewTab === 'preview'` is the code editor not being open.
   * A save failure depends on neither.
   */
  const panelStart = app.indexOf("{selectedSelector && previewTab === 'preview' && (");
  check('the selection panel was found', panelStart > 0, true);
  check('the bar is not inside it', at < panelStart, true);

  const codeGate = app.indexOf("{selectedSelector && previewTab === 'code' && (");
  check('nor inside the code-tab one', codeGate === -1 || at < codeGate, true);

  // And it is inside the pane container, so it is drawn with the document.
  check('it sits with the panes', app.slice(0, at).includes('app__pane'), true);
}

// --- what it says ----------------------------------------------------------------
{
  const flat = hook.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  /*
   * Three messages, because the advice differs. A throughput burst clears on its
   * own, so "try again" is true; a document over the row limit will be just as
   * large next time, so it is not.
   */
  check('a burst is called temporary', /保存が混み合って失敗しました/.test(flat), true);
  check('and too large is called permanent', /保存できる大きさを超えています/.test(flat), true);
  check('anything else is not guessed at', /保存に失敗しました。編集は画面に残っています/.test(flat), true);

  /*
   * Every one of them says the edit is still on screen. That is the question
   * asked first and the old message did not answer it.
   */
  const messages = [...flat.matchAll(/'([^']*保存[^']*)'/g)].map((m) => m[1]);
  check('some messages were found', messages.length >= 3, true);
  check('each says the work is still there',
    messages.filter((m) => !m.includes('画面に残って')), []);
}

// --- and the retry sends what failed ----------------------------------------------
{
  const flat = hook.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ');
  check('the failed document is kept', flat.includes('unsaved.current = html;'), true);
  check('the retry sends it', flat.includes('const html = unsaved.current; if (html) save(html);'), true);
  /*
   * Cleared on success, or a later retry would resend a document that is already
   * stored — harmless but it would make the button lie about there being
   * anything to retry.
   */
  check('and it is cleared once the write lands', flat.includes('unsaved.current = null; setError(null); setStatus(\'saved\');'), true);
  check('and when a new document replaces the edits', flat.includes('setError(null); unsaved.current = null;'), true);

  /*
   * Not through the debounce. A retry is a person pressing a button; putting it
   * behind the 1200ms pause makes the button look broken and then work.
   */
  const retryAt = flat.indexOf('const retry = useCallback');
  check('the retry does not go through the timer',
    !flat.slice(retryAt, retryAt + 220).includes('setTimeout'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
