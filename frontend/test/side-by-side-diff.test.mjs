// The diff, laid out the way a code review is read.
//
// `computeInlineDiff` already aligns the two texts — an LCS, with `oldLine` and
// `newLine` carried on every entry — but emits one stream: removals, then the
// additions that replace them. That answers 「何が変わったか」. The comparison view
// is asked 「どちらがどう違うか」, which is a question about two things standing
// next to each other, so the same data is dealt into two columns.
//
// The zip is the whole of it. Within a change block the first removed line sits
// opposite the first added one, because a line that was EDITED is one line in
// both versions and putting the two level is the only reason to have columns at
// all. Stacking them — every removal, then every addition — would be the unified
// diff again in a wider box.
//
// Blanks are the other half. When the runs are different lengths the shorter
// side gets nothing on those rows, and that absence is what makes an insertion
// look like an insertion rather than like a replacement of something.
//
//   node test/side-by-side-diff.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist-test/sbs-entry.ts');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, "export { toSideBySide } from '../src/utils/sideBySideDiff'\n");
execSync(
  `npx esbuild "${entry}" --bundle --platform=node --format=esm --jsx=automatic ` +
    `--external:react --external:react/jsx-runtime ` +
    `--outfile="${path.join(root, 'dist-test/sbs.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { toSideBySide } = await import(pathToFileURL(path.join(root, 'dist-test/sbs.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const ctx = (c, o, n) => ({ type: 'context', content: c, oldLine: o, newLine: n });
const del = (c, o) => ({ type: 'removed', content: c, oldLine: o });
const add = (c, n) => ({ type: 'added', content: c, newLine: n });
/** What each column shows, as a pair, for reading assertions at a glance. */
const shape = (rows) => rows.map((r) => (r.skip ? ['@@'] : [r.left?.content ?? null, r.right?.content ?? null]));

// --- an unchanged line is the same line on both sides ------------------------
check('context appears in both columns',
  shape(toSideBySide([ctx('same', 1, 1)])), [['same', 'same']]);

// --- an edit is one row, not two --------------------------------------------
check('a replaced line sits opposite its replacement',
  shape(toSideBySide([ctx('a', 1, 1), del('old', 2), add('new', 2), ctx('b', 3, 3)])),
  [['a', 'a'], ['old', 'new'], ['b', 'b']]);

check('and the line numbers are each column’s own',
  toSideBySide([del('old', 7), add('new', 9)]).map((r) => [r.left?.oldLine, r.right?.newLine]),
  [[7, 9]]);

// --- runs of different length ------------------------------------------------
//
// Two lines became three: the first two pair up, and the third has nothing on
// the left. A blank there is the shape of an insertion.
check('a longer addition run leaves blanks on the left',
  shape(toSideBySide([del('x', 1), del('y', 2), add('p', 1), add('q', 2), add('r', 3)])),
  [['x', 'p'], ['y', 'q'], [null, 'r']]);

check('a longer removal run leaves blanks on the right',
  shape(toSideBySide([del('x', 1), del('y', 2), del('z', 3), add('p', 1)])),
  [['x', 'p'], ['y', null], ['z', null]]);

check('a pure insertion has nothing opposite it',
  shape(toSideBySide([ctx('a', 1, 1), add('new', 2)])), [['a', 'a'], [null, 'new']]);

check('a pure deletion has nothing opposite it',
  shape(toSideBySide([ctx('a', 1, 1), del('gone', 2)])), [['a', 'a'], ['gone', null]]);

// --- ordering within a block -------------------------------------------------
//
// The unified stream emits every removal before any addition. Zipping has to
// pair them by position within the block, not by the order they arrived.
check('additions are not pushed below the removals',
  shape(toSideBySide([del('1', 1), del('2', 2), add('one', 1), add('two', 2)])),
  [['1', 'one'], ['2', 'two']]);

// --- the collapsed run between changes --------------------------------------
const withSkip = toSideBySide([ctx('a', 1, 1), { type: 'context', content: '@@ ... (40 lines) @@' }, ctx('b', 42, 42)]);
check('a collapsed run is one marker across both columns',
  withSkip.map((r) => r.skip ?? [r.left?.content, r.right?.content]),
  [['a', 'a'], '@@ ... (40 lines) @@', ['b', 'b']]);
check('the marker occupies neither column', [withSkip[1].left, withSkip[1].right], [null, null]);

// --- a block that ends the file ---------------------------------------------
//
// The buffered runs are flushed by the next context line; a change at the very
// end has none, so it needs flushing when the input runs out.
check('a change with no context after it is not dropped',
  shape(toSideBySide([ctx('a', 1, 1), del('last', 2), add('final', 2)])),
  [['a', 'a'], ['last', 'final']]);

check('nothing in, nothing out', toSideBySide([]), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
