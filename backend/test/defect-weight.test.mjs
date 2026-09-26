/**
 * A screen made usable is not outweighed by an emoji.
 *
 * The repair judge compared finding counts. On the live generation of
 * 2026-09-13 a pass filled two screens from 18% to 100%, made them reachable and
 * put the missing navigation on screen, added an emoji and a low-contrast label
 * doing it, and was rejected: three findings before, three after.
 *
 *   node test/defect-weight.test.mjs      (from backend/)
 */
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const out = path.join(root, 'dist/defect-weight.test.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/orchestration/repair/defect-weight.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error',
});
const { weightedCount, defectWeight, SEVERE_WEIGHT } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const ids = (...xs) => xs.map((id) => ({ id }));
const convergent = (list) => list.filter((d) => !d.id.startsWith('visual-'));

// --- the measured case, verbatim from the log ----------------------------------------------
const before = ids('imagery-missing', 'shell-without-nav', 'screen-thin', 'visual-typography', 'visual-density');
const after = ids('emoji', 'contrast-low', 'contrast-introduced', 'visual-typography', 'visual-density', 'visual-artefact');
check('by count the pass looked like no improvement', [convergent(before).length, convergent(after).length], [3, 3]);
check('by weight it is one: two screens and a nav outweigh three cosmetic findings',
  weightedCount(convergent(after)) < weightedCount(convergent(before)), true);

// --- and the weight does not let damage through ------------------------------------------------
check('three cosmetic regressions cancel one functional fix',
  weightedCount(ids('emoji', 'contrast-low', 'icons')) < weightedCount(ids('screen-unreachable')), false);
check('trading a usable screen for a thrown error is not an improvement',
  weightedCount(ids('console-error')) < weightedCount(ids('screen-thin')), false);
check('the weight is small enough that stacked damage still counts', SEVERE_WEIGHT, 3);

// --- what is heavy -----------------------------------------------------------------------------
for (const id of ['blank-render', 'screen-thin', 'screen-unreachable', 'shell-without-nav', 'action-dead-runtime', 'console-error', 'export-missing', 'import-missing']) {
  check(`${id} is a usability finding`, defectWeight(id), SEVERE_WEIGHT);
}
for (const id of ['emoji', 'contrast-low', 'icons', 'imagery-missing', 'default-palette', 'visual-density', 'something-new']) {
  check(`${id} counts once`, defectWeight(id), 1);
}
/*
 * The breaking regressions are rejected outright before any weighing, so a
 * weight on them would be a second, contradictory rule.
 */
for (const id of ['render-lost', 'unreachable-introduced', 'console-error-introduced']) {
  check(`${id} is not weighted here — the judge rejects on it`, defectWeight(id), 1);
}

// --- wired into the judge -------------------------------------------------------------------------
const graph = read('src/orchestration/generate/graph.ts');
const judge = graph.slice(graph.indexOf('const judgeRepair = async ('), graph.indexOf('const repairBudget = new RepairBudget()'));
check('the judge decides on weight', /\? weighed\(after\) < weighed\(before\)/.test(judge), true);
check('still only on the convergent findings', /const weighed = \(list: InteractionDefect\[\]\) => weightedCount\(list\.filter\(convergent\)\)/.test(judge), true);
check('and still rejects a breaking candidate regardless', /if \(improved && longEnough && broke\.length === 0\)/.test(judge), true);
check('both verdicts log the weights', (judge.match(/weightedAfter: weighed\(after\)/g) ?? []).length, 2);
check('the candidate gets the arithmetic contrast fix after its render',
  judge.indexOf('applyDeterministicFixes(candidate, factsAfter)') > judge.indexOf('const factsAfter = await verify(candidate)'), true);
check('and a contrast fault it closed is not counted against the pass',
  /settled\.fixed\.includes\('contrast-low'\) && \(d\.id === 'contrast-low' \|\| d\.id === 'contrast-introduced'\)/.test(judge), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
