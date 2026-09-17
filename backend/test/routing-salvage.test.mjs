// Salvaging a repair pass that broke the routing.
//
// The batch is the unit of judgement and it is far too coarse: a pass writes
// App.svelte, globals.css and eight icons, one of them breaks the routing, and
// all ten go back. Measured on the v200 round — six of seven verdicts were
// breaking rejections, and the counts they gave up were 18→9, 12→5, 11→7 and
// 10→5.
//
//   node test/routing-salvage.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/graph.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/rs.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'pipe', cwd: root }
);
const { isRoutingFile, withoutRoutingChanges, withoutFiles, revertSuspects } = await import(
  pathToFileURL(path.join(root, 'dist/rs.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- which files decide what renders and where you can get to ------------------
for (const [kind, ext] of [['react', '.tsx'], ['vue', '.vue'], ['svelte', '.svelte']]) {
  check(`${kind}: the shell routes`, isRoutingFile(`src/App${ext}`, kind), true);
  check(`${kind}: a screen routes`, isRoutingFile(`src/screens/HomeScreen${ext}`, kind), true);
  check(`${kind}: the route table routes`, isRoutingFile('src/routes.ts', kind), true);
  check(`${kind}: an icon does not`, isRoutingFile(`src/components/icons/Chevron${ext}`, kind), false);
  check(`${kind}: the stylesheet does not`, isRoutingFile('src/styles/globals.css', kind), false);
  check(`${kind}: a ui component does not`, isRoutingFile(`src/components/ui/Card${ext}`, kind), false);
}
check('the entry routes', isRoutingFile('src/main.tsx', 'react'), true);
check('a store does not', isRoutingFile('src/store/index.ts', 'react'), false);

// --- the reduction --------------------------------------------------------------
const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const doc = (...blocks) => `<!DOCTYPE html><html><body><div id="root"></div>\n${blocks.join('')}</body></html>`;

const BASE = doc(
  fence('src/main.tsx', "import App from './App'"),
  fence('src/App.tsx', 'export default function App(){ return <main>old shell</main> }'),
  fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>old home</b> }'),
  fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg /> }'),
  fence('src/styles/globals.css', '.a{color:#000}')
);
// A pass that rewrote the shell (breaking it) and also wrote a good icon and
// stylesheet — the shape every rejected v200 batch had.
const CANDIDATE = doc(
  fence('src/main.tsx', "import App from './App'"),
  fence('src/App.tsx', 'export default function App(){ return <main>BROKEN shell</main> }'),
  fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>new home</b> }'),
  fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg viewBox="0 0 24 24" /> }'),
  fence('src/styles/globals.css', '.a{color:#111}.b{gap:8px}')
);

const r = withoutRoutingChanges(BASE, CANDIDATE, 'react');
check('the routing edits are reverted', r.reverted, ['src/App.tsx', 'src/screens/HomeScreen.tsx']);
check('and the rest is kept',
  r.kept, ['src/components/icons/Chevron.tsx', 'src/styles/globals.css']);
check('the shell really is the old one', r.html.includes('old shell'), true);
check('the screen really is the old one', r.html.includes('old home'), true);
check('the icon really is the new one', r.html.includes('viewBox="0 0 24 24"'), true);
check('the stylesheet really is the new one', r.html.includes('.b{gap:8px}'), true);

// Nothing to try, in both directions — the caller must not spend a browser run
// re-measuring a document it has already judged.
check('a batch that only touched routing has nothing left',
  withoutRoutingChanges(BASE, doc(
    fence('src/main.tsx', "import App from './App'"),
    fence('src/App.tsx', 'export default function App(){ return <main>BROKEN</main> }'),
    fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>old home</b> }'),
    fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg /> }'),
    fence('src/styles/globals.css', '.a{color:#000}')
  ), 'react'), null);
check('a batch that touched no routing has nothing to revert',
  withoutRoutingChanges(BASE, doc(
    fence('src/main.tsx', "import App from './App'"),
    fence('src/App.tsx', 'export default function App(){ return <main>old shell</main> }'),
    fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>old home</b> }'),
    fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg width="16" /> }'),
    fence('src/styles/globals.css', '.a{color:#000}')
  ), 'react'), null);
