// Every error message the API can put in front of a person, in one voice.
//
// The screen shows a server message when it is Japanese and falls back to its
// own sentence otherwise (frontend/src/utils/requests/request.ts). Until
// 2026-09-27 two thirds of these were English API-contract text
// (`prompt is required and must be a string`) and the Japanese ones were written
// three ways — with and without a full stop, 「失敗しました」 beside
// 「できませんでした」, 「しばらくしてから再試行」 beside 「少し待ってから」. The
// house style, shared with the frontend (frontend/test/error-text.test.mjs):
//
//   - Japanese, polite, ending in 「。」;
//   - what could not be done, as 「〜できませんでした。」, never 「失敗しました」;
//   - no field names, HTTP words or exception names;
//   - the next step where there is one, in the fixed phrases below.
//
//   node test/error-style.test.mjs      (from backend/)
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

const JAPANESE = /[぀-ヿ㐀-鿿]/;
// Interpolations are read as their text; the rules are about the words around them.
const text = (lit) => lit.slice(1, -1).replace(/\$\{[^}]*\}/g, 'X');
const problems = (lit) => {
  const t = text(lit);
  const out = [];
  if (!JAPANESE.test(t)) out.push('not Japanese');
  // Ending in an interpolation means ending in a message checked on its own.
  if (!t.endsWith('。') && !/\$\{[^}]*\}`$/.test(lit)) out.push('no closing 。');
  if (/失敗しました/.test(t)) out.push('「失敗しました」');
  if (/再試行|しばらくしてから|少し待ってから/.test(t)) out.push('not the fixed phrase しばらく待ってから、もう一度お試しください。');
  // JSON is left out: 「CSV・TSV・JSON」 names file formats a person picks from.
  if (/\b(HTTP|null|undefined|Error)\b|\w+Exception/.test(t)) out.push('developer words');
  return out;
};

const USER_FACING = ['src/handlers/lambda-handler.ts', 'src/handlers/share-routes.ts', 'src/middleware/auth.ts', 'src/middleware/guardrails.ts'];
const found = [];
for (const file of USER_FACING) {
  const src = read(file);
  // `error: '…'` in a response body or a validator's result
  for (const m of src.matchAll(/error: (?:[\w.]+ === '\w+' \? )?('(?:[^'\\\n]|\\.)*'|`[^`\n]*`)(?: : ('(?:[^'\\\n]|\\.)*'))?/g)) {
    found.push([file, m[1]]);
    if (m[2]) found.push([file, m[2]]);
  }
  // an auth or guardrail refusal, whose message becomes the body
  for (const m of src.matchAll(/new (?:AuthError|GuardrailBlockedError)\(\s*('(?:[^'\\\n]|\\.)*')/g)) found.push([file, m[1]]);
  // a job marked failed here rather than by describeFailure — the chat shows it
  for (const m of src.matchAll(/updateJobStatus\([^,]+, 'failed', undefined, ('(?:[^'\\\n]|\\.)*')\)/g)) found.push([file, m[1]]);
}
check('the messages were found', found.length > 80, true);
const bad = found.map(([f, lit]) => [f, lit, problems(lit)]).filter(([, , p]) => p.length).map(([f, lit, p]) => `${path.basename(f)}: ${lit} — ${p.join(', ')}`);
check('every message a person can see follows the house style', bad, []);

// The job-failure sentences describeFailure writes are in the same voice.
const failures = read('src/utils/failure-message.ts');
const failureTexts = [...failures.matchAll(/message:\s*\n?\s*('(?:[^'\\\n]|\\.)*'(?:\s*\+\s*'(?:[^'\\\n]|\\.)*')*)/g)]
  .map((m) => `'${m[1].split(/'\s*\+\s*'/).join('').replace(/^'|'$/g, '')}'`);
check('the job-failure sentences were found', failureTexts.length >= 4, true);
check('and follow it too', failureTexts.filter((t) => problems(t).length).map((t) => `${t} — ${problems(t).join(', ')}`), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
