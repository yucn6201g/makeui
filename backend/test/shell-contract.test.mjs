// Two ways a generated project compiles perfectly and is still not a usable mock.
//
// Both were measured on real `standard` runs of the same brief, and both were
// invisible to every existing check — because the code is correct. It is the
// product decision that is wrong, and no compiler has an opinion about that.
//
//   AUTH GATE (score 44, one screen rendered)
//     App.tsx:  if (!state.currentUser && route.screen !== 'login') { navigate('login'); return null }
//     store:    currentUser: null
//     Browser verification reported screens: [{id:'login'}] and could go no
//     further — getting past it needs credentials typed, which nothing it can
//     click will do. Nine screens existed and one was reachable.
//
//   SHELL WITHOUT NAVIGATION (all three runs measured, including the one that
//     rendered seven screens)
//     routes.ts exported NAV_ITEMS with nine entries; App.tsx rendered
//     `<header><h1>title</h1></header><main>{screen}</main>`. The navigation
//     contract was declared, typed and exported, and nothing put it on screen.
//
//   node test/shell-contract.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/interaction-audit.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/sc.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { auditShellContract, declaredScreenIds } = await import(pathToFileURL(path.join(root, 'dist/sc.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
// The first fence must start its own line — a fence is a whole line, so
// `<body>@@@makeui:file …` is not one and the reader drops that file silently.
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;

const ROUTES = `export type ScreenId = 'home' | 'list' | 'login';
export interface NavItem { id: ScreenId; label: string }
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'ホーム' },
  { id: 'list', label: '一覧' },
];`;

// Transcribed from the run that scored 44.
const GATED_SHELL = `import { useNavigation } from './hooks/useNavigation'
import { useApp } from './store/AppProvider'
import HomeScreen from './screens/HomeScreen'
import LoginScreen from './screens/LoginScreen'

export default function App() {
  const { route, navigate } = useNavigation()
  const { state } = useApp()

  if (!state.currentUser && route.screen !== 'login') {
    navigate('login')
    return null
  }

  return (
    <>
      <header className="header"><h1>備品在庫管理</h1></header>
      <main>{route.screen === 'login' ? <LoginScreen /> : <HomeScreen />}</main>
    </>
  )
}`;

const SIGNED_OUT_STORE = `const initialState: AppState = {
  currentUser: null,
  items: SEED_ITEMS,
};`;

const SIGNED_IN_STORE = `const DEMO_USER: User = { id: 'u1', name: '山田太郎' };
const initialState: AppState = {
  currentUser: DEMO_USER,
  items: SEED_ITEMS,
};`;

const NAV_SHELL = `import { NAV_ITEMS } from './routes'
import { useNavigation } from './hooks/useNavigation'
import HomeScreen from './screens/HomeScreen'

export default function App() {
  const { route, navigate } = useNavigation()
  return (
    <div className="app">
      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <a key={item.id} href={'#/' + item.id}
             aria-current={route.screen === item.id ? 'page' : undefined}>{item.label}</a>
        ))}
      </nav>
      <main><HomeScreen /></main>
    </div>
  )
}`;

const ids = (doc) => auditShellContract(doc, 'react').map((d) => d.id).sort();

// --- the auth gate ---------------------------------------------------------
check('a shell that redirects to login with nobody signed in is reported',
  ids(project(
    fence('src/App.tsx', GATED_SHELL),
    fence('src/routes.ts', ROUTES),
    fence('src/store/AppProvider.tsx', SIGNED_OUT_STORE),
  )).includes('auth-gate'), true);

// The same gate is fine once the mock starts signed in — the sign-in screen
// becomes somewhere you can go rather than somewhere you begin.
check('the same shell with a demo user already signed in is not',
  ids(project(
    fence('src/App.tsx', GATED_SHELL),
    fence('src/routes.ts', ROUTES),
    fence('src/store/AppProvider.tsx', SIGNED_IN_STORE),
  )).includes('auth-gate'), false);

// A login screen that is simply one of the screens is not a gate.
check('an app with a login screen and no redirect is left alone',
  ids(project(
    fence('src/App.tsx', NAV_SHELL),
    fence('src/routes.ts', ROUTES),
    fence('src/store/AppProvider.tsx', SIGNED_OUT_STORE),
  )).includes('auth-gate'), false);

// --- the missing navigation ------------------------------------------------
check('NAV_ITEMS declared and never rendered is reported',
  ids(project(
    fence('src/App.tsx', GATED_SHELL),
    fence('src/routes.ts', ROUTES),
    fence('src/store/AppProvider.tsx', SIGNED_IN_STORE),
  )), ['shell-without-nav']);

