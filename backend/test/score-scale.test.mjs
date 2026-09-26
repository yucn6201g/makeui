/**
 * Every stored score says which measurement took it.
 *
 * The walk changed on 2026-09-13 in a way that moves the score of the same
 * document by up to twelve points. `SCORE_RUBRIC` is written onto every version
 * row, and the admin list marks rows on an older scale. This holds the chain:
 * generation metadata -> job runner -> version row -> read back -> the client's
 * copy of the constant.
 *
 *   node test/score-scale.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const scoring = read('src/orchestration/audit/scoring.ts');
const backendScale = Number(/export const SCORE_RUBRIC = (\d+)/.exec(scoring)?.[1]);
const clientScale = Number(/export const CURRENT_SCORE_RUBRIC = (\d+);/.exec(read('../frontend/src/utils/projects/scoreScale.ts'))?.[1]);
check('the scale is a number', Number.isInteger(backendScale) && backendScale > 0, true);
check('and the client marks rows against the same number', clientScale, backendScale);
check('the current value is explained where it is declared', scoring.includes(` ${backendScale} (2026-`), true);
check('and there is one scale constant, not two', /export const SCORE_SCALE\b/.test(scoring), false);

check('generation reports it, inside scoreParts', /scoreParts: \{ rubric: scored\.rubric,/.test(read('src/orchestration/generate/graph.ts')), true);
const runner = read('src/handlers/job-runner.ts');
check('both saved paths record it, generation from the run', /scoreRubric: \(result\.metadata\?\.scoreParts as \{ rubric\?: number \} \| undefined\)\?\.rubric \?\? SCORE_RUBRIC,/.test(runner), true);
check('and edit', (runner.match(/scoreRubric: /g) ?? []).length, 2);

const history = read('src/services/version-history.ts');
check('the row stores it only when known', /\.\.\.\(entry\.scoreRubric === undefined \? \{\} : \{ scoreRubric: \{ N: String\(entry\.scoreRubric\) \} \}\)/.test(history), true);
check('the list projection asks for it', /'score', 'scoreVerified', 'scoreRubric',/.test(history), true);
check('and both readers return it', (history.match(/scoreRubric: Number\(item\.scoreRubric\.N\)/g) ?? []).length, 2);

// --- and what the score cannot carry travels the same chain ----------------------------------
/*
 * The request's checklist and the findings a version shipped with were in the
 * chat reply only. The same chain now carries them to the version list.
 */
const graph = read('src/orchestration/generate/graph.ts');
check('generation reports its checklist and its open findings',
  /requirements: \{ total: requirementSummary\.total, met: requirementSummary\.met/.test(graph) && /openFindings: openDefects\.length,/.test(graph), true);
check('from the one summary the reply also reads', /const requirementSummary = summarizeRequirements\(checkRequirements\(finalHtml, requirements\)\)/.test(graph) && /requirements: requirementSummary,/.test(graph), true);
check('an edit reports its checklist', /requirements: \{ total: editSummary\.total, met: editSummary\.met/.test(read('src/orchestration/edit/meta-orchestrator.ts')), true);
check('the runner saves met of checked, from both paths', (runner.match(/\.\.\.checklistOf\(/g) ?? []).length, 2);
check('a checklist with nothing checkable saves nothing, not zero', /return checked > 0 \? \{ requirementsMet: req\.met, requirementsChecked: checked \} : \{\};/.test(runner), true);
check('the row stores them only when known',
  /\.\.\.\(entry\.requirementsChecked === undefined \? \{\} : \{/.test(history) && /\.\.\.\(entry\.openFindings === undefined \? \{\} : \{ openFindings:/.test(history), true);
check('the list projection asks for them', /'requirementsMet', 'requirementsChecked', 'openFindings',/.test(history), true);
check('and both readers return them', (history.match(/openFindings: Number\(item\.openFindings\.N\)/g) ?? []).length, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
