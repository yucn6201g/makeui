/**
 * The repair judge measures "after" with the same instrument as "before".
 *
 * A pass is accepted when the convergent defect count goes down. `before` is
 * the list the pass was handed, built by `collectDefects`; `after` was built by
 * a hand-kept list of five auditors. `collectDefects` had grown to fifteen, and
 * every auditor added since was appended there and never in the judge — so ten
 * auditors' findings could be handed to a pass and could not be reported as
 * remaining afterwards. They left the count whether or not anything was fixed.
 *
 * Measured over 30 days before the fix: thirteen defect ids were handed to
 * passes and never once appeared in a judge's `remaining` list, and 34 of 191
 * accepted passes counted as improved only because those ids dropped out.
 * That is also why FIX_RATE showed several of them at exactly 100%.
 *
 * The property is structural, so it is asserted structurally: there is one
 * collector, and the judge calls it. A second list can drift again the day an
 * auditor is added; a single call cannot.
 *
 *   node test/judge-symmetry.test.mjs      (from backend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const judgeStart = src.indexOf('const judgeRepair = async (');
const judgeEnd = src.indexOf("logger.info('Interaction repair accepted'", judgeStart);
const judge = src.slice(judgeStart, judgeEnd);
check('the judge was found', judgeStart > 0 && judgeEnd > judgeStart, true);

check('after is built by the same collector as before',
  /const after = collectDefects\(candidate, afterRuntime, afterVisual\)/.test(judge), true);

/*
 * And no auditor is called directly inside the judge. A direct call is the
 * beginning of a second list: the next one added to `collectDefects` would be
 * missing here again, and nothing would say so.
 */
const collectorBody = src.slice(src.indexOf('const collectDefects = ('), src.indexOf('const convergent = '));
const auditors = [...collectorBody.matchAll(/\.\.\.(\w+)\(/g)].map((m) => m[1]);
check('the collector was read', auditors.length >= 10, true);
check('the judge calls none of them itself',
  auditors.filter((a) => new RegExp(`\\.\\.\\.${a}\\(candidate`).test(judge)), []);

// Both call sites hand the pass's own defect list as `before`.
const calls = [...src.matchAll(/await judgeRepair\(\s*\n?\s*(\w+),\s*\n?\s*(\w+),/g)].map((m) => m[2]);
check('every top-level judgement compares against the pass’s defects',
  calls.filter((b) => b !== 'defects' && b !== 'before'), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
