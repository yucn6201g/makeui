// Tests for per-file repair: routing defects to files, and splicing the results.
//
// The splice is string surgery on a document the user is about to receive, and
// getting it wrong is silent — a block whose opening tag was rebuilt instead of
// kept still looks like a file, it is just a different one. So the assertions
// check the tag survives byte-for-byte, that neighbouring blocks are untouched,
// and that a planner naming a path outside the project cannot write anywhere.
//
//   node test/repair-files.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair/repair-files.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/rf.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { writeFile, planFileRepairs, repairFiles } = await import(
  pathToFileURL(path.join(root, 'dist/rf.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const DOC = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/App.tsx">OLD APP</script>
<script type="text/jsx" data-file="src/screens/ListScreen.tsx">OLD LIST</script>
<style data-file="src/styles/globals.css">:root{--a:1}</style>
</body></html>`;

// --- writeFile: replacing --------------------------------------------------
let out = writeFile(DOC, 'src/App.tsx', 'NEW APP');
check('the body is replaced', out.includes('NEW APP'), true);
check('the old body is gone', out.includes('OLD APP'), false);
check('the opening tag survives verbatim', out.includes('<script type="text/jsx" data-file="src/App.tsx">'), true);
check('the neighbour is untouched', out.includes('OLD LIST'), true);
check('the stylesheet is untouched', out.includes(':root{--a:1}'), true);

out = writeFile(DOC, 'src/styles/globals.css', ':root{--a:2}');
check('a style block is replaced', out.includes(':root{--a:2}') && !out.includes(':root{--a:1}'), true);
check('the style tag survives', out.includes('<style data-file="src/styles/globals.css">'), true);

// A path that is a prefix of another must not match the longer one.
const AMBIG = `<html><body>
<script type="text/jsx" data-file="src/Card.tsx">CARD</script>
<script type="text/jsx" data-file="src/CardList.tsx">CARDLIST</script>
</body></html>`;
out = writeFile(AMBIG, 'src/Card.tsx', 'X');
check('a prefix path does not match the longer one', out.includes('CARDLIST') && !out.includes('CARD<'), true);

// --- writeFile: creating ---------------------------------------------------
out = writeFile(DOC, 'src/components/icons/Search.tsx', 'export default function S(){return null}');
check('a new file is added', out.includes('data-file="src/components/icons/Search.tsx"'), true);
check('a new tsx file uses the jsx transport', /<script type="text\/jsx" data-file="src\/components\/icons\/Search\.tsx">/.test(out), true);
check('a new file lands before </body>', out.indexOf('Search.tsx') < out.indexOf('</body>'), true);
check('creating did not disturb the existing files', out.includes('OLD APP') && out.includes('OLD LIST'), true);

out = writeFile(DOC, 'src/styles/print.css', '@media print{}');
check('a new css file uses a style block', /<style data-file="src\/styles\/print\.css">/.test(out), true);

check('a document with no body cannot take a new file', writeFile('<html></html>', 'src/New.tsx', 'x'), null);

// --- planFileRepairs -------------------------------------------------------
const defects = [
  { id: 'native-dialog', instruction: 'alert() をモーダルに置き換えてください。' },
  { id: 'imagery-missing', instruction: 'src/components/illustrations/ がありません。' },
  { id: 'token-adoption', instruction: 'トークン参照率が低いです。' },
];
const planner = (assignments) => async () => JSON.stringify({ assignments });

let plans = await planFileRepairs(DOC, defects, planner([
  { defect: 1, paths: ['src/screens/ListScreen.tsx'] },
  { defect: 2, paths: ['src/components/illustrations/EmptyBox.tsx'] },
  { defect: 3, paths: ['src/styles/globals.css'] },
]));
check('one plan per file', plans.map((p) => p.path).sort(), [
  'src/components/illustrations/EmptyBox.tsx', 'src/screens/ListScreen.tsx', 'src/styles/globals.css',
].sort());
check('a path the project lacks is marked for creation',
  plans.find((p) => p.path.includes('illustrations')).create, true);
check('an existing path is not', plans.find((p) => p.path.endsWith('globals.css')).create, false);

// Several defects landing on one file are grouped, not repeated.
plans = await planFileRepairs(DOC, defects, planner([
  { defect: 1, paths: ['src/App.tsx'] },
  { defect: 3, paths: ['src/App.tsx'] },
]));
check('defects on one file are grouped', plans.length, 1);
check('and both are carried', plans[0].defects.map((d) => d.id), ['native-dialog', 'token-adoption']);

// A planner naming somewhere outside the project must not get a write.
plans = await planFileRepairs(DOC, defects, planner([
  { defect: 1, paths: ['../../etc/passwd', '/etc/hosts', 'package.json', 'src/App.tsx'] },
]));
check('out-of-tree paths are dropped', plans.map((p) => p.path), ['src/App.tsx']);

// A defect index the planner invented refers to nothing and is ignored.
plans = await planFileRepairs(DOC, defects, planner([{ defect: 99, paths: ['src/App.tsx'] }]));
check('an unknown defect index is ignored', plans, []);

check('unparsable planner output yields no plan',
  await planFileRepairs(DOC, defects, async () => 'I could not determine this.'), []);

// --- repairFiles -----------------------------------------------------------
let res = await repairFiles(
  DOC,
  [{ path: 'src/App.tsx', defects: [defects[0]], create: false }],
  async () => '```tsx\nexport default function App(){ return null }\n```'
);
check('fences are stripped from a file response', res.html.includes('```'), false);
check('the file was written', res.written, ['src/App.tsx']);

// A response that loses most of the file is a gutting, not a fix.
res = await repairFiles(
  DOC,
  [{ path: 'src/screens/ListScreen.tsx', defects: [defects[0]], create: false }],
  async () => 'x'
);
check('a truncated response is skipped', res.skipped, ['src/screens/ListScreen.tsx']);
check('and the document is unchanged', res.html, DOC);

// A file that does not parse is dropped on its own, not by failing the batch.
// Measured on the first real run: nine files came back, one had a syntax error,
// and the whole-document compile check discarded all nine.
res = await repairFiles(
  DOC,
  [
    { path: 'src/App.tsx', defects: [defects[0]], create: false },
    { path: 'src/screens/ListScreen.tsx', defects: [defects[0]], create: false },
  ],
  async (_system, user) =>
    user.includes('ListScreen')
      ? 'export default function ListScreen(){ return <div>unclosed }'
      : 'export default function App(){ return <main>ok</main> }'
);
check('a file that does not parse is skipped', res.skipped, ['src/screens/ListScreen.tsx']);
check('its neighbours are still written', res.written, ['src/App.tsx']);
check('the broken body never reached the document', res.html.includes('unclosed'), false);

// TypeScript generics in a .ts file must not be mistaken for JSX.
res = await repairFiles(
  DOC,
  [{ path: 'src/styles/globals.css', defects: [defects[2]], create: false }],
  async () => ':root{--a:3;--b:4;--c:5}'
);
check('css is not run through the TypeScript parser', res.written, ['src/styles/globals.css']);

// One file failing must not take the others with it.
res = await repairFiles(
  DOC,
  [
    { path: 'src/App.tsx', defects: [defects[0]], create: false },
    { path: 'src/screens/ListScreen.tsx', defects: [defects[0]], create: false },
  ],
  async (_system, user) => {
    if (user.includes('ListScreen')) throw new Error('model unavailable');
    return 'export default function App(){ return null }';
  }
);
check('a failed file is skipped', res.skipped, ['src/screens/ListScreen.tsx']);
check('a succeeding file is still written', res.written, ['src/App.tsx']);
check('the skipped file keeps its old contents', res.html.includes('OLD LIST'), true);

// --- imports that do not resolve ------------------------------------------
// The production failure this gate was added for, reproduced exactly. A repair
// rewrote Header.tsx to import '../icons/UserIcon', wrote seven sibling icons
// and not that one, and passed every check: the file was valid TypeScript and
// so was everything else. The first require threw, nothing mounted, and a
// six-screen application shipped as a blank page scoring 30.
const APP_DOC = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/main.tsx">
import App from './App';
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')).render(<App />);
</script>
<script type="text/jsx" data-file="src/App.tsx">
import Header from './components/ui/Header';
export default function App(){ return <div><Header /></div>; }
</script>
<script type="text/jsx" data-file="src/components/ui/Header.tsx">
export default function Header(){ return <header>棚卸</header>; }
</script>
</body></html>`;

const HEADER_WANTING_ICON = `import UserIcon from '../icons/UserIcon';
export default function Header(): JSX.Element {
  return <header className="hd"><UserIcon /><span>棚卸</span></header>;
}`;

// The module is written rather than the edit thrown away.
//
// This used to revert unconditionally, and that revert was the largest single
// obstacle to a decomposed project. Measured on the v194 round: told to break
// its screens into components, Vue imported eight it had not written, six
// screens were reverted for the dangling imports, the pass therefore changed
// nothing, was judged "no improvement", and the components it HAD created were
// discarded with it. Vue shipped one component against React's eleven on the
// same brief.
//
// The import names the path and the importer shows how it is used, so this is a
// smaller question than the repair that produced it.
res = await repairFiles(
  APP_DOC,
  [{ path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false }],
  async (_system, user) =>
    user.includes('UserIcon')
      ? 'export default function UserIcon(): JSX.Element { return <svg viewBox="0 0 24 24" />; }'
      : HEADER_WANTING_ICON
);
check('the missing module is written', res.written.includes('src/components/icons/UserIcon.tsx'), true);
check('and the edit that wanted it survives', res.written.includes('src/components/ui/Header.tsx'), true);
check('nothing is skipped', res.skipped, []);
check('both are in the document',
  res.html.includes('UserIcon') && res.html.includes('viewBox'), true);

// One round, then the revert exactly as before. A model that cannot write the
// module does not get to leave a dangling import in the document.
//
// A hook, not an icon. `leafModule` now draws the graphics itself and never asks
// — so an icon can no longer stand for "a module the model failed to write", and
// this case, which is about the revert path, needs one that still goes out.
const HEADER_WANTING_HOOK = `import { useUser } from '../hooks/useUser';
export default function Header(): JSX.Element {
  const u = useUser();
  return <header className="hd"><span>{u}</span></header>;
}`;
res = await repairFiles(
  APP_DOC,
  [{ path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false }],
  async (_system, user) => (user.includes('useUser') ? 'this is not valid <<< typescript' : HEADER_WANTING_HOOK)
);
check('a module that cannot be written falls back to the revert', res.written, []);
check('and the importer is reported as skipped', res.skipped, ['src/components/ui/Header.tsx']);
check('the document keeps the version that loads', res.html.includes('<header>棚卸</header>'), true);
check('the broken import never reaches the document', res.html.includes('useUser'), false);

// And the icon it used to be. A leaf graphic is drawn here, so the same repair
// that used to be reverted now lands without a call going out at all — which is
// the whole of what the deterministic writer buys.
let iconAsks = 0;
res = await repairFiles(
  APP_DOC,
  [{ path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false }],
  async (_system, user) => {
    if (/^Write a new file: /m.test(user)) { iconAsks += 1; return 'this is not valid <<< typescript'; }
    return HEADER_WANTING_ICON;
  }
);
check('a missing icon is drawn rather than asked for', iconAsks, 0);
check('the repair that wanted it survives', res.written.includes('src/components/ui/Header.tsx'), true);
check('and the icon is in the document', res.html.includes('src/components/icons/UserIcon.tsx'), true);
// The drawing has to be the icon the name asked for, not a filler shape — the
// glyph table is asserted in leaf-modules.test.mjs; here it only has to arrive.
check('with something actually drawn in it', /d="M[^"]{6,}"/.test(res.html), true);

// The same edit is fine once the module it imports exists.
res = await repairFiles(
  APP_DOC,
  [
    { path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false },
    { path: 'src/components/icons/UserIcon.tsx', defects: [defects[0]], create: true },
  ],
  async (_system, user) =>
    user.includes('UserIcon.tsx')
      ? 'export default function UserIcon(): JSX.Element { return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="3" /></svg>; }'
      : HEADER_WANTING_ICON
);
check('both land when the imported file is written too',
  res.written.sort(), ['src/components/icons/UserIcon.tsx', 'src/components/ui/Header.tsx']);
check('and the import is in the document', res.html.includes("from '../icons/UserIcon'"), true);

// A directory import is not broken just because its barrel has not been
// generated yet — the pipeline adds those after repair, so the gate has to ask
// about the document that ships, not the intermediate one.
res = await repairFiles(
  APP_DOC,
  [
    { path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false },
    { path: 'src/components/icons/UserIcon.tsx', defects: [defects[0]], create: true },
  ],
  async (_system, user) =>
    user.includes('UserIcon.tsx')
      ? 'export default function UserIcon(): JSX.Element { return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6" r="3" /></svg>; }'
      : `import { UserIcon } from '../icons';
export default function Header(): JSX.Element {
  return <header className="hd"><UserIcon /><span>棚卸</span></header>;
}`
);
check('a folder import is kept, because the barrel is added later',
  res.written.includes('src/components/ui/Header.tsx'), true);

// A document that arrived with a broken import is not this pass's doing, and
// reverting good work to atone for it would fix nothing.
const ALREADY_BROKEN = APP_DOC.replace(
  '<script type="text/jsx" data-file="src/App.tsx">',
  `<script type="text/jsx" data-file="src/lib/util.ts">import { gone } from './missing';\nexport const u = gone;</script>
<script type="text/jsx" data-file="src/App.tsx">`
);
res = await repairFiles(
  ALREADY_BROKEN,
  [{ path: 'src/lib/util.ts', defects: [defects[0]], create: false }],
  async () => `import { gone } from './missing';\nexport const u = gone;\nexport const v = 2;\nexport const w = 3;`
);
check('a pre-existing broken import is not blamed on the repair',
  res.written, ['src/lib/util.ts']);

// A created module must survive the revert path.
//
// `spliceAll` rebuilds the document from the original html plus `usable`, so a
// file written straight into the working copy vanishes the next time anything
// re-splices — and something re-splices whenever another import is still
// dangling. Two files are repaired here: one wants a module that gets written,
// the other wants one that cannot be, so the revert runs and the first file's
// new module has to still be there afterwards.
const TWO_DOC = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/main.tsx">
import App from './App';
import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')).render(<App />);
</script>
<script type="text/jsx" data-file="src/App.tsx">
import Header from './components/ui/Header';
import Footer from './components/ui/Footer';
export default function App(){ return <div><Header /><Footer /></div>; }
</script>
<script type="text/jsx" data-file="src/components/ui/Header.tsx">
export default function Header(){ return <header>棚卸</header>; }
</script>
<script type="text/jsx" data-file="src/components/ui/Footer.tsx">
export default function Footer(){ return <footer>脚</footer>; }
</script>
</body></html>`;

res = await repairFiles(
  TWO_DOC,
  [
    { path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false },
    { path: 'src/components/ui/Footer.tsx', defects: [defects[0]], create: false },
  ],
  /*
   * Keyed on the file being ASKED FOR, not on the name appearing anywhere.
   *
   * `user.includes('UserIcon')` matched the second creation round too, because
   * by then UserIcon is in the project and the prompt lists the project's files
   * — so the stub answered the GhostIcon request with the UserIcon body, which
   * parses, and the module that was supposed to be unwritable got written. A
   * fake that answers a different question than the one asked tests nothing.
   */
  async (_system, user) => {
    const asked = /^Write a new file: (.+)$/m.exec(user)?.[1];
    if (asked === 'src/components/icons/UserIcon.tsx') return 'export default function UserIcon(): JSX.Element { return <svg />; }';
    if (asked) return 'this is not valid <<< typescript';
    /*
     * A hook, not a GhostIcon.
     *
     * This case needs one repaired file to survive and the other to be reverted,
     * and the reverted one has to want a module nothing can supply. An icon no
     * longer qualifies — `leafModule` draws it — so Footer wants a hook, which
     * still goes to the model and still comes back unusable.
     */
    if (user.startsWith('File: src/components/ui/Footer.tsx')) return `import { useGhost } from '../hooks/useGhost';
export default function Footer(): JSX.Element { return <footer>{useGhost()}脚</footer>; }`;
    return HEADER_WANTING_ICON;
  }
);
check('the file whose module was written survives',
  res.written.includes('src/components/ui/Header.tsx'), true);
check('and so does the module itself',
  res.written.includes('src/components/icons/UserIcon.tsx') && res.html.includes('UserIcon'), true);
check('the file whose module could not be written is reverted',
  res.skipped.includes('src/components/ui/Footer.tsx'), true);
check('and its dangling import is gone', res.html.includes('useGhost'), false);

// A reply that does not parse gets one more attempt, with the error.
//
// Measured at v207: the build repair for a Svelte chart component replied with
// markup that also would not parse, so the file was stubbed — twenty points and
// a screen — and nothing tried again. The second call is not a resample: it is
// given something the first did not have, namely what its own reply failed on.
let attempts = 0;
res = await repairFiles(
  APP_DOC,
  [{ path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false }],
  async (_system, user) => {
    attempts++;
    // First reply is broken; the second is only produced once the error comes back.
    if (!user.includes('コンパイルできませんでした')) return 'export default function Header(){ return <header>棚卸< }';
    return 'export default function Header(): JSX.Element { return <header className="hd">棚卸</header>; }';
  },
  true
);
check('the second attempt is made', attempts, 2);
check('and its result is written', res.written, ['src/components/ui/Header.tsx']);
check('the document has the repaired file', res.html.includes('className="hd"'), true);

// Off by default, because across the repair loop a rejected file is one of many
// and the pass is judged as a whole.
attempts = 0;
res = await repairFiles(
  APP_DOC,
  [{ path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false }],
  async () => { attempts++; return 'export default function Header(){ return <header>棚卸< }'; }
);
check('without the flag there is only one attempt', attempts, 1);
check('and nothing is written', res.written, []);

// Two bad replies is the model failing, not the prompt: it stops there.
attempts = 0;
res = await repairFiles(
  APP_DOC,
  [{ path: 'src/components/ui/Header.tsx', defects: [defects[0]], create: false }],
  async () => { attempts++; return 'export default function Header(){ return <header>棚卸< }'; },
  true
);
check('a second bad reply ends it', attempts, 2);
check('and still nothing is written', res.written, []);
check('and the file is reported skipped', res.skipped, ['src/components/ui/Header.tsx']);


/*
 * A file that wants THREE new modules gets all three.
 *
 * `importsLost` reports one dangling spec per importer, so a single creation
 * round asks for one and reverts the file for the other two — measured over 30
 * days, twenty passes wrote a module and were reverted anyway, 66 reverts
 * between them. The rounds are bounded at three and stop as soon as one writes
 * nothing, so an unsatisfiable import costs one extra round rather than a loop.
 */
{
  const THREE_DOC = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/main.tsx">
import App from './App';
export default App;
</script>
<script type="text/jsx" data-file="src/App.tsx">
import Screen from './screens/Screen';
export default function App(){ return <Screen />; }
</script>
<script type="text/jsx" data-file="src/screens/Screen.tsx">
export default function Screen(){ return <main>x</main>; }
</script>
</body></html>`;

  /*
   * Three hooks, not three icons.
   *
   * The subject here is the rounds loop, and it is only visible when the modules
   * have to be bought one round at a time. `leafModule` writes all three icons in
   * the first round without a call, which would make the loop untestable — so the
   * icons moved to their own case below and this one wants modules nobody can
   * draw.
   */
  const WANTS_THREE = `import { useA } from '../hooks/useA';
import { useB } from '../hooks/useB';
import { useC } from '../hooks/useC';
export default function Screen(): JSX.Element { return <main>{useA()}{useB()}{useC()}</main>; }`;

  let asks = 0;
  const out = await repairFiles(
    THREE_DOC,
    [{ path: 'src/screens/Screen.tsx', defects: [defects[0]], create: false }],
    async (_system, user) => {
      const asked = /^Write a new file: (.+)$/m.exec(user)?.[1];
      if (asked) {
        asks += 1;
        const name = asked.split('/').pop().replace(/\.(tsx|ts)$/, '');
        return `export const ${name} = () => 'x';`;
      }
      return WANTS_THREE;
    }
  );
  check('every module the file wanted was written', asks, 3);
  check('and the file itself survives', out.written.includes('src/screens/Screen.tsx'), true);
  check('nothing was reverted', out.skipped, []);
  check('all three modules are in the document',
    ['useA', 'useB', 'useC'].filter((n) => !out.html.includes(`src/hooks/${n}.ts`)), []);

  /*
   * The same file, wanting three graphics instead.
   *
   * One round, no calls, and the reason the rounds loop matters less than it
   * did: `importsLost` still reports one spec per importer, but the deterministic
   * writer does not work from that list one at a time — it satisfies everything
   * it recognises in the round it is given.
   */
  const WANTS_THREE_ICONS = `import AIcon from '../components/icons/AIcon';
import BIcon from '../components/icons/BIcon';
import CIcon from '../components/icons/CIcon';
export default function Screen(): JSX.Element { return <main><AIcon /><BIcon /><CIcon /></main>; }`;

  let drawnAsks = 0;
  const drawn = await repairFiles(
    THREE_DOC,
    [{ path: 'src/screens/Screen.tsx', defects: [defects[0]], create: false }],
    async (_system, user) => {
      if (/^Write a new file: /m.test(user)) { drawnAsks += 1; return 'this is not valid <<< typescript'; }
      return WANTS_THREE_ICONS;
    }
  );
  check('three graphics cost no calls at all', drawnAsks, 0);
  check('the file that wanted them survives', drawn.written.includes('src/screens/Screen.tsx'), true);
  check('and all three were drawn',
    ['AIcon', 'BIcon', 'CIcon'].filter((n) => !drawn.html.includes(`src/components/icons/${n}.tsx`)), []);
}


// --- the store travels with a wiring defect ---------------------------------
/*
 * A button that does nothing is fixed by giving it a handler, and a handler
 * writes state. The per-file repair sends ONE file, so the model was being asked
 * to wire a control to a store whose exported names it had never seen. It has
 * two options from there — invent a name, which fails to compile and reverts the
 * pass, or change nothing — and it changes nothing: `action-dead-runtime` was
 * handed to 93 passes over 30 days and cleared 5 times, and is still in the
 * document at the end of 84% of the runs that report it.
 *
 * So the store and the router ride along, as reading material, on the passes
 * that cannot succeed without them.
 */
const WIRED = `<!DOCTYPE html><html><body><div id="root"></div>
<script type="text/jsx" data-file="src/App.tsx">OLD APP</script>
<script type="text/jsx" data-file="src/screens/ListScreen.tsx">OLD LIST</script>
<script type="text/jsx" data-file="src/store/appStore.ts">export const addItem = () => {}</script>
<script type="text/jsx" data-file="src/routes.ts">export type ScreenId = 'list'</script>
<style data-file="src/styles/globals.css">:root{--a:1}</style>
</body></html>`;

const seen = [];
const capture = async (system, user) => { seen.push({ system, user }); return 'export default function S(){ return null }'; };

const dead = { id: 'action-dead-runtime', instruction: '保存ボタンが何もしません' };
const colour = { id: 'contrast-low', instruction: 'コントラストが足りません' };

seen.length = 0;
await repairFiles(WIRED, [{ path: 'src/screens/ListScreen.tsx', defects: [dead], create: false }], capture);
check('a wiring defect is shown the store', seen[0].user.includes('export const addItem'), true);
check('and the router', seen[0].user.includes("ScreenId = 'list'"), true);
check('marked as reading material', /REFERENCE ONLY/.test(seen[0].user), true);
/*
 * The file to return is named first and shown last, with everything it may only
 * read in between. Returning some other file is the single most common way a
 * repair is thrown away — 201 replies in 30 days.
 */
check('the file to edit is still named first',
  seen[0].user.startsWith('File: src/screens/ListScreen.tsx'), true);
check('and its contents come last',
  seen[0].user.lastIndexOf('--- current contents ---') > seen[0].user.indexOf('REFERENCE ONLY'), true);
// The model is told what happens if it invents a name, because that is the
// failure this change makes newly possible.
check('and is warned off inventing a symbol', /does not compile loses the whole pass/.test(seen[0].user), true);

/*
 * And on nothing else. Unconditionally this would put the store on all 27
 * repair calls a run makes, to be read by the 23 of them fixing a colour.
 */
seen.length = 0;
await repairFiles(WIRED, [{ path: 'src/screens/ListScreen.tsx', defects: [colour], create: false }], capture);
check('an ordinary defect is not shown the store', seen[0].user.includes('export const addItem'), false);
check('and carries no reference block', /REFERENCE ONLY/.test(seen[0].user), false);

// The store is reading material, not a target: rewritten badly it takes the
// whole project down rather than one screen, and the splice is all-or-nothing.
seen.length = 0;
const res2 = await repairFiles(WIRED, [{ path: 'src/store/appStore.ts', defects: [dead], create: false }], capture);
check('the store is never sent its own body twice',
  (seen[0].user.match(/export const addItem/g) ?? []).length, 1);
check('and repairing it still writes only it', res2.written, ['src/store/appStore.ts']);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
