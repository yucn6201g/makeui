// Parser tests for the design critic's edit format.
//
// This is string surgery on model output, and reasoning about the regexes was
// not enough: writing these found a real bug — a FIX whose quote did not match
// was correctly dropped, but left the pass looking unrecognised, so the critic's
// entire raw output was then filed into the spec as if it were design.
//
//   node test/critic-edits.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Paths resolved from this file, not the shell's cwd, so `npm test` from the
// package root and `node test/...` from inside test/ both work.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/generate/strands-design.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/sd.test.mjs')}" --external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/* --external:zod`,
  { stdio: 'inherit', cwd: root }
);
const { applyCriticEdits } = await import(pathToFileURL(path.join(root, 'dist/sd.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const IA = 'SCREENS AND INFORMATION ARCHITECTURE';
const mk = () => new Map([
  [IA, '画面1: dashboard\n画面2: projects\n戻る導線は未定。'],
  ['CONTENT', 'テーブルの行: 案件A, 案件B'],
]);

// ADD — the common case.
let s = mk();
let r = applyCriticEdits(s, `### ADD: ${IA}\n画面3: settings（サイドバーから開く）。戻るはヘッダーの×。\n<<<END`);
check('ADD appends to the right section', r.length === 1 && r[0].startsWith(`${IA}:added(`), true);
check('ADD kept the original text', s.get(IA).startsWith('画面1: dashboard'), true);
check('ADD did not touch other sections', s.get('CONTENT'), 'テーブルの行: 案件A, 案件B');

// FIX — exact quote.
s = mk();
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n戻る導線は未定。\n<<<REPLACE\n戻る導線: ヘッダー左の「←」で一覧へ。\n<<<END`);
check('FIX replaces the quoted span', r, [`${IA}:fixed`]);
check('FIX result', s.get(IA).includes('戻る導線: ヘッダー左の「←」で一覧へ。'), true);
check('FIX removed the old text', s.get(IA).includes('戻る導線は未定。'), false);

// FIX with a quote that does not match — must be dropped, not fuzzy-matched.
s = mk();
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n戻る導線は未決定です\n<<<REPLACE\nX\n<<<END`);
check('FIX with a wrong quote is dropped', r, [`${IA}:fix-no-match`]);
check('FIX with a wrong quote changed nothing', s.get(IA), mk().get(IA));

// FIX whose quote appears twice — ambiguous, must be dropped.
s = new Map([[IA, 'あ\n同じ行\nい\n同じ行']]);
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n同じ行\n<<<REPLACE\nX\n<<<END`);
check('ambiguous FIX is dropped', r, [`${IA}:fix-ambiguous`]);

// Several blocks at once.
s = mk();
r = applyCriticEdits(s, [
  `### FIX: ${IA}`, '<<<FIND', '戻る導線は未定。', '<<<REPLACE', '戻る導線: ←', '<<<END',
  `### ADD: CONTENT`, '空状態: 「案件がまだありません」と表示する。', '<<<END',
].join('\n'));
check('FIX and ADD together', r.map((x) => x.split('(')[0]).sort(), [`${IA}:fixed`, 'CONTENT:added'].sort());

// NO CORRECTIONS
s = mk();
r = applyCriticEdits(s, 'NO CORRECTIONS');
// Reported distinctly from silence: "I read it and it is sound" and "I returned
// nothing" are different facts about the run, and the log showed both as "none".
check('NO CORRECTIONS is reported as such', r, ['no-corrections']);
check('NO CORRECTIONS left sections alone', s.get(IA), mk().get(IA));

s = mk();
check('a silent critic is reported distinctly', applyCriticEdits(s, '   '), ['silent']);
check('a silent critic left sections alone', s.get(IA), mk().get(IA));

// Legacy whole-section REPLACE still honoured, with its length guard.
s = mk();
const long = 'x'.repeat(mk().get(IA).length);
r = applyCriticEdits(s, `### REPLACE: ${IA}\n${long}\n### END`);
check('legacy REPLACE at full length is accepted', r, [`${IA}:replaced`]);
s = mk();
r = applyCriticEdits(s, `### REPLACE: ${IA}\nshort\n### END`);
check('legacy REPLACE that shrinks is rejected', r[0].startsWith(`${IA}:rejected-too-short`), true);

// Unrecognised shape is kept rather than discarded.
s = mk();
r = applyCriticEdits(s, 'この仕様には戻る導線がありません。追加してください。');
check('prose is kept as its own section', r, ['unparsed:kept-as-section']);
check('prose landed in CORRECTIONS', s.has('CORRECTIONS'), true);

// --- whitespace-tolerant FIND ---------------------------------------------
// Measured: on the first production run of this format, 13 of 13 FIX blocks
// failed to match. A model that reflows a line while copying it has still
// identified the right span; one that paraphrases has not. Only the first is
// forgiven, and the result records which of the two happened.

s = new Map([[IA, '画面3: settings は サイドバー から開く']]);
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n画面3: settings は\nサイドバー から開く\n<<<REPLACE\n画面3: settings はヘッダーから開く\n<<<END`);
check('reflowed quote matches loosely', r, [`${IA}:fixed-loose`]);
check('reflowed quote replaced the right span', s.get(IA), '画面3: settings はヘッダーから開く');

s = new Map([[IA, 'a\n    戻る導線: 未定\nb']]);
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n戻る導線: 未定\n<<<REPLACE\n戻る導線: 一覧へ\n<<<END`);
check('indented quote matches', r, [`${IA}:fixed`]);
check('text outside the span is untouched', s.get(IA), 'a\n    戻る導線: 一覧へ\nb');

s = new Map([[IA, '戻る導線は未定。']]);
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n戻る導線が決まっていない。\n<<<REPLACE\nX\n<<<END`);
check('paraphrase is not forgiven', r, [`${IA}:fix-no-match`]);
check('paraphrase changed nothing', s.get(IA), '戻る導線は未定。');

s = new Map([[IA, '同じ  行\nx\n同じ\n行']]);
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\n同じ 行\n<<<REPLACE\nY\n<<<END`);
check('ambiguous loose match is dropped', r, [`${IA}:fix-ambiguous`]);

s = new Map([[IA, 'route: /projects/:id (詳細)']]);
r = applyCriticEdits(s, `### FIX: ${IA}\n<<<FIND\nroute: /projects/:id (詳細)\n<<<REPLACE\nroute: /projects/:id/detail\n<<<END`);
check('regex metacharacters are treated literally', r, [`${IA}:fixed`]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