check('an identical candidate has nothing at all',
  withoutRoutingChanges(BASE, BASE, 'react'), null);

// A file the pass created that is not routing is kept like any other edit.
const CREATED = doc(
  fence('src/main.tsx', "import App from './App'"),
  fence('src/App.tsx', 'export default function App(){ return <main>BROKEN shell</main> }'),
  fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>old home</b> }'),
  fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg /> }'),
  fence('src/components/icons/Search.tsx', 'export function Search(){ return <svg /> }'),
  fence('src/styles/globals.css', '.a{color:#000}')
);
/*
 * Kept only while something still imports it. The live run of 2026-09-13 kept
 * nine icons and illustrations whose screens the revert had put back, and the
 * reply reported them as drawn and never displayed — a finding the salvage
 * created. Alone like this, with its importer reverted, it goes, and there is
 * nothing left to try.
 */
check('a created component nothing imports is not kept', withoutRoutingChanges(BASE, CREATED, 'react'), null);
const CREATED_AND_USED = doc(
  fence('src/main.tsx', "import App from './App'"),
  fence('src/App.tsx', 'export default function App(){ return <main>BROKEN shell</main> }'),
  fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>old home</b> }'),
  fence('src/components/icons/Chevron.tsx', "import { Search } from './Search'\nexport function Chevron(){ return <svg><Search /></svg> }"),
  fence('src/components/icons/Search.tsx', 'export function Search(){ return <svg /> }'),
  fence('src/components/ui/Orphan.tsx', "import { Leaf } from '../icons/Leaf'\nexport function Orphan(){ return <Leaf /> }"),
  fence('src/components/icons/Leaf.tsx', 'export function Leaf(){ return <svg /> }'),
  fence('src/styles/globals.css', '.a{color:#000}')
);
const c = withoutRoutingChanges(BASE, CREATED_AND_USED, 'react');
check('a created component a kept file imports is kept', c.kept, ['src/components/icons/Chevron.tsx', 'src/components/icons/Search.tsx']);
check('an orphan, and what only the orphan imported, are dropped', c.dropped.sort(), ['src/components/icons/Leaf.tsx', 'src/components/ui/Orphan.tsx']);
check('and the broken shell is still reverted', c.html.includes('old shell'), true);
check('an existing file is never dropped for being unused', c.dropped.some((p) => p.includes('Chevron')), false);

// --- and the same salvage for a file that will not compile ------------------------
//
// A pass writes nine files, one of them does not build, and the compiler names
// it. Rejecting the document there throws away the other eight for a fault that
// has exactly one file's worth of blame. Measured over 45 days: thirteen passes
// were rejected for 「no longer compiles」, and in ten of them the named file was
// one the pass had written.
{
  const CANDIDATE = doc(
    fence('src/main.tsx', "import App from './App'"),
    fence('src/App.tsx', 'export default function App(){ return <main>NEW shell</main> }'),
    fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>NEW home</b> }'),
    fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg width="16" /> }'),
    fence('src/styles/globals.css', '.a{color:#111}')
  );
  const r = withoutFiles(BASE, CANDIDATE, ['src/screens/HomeScreen.tsx']);
  check('the named file goes back', r.reverted, ['src/screens/HomeScreen.tsx']);
  check('and it really is the old one', r.html.includes('old home'), true);
  check('while every other edit is kept',
    ['NEW shell', 'width="16"', '#111'].map((x) => r.html.includes(x)), [true, true, true]);

  check('reverting the only change leaves nothing to keep',
    withoutFiles(BASE, doc(
      fence('src/main.tsx', "import App from './App'"),
      fence('src/App.tsx', 'export default function App(){ return <main>old shell</main> }'),
      fence('src/screens/HomeScreen.tsx', 'export default function HomeScreen(){ return <b>NEW home</b> }'),
      fence('src/components/icons/Chevron.tsx', 'export function Chevron(){ return <svg /> }'),
      fence('src/styles/globals.css', '.a{color:#000}')
    ), ['src/screens/HomeScreen.tsx']), null);

  /*
   * The case that is NOT the pass's fault: the compiler named a file this pass
   * never touched. Three of the thirteen were this, and there the document was
   * already broken and every attempt against it was being blamed for it.
   */
  check('a file the pass did not touch has nothing to revert',
    withoutFiles(BASE, CANDIDATE, ['src/data/nothing.ts']), null);
}

