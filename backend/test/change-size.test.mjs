/**
 * How much of a file a rewrite changed — the number that decides whether a
 * search-and-replace output format is worth building.
 *
 * Every repair returns the complete file; output is 76% of that stage's cost,
 * and the stage is 31% of a run. The measurement has to be right in one
 * direction above all: when it cannot be exact it must over-state the change,
 * because an under-stated change would argue for a patch format the data does
 * not support.
 *
 *   node test/change-size.test.mjs      (from backend/)
 */
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/change-size.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/cz.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { changeSize } = await import(pathToFileURL(path.join(root, 'dist/cz.test.mjs')).href);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const lines = (n, tag = 'x') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n');
const FILE = lines(100);

check('an identical file changed nothing', changeSize(FILE, FILE).changedShare, 0);
check('and every line is unchanged', changeSize(FILE, FILE).unchangedLines, 100);

// The repair that is most of them: one import added at the top.
const withImport = `import { CheckIcon } from './icons/CheckIcon'\n${FILE}`;
check('one line added at the top is a 1% change', changeSize(FILE, withImport).changedShare, 0.01);

// A line changed in the middle — the prefix and suffix alone would not see the
// rest of the file is untouched unless the middle is compared.
const mid = FILE.replace('x50', 'CHANGED');
check('one line changed in the middle is a 1% change', changeSize(FILE, mid).changedShare, 0.01);

// Two separated edits: prefix/suffix give up between them, the LCS does not.
const two = FILE.replace('x10', 'A').replace('x90', 'B');
check('two separate edits count only the two lines', changeSize(FILE, two).unchangedLines, 98);
check('and are exact, not estimated', changeSize(FILE, two).estimated, false);

check('a complete rewrite is a full change', changeSize(FILE, lines(100, 'y')).changedShare, 1);
check('an empty before is a full change', changeSize('', FILE).changedShare, 1);

// --- when it cannot be exact, it over-states -------------------------------------
/*
 * Past the comparison budget the middle is not compared, so unchanged lines in
 * it are counted as changed. That errs toward "a repair rewrites a lot", which is
 * the direction that argues AGAINST building the patch format.
 */
const BIG = lines(3000);
const bigTwo = BIG.replace('x100\n', 'A\n').replace('x2900\n', 'B\n');
const big = changeSize(BIG, bigTwo);
check('a very large middle is estimated', big.estimated, true);
check('and never under-states the change', big.changedShare >= 2 / 3000, true);

// --- wired into both rewrite paths ---------------------------------------------------
const repair = read('src/orchestration/repair-files.ts');
const edit = read('src/orchestration/edit-files.ts');
check('an accepted repair logs its change size', /logger\.info\('File repair change size'/.test(repair), true);
check('measured on the lean bodies, so embedded pictures do not count',
  /changeSize\(leaned\.text, lean\(body\)\.text\)/.test(repair), true);
check('not for a file the repair created, which has no before', /if \(!plan\.create\) \{\s*const size = changeSize/.test(repair), true);
check('an accepted edit logs its change size too', /logger\.info\('File edit change size'/.test(edit), true);
check('and the script that reads them back exists', fs.existsSync(path.join(root, 'scripts/repair-change-size.mjs')), true);

// --- the decision, written down before the data ---------------------------------------
const script = read('scripts/repair-change-size.mjs');
check('the script states its thresholds', /const MIN_FILES = 30;[\s\S]*const BUILD_AT = 0\.4;[\s\S]*const SKIP_AT = 0\.7;/.test(script), true);
check('and gives a verdict per path', /verdict: \$\{verdict\(rows\)\}/.test(script), true);
check('estimated from what a replace block carries, not from the changed share alone',
  /2 \* r\.changedShare \+ CONTEXT_LINES \/ lines/.test(script) && !/\* r\.changedShare, 0\)/.test(script), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
