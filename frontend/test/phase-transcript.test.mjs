// Attributing a run's token spend to the step that caused it.
//
// The ledger counts model calls for the whole run and does not know which step
// was current when each one happened, so the server sends a running total and
// the transcript differences it across each step's boundaries. The awkward cases
// are all about WHEN a figure first arrives, not about the arithmetic:
//
//  - a step opens before any call has reported, so its baseline is not yet known
//  - a step's own calls report on a later poll than the one that opened it
//  - the server sends nothing at all (no ledger scope), and a step must then
//    show no figure rather than a zero it did not earn
//
//   node test/phase-transcript.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/phaseTranscript.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/pt.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { appendPhase, splitStream, TAIL_CHARS } = await import(
  pathToFileURL(path.join(root, 'dist-test/pt.test.mjs')).href
);

let pass = 0,
  fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// A run: design spends 1,200, then code generation spends 4,300 more.
let t = [];
t = appendPhase(t, '設計中', 'a', 10, 0, 1000); //   opens before anything reported
t = appendPhase(t, '設計中', 'ab', 20, 1200, 1001); // its calls report
t = appendPhase(t, 'コード生成中', '', 0, 1200, 1002); // label changes; design closes
t = appendPhase(t, 'コード生成中', 'x', 500, 5500, 1003);

check('two steps recorded', t.map((p) => p.label), ['設計中', 'コード生成中']);
check('the first step is charged its own spend', t[0].tokens, 1200);
check('and the second only what came after it', t[1].tokens, 4300);
check('the first step is closed', typeof t[0].endedAt, 'number');
check('the second is still open', t[1].endedAt, undefined);

// The baseline is claimed on the first poll that carries a figure. Taking it
// when the step merely opened would credit this step with the previous one's
// spend — here, 1,200 that design paid for.
let u = [];
u = appendPhase(u, 'A', '', 0, undefined, 1000);
u = appendPhase(u, 'A', '', 0, 1200, 1001);
u = appendPhase(u, 'A', '', 0, 1500, 1002);
check('a late first figure sets the baseline', u[0].tokens, 300);

// No ledger scope: nothing is reported, so nothing is claimed.
let v = [];
v = appendPhase(v, 'A', 'x', 10, undefined, 1000);
v = appendPhase(v, 'B', 'y', 10, undefined, 1001);
check('no figure means no figure', [v[0].tokens, v[1].tokens], [undefined, undefined]);

// A total that goes backwards must not produce a negative charge. It should not
// happen, but a retried job writing an older total would show "-800 tok".
// Nothing rather than zero, for the same reason a step with no reported calls
// shows nothing: a figure of 0 would assert the step was free.
let w = [];
w = appendPhase(w, 'A', '', 0, 2000, 1000);
w = appendPhase(w, 'A', '', 0, 1200, 1001);
check('a total that moves backwards shows nothing', w[0].tokens, undefined);

// Identity: an unchanged poll must return the SAME array so React can skip the
// render. Polls arrive every two seconds and most carry nothing new.
const before = appendPhase([], 'A', 'x', 10, 500, 1000);
const after = appendPhase(before, 'A', 'x', 10, 500, 1001);
check('an unchanged poll does not re-render', after === before, true);
// But a changed token count IS a change, even with identical text.
const moved = appendPhase(before, 'A', 'x', 10, 900, 1002);
check('a changed token count is a change', moved === before, false);
check('and is reflected', moved[0].tokens, 400);

// `chars` still drives splitStream, which is why it was kept rather than
// replaced. A tail past the transport window is code even with no boundary in it.
check('chars still decides that a long tail is code', splitStream('<div>x</div>', '', false, TAIL_CHARS + 1).code.length > 0, true);
check('and a short one is still prose', splitStream('考えています', '', false, 10).prose, '考えています');

// --- a run shows its own steps and nobody else's --------------------------------
/*
 * `useModify` clears everything else the previous run left — the plan, the
 * stream tail, the character count, the tools, the events, the run info — and
 * did not clear the transcript. So a second edit opened with the first edit's
 * steps already in the card and appended its own underneath, and a third showed
 * all three. Reported as 「過去の変更指示の生成過程も表示されている」.
 *
 * `reset()` has always cleared it, and `generate()` calls `reset()`. The edit
 * path never has, which is why the same bug never appeared on the other side.
 */
import fs2 from 'node:fs';
const hook = fs2.readFileSync(path.join(root, 'src/hooks/useModify.ts'), 'utf8');
const startOfRun = hook.slice(hook.indexOf('const modify = useCallback'), hook.indexOf('const controller = new AbortController'));
check('starting an edit clears the transcript', /setPhases\(\[\]\)/.test(startOfRun), true);
/*
 * Together with everything else from the last run, in one place — the property
 * that failed here was not "the transcript is cleared somewhere" but "this list
 * is complete".
 */
for (const [what, call] of [
  ['the plan', 'setPlan(null)'],
  ['the stream tail', 'setStreamTail(null)'],
  ['the character count', 'setStreamChars(0)'],
  ['the tools', 'setToolsUsed([])'],
  ['the run info', 'setRunInfo(null)'],
]) {
  check(`and ${what}`, startOfRun.includes(call), true);
}
// But resuming a job that is already running must restore what it collected,
// which is the one place phases are set from outside the run.
check('resuming still restores a transcript', /if \(priorPhases && priorPhases.length > 0\) setPhases\(priorPhases\)/.test(hook), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