// --- one file at a time, most likely culprit first ---------------------------------
/*
 * The 2026-09-13 run: a pass rewrote two screens, the store and a hook, created
 * a dozen components and icons, and the app crashed with React #130. The routing
 * revert put both screens back together, rendered, and was no improvement —
 * the screens were where the work was.
 */
{
  const B = doc(
    fence('src/App.tsx', 'export default function App(){ return <main/> }'),
    fence('src/screens/HoldingsScreen.tsx', 'export default function H(){ return <b>old</b> }'),
    fence('src/screens/AlertsScreen.tsx', 'export default function A(){ return <b>old</b> }'),
    fence('src/store/AppProvider.tsx', 'export const old = 1'),
    fence('src/styles/globals.css', '.a{color:#000}')
  );
  const C = doc(
    fence('src/App.tsx', 'export default function App(){ return <main/> }'),
    fence('src/screens/HoldingsScreen.tsx', 'export default function H(){ return <Toolbar/> }'),
    fence('src/screens/AlertsScreen.tsx', 'export default function A(){ return <AlertBadge/> }'),
    fence('src/store/AppProvider.tsx', 'export const next = 1'),
    fence('src/styles/globals.css', '.a{color:#111}'),
    fence('src/components/ui/AlertBadge.tsx', 'export function AlertBadge(){ return <i/> }')
  );
  const ERRORS = [
    'Error: React #130: Element type is invalid: expected a string … but got: undefined.',
    'render() was called but #root is empty at route "#/alerts"',
  ];
  check('the screen for the route the error names comes first, then screens, then the rest',
    revertSuspects(B, C, ERRORS), ['src/screens/AlertsScreen.tsx', 'src/screens/HoldingsScreen.tsx', 'src/store/AppProvider.tsx']);
  check('a file the error names by name outranks the route',
    revertSuspects(B, C, ['TypeError in AppProvider', ...ERRORS])[0], 'src/store/AppProvider.tsx');
  check('a created file is not a suspect, and neither is a stylesheet',
    revertSuspects(B, C, ERRORS).some((x) => /AlertBadge|\.css$/.test(x)), false);
  check('with no error text the order is screens first, as written',
    revertSuspects(B, C, []), ['src/screens/HoldingsScreen.tsx', 'src/screens/AlertsScreen.tsx', 'src/store/AppProvider.tsx']);
  check('one changed file is no salvage: reverting it is rejecting the pass',
    revertSuspects(B, doc(
      fence('src/App.tsx', 'export default function App(){ return <main/> }'),
      fence('src/screens/HoldingsScreen.tsx', 'export default function H(){ return <Toolbar/> }'),
      fence('src/screens/AlertsScreen.tsx', 'export default function A(){ return <b>old</b> }'),
      fence('src/store/AppProvider.tsx', 'export const old = 1'),
      fence('src/styles/globals.css', '.a{color:#000}')
    ), ERRORS), []);

  const graph = fs.readFileSync(path.join(root, 'src/orchestration/graph.ts'), 'utf8');
  const brokeAt = graph.indexOf('if (broke.length > 0 && !isRetry)');
  const broke = graph.slice(brokeAt, graph.indexOf('const improved =', brokeAt));
  check('the single reverts run after the routing revert, inside the breaking branch',
    broke.indexOf('withoutRoutingChanges(') < broke.indexOf('revertSuspects('), true);
  check('are bounded', broke.includes('.slice(0, MAX_SINGLE_REVERTS)'), true);
  check('skip a revert identical to the routing one', broke.includes("reduced.reverted.length === 1 && reduced.reverted[0] === path"), true);
  check('and each is judged as a retry, so none recurses', /judgeRepair\(one\.html, before, pass, `\$\{kind\} \(\$\{path\} reverted\)`, minLength, true\)/.test(broke), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