check('a shell that renders NAV_ITEMS is not',
  ids(project(
    fence('src/App.tsx', NAV_SHELL),
    fence('src/routes.ts', ROUTES),
    fence('src/store/AppProvider.tsx', SIGNED_IN_STORE),
  )), []);

// Putting the navigation in its own component is the better arrangement, not a
// worse one, so it must not be reported.
check('navigation extracted into a Sidebar component still counts',
  ids(project(
    fence('src/App.tsx', `import Sidebar from './components/ui/Sidebar'\nexport default function App() { return <div><Sidebar /><main /></div> }`),
    fence('src/components/ui/Sidebar.tsx', `import { NAV_ITEMS } from '../../routes'\nexport default function Sidebar() { return <nav>{NAV_ITEMS.map((i) => <a key={i.id} href={'#/' + i.id}>{i.label}</a>)}</nav> }`),
    fence('src/routes.ts', ROUTES),
    fence('src/store/AppProvider.tsx', SIGNED_IN_STORE),
  )), []);

// A project that declares no NAV_ITEMS is not asked about rendering them.
check('a project with no navigation contract is not judged on one',
  ids(project(
    fence('src/App.tsx', `export default function App() { return <main /> }`),
    fence('src/routes.ts', `export type ScreenId = 'home';`),
    fence('src/store/AppProvider.tsx', SIGNED_IN_STORE),
  )), []);

// --- the other frameworks fail the same way --------------------------------
check('a Vue shell without its navigation is reported',
  auditShellContract(project(
    fence('src/App.vue', `<template><header><h1>t</h1></header><main><HomeScreen /></main></template>\n<script setup lang="ts">\nimport HomeScreen from './screens/HomeScreen.vue'\n</script>`),
    fence('src/routes.ts', ROUTES),
  ), 'vue').map((d) => d.id), ['shell-without-nav']);

// --- a document that is not a project --------------------------------------
check('a plain document has no shell to judge',
  auditShellContract('<!DOCTYPE html><html><body><h1>hi</h1></body></html>', 'react'), []);

// --- the declared screens, in a file with no semicolons ------------------------
//
// `declaredScreenIds` read the union as "everything up to the next semicolon".
// Vue projects are written without them, so when the file had none anywhere the
// match failed and the project reported zero declared screens — measured at 47
// of the 147 stored documents that declare a union, 41 of them Vue.
//
// Zero is not a harmless miscount. It hands the walk no route list, so nothing
// is ever reported unreachable, and it takes `declaredScreens > 1` false, which
// skips the reach term entirely: no award, and no deduction however little of
// the application opens. The v194 Vue result scored 65 having opened three of
// its eight screens.
const routesDoc = (routes) => [
  '<!DOCTYPE html><html><body><div id="root"></div>',
  '@@@makeui:file src/routes.ts',
  routes,
  '@@@makeui:endfile',
  '</body></html>',
].join('\n');

check('a union with no semicolon is read',
  declaredScreenIds(routesDoc("export type ScreenId = 'home' | 'search' | 'detail'\n\nexport interface Route {\n  screen: ScreenId\n}")),
  ['home', 'search', 'detail']);

check('a union with one still is',
  declaredScreenIds(routesDoc("export type ScreenId = 'home' | 'search';\nexport const X = 1;")),
  ['home', 'search']);

// The statement ends where the pipes stop. `export` on the next line is a
// perfectly good identifier, and a pattern that merely collected tokens would
// swallow the rest of the file.
check('the declaration after it is not swallowed',
  declaredScreenIds(routesDoc("export type ScreenId = 'home'\n\nexport interface NavItem {\n  id: ScreenId\n}\n\nexport const NAV_ITEMS = []")),
  ['home']);

check('a union broken across lines with leading pipes is read',
  declaredScreenIds(routesDoc("type ScreenId =\n  | 'a'\n  | 'b'\n  | 'c'\n\nconst x = 1")),
  ['a', 'b', 'c']);

// A project with no union at all still answers, and answers empty rather than
// throwing — plain HTML output declares its screens in the markup.
check('no union is no screens', declaredScreenIds(routesDoc('export const NAV_ITEMS = []')), []);

// --- the nav instruction names what the project has ----------------------------
//
// "Iterate NAV_ITEMS and render a navigation" survived three repair passes at
// v144 and was still open on both React and Vue at v194. When a model does act
// on it, the corpus says what it writes: `href={item.hash}`, `item.screen`,
// `item.icon` — off elements carrying only `id` and `label`. Twelve stored
// documents do exactly that, and each renders a nav whose links go nowhere. So
// the two things it gets wrong are named.
const navDoc = (extra) => [
  '<!DOCTYPE html><html><body><div id="root"></div>',
  '@@@makeui:file src/routes.ts',
  "export type ScreenId = 'home' | 'list'",
  "export const NAV_ITEMS = [{ id: 'home', label: 'ホーム' }, { id: 'list', label: '一覧' }]",
  '@@@makeui:endfile',
  '@@@makeui:file src/App.tsx',
  'export default function App(){ return <div>x</div>; }',
  '@@@makeui:endfile',
  extra ?? '',
  '</body></html>',
].join('\n');

