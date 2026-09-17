/**
 * The hand-edit flush runs on unmount, and once.
 *
 * It used to depend on `save`. `save` depends on `onSaved`, which App.tsx passes
 * as an inline arrow, so its identity changed on every render — and an effect
 * whose dependencies change runs its cleanup. That cleanup saved
 * `pending.current` and did not clear it, so the next render saved the same
 * document again; and `save` itself renders, by setting a status and by
 * refetching the version list, so each save caused the next. It also cancelled
 * the debounce timer without re-arming it, removing the one thing that would
 * have cleared `pending` and ended the loop.
 *
 * Measured in the Lambda log on 2026-09-02: 257 saves of a 105KB document in 24
 * seconds, 26MB written, 65 of them refused with 「Throughput exceeds the current
 * capacity of your table」 on POST /versions. Those sixty-five are the lost hand
 * edits the save-failure bar reports — this is where they came from.
 *
 * Source-read: what is asserted is an effect's dependency list and the order of
 * two statements, which is exactly what was wrong.
 *
 *   node test/direct-edit-flush.test.mjs      (from frontend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = fs.readFileSync(path.join(root, 'src/hooks/useDirectEdit.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const code = hook.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the flush is an unmount effect ---------------------------------------------
{
  const at = code.indexOf('const last = pending.current;');
  check('the flush was found', at > 0, true);

  /*
   * Its dependency list is empty. Anything in it re-runs the cleanup on a render,
   * which is the whole defect — so the assertion is on the list, not on the body.
   */
  const deps = code.slice(at, at + 260).match(/\}, \[([^\]]*)\]\);/);
  check('it depends on nothing', deps?.[1].trim(), '');

  /*
   * And it clears `pending` BEFORE writing. Even one stray re-run then has
   * nothing to send, which is the difference between a bug and a burst.
   */
  const clearAt = code.indexOf('pending.current = null;', at);
  const saveAt = code.indexOf('saveRef.current(last)', at);
  check('pending is cleared before the write', clearAt > 0 && clearAt < saveAt, true);

  /*
   * The flush reaches `save` through a ref. Calling `save` directly would put it
   * back in the dependency list, or make the flush send a stale closure.
   */
  check('save is reached through a ref', /saveRef\.current = save/.test(code), true);
  check('and the flush does not call save directly',
    /\}, \[\]\);/.test(code) && !/void save\(pending\.current\)/.test(code), true);
}

// --- the debounce is still what schedules an ordinary save ------------------------
{
  check('the debounce survives', /SAVE_DEBOUNCE_MS/.test(code), true);
  check('and it clears pending when it fires', /pending\.current = null;\s*if \(next\) void save\(next\)/.test(code.replace(/\s+/g, ' ')) || /const next = pending\.current;\s*pending\.current = null;/.test(code), true);
}

// --- the prop that made it fire is still an inline arrow --------------------------
{
  /*
   * Not a defect on its own — a callback prop is allowed to be one — but it is
   * the condition that turned the dependency into a loop, so it is recorded
   * here. If it were ever memoised, this test would still hold; the fix does not
   * depend on it.
   */
  check('onSaved is passed inline, as it was', /onSaved: \(\) => fetchVersions\(/.test(app), true);
}

// --- and the same shape one file over --------------------------------------------
{
  /*
   * `useChatHistory` has the same acting cleanup. It was latent rather than
   * live — its `flush` depends only on `token` and `apiUrl`, so it re-ran on a
   * token refresh rather than on every render, and the log shows at most three
   * chat saves in a session against 257 version saves in one — but the property
   * that made it safe was a dependency happening to be stable, which is not
   * something a reader can check from the effect.
   */
  const chat = fs.readFileSync(path.join(root, 'src/hooks/useChatHistory.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const at = chat.indexOf('flushRef.current();');
  check('its flush is an unmount effect too', at > 0, true);
  const deps = chat.slice(at, at + 120).match(/\}, \[([^\]]*)\]\);/);
  check('and depends on nothing', deps?.[1].trim(), '');
  /*
   * Here the payload is deliberately NOT cleared before the write: this flush
   * holds it until the request lands so a failure has something to retry from,
   * which is the opposite trade from the hand-edit one and worth pinning so a
   * later tidy-up does not "make them consistent".
   */
  check('the thread is still held until the write lands',
    /pendingRef\.current = null;/.test(chat.slice(chat.indexOf('.then('), chat.indexOf('.catch('))), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
