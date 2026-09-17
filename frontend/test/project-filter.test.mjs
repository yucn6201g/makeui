// The project list decides what to show from three independent rules, and the
// interesting part is where they meet.
//
//   ARCHIVE is not a filter, it is a different set. A project put away must not
//   come back because someone searched for it.
//   FRAMEWORK has to agree with the badge on the card, so both read one
//   `projectKind`. The badge and the preview once disagreed about what a
//   document was, which is what a second copy of that predicate buys.
//   SEARCH runs against Japanese names typed with an IME, where 「Ｒｅａｃｔ」
//   and 「React」 look alike and are not.
//
//   node test/project-filter.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/projectFilter.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/pf.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { projectKind, normalizeSearch, matchesQuery, visibleProjects, frameworkCounts, sortProjects } =
  await import(pathToFileURL(path.join(root, 'dist-test/pf.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const doc = (...paths) =>
  `<!DOCTYPE html><html><body>\n${paths.map((p) => fence(p, 'x')).join('')}</body></html>`;

let seq = 0;
const project = (over = {}) => ({
  projectId: `p${++seq}`,
  userId: 'u',
  name: 'Untitled',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

// --- projectKind -------------------------------------------------------------
check('a stored kind is taken as written',
  projectKind(project({ outputKind: 'svelte' })), 'svelte');
// A stored `html` is not trusted: every run was recorded as `html` for as long
// as the server classified with a detector that could no longer match anything,
// so the value is present, wrong, and truthy.
check('a stored html defers to the document',
  projectKind(project({ outputKind: 'html', lastHtml: doc('src/App.vue') })), 'vue');
check('and survives as a label when there is no document',
  projectKind(project({ outputKind: 'html' })), 'html');
check('a project with neither has no kind', projectKind(project()), null);

// --- search ------------------------------------------------------------------
check('case is folded', matchesQuery('Sales Dashboard', 'sales'), true);
// With an IME on, typing full-width is as likely as typing half-width, and the
// two look nearly identical on screen.
check('full-width ascii matches half-width', matchesQuery('React 管理画面', 'Ｒｅａｃｔ'), true);
check('and the other way round', matchesQuery('Ｒｅａｃｔ 管理画面', 'react'), true);
// Unlike the credential fields, a project name is mostly Japanese; stripping
// non-ascii the way `toHalfWidth` does would leave nothing to match on.
check('kanji and kana are left alone', matchesQuery('売上分析ダッシュボード', '売上'), true);
check('an ideographic space is a space', normalizeSearch('売上　分析'), '売上 分析');
check('an empty query matches everything', matchesQuery('anything', '   '), true);
check('a miss is a miss', matchesQuery('Sales', 'invoice'), false);

// --- the three rules together ------------------------------------------------
const list = [
  project({ name: 'Sales Dashboard', outputKind: 'react' }),
  project({ name: '売上分析', outputKind: 'vue' }),
  project({ name: 'Sales Archive', outputKind: 'react', archivedAt: '2026-08-20T00:00:00.000Z' }),
  project({ name: 'Storefront', outputKind: 'svelte' }),
];
const names = (f) => visibleProjects(list, f).map((p) => p.name);

check('the active list leaves the archive out',
  names({ query: '', framework: 'all', archived: false }),
  ['Sales Dashboard', '売上分析', 'Storefront']);
check('and the archive holds only what was put in it',
  names({ query: '', framework: 'all', archived: true }), ['Sales Archive']);
// The whole point of archiving: a search from the main list must not turn it up.
check('a search does not reach into the archive',
  names({ query: 'Sales', framework: 'all', archived: false }), ['Sales Dashboard']);
check('the framework filter narrows within the set',
  names({ query: '', framework: 'react', archived: false }), ['Sales Dashboard']);
check('search and framework compose',
  names({ query: 'sales', framework: 'vue', archived: false }), []);
check('a Japanese query finds a Japanese name',
  names({ query: '売上', framework: 'all', archived: false }), ['売上分析']);

// --- the counts on the tabs --------------------------------------------------
// Counted over the set being shown, not the whole account: an archived React
// project must not inflate the React tab on the active list.
check('counts are per set',
  frameworkCounts(list, false), { all: 3, react: 1, vue: 1, svelte: 1 });
check('and the archive has its own',
  frameworkCounts(list, true), { all: 1, react: 1, vue: 0, svelte: 0 });
// Counts ignore the query, so clearing a search cannot surprise you with a
// number that was never shown.
check('a project with no kind still counts under すべて',
  frameworkCounts([project({ name: 'Empty' })], false), { all: 1, react: 0, vue: 0, svelte: 0 });

// --- sorting ------------------------------------------------------------------
//
// A star says where a project should be, not what it cost. Sorting by tokens
// and losing the starred one to the bottom of the page defeats the point of
// having starred it, so the star is the first key in both directions.
const costed = [
  project({ name: 'cheap', totalTokens: 10_000, requestCount: 1 }),
  project({ name: 'dear', totalTokens: 900_000, requestCount: 30 }),
  project({ name: 'middling', totalTokens: 200_000, requestCount: 9 }),
];
const order = (sort) => sortProjects(costed, sort).map((p) => p.name);

check('tokens, most first', order({ key: 'tokens', direction: 'desc' }), ['dear', 'middling', 'cheap']);
check('tokens, fewest first', order({ key: 'tokens', direction: 'asc' }), ['cheap', 'middling', 'dear']);
check('requests, most first', order({ key: 'requests', direction: 'desc' }), ['dear', 'middling', 'cheap']);
check('requests, fewest first', order({ key: 'requests', direction: 'asc' }), ['cheap', 'middling', 'dear']);
// These three share an `updatedAt`, so `recent` has nothing to separate them
// and the stable sort keeps the order they arrived in. That is the property
// worth pinning: the direction control must not shuffle a list of projects
// updated at the same moment.
check('recent leaves equal timestamps in the given order',
  order({ key: 'recent', direction: 'desc' }), ['cheap', 'dear', 'middling']);
check('in either direction', order({ key: 'recent', direction: 'asc' }), ['cheap', 'dear', 'middling']);
check('and so does no sort at all', sortProjects(costed).map((p) => p.name), ['cheap', 'dear', 'middling']);

const withStar = [
  project({ name: 'cheap-starred', totalTokens: 10_000, favouritedAt: '2026-08-20T00:00:00.000Z' }),
  project({ name: 'dear', totalTokens: 900_000 }),
  project({ name: 'middling', totalTokens: 200_000 }),
];
check('a favourite stays on top of a descending sort',
  sortProjects(withStar, { key: 'tokens', direction: 'desc' }).map((p) => p.name),
  ['cheap-starred', 'dear', 'middling']);
check('and of an ascending one',
  sortProjects(withStar, { key: 'tokens', direction: 'asc' }).map((p) => p.name),
  ['cheap-starred', 'middling', 'dear']);

// A project that has never run has no counters. Treating that as zero is what
// keeps it in the list rather than at an undefined position.
const unused = [project({ name: 'never-run' }), project({ name: 'run', totalTokens: 5 })];
check('a project with no counters sorts as zero',
  sortProjects(unused, { key: 'tokens', direction: 'desc' }).map((p) => p.name), ['run', 'never-run']);

// Equal values keep the order they arrived in — the server's, most recently
// updated first — so a list of untouched projects still reads sensibly.
const tied = [project({ name: 'a' }), project({ name: 'b' }), project({ name: 'c' })];
check('ties are stable',
  sortProjects(tied, { key: 'requests', direction: 'desc' }).map((p) => p.name), ['a', 'b', 'c']);

// And it composes with the filters rather than replacing them.
check('sorting runs after filtering',
  visibleProjects(
    [...costed, project({ name: 'archived-dear', totalTokens: 999_999, archivedAt: '2026-08-20T00:00:00.000Z' })],
    { query: '', framework: 'all', archived: false, sort: { key: 'tokens', direction: 'desc' } }
  ).map((p) => p.name),
  ['dear', 'middling', 'cheap']);

// The input is not reordered in place: the caller holds the list React renders
// from, and mutating it is a re-render that does not happen.
const original = [project({ name: 'x', totalTokens: 1 }), project({ name: 'y', totalTokens: 2 })];
sortProjects(original, { key: 'tokens', direction: 'desc' });
check('the input array is left alone', original.map((p) => p.name), ['x', 'y']);

// --- 更新順 in both directions --------------------------------------------
// It used to return the server's order untouched, which is descending by
// `updatedAt` and correct — but it meant the one direction the list could not
// be reversed was its own default.

const at = (name, iso, over = {}) => project({ name, updatedAt: iso, ...over });
const byDate = [
  at('old', '2026-08-01T00:00:00.000Z'),
  at('newest', '2026-08-27T00:00:00.000Z'),
  at('middle', '2026-08-15T00:00:00.000Z'),
];

check('更新順 descending is newest first',
  sortProjects(byDate, { key: 'recent', direction: 'desc' }).map((p) => p.name),
  ['newest', 'middle', 'old']);
check('and ascending is oldest first',
  sortProjects(byDate, { key: 'recent', direction: 'asc' }).map((p) => p.name),
  ['old', 'middle', 'newest']);

// The star outranks the date in both directions, exactly as it outranks a count
// — it is a statement about where a project should be, not about when it moved.
{
  const starred = [
    at('old', '2026-08-01T00:00:00.000Z'),
    at('newest', '2026-08-27T00:00:00.000Z'),
    at('old-starred', '2026-08-02T00:00:00.000Z', { favouritedAt: '2026-08-20T00:00:00.000Z' }),
  ];
  check('a starred project stays on top of a newer one',
    sortProjects(starred, { key: 'recent', direction: 'desc' }).map((p) => p.name),
    ['old-starred', 'newest', 'old']);
  check('and on top of an older one when reversed',
    sortProjects(starred, { key: 'recent', direction: 'asc' }).map((p) => p.name),
    ['old-starred', 'old', 'newest']);
}

// Omitting the sort entirely is not the same as asking for `recent`: it leaves
// the server's order, which is what a list with no controls touched should show.
check('no sort leaves the arrival order',
  sortProjects(byDate).map((p) => p.name), ['old', 'newest', 'middle']);

// --- favourites as their own axis -----------------------------------------
// Not a fourth framework value: "React" and "favourite" answer different
// questions, and one control for both would make a starred Vue project
// unaskable.
{
  const mixed = [
    project({ name: 'react-plain', lastHtml: doc('src/App.tsx') }),
    project({ name: 'react-star', lastHtml: doc('src/App.tsx'), favouritedAt: '2026-08-20T00:00:00.000Z' }),
    project({ name: 'vue-star', lastHtml: doc('src/App.vue'), favouritedAt: '2026-08-21T00:00:00.000Z' }),
  ];
  const shown = (f) => visibleProjects(mixed, { query: '', framework: 'all', archived: false, ...f }).map((p) => p.name);
  check('favourite alone narrows to the starred', shown({ favourite: true }).sort(), ['react-star', 'vue-star']);
  check('and composes with the framework filter',
    shown({ favourite: true, framework: 'vue' }), ['vue-star']);
  check('a starred Vue project is askable, which is the whole point',
    shown({ favourite: true, framework: 'vue' }).length, 1);
  check('and leaving it off changes nothing', shown({}).length, 3);
  check('nor does passing it false', shown({ favourite: false }).length, 3);
}
{
  // Archiving clears the star, so the favourite view of the archive is empty by
  // construction rather than by accident.
  const archived = [project({ name: 'a', archivedAt: '2026-08-20T00:00:00.000Z' })];
  check('the archive has no favourites to show',
    visibleProjects(archived, { query: '', framework: 'all', archived: true, favourite: true }).length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
