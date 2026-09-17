// What one run is allowed to rewrite, and what it drops when it is not.
//
// `repairPasses` bounds passes; a pass plans one call per defective file, so the
// profile that says "3" never said how many calls that was. Measured over 17
// real generations: 30.8 per-file repairs a run, worst four at 46, 53, 62, 69.
//
// The two bounds are different in kind and the tests are separated accordingly.
// The per-file cap removes work that cannot succeed — a third rewrite of a file
// that survived two. The per-run cap removes work that could have, so what it
// removes has to be the least valuable available, and it has to be reported.
//
//   node test/repair-budget.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair-budget.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/rb.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { RepairBudget, MAX_FILE_REPAIRS, MAX_ATTEMPTS_PER_FILE } = await import(
  pathToFileURL(path.join(root, 'dist/rb.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

/** A plan with `n` defects. */
const plan = (path, n = 1) => ({ path, defects: Array.from({ length: n }, (_, i) => i) });
const paths = (list) => list.map((p) => p.path);

// --- the ordinary run is untouched --------------------------------------------
//
// The budget is above the measured median and mean on purpose. A run of typical
// size must not notice it exists, or this is a quality change wearing a cost
// change's clothes.
{
  const b = new RepairBudget();
  const three = [plan('a'), plan('b'), plan('c')];
  const first = b.admit(three);
  check('a normal pass runs everything', paths(first.run).sort(), ['a', 'b', 'c']);
  check('and drops nothing', first.skipped, []);
  const second = b.admit([plan('d'), plan('e')]);
  check('so does the next pass', paths(second.run).sort(), ['d', 'e']);
  check('the run has spent five calls', b.spent, 5);
}

// --- the per-file cap: work that cannot succeed --------------------------------
{
  const b = new RepairBudget();
  b.admit([plan('same')]);
  b.admit([plan('same')]);
  check(`a file gets ${MAX_ATTEMPTS_PER_FILE} attempts`, b.attempts('same'), MAX_ATTEMPTS_PER_FILE);
  const third = b.admit([plan('same', 4), plan('other')]);
  check('a third attempt on it is refused', paths(third.run), ['other']);
  check('and says why', third.skipped, [{ path: 'same', defects: 4, reason: 'attempts' }]);
  check('a refused attempt costs no budget', b.spent, 3);
}

// --- the per-run cap: work that could have succeeded ---------------------------
//
// So it goes in defect order. Dropping by whatever order the planner returned
// would throw away a file with six defects to keep one with a single cosmetic
// finding.
{
  const b = new RepairBudget(3);
  const admitted = b.admit([plan('one', 1), plan('six', 6), plan('two', 2), plan('four', 4)]);
  check('the budget spends itself on the worst files', paths(admitted.run), ['six', 'four', 'two']);
  check('and the lightest is what is dropped',
    admitted.skipped, [{ path: 'one', defects: 1, reason: 'budget' }]);
  check('nothing runs once it is spent', b.admit([plan('late', 9)]).run, []);
  check('and that is reported too, not silent',
    b.admit([plan('later', 9)]).skipped, [{ path: 'later', defects: 9, reason: 'budget' }]);
}

// --- the budget is a run's, not a pass's --------------------------------------
//
// The thing that was unbounded is the total. Three passes each obeying their own
// limit is three times that limit.
{
  const b = new RepairBudget(4);
  check('pass one takes three', b.admit([plan('a'), plan('b'), plan('c')]).run.length, 3);
  check('pass two gets what is left, not a fresh allowance',
    b.admit([plan('d'), plan('e'), plan('f')]).run.length, 1);
  check('and the run stops there', b.remaining, 0);
}

// --- the defaults are the measured ones ----------------------------------------
check('the run budget is above every typical run', MAX_FILE_REPAIRS >= 32, true);
check('and a file gets two attempts, not one', MAX_ATTEMPTS_PER_FILE, 2);

// A budget of zero is a mode that buys no repair; it must admit nothing rather
// than fall through to "unbounded".
check('a zero budget admits nothing', new RepairBudget(0).admit([plan('a')]).run, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
