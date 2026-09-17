// A brace in a sentence used to cost a 77,000-token rewrite.
//
// Five call sites read a model's JSON with `text.match(/\{[\s\S]*\}/)`, which is
// greedy and anchored on nothing: it takes everything from the FIRST `{` to the
// LAST `}`. Measured on the edit planner, 2026-08-29:
//
//   SyntaxError: Unexpected non-whitespace character after JSON at position 153
//
// The planner had answered correctly and added a sentence. The caller read the
// failed parse as "no plan" and rewrote the entire document instead — nineteen
// times the price of the per-file path it was avoiding.
//
// So the shape of the reply is the thing under test, not the happy case.
//
//   node test/model-json.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/model-json.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/mj.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { firstJsonObject } = await import(pathToFileURL(path.join(root, 'dist/mj.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const NL = String.fromCharCode(10);

// --- what it was always asked to do -------------------------------------------
check('a bare object', firstJsonObject('{"files":["a.tsx"]}'), { files: ['a.tsx'] });
check('whitespace around it', firstJsonObject(`  ${NL}{"a":1}${NL} `), { a: 1 });

// --- the failure that was measured ---------------------------------------------
//
// Prose AFTER the object, containing a brace. The greedy match swallowed the
// sentence and the parse threw.
check('a sentence after the object, with a brace in it',
  firstJsonObject(`{"files":["src/App.tsx"]}${NL}${NL}この変更は {App} を書き換えます。`),
  { files: ['src/App.tsx'] });

// Prose BEFORE it, which the greedy match also could not survive: the first `{`
// moved and everything from there was garbage.
check('a sentence before the object',
  firstJsonObject(`まず {App.tsx} を確認しました。${NL}{"files":["src/App.tsx"]}`),
  { files: ['src/App.tsx'] });
check('prose on both sides',
  firstJsonObject(`{メモ}${NL}{"files":["a"]}${NL}以上です {終}`), { files: ['a'] });

// A fenced block is the shape models produce most often when told not to.
check('inside a code fence',
  firstJsonObject('```json' + NL + '{"assignments":[{"defect":1,"paths":["a.tsx"]}]}' + NL + '```'),
  { assignments: [{ defect: 1, paths: ['a.tsx'] }] });

// --- braces that are not structure ---------------------------------------------
//
// A `}` inside a string is not a close. This is a real reply shape here —
// planners write Japanese `reason` fields quoting what the screen displays — and
// counting braces naively truncates the object mid-value.
check('a closing brace inside a string value',
  firstJsonObject('{"reason":"画面に } と表示される","path":"a.tsx"}'),
  { reason: '画面に } と表示される', path: 'a.tsx' });
check('an escaped quote before one',
  firstJsonObject('{"reason":"\\"}\\" が出る","path":"a.tsx"}'),
  { reason: '"}" が出る', path: 'a.tsx' });
check('nested objects are not closed early',
  firstJsonObject('{"a":{"b":{"c":1}},"d":2}'), { a: { b: { c: 1 } }, d: 2 });

// --- nothing usable -------------------------------------------------------------
check('no object at all', firstJsonObject('OK, no issues found.'), null);
check('an unterminated object', firstJsonObject('{"files":['), null);
check('an empty string', firstJsonObject(''), null);
check('a non-string', firstJsonObject(undefined), null);

/*
 * An array is not an object. Every caller reads a named field off the result, so
 * accepting a bare array would move the failure from here to the field access,
 * where it reads as the model having answered with nothing.
 */
check('a bare array is not accepted', firstJsonObject('[1,2,3]'), null);
check('but an object after one is', firstJsonObject('[1,2] then {"a":1}'), { a: 1 });

// A stray close before the object must not stop the scan.
check('a stray closing brace first', firstJsonObject(`} ${NL} {"a":1}`), { a: 1 });

// --- and every call site uses it -------------------------------------------------
//
// The point of a shared helper is that the next one cannot quietly reintroduce
// the pattern. Five files had it; none should now.
{
  const files = [
    'src/orchestration/edit-files.ts',
    'src/orchestration/repair-files.ts',
    'src/orchestration/build-files.ts',
    'src/orchestration/workflow-router.ts',
    'src/orchestration/visual-critic.ts',
  ];
  const greedy = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    /*
     * The exact sequence that was there — brace, greedy any, brace — built from
     * character codes so this file survives being edited through a heredoc.
     *
     * Narrower than `[\s\S]*` on purpose. That matched two innocent lazy uses,
     * a fenced-code grab and a `:root {...}` grab, and a check that fires on
     * correct code is a check people learn to ignore.
     */
    const BS = String.fromCharCode(92);
    const needle = BS + '{[' + BS + 's' + BS + 'S]*' + BS + '}';
    if (src.includes(needle)) greedy.push(f);
    if (!src.includes('firstJsonObject')) greedy.push(`${f} (does not use the helper)`);
  }
  check('no call site still grabs first-brace-to-last-brace', greedy, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
