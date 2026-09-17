/**
 * Which rows in the version list were scored with an older measurement.
 *
 * On 2026-09-13 the browser walk stopped reporting working buttons as dead
 * (replayed over 33 stored outputs: 45 dead actions -> 9, up to twelve points a
 * document). A row scored before that sits under a row scored after it and
 * reads as a regression that never happened. The rows now say which scale they
 * were scored on.
 *
 *   node test/score-scale.test.mjs      (from frontend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = path.join(root, 'dist-test/score-scale.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(root, 'src/utils/scoreScale.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out,
});
const { isOlderScoreScale, isOlderRubric, CURRENT_SCORE_RUBRIC } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

check('a row from before the field existed is on the older scale', isOlderScoreScale({ scoreVerified: true }), true);
check('so is a row that says an older number', isOlderScoreScale({ scoreVerified: true, scoreRubric: CURRENT_SCORE_RUBRIC - 1 }), true);
check('a current row is not marked', isOlderScoreScale({ scoreVerified: true, scoreRubric: CURRENT_SCORE_RUBRIC }), false);
check('an edit scored without a browser is never marked: the change was to what a browser measures',
  isOlderScoreScale({ scoreVerified: false }), false);
check('a row that does not say whether it rendered is treated as rendered', isOlderScoreScale({}), true);

const panel = read('src/components/AdminPanel.tsx');
check('the version list marks it', /\{isOlderScoreScale\(v\) && \(/.test(panel), true);
check('with the date the scale changed, so the reader knows which rows compare',
  panel.includes('計測方法の変更（2026-09-13）より前のスコアです'), true);
check('the admin type carries the field', /scoreRubric\?: number;/.test(read('src/hooks/useAdmin.ts')), true);

// --- the chat thread -----------------------------------------------------------------
check('a chat score from scale 3 is older now', isOlderRubric(3), true);
check('one without a rubric is the first scale', isOlderRubric(undefined), true);
check('the current one is not', isOlderRubric(CURRENT_SCORE_RUBRIC), false);
const app = read('src/App.tsx');
check('the tooltip compares against the current scale, not a literal 2', /if \(isOlderRubric\(parts\.rubric\)\) return unverified \+ oldScale;/.test(app) && !/rubric \?\? 1\) < 2/.test(app), true);
check('and the chip says so where it is read', /isOlderRubric\(msg\.runInfo\.scoreParts\?\.rubric\) && \(\s*<span className="app__chat-score-unverified"> 旧基準<\/span>/.test(app), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