const swn = (doc) => auditShellContract(doc, 'react').find((d) => d.id === 'shell-without-nav');

check('a shell that never renders NAV_ITEMS is reported', Boolean(swn(navDoc())), true);
check('the keys the elements actually carry are named',
  /id と label だけです/.test(swn(navDoc()).instruction), true);
check('and the ones models invent are ruled out',
  /hash・href・screen・icon/.test(swn(navDoc()).instruction), true);

// The project's own navigation, named as it is written. Three shapes are in
// circulation and only one is a bare function.
const withNav = (body) => navDoc(['@@@makeui:file src/hooks/useNavigation.ts', body, '@@@makeui:endfile'].join('\n'));
check('a hook that returns navigate is named',
  /useNavigation\(\) が返す navigate/.test(
    swn(withNav('export function useNavigation() { const navigate = (s) => {}; return { navigate }; }')).instruction), true);
check('a default-exported hook too',
  /useNavigation\(\) が返す navigate/.test(
    swn(withNav('export default function useNavigation() { const navigate = (s) => {}; return { navigate }; }')).instruction), true);
check('a bare exported function is named directly',
  /navigate\(item\.id\) で行って/.test(
    swn(withNav('export function navigate(screen) {}')).instruction), true);

// A hook that returns no navigate must not be quoted: naming a call that does
// not exist is worse than the generic sentence. `useApp()` is a store hook on a
// project whose useNavigation is the one that navigates.
check('a hook with no navigate is not named',
  /各画面が既に使っているのと同じ仕組み/.test(
    swn(withNav('export function useApp() { return useContext(AppContext); }')).instruction), true);

// A shell that already navigates is not a shell without navigation.
//
// The finding claims 画面同士が行き来できない, and 58 of the 238 documents that
// raised it across the corpus had a working <nav> in the shell — hand-written
// instead of iterated from NAV_ITEMS. Not using the list is a contract
// violation; the sentence describing what it cost the user was false, and a
// repair round went on rebuilding navigation the document already had.
const shell = (app, extra) => [
  '<!DOCTYPE html><html><body><div id="root"></div>',
  '@@@makeui:file src/routes.ts',
  "export type ScreenId = 'home' | 'list'",
  "export const NAV_ITEMS = [{ id: 'home', label: 'ホーム' }, { id: 'list', label: '一覧' }]",
  '@@@makeui:endfile',
  '@@@makeui:file src/App.tsx',
  app,
  '@@@makeui:endfile',
  extra ?? '',
  '</body></html>',
].join('\n');

check('a hand-written nav covering every entry is left alone',
  Boolean(swn(shell('export default function App(){ return <nav><a href="#/home">ホーム</a><a href="#/list">一覧</a></nav>; }'))),
  false);
// `#/` is the home route, not a placeholder — a nav of `#/` and `#/list`
// covers both entries.
check('the root route counts as a destination',
  Boolean(swn(shell('export default function App(){ return <nav><a href="#/">ホーム</a><a href="#/list">一覧</a></nav>; }'))),
  false);
// `href="#"` is what a footer of 利用規約 / プライバシーポリシー links carries.
// Counting those would let three dead links clear a three-entry NAV_ITEMS.
check('placeholder hashes do not count',
  Boolean(swn(shell('export default function App(){ return <nav><a href="#">利用規約</a><a href="#">規約</a></nav>; }'))),
  true);
// Covering one of two is a real defect, but not the one the original sentence
// described — the links exist and a destination is missing from them.
const half = swn(shell('export default function App(){ return <nav><a href="#/home">ホーム</a></nav>; }'));
check('partial coverage is still reported', Boolean(half), true);
check('and says how much is reachable', /NAV_ITEMS は 2 個ありますが.*辿れるのは 1 個/.test(half.instruction), true);
check('rather than claiming there is no navigation',
  /描画されていません/.test(half.instruction), false);
// Navigation living in a Sidebar is the right thing to do, and the check has
// always looked one level down for it.
check('a nav component covering the entries is left alone',
  Boolean(swn(shell(
    'export default function App(){ return <Sidebar />; }',
    ['@@@makeui:file src/components/ui/Sidebar.tsx',
     'export function Sidebar(){ return <nav><a href="#/home">ホーム</a><a href="#/list">一覧</a></nav>; }',
     '@@@makeui:endfile'].join('\n')))),
  false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
