// The diff, per file.
//
// A generated project is many files inside one transported document. Diffing
// the document as one text says how many lines moved and not which file they
// moved in, which is the first thing anyone reviewing a change wants to know —
// so the comparison splits first and aligns each file against its counterpart.
//
// What is asserted here is mostly about absence and order: a file that did not
// change is not in the list at all (a list of what changed is only useful if
// that is what it is), a file that exists on one side only is reported as such
// rather than as a wall of edits, and the collapsed runs say where the reader
// has been moved to rather than only how far.
//
//   node test/file-diff.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-test/filediff-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, "export { diffFileSets, summarise } from '../src/utils/editing/fileDiff'\n");
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/filediff.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { diffFileSets, summarise } = await import(
  pathToFileURL(path.join(root, 'dist-test/filediff.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const f = (path, content) => ({ path, content });
/** Rows as pairs, for reading assertions at a glance. */
const shape = (rows) => rows.map((r) => (r.skip ? ['@@'] : [r.left?.content ?? null, r.right?.content ?? null]));

// --- what is in the list ------------------------------------------------------
check('an identical file is not listed',
  diffFileSets([f('a.js', 'x'), f('b.js', 'y')], [f('a.js', 'x'), f('b.js', 'y')]), []);

check('only the file that changed is listed',
  diffFileSets([f('a.js', 'x'), f('b.js', 'y')], [f('a.js', 'x'), f('b.js', 'z')])
    .map((d) => [d.path, d.status]),
  [['b.js', 'modified']]);

check('a file the new version does not have is a removal',
  diffFileSets([f('gone.js', 'x')], []).map((d) => [d.path, d.status, d.removed, d.added]),
  [['gone.js', 'removed', 1, 0]]);

check('a file the old version did not have is an addition',
  diffFileSets([], [f('new.js', 'a\nb')]).map((d) => [d.path, d.status, d.added, d.removed]),
  [['new.js', 'added', 2, 0]]);

// A whole-file addition is shown whole — there is no other side to give it
// context, and the three lines around each change would be the file anyway.
check('an added file shows every one of its lines',
  shape(diffFileSets([], [f('new.js', 'a\nb')])[0].rows),
  [[null, 'a'], [null, 'b']]);

// --- order --------------------------------------------------------------------
//
// The newer version's order, which is the splitter's: index.html first, then
// folders. Files only the older version had have no place in it, so they follow.
check('the listing follows the new version, removals last',
  diffFileSets(
    [f('index.html', '1'), f('dropped.js', 'x'), f('src/a.js', '1')],
    [f('index.html', '2'), f('src/a.js', '2')]
  ).map((d) => d.path),
  ['index.html', 'src/a.js', 'dropped.js']);

// --- inside one file ----------------------------------------------------------
const thirty = (edited) =>
  Array.from({ length: 30 }, (_, i) => (i === 20 && edited ? 'edited' : `line ${i + 1}`)).join('\n');
const one = diffFileSets([f('a.js', thirty(false))], [f('a.js', thirty(true))])[0];

check('one changed line is one added and one removed', [one.added, one.removed], [1, 1]);

check('and it is shown against its three lines of context',
  shape(one.rows),
  [['@@'],
   ['line 18', 'line 18'], ['line 19', 'line 19'], ['line 20', 'line 20'],
   ['line 21', 'edited'],
   ['line 22', 'line 22'], ['line 23', 'line 23'], ['line 24', 'line 24']]);

// The marker is the answer to 「どこ」: not only that lines were skipped but
// which line the reader has landed on, in both versions.
check('the collapsed run names the line it resumes at',
  one.rows[0].skip, '@@ -18 +18 @@ 17 行省略');

// --- the summary line ---------------------------------------------------------
check('the total is the sum of the files',
  summarise(diffFileSets(
    [f('a.js', 'x'), f('b.js', 'p\nq')],
    [f('a.js', 'y'), f('b.js', 'p\nq\nr')]
  )),
  { files: 2, added: 2, removed: 1 });

check('nothing changed is nothing to total', summarise([]), { files: 0, added: 0, removed: 0 });

// --- a diff too large to read -------------------------------------------------
//
// Cut, and said so. Silently showing the first 400 rows of a 4000-row change
// reads as a complete answer, which is the one thing a truncation must not do.
const big = diffFileSets(
  [f('big.js', Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n'))],
  [f('big.js', Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n'))]
)[0];
check('a long diff is cut', big.rows.length, 400);
check('and says that it was cut', typeof big.note, 'string');
check('while still counting the whole change', [big.added, big.removed], [600, 600]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
