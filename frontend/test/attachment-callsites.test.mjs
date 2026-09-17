// Every request that can carry the user's attachments must actually carry them.
//
// This is the third time a trailing optional argument has been dropped at a call
// site, and all three failed the same way — silently, past the type checker,
// past the unit tests, visible only in a finished result that ignored the file.
//
//   `runModify` called `directModify` with eleven arguments where the twelfth
//   was the data. Found on the deployed Runtime, after a generation had run.
//   `handleApprovePlan` called `modify` without `dataFile`, so approving a plan
//   for an EDIT dropped the attachment. Found by reading, not by a test.
//
// TypeScript cannot see an omitted optional parameter. Where the fix was
// internal the parameter was made required instead (see meta-orchestrator);
// these are React callbacks with nine positional parameters, where that is not
// available. So the guard is on the source itself, in the same spirit as
// backend/test/source-hygiene.test.mjs.
//
// The rule: a call to `generate(` or `modify(` in App.tsx must mention
// `dataFile`. One that genuinely should not carry an attachment says so with a
// `no-attachment:` comment giving the reason.
//
//   node test/attachment-callsites.test.mjs      (from frontend/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(root, 'src/App.tsx');
const lines = fs.readFileSync(APP, 'utf8').split('\n');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** The opt-out, for a call that legitimately carries no attachment. */
const EXEMPT = 'no-attachment:';
/** How far above a call the reason may sit. A reason needs room to be a reason. */
const EXEMPT_WINDOW = 6;

/*
 * Call sites, including the ones written across several lines.
 *
 * The first version of this only matched a call that opened and closed on the
 * same line, which silently skipped the Figma import's `generate(`. A guard with
 * a blind spot is the exact thing this test exists to prevent, so the whole
 * expression is collected by balancing parentheses instead.
 */
const calls = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!/(?:^|[^.\w])(generate|modify)\s*\(/.test(line)) continue;
  // A declaration is not a call: `const modify = useCallback(` and friends.
  if (/\b(const|let|var|function)\s+(generate|modify)\b/.test(line)) continue;

  let depth = 0, text = '', end = i;
  for (let j = i; j < lines.length && j < i + 20; j++) {
    for (const ch of lines[j]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    text += lines[j].trim() + ' ';
    end = j;
    if (depth <= 0) break;
  }
  const above = lines.slice(Math.max(0, i - EXEMPT_WINDOW), i).join('\n');
  calls.push({
    line: i + 1,
    endLine: end + 1,
    text: text.trim(),
    carries: text.includes('dataFile'),
    exempt: above.includes(EXEMPT) || text.includes(EXEMPT),
  });
}

check('the call sites were found at all', calls.length >= 4, true);

check(
  'every generate/modify call carries the attachment, or says why not',
  calls.filter((c) => !c.carries && !c.exempt).map((c) => `App.tsx:${c.line} ${c.text.slice(0, 70)}`),
  []
);

// The opt-out has to work, or the rule above has no escape and the next call
// that legitimately carries no attachment gets one written anyway.
//
// Against a fixture, for the same reason the multi-line case below is: this
// asserted that App.tsx contained an exempt call, and the only one was the
// component-regeneration panel's `modify(`. Deleting that panel — a change with
// nothing to do with attachments — broke a guard about attachments. A real call
// site is not evidence about this machinery; it is a coincidence about App.tsx.
const EXEMPT_FIXTURE = [
  '    // no-attachment: rebuilt from a selector, so nothing was attached to it.',
  '    modify(html, instruction, preset, model);',
];
const exemptSeen = (() => {
  const above = EXEMPT_FIXTURE.slice(0, -1).join('\n');
  const call = EXEMPT_FIXTURE[EXEMPT_FIXTURE.length - 1];
  return above.includes(EXEMPT) || call.includes(EXEMPT);
})();
check('a reason above a call exempts it', exemptSeen, true);
check('and a call with no reason is not exempt',
  '    modify(html, instruction, preset, model);'.includes(EXEMPT), false);

// And the guard must be able to fail. If the pattern stopped matching, every
// assertion above would pass vacuously.
check('the guard sees calls that do carry it', calls.some((c) => c.carries), true);

// The multi-line case specifically, because it was the blind spot.
//
// Against a fixture rather than against whichever call site happens to be
// written that way. It used to assert that App.tsx contained one, and the only
// one was the Figma import's `generate(` — so removing that panel, a change with
// nothing to do with attachments, broke this guard. A test that depends on
// unrelated code keeping a particular shape reports on that code, not on the
// thing it was written to protect.
const MULTILINE = [
  '    generate(',
  '      summary,',
  '      preset,',
  '      dataFile ?? undefined,',
  '    );',
];
const collected = (() => {
  let depth = 0, text = '', end = 0;
  for (let j = 0; j < MULTILINE.length; j++) {
    for (const ch of MULTILINE[j]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    text += MULTILINE[j].trim() + ' ';
    end = j;
    if (depth <= 0) break;
  }
  return { text: text.trim(), endLine: end + 1 };
})();
check('a call written across several lines is collected whole', collected.endLine > 1, true);
check('and its arguments are all seen', collected.text.includes('dataFile'), true);

// --- one paperclip ----------------------------------------------------------
//
// The composer had two attach buttons: one taking images, one taking data
// files. The two mean different things to the pipeline and still do, but that
// is the pipeline's distinction — for the person attaching a file it meant a
// document silently refused by one button that the other would have taken.
//
// So the rule is the count. A second control reintroduces the choice.
const src = lines.join('\n');
const attachButtons = (src.match(/app__attach-btn/g) ?? []).length;
check('the composer has exactly one attach control', attachButtons, 1);

// And it accepts both kinds, routed by extension rather than by which button
// was pressed.
check('it accepts every attachable type', /accept=\{ANY_ATTACHMENT_ACCEPT\}/.test(src), true);
check('and routes images by their name', /isImageAttachment\(/.test(src), true);
// The old per-kind lists must not linger next to the shared one.
check('no button carries its own image list', /accept=".png,.jpg/.test(src), false);

console.log(`\n${calls.length} call sites inspected`);
for (const c of calls) {
  const span = c.endLine > c.line ? `${c.line}-${c.endLine}` : `${c.line}`;
  console.log(`  App.tsx:${span.padEnd(9)} ${c.carries ? 'carries' : c.exempt ? 'exempt ' : 'MISSING'}  ${c.text.slice(0, 60)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
