// Searching every file in the project.
//
// The rules worth pinning are not "does it find the word". They are the three
// ways a search box lies: a plain query treated as a pattern, a bad pattern
// treated as no matches, and a ceiling treated as an answer.
//
//   node test/code-search.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/editing/codeSearch.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/cs.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { searchFiles, MAX_MATCHES } = await import(
  pathToFileURL(path.join(root, 'dist-test/cs.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const FILES = [
  { path: 'src/App.svelte', content: 'let appState = $state(0);\nconst total = appState + 1;\n' },
  { path: 'src/lib/store.svelte.ts', content: 'export const appState = $state({});\n' },
  { path: 'README.md', content: '# Project\nNothing here.\n' },
];

// --- the ordinary case -------------------------------------------------------
const r = searchFiles(FILES, 'appState');
check('every file that matches is listed', r.files.map((f) => f.path),
  ['src/App.svelte', 'src/lib/store.svelte.ts']);
check('and every match in them', r.total, 3);
check('a match carries its line number', r.files[0].matches[0].line, 1);
check('and where it sits on that line', [r.files[0].matches[0].start, r.files[0].matches[0].end], [4, 12]);
check('a file with no match is absent', r.files.some((f) => f.path === 'README.md'), false);

// --- case ---------------------------------------------------------------------
check('insensitive by default', searchFiles(FILES, 'APPSTATE').total, 3);
check('and sensitive on request', searchFiles(FILES, 'APPSTATE', { caseSensitive: true }).total, 0);

// --- a plain query is not a pattern -------------------------------------------
// `$state(0)` is what someone types when they mean those characters. Read as a
// regex it is a group, a class and a quantifier, and matches nothing.
check('a plain query is taken literally', searchFiles(FILES, '$state(0)').total, 1);
check('and the same query as a regex is not', searchFiles(FILES, '$state(0)', { regex: true }).total, 0);
check('a real regex works when asked for',
  searchFiles(FILES, 'app[A-Z]\\w+', { regex: true }).total, 3);

// --- a pattern that cannot compile --------------------------------------------
// Reported, not silently answered with zero: those look identical in a results
// list and only one of them means "no matches".
const bad = searchFiles(FILES, '(unclosed', { regex: true });
check('a broken pattern is an error', typeof bad.error, 'string');
check('and not an empty result set', bad.files, []);
check('a literal search on the same text is fine', searchFiles(FILES, '(unclosed').error, undefined);

// --- the ceiling ---------------------------------------------------------------
const BIG = [{ path: 'big.txt', content: Array.from({ length: 1000 }, () => 'x').join('\n') }];
const capped = searchFiles(BIG, 'x');
check('the ceiling stops the search', capped.total, MAX_MATCHES);
check('and the result says so', capped.truncated, true);
check('an ordinary search does not claim truncation', r.truncated, false);

// --- patterns with no width -----------------------------------------------------
// `a*` matches the empty string at every index. Stepping past it is what keeps
// this from hanging; refusing it would be refusing a legal search.
const empty = searchFiles([{ path: 'a.txt', content: 'abc\n' }], 'z*', { regex: true });
check('a zero-width pattern terminates', empty.truncated || empty.total >= 0, true);

check('an empty query finds nothing at all', searchFiles(FILES, '').total, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
