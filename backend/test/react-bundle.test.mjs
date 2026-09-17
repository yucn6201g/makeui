// Tests for compiling a generated React project into a runnable document.
//
// This is the code that decides whether browser verification looks at the real
// app or at a blank page. It ran for two weeks looking at a blank page and
// reported no defects, so "it returned something" is not a passing condition
// here — the assertions check that the JSX is gone, that imports point at real
// module ids, and that a project which cannot compile says so.
//
//   node test/react-bundle.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/react-bundle.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/rb.test.mjs')}"`,
  { stdio: 'inherit', cwd: root }
);
const { toRunnableDocument, isReactBundle, normalizeReactExtensions, addMissingBarrels, unresolvedImports, moduleDefects, destructuredKeyDefects, conditionalHookDefects, truncatedDocumentDefects, rootPropsNeverPassedDefects, requiredPropNeverPassedDefects, missingItemKeyDefects, frameworkConfusionDefects } = await import(
  pathToFileURL(path.join(root, 'dist/rb.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const block = (path, body) => `<script type="text/jsx" data-file="${path}">${body}</script>`;

const PROJECT = `<!DOCTYPE html><html><body><div id="root"></div>
${block('src/main.tsx', `
import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`)}
${block('src/App.tsx', `
import { useNavigation } from './hooks/useNavigation';
import ListScreen from './screens/ListScreen';
export default function App(): JSX.Element {
  const { route } = useNavigation();
  return <div className="shell">{route.screen === 'list' ? <ListScreen /> : <ListScreen />}</div>;
}
`)}
${block('src/routes.ts', `
export type ScreenId = 'list' | 'detail';
export interface NavItem { id: ScreenId; label: string }
export const NAV_ITEMS: NavItem[] = [{ id: 'list', label: '一覧' }, { id: 'detail', label: '詳細' }];
`)}
${block('src/hooks/useNavigation.ts', `
import { useState } from 'react';
import type { ScreenId } from '../routes';
const DEFAULT_ROUTE = { screen: 'list' as ScreenId };
export function useNavigation() {
  const [route] = useState<{ screen: ScreenId }>(DEFAULT_ROUTE);
  return { route };
}
`)}
${block('src/screens/ListScreen.tsx', `
export default function ListScreen(): JSX.Element { return <table><tbody><tr><td>行</td></tr></tbody></table>; }
`)}
<style data-file="src/styles/globals.css">:root{--accent:#0b6}</style>
</body></html>`;

// --- detection ------------------------------------------------------------
check('a React project is detected', isReactBundle(PROJECT), true);
check('a plain HTML mock is not', isReactBundle('<html><div data-screen="home">x</div></html>'), false);

let r = toRunnableDocument('<!DOCTYPE html><html><body><div data-screen="home">hi</div></body></html>');
check('plain HTML passes through untouched', r.compiled, false);
check('plain HTML keeps its own markup', r.html.includes('data-screen="home"'), true);

// --- compilation ----------------------------------------------------------
r = toRunnableDocument(PROJECT);
check('the project compiles', r.error, null);
check('nothing was left unresolved', r.warnings, []);

// JSX must actually be gone. A document that still contains `<App />` inside a
// module body was never transformed, and the browser would throw on it.
const bodies = r.html.slice(r.html.indexOf('var __defs'), r.html.indexOf('var __cache'));
check('JSX was transformed away', /<App\s*\/>|<div className/.test(bodies), false);
check('React calls were emitted', /createElement|jsx/.test(bodies), true);

// Imports must point at ids the registry actually holds.
// Sucrase keeps the source's quote style, so match either.
const requires = (id) => new RegExp(`require\\((["'])${id.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\1\\)`).test(bodies);
check('relative import resolved to a module id', requires('src/App.tsx'), true);
check('extensionless hop resolved', requires('src/hooks/useNavigation.ts'), true);
check('bare react specifier left alone', /require\(["']react-dom\/client["']\)/.test(bodies), true);
check('no unresolved throw stubs', bodies.includes('Module not found'), false);

// The page has to be able to start on its own.
check('React is inlined, not fetched', r.html.includes('<script src'), false);
check('React UMD is present', r.html.includes('react.production.min.js') || r.html.length > 100_000, true);
check('the entry is required', r.html.includes('require("src/main.tsx")'), true);
check('CSS travelled with it', r.html.includes('--accent:#0b6'), true);
// DEFAULT_ROUTE wins over NAV_ITEMS[0]; here both say list, so the union follows.
check('routes are offered in order', r.html.includes('["#/list","#/detail"]'), true);

// --- failure modes --------------------------------------------------------
r = toRunnableDocument(`<html><body>${block('src/main.tsx', 'export default function X( { return <a/>; }')}</body></html>`);
check('a syntax error is reported, not thrown', r.error !== null && r.html === '', true);
check('the error names the file', r.error.startsWith('src/main.tsx:'), true);

r = toRunnableDocument(`<html><body>${block('src/App.tsx', 'export default function App(){ return <b/>; }')}</body></html>`);
check('a project with no entry point is reported', /エントリーポイント/.test(r.error), true);

// An import of a file that is not in the project must not silently bind.
r = toRunnableDocument(`<html><body>
${block('src/main.tsx', `import App from './App';\nimport { gone } from './lib/missing';\nApp; gone;`)}
${block('src/App.tsx', 'export default function App(){ return <b/>; }')}
</body></html>`);
check('a missing module is warned about', r.warnings.length, 1);
check('and throws where it is used', r.html.includes('Module not found'), true);

// A .ts file carrying JSX is a generation mistake that must not fail the render.
r = toRunnableDocument(`<html><body>
${block('src/main.tsx', `import P from './store/Provider';\nP;`)}
${block('src/store/Provider.ts', 'export default function P(){ return <i/>; }')}
</body></html>`);
check('JSX in a .ts file still compiles', r.error, null);
check('and is recorded as a warning', /\.tsx にすべき/.test(r.warnings[0] ?? ''), true);

// --- .ts files holding JSX -------------------------------------------------
// The contract says JSX belongs in .tsx. Generation breaks it often enough that
// the preview grew a retry and showed the user a warning about a rule they did
// not write; the exported project shipped a file tsc refuses.
const MIXED = `<html><body>
${block('src/main.tsx', `import P from './store/Provider';\nP;`)}
${block('src/store/Provider.ts', 'export default function P(){ return <i/>; }')}
${block('src/lib/format.ts', 'export const f = (n: number): string => String(n);')}
${block('src/lib/broken.ts', 'export const g = (((;')}
</body></html>`;

let n = normalizeReactExtensions(MIXED);
check('a .ts holding JSX is renamed', n.renamed, ['src/store/Provider.ts → src/store/Provider.tsx']);
check('the rename is applied to the document', n.html.includes('data-file="src/store/Provider.tsx"'), true);
check('and the old path is gone', n.html.includes('data-file="src/store/Provider.ts"'), false);
check('plain TypeScript is left alone', n.html.includes('data-file="src/lib/format.ts"'), true);
// A file that fails both ways is broken, not misnamed — renaming would hide it.
check('a file broken either way is not renamed', n.html.includes('data-file="src/lib/broken.ts"'), true);
check('file bodies are untouched', n.html.includes('return <i/>'), true);

// Imports omit extensions, which is exactly why the rename needs no other edits.
// Checked on a project without the deliberately-broken file, which would fail
// compilation for its own reasons and prove nothing about the rename.
const MIXED_OK = `<html><body>
${block('src/main.tsx', `import P from './store/Provider';\nP;`)}
${block('src/store/Provider.ts', 'export default function P(){ return <i/>; }')}
</body></html>`;
const fixed = normalizeReactExtensions(MIXED_OK);
check('imports still resolve after the rename', toRunnableDocument(fixed.html).error, null);
check('and the renamed module is in the registry',
  /require\((["'])src\/store\/Provider\.tsx\1\)/.test(toRunnableDocument(fixed.html).html), true);
check('with no unresolved warning', toRunnableDocument(fixed.html).warnings, []);

// Before the rename the same project compiles too — via the retry — but records
// the warning that was reaching the user.
check('the unnormalised project warns instead', toRunnableDocument(MIXED_OK).warnings.length, 1);

check('a plain HTML page is not touched', normalizeReactExtensions('<html><body>hi</body></html>').renamed, []);
check('a project with nothing to fix reports nothing', normalizeReactExtensions(PROJECT).renamed, []);

// --- imports that will not resolve ----------------------------------------
// Asked before a document is committed, by everything that writes files. It has
// to answer the same way the bundler does, or it is either rejecting projects
// that would have run or passing ones that will not.
const withFiles = (...blocks) => `<html><body>${blocks.join('\n')}</body></html>`;

check('a project with sound imports has none', unresolvedImports(PROJECT), []);
check('a plain HTML mock is not walked', unresolvedImports('<html><body>hi</body></html>'), []);

check('a missing sibling is reported',
  unresolvedImports(withFiles(
    block('src/components/ui/Header.tsx', `import UserIcon from '../icons/UserIcon';\nUserIcon;`),
    block('src/components/icons/HomeIcon.tsx', 'export default function H(){ return <svg/>; }')
  )),
  [{ importer: 'src/components/ui/Header.tsx', spec: '../icons/UserIcon' }]);

check('a sibling that exists is not',
  unresolvedImports(withFiles(
    block('src/components/ui/Header.tsx', `import UserIcon from '../icons/UserIcon';\nUserIcon;`),
    block('src/components/icons/UserIcon.tsx', 'export default function U(){ return <svg/>; }')
  )), []);

// A directory with no index does not resolve — which is exactly why
// addMissingBarrels runs before anything asks this question.
check('a folder without a barrel does not resolve',
  unresolvedImports(withFiles(
    block('src/App.tsx', `import { UserIcon } from './components/icons';\nUserIcon;`),
    block('src/components/icons/UserIcon.tsx', 'export default function U(){ return <svg/>; }')
  )).length, 1);
check('and resolves once the barrel is added',
  unresolvedImports(addMissingBarrels(withFiles(
    block('src/App.tsx', `import { UserIcon } from './components/icons';\nUserIcon;`),
    block('src/components/icons/UserIcon.tsx', 'export default function U(){ return <svg/>; }')
  )).html), []);

// Bare specifiers are packages, not project files, and are none of this check's
// business — flagging 'react' would revert every file in the project.
check('a package import is ignored',
  unresolvedImports(withFiles(block('src/App.tsx', `import { useState } from 'react';\nuseState;`))), []);

// Assets are not modules, and the transform already knows it: rewriteRequires
// turns them into `({})`. Reporting them here made this stricter than the
// bundler it exists to predict, and a repair that correctly added a stylesheet
// import to Footer.tsx was reverted for it — measured in real use.
check('a stylesheet import is not a missing module',
  unresolvedImports(withFiles(block('src/components/Footer.tsx', `import '../styles/tokens.css';\nexport const F = 1;`))), []);
check('nor is an image import',
  unresolvedImports(withFiles(block('src/App.tsx', `import logo from './assets/logo.svg';\nlogo;`))), []);
// And the transform agrees, which is the property that matters.
check('the transform does not complain about it either',
  toRunnableDocument(withFiles(
    block('src/main.tsx', `import './styles/tokens.css';\nimport App from './App';\nApp;`),
    block('src/App.tsx', 'export default function App(){ return <b/>; }')
  )).warnings, []);
// A missing *source* file is still reported.
check('a missing source module is still checked',
  unresolvedImports(withFiles(block('src/main.tsx', `import './lib/nothing';`))).length, 1);

// This must agree with the transform, which is the thing that actually runs.
// A disagreement in either direction is a bug: rejecting what would have run,
// or passing what will not.
const MISSING = withFiles(
  block('src/main.tsx', `import App from './App';\nApp;`),
  block('src/App.tsx', `import X from './widgets/X';\nexport default function App(){ return <X/>; }`)
);
check('it agrees with the transform about a missing module',
  [unresolvedImports(MISSING).length, toRunnableDocument(MISSING).warnings.length], [1, 1]);
check('and about a sound one',
  [unresolvedImports(PROJECT).length, toRunnableDocument(PROJECT).warnings.length], [0, 0]);

// --- the defect it turns into ---------------------------------------------
// The repair planner works from defect text. A stack trace under the heading
// "console-error" did not tell it the fix was to write one file, and a
// six-screen application shipped blank as a result. This says so directly.
check('a sound project produces no defect', moduleDefects(PROJECT), []);
check('a plain HTML mock produces none', moduleDefects('<html><body>hi</body></html>'), []);

const BROKEN = withFiles(
  block('src/main.tsx', `import App from './App';\nApp;`),
  block('src/App.tsx', `import Header from './components/ui/Header';\nexport default function App(){ return <Header/>; }`),
  block('src/components/ui/Header.tsx', `import UserIcon from '../icons/UserIcon';\nexport default function H(){ return <UserIcon/>; }`),
  block('src/components/icons/HomeIcon.tsx', 'export default function I(){ return <svg/>; }')
);
let md = moduleDefects(BROKEN);
check('a missing module is one defect', md.length, 1);
check('under a name the repair loop can converge on', md[0].id, 'import-missing');
check('it names the file that imports', md[0].instruction.includes('src/components/ui/Header.tsx'), true);
check('and the specifier that is missing', md[0].instruction.includes("'../icons/UserIcon'"), true);
// Deleting the import makes the error go away and the icon go away with it.
check('it forbids the cheap fix', /import を消して/.test(md[0].instruction), true);

// A folder import whose barrel has not been written yet is not a defect: the
// pipeline adds barrels, so reporting it would send the repair after a problem
// that does not survive to the output.
check('a folder import awaiting its barrel is not reported',
  moduleDefects(withFiles(
    block('src/main.tsx', `import { A } from './components/icons';\nA;`),
    block('src/components/icons/A.tsx', 'export default function A(){ return <svg/>; }')
  )), []);


// --- a name destructured out of something that never had it ---------------------
//
// Both halves are valid on their own and they live in different files, so the
// project parses, compiles, bundles, and throws a TypeError on first render.
// Measured at v176 on two of six runs, in two different frameworks:
//
//   Vue     const { state, toast } = useStore()   // returns { state, dispatch }
//   Svelte  let { currentToast } = $derived.by(() => ({ message: … }))
//
// Reported rather than repaired: the two want opposite fixes — the Svelte one
// should lose its braces, the Vue one wants `state.toast` — and choosing means
// knowing what the author meant.
const dkDoc = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;
const dkFence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const dkFires = (...blocks) => destructuredKeyDefects(dkDoc(...blocks)).length > 0;

const STORE = dkFence('src/store/index.ts',
  `const state = { toast: { visible: false } };\nfunction dispatch() {}\nexport function useStore() {\n  return { state, dispatch }\n}`);

check('a key the factory never returns, dereferenced in markup',
  dkFires(STORE, dkFence('src/App.vue',
    `<template><Toast v-if="toast.visible" /></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst { state, toast } = useStore()\n</script>`)),
  true);

// The instruction has to name the file, the name and what IS on offer — that is
// the part a repair pass cannot work out for itself.
const dkMsg = destructuredKeyDefects(dkDoc(STORE, dkFence('src/App.vue',
  `<template><Toast v-if="toast.visible" /></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst { state, toast } = useStore()\n</script>`)))[0].instruction;
check('the missing name is quoted', /`toast`/.test(dkMsg), true);
check('and what the factory does return', /\{ state, dispatch \}/.test(dkMsg), true);

// A name that IS returned is ordinary code.
check('a key the factory does return is fine',
  dkFires(STORE, dkFence('src/App.vue',
    `<template><div>{{ state.toast.visible }}</div></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst { state } = useStore()\n</script>`)),
  false);

// Nothing reads through it, so nothing breaks — an unused binding is not a
// blank page, and reporting it would spend a repair pass on tidiness.
check('an unused destructured name is not reported',
  dkFires(STORE, dkFence('src/App.vue',
    `<template><div>ok</div></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst { state, toast } = useStore()\n</script>`)),
  false);

// A spread means the object carries names this cannot see from the text.
check('a spread in the returned object silences it',
  dkFires(dkFence('src/store/index.ts', `export function useStore() {\n  return { ...base, dispatch }\n}`),
    dkFence('src/App.vue',
      `<template><Toast v-if="toast.visible" /></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst { toast } = useStore()\n</script>`)),
  false);

// Svelte's dialect, where the factory is inline and there is no other module.
check('a destructured rune whose literal lacks the key',
  dkFires(dkFence('src/App.svelte',
    `<script lang="ts">\n  let { currentToast } = $derived.by(() => {\n    return { message: appState.toast };\n  });\n</script>\n{#if currentToast.message}<Toast />{/if}`)),
  true);

check('the same rune when the key matches',
  dkFires(dkFence('src/App.svelte',
    `<script lang="ts">\n  let { currentScreen } = $derived.by(() => {\n    return { currentScreen: route().screen };\n  });\n</script>\n<div>{currentScreen.id}</div>`)),
  false);

// The concise arrow form returns the literal directly.
check('the parenthesised arrow form is read too',
  dkFires(dkFence('src/App.svelte',
    `<script lang="ts">\n  let { toast } = $derived(() => ({ message: 'hi' }));\n</script>\n{#if toast.message}<b/>{/if}`)),
  true);


// --- a hook called inside a branch ---------------------------------------------
//
//   if (state.ui.modalType === 'rejection') {
//     const [reason, setReason] = React.useState('');
//
//   Minified React error #310 — rendered more hooks than during the previous
//
// React pairs hooks with their state by call order, so a hook behind a condition
// shifts every hook after it the moment the condition flips. The screen works on
// load and dies mid-interaction, which is the expensive kind of broken.
// Measured at v177 on a modal that declared each branch's state inside the
// branch. Reported rather than hoisted: whether it CAN be hoisted depends on
// what it closes over.
const hookDoc = (body) => dkDoc(dkFence('src/components/ui/Modal.tsx', body));
const hookFires = (body) => conditionalHookDefects(hookDoc(body)).length > 0;

check('a hook inside an if is reported', hookFires(
  `export default function Modal() {\n` +
  `  const { state } = useApp();\n` +
  `  if (state.ui.modalType === 'rejection') {\n` +
  `    const [reason, setReason] = React.useState('');\n` +
  `    return <div>{reason}</div>;\n` +
  `  }\n` +
  `  return null;\n}`), true);

// The instruction has to name the hook and the branch it sits in.
const hookMsg = conditionalHookDefects(hookDoc(
  `export default function Modal() {\n` +
  `  if (state.ui.modalType === 'rejection') {\n` +
  `    const [reason, setReason] = React.useState('');\n` +
  `  }\n}`))[0].instruction;
check('the hook is named', /useState\(\)/.test(hookMsg), true);
check('and the condition it is inside', /modalType === 'rejection'/.test(hookMsg), true);

// Hooks at the top of a component are the normal case and must stay silent.
check('top-level hooks are fine', hookFires(
  `export default function Panel() {\n` +
  `  const [open, setOpen] = useState(false);\n` +
  `  const ref = useRef(null);\n` +
  `  useEffect(() => { setOpen(true); }, []);\n` +
  `  if (!open) return null;\n` +
  `  return <div ref={ref} />;\n}`), false);

// A conditional INSIDE a hook callback is ordinary code, not a conditional hook.
check('a branch inside an effect is fine', hookFires(
  `export default function Panel() {\n` +
  `  const [n, setN] = useState(0);\n` +
  `  useEffect(() => {\n` +
  `    if (n > 2) { setN(0); }\n` +
  `  }, [n]);\n` +
  `  return null;\n}`), false);

// A loop is the same rule.
check('a hook inside a loop is reported', hookFires(
  `export default function List() {\n` +
  `  for (const x of items) {\n` +
  `    const [v] = useState(x);\n` +
  `  }\n` +
  `  return null;\n}`), true);


// --- a response that stopped in the middle of a file ---------------------------
//
// The transport counts its own fences, so this is arithmetic, not a guess.
// Measured at v178: a Vue project that got as far as App.vue's <script setup>
// and stopped, leaving the block to swallow the document's own </body></html>.
// The compiler calls that `Invalid end tag`, which sends the repair pass after a
// markup bug in a file whose real problem is that it is half there.
const truncDoc = `<!DOCTYPE html><html><body>
@@@makeui:file src/main.ts
import App from './App.vue';
@@@makeui:endfile
@@@makeui:file src/App.vue
<template><div>x</div></template>
</body></html>`;
check('an unclosed final file is reported', truncatedDocumentDefects(truncDoc).length, 1);
const truncMsg = truncatedDocumentDefects(truncDoc)[0].instruction;
check('the counts are stated', /開始 2 件.*終了 1 件/.test(truncMsg), true);
check('the unfinished file is named', /src\/App\.vue/.test(truncMsg), true);
// The instruction has to steer away from the compiler's account of it.
check('it says not to chase the markup', /構文の誤りではなく/.test(truncMsg), true);

check('a complete document is not reported',
  truncatedDocumentDefects(dkDoc(dkFence('src/main.ts', 'x'), dkFence('src/App.vue', 'y'))).length, 0);
check('a document with no fences is not reported',
  truncatedDocumentDefects('<!DOCTYPE html><html><body><div id="root"></div></body></html>').length, 0);


// --- a root component waiting for props nothing can pass -----------------------
//
//   // src/main.ts
//   mount(App, { target: document.getElementById('root') });
//   // src/App.svelte
//   let { currentRoute } = $props();
//   {#if currentRoute.screen === 'feed'}
//
// The root has no parent, so nothing above it can ever supply the value — which
// is what separates this from an ordinary missing prop. Undefined on every
// render, and the first dereference blanks the app. Measured at v181; the same
// file imported a `route` store it then never used.
const rootDoc = (main, app) => dkDoc(dkFence('src/main.ts', main), dkFence('src/App.svelte', app));
const MOUNT_BARE = "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });";
const APP_PROPS = "<script>\n  let { currentRoute } = $props();\n</script>\n{#if currentRoute.screen === 'feed'}<Feed />{/if}";

check('a root prop the entry never passes is reported',
  rootPropsNeverPassedDefects(rootDoc(MOUNT_BARE, APP_PROPS)).length, 1);
const rootMsg = rootPropsNeverPassedDefects(rootDoc(MOUNT_BARE, APP_PROPS))[0].instruction;
check('the prop is named', /`currentRoute`/.test(rootMsg), true);
check('both files are named', /src\/App\.svelte/.test(rootMsg) && /src\/main\.ts/.test(rootMsg), true);

// The entry that does pass them is ordinary.
check('a mount with props is fine',
  rootPropsNeverPassedDefects(rootDoc(
    "mount(App, { target: document.getElementById('root'), props: { currentRoute: r } });", APP_PROPS)).length, 0);

// An unused prop declaration is untidy, not broken — a repair pass spent on it
// would be worse than leaving it.
check('a prop that is never dereferenced is not reported',
  rootPropsNeverPassedDefects(rootDoc(MOUNT_BARE,
    "<script>\n  let { currentRoute } = $props();\n</script>\n<div>hello</div>")).length, 0);

// A root that reads its state from a module has no props to miss.
check('a root without props is fine',
  rootPropsNeverPassedDefects(rootDoc(MOUNT_BARE,
    "<script>\n  import { route } from './lib/nav';\n</script>\n{#if route().screen === 'feed'}<Feed />{/if}")).length, 0);


// --- the same missing key, read as a property instead of destructured ----------
//
//   const store = useStore()          // returns { state, toggleFavorite, … }
//   <span v-if="store.favorites.length">
//
// `favorites` lives under `state`, so `store.favorites` is undefined and
// `.length` throws. Measured at v189, where it blanked a Vue project that had
// nothing else wrong with it — five screens, icons, a real store.
const PROP_STORE = dkFence('src/store/index.ts',
  'const state = { favorites: [] };\nfunction toggleFavorite() {}\nexport function useStore() {\n  return { state, toggleFavorite }\n}');
const propAccess = destructuredKeyDefects(dkDoc(PROP_STORE, dkFence('src/App.vue',
  `<template><span>{{ store.favorites.length }}</span></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst store = useStore()\n</script>`)));
check('a property the factory does not provide is reported', propAccess.length, 1);
check('the access is named', /`store\.favorites`/.test(propAccess[0].instruction), true);

// A key it does provide is ordinary code.
check('a provided key is fine',
  destructuredKeyDefects(dkDoc(PROP_STORE, dkFence('src/App.vue',
    `<template><span>{{ store.state.favorites.length }}</span></template>\n<script setup lang="ts">\nimport { useStore } from './store'\nconst store = useStore()\n</script>`))).length, 0);

// A getter provides a key too. `useNavigation()` returning `get route() { … }`
// was read as providing no `route`, so a project that worked perfectly reported
// a missing key on every pass — budget spent on nothing.
check('a getter counts as provided',
  destructuredKeyDefects(dkDoc(
    dkFence('src/lib/nav.ts', 'export function useNavigation() {\n  return {\n    get route() { return current; },\n    navigate() {},\n  }\n}'),
    dkFence('src/App.tsx', "import { useNavigation } from './lib/nav';\nconst nav = useNavigation();\nconst id = nav.route.screen;"))).length, 0);

// The function's OWN return, not the first one inside it. `useNavigation` opens
// with a `parseHash` helper returning `{ screen }`, and taking that as the
// hook's contract made every real key look missing.
check('a nested helper return is not the contract',
  destructuredKeyDefects(dkDoc(
    dkFence('src/lib/nav.ts', 'export function useNavigation() {\n  function parseHash() {\n    return { screen: "a" };\n  }\n  return { screen: parseHash().screen, navigate() {} }\n}'),
    dkFence('src/App.tsx', "import { useNavigation } from './lib/nav';\nconst nav = useNavigation();\nnav.navigate();"))).length, 0);

// `navigation.params?.id` says the author knows it can be absent, and the chain
// short-circuits rather than throwing.
check('an optional-chained access is not reported',
  destructuredKeyDefects(dkDoc(
    dkFence('src/lib/nav.ts', 'export function useNavigation() {\n  return { screen: "a" }\n}'),
    dkFence('src/App.tsx', "import { useNavigation } from './lib/nav';\nconst nav = useNavigation();\nconst id = nav.params?.id;"))).length, 0);


// --- a prop the child requires and the parent never passes ---------------------
//
//   // src/screens/SearchScreen.svelte
//   let { navigate } = $props<{ navigate: (s: ScreenId) => void }>();
//   // src/App.svelte
//   <SearchScreen />
//   TypeError: $$props.navigate is not a function
//
// Measured at v189: App held `navigate` from useNavigation() and handed it to
// none of its five screens, every one of which declared it required. Five
// console errors and a score of 30 on a project that was otherwise complete.
const rpDoc = (...b) => dkDoc(...b);
const CHILD = dkFence('src/screens/SearchScreen.svelte',
  "<script lang=\"ts\">\n  let { navigate } = $props<{ navigate: (s: string) => void }>();\n</script>\n<button onclick={() => navigate('list')}>go</button>");

check('a required prop the parent omits is reported',
  requiredPropNeverPassedDefects(rpDoc(CHILD, dkFence('src/App.svelte',
    "<script lang=\"ts\">\n  import SearchScreen from './screens/SearchScreen.svelte';\n</script>\n<SearchScreen />"))).length, 1);
check('passing it explicitly is fine',
  requiredPropNeverPassedDefects(rpDoc(CHILD, dkFence('src/App.svelte',
    "<script lang=\"ts\">\n  import SearchScreen from './screens/SearchScreen.svelte';\n  const navigate = () => {};\n</script>\n<SearchScreen navigate={navigate} />"))).length, 0);

// Svelte's shorthand is an attribute. Missing this fired on thirty-three of a
// hundred and thirty stored documents, one of which scored 79 with no errors.
check('the Svelte shorthand counts as passing',
  requiredPropNeverPassedDefects(rpDoc(CHILD, dkFence('src/App.svelte',
    "<script lang=\"ts\">\n  const navigate = () => {};\n</script>\n<SearchScreen {navigate} />"))).length, 0);
check('a spread may carry it, so it is left alone',
  requiredPropNeverPassedDefects(rpDoc(CHILD, dkFence('src/App.svelte', '<SearchScreen {...props} />'))).length, 0);

// An attribute value can contain `>`. Stopping at the first one cut the tag
// short and read every attribute after it as absent.
const CARD = dkFence('src/components/PropertyCard.tsx',
  'export function PropertyCard({ onToggle }) { return <button onClick={() => onToggle()} />; }');
check('an arrow in an earlier attribute does not hide a later one',
  requiredPropNeverPassedDefects(rpDoc(CARD, dkFence('src/screens/List.tsx',
    'export default () => <PropertyCard onClick={() => go()} onToggle={() => t()} />;'))).length, 0);

// A default or a `?` makes it optional, and an unused declaration is untidy
// rather than broken.
check('a prop with a default is optional',
  requiredPropNeverPassedDefects(rpDoc(
    dkFence('src/components/Badge.svelte', "<script lang=\"ts\">\n  let { tone = 'plain' } = $props();\n</script>\n<b>{tone.length}</b>"),
    dkFence('src/App.svelte', '<Badge />'))).length, 0);
check('a declared but unused prop is not reported',
  requiredPropNeverPassedDefects(rpDoc(
    dkFence('src/components/Badge.svelte', "<script lang=\"ts\">\n  let { tone } = $props();\n</script>\n<b>x</b>"),
    dkFence('src/App.svelte', '<Badge />'))).length, 0);

// `children` is passed by the element's body, not by an attribute. This looked
// for a `children=` attribute, found none, and reported the parent — 31 of the
// 78 findings across the corpus, every one on a `<Button>` or `<Shell>` whose
// body was sitting right there in the markup.
const BUTTON = dkFence('src/components/ui/Button.svelte',
  "<script lang=\"ts\">\n  let { variant = 'primary', children } = $props();\n</script>\n<button class={variant}>{@render children()}</button>");
check('an element body passes children',
  requiredPropNeverPassedDefects(rpDoc(BUTTON, dkFence('src/screens/Detail.svelte',
    '<Button variant="primary" onclick={add}>カートに追加</Button>'))).length, 0);
// React spells it the same way.
const CARD2 = dkFence('src/components/ui/Panel.tsx',
  'export function Panel({ children }) { return <section>{children.length}</section>; }');
check('and in React too',
  requiredPropNeverPassedDefects(rpDoc(CARD2, dkFence('src/screens/Home.tsx',
    'export default () => <Panel>本文</Panel>;'))).length, 0);
// A component whose whole job is to render what it wraps, given nothing to
// wrap, renders an empty control — so the self-closing form still reports.
check('a self-closing tag passes nothing',
  requiredPropNeverPassedDefects(rpDoc(BUTTON, dkFence('src/screens/Detail.svelte',
    '<Button variant="primary" />'))).length, 1);
// The exemption is for `children` alone — a sibling prop is still missing.
const LABELLED = dkFence('src/components/ui/Field.svelte',
  "<script lang=\"ts\">\n  let { label, children } = $props();\n</script>\n<label>{label.trim()}{@render children()}</label>");
check('a body does not excuse the other props',
  requiredPropNeverPassedDefects(rpDoc(LABELLED, dkFence('src/screens/Form.svelte',
    '<Field><input /></Field>'))).length, 1);

// A missing project file and a missing framework module need opposite repairs.
// The instruction said 「不足しているファイルを新規作成してください」 and
// 「import を消して解決するのは避けてください」 for everything in the list — and
// for `$app/navigation`, SvelteKit's runtime and three of the ten corpus
// findings, both halves are wrong: the module cannot be written, and deleting
// the import is exactly the repair.
const imports = (body) =>
  moduleDefects(withFiles(
    block('src/main.ts', "import App from './App.svelte';\nApp;"),
    block('src/App.svelte', "<script>import { go } from './lib/navigation.svelte';</script>"),
    block('src/lib/navigation.svelte.ts', body)
  ))[0]?.instruction ?? '';
const localMiss = imports("import ProductCard from '../components/ui/ProductCard.svelte'");
check('a relative specifier is a file to create', /新規作成/.test(localMiss), true);
check('and not one to delete', /その import を削除/.test(localMiss), false);
const pkgMiss = imports("import { goto } from '$app/navigation'");
check('a package specifier is one to delete', /その import を削除/.test(pkgMiss), true);
check('and not one to create', /新規作成/.test(pkgMiss), false);
// Both kinds in one document get both halves, each naming its own specifiers.
const both = imports(
  "import { goto } from '$app/navigation'\nimport Card from '../components/ui/Card.svelte'"
);
check('both kinds are separated', /新規作成/.test(both) && /その import を削除/.test(both), true);

// --- a loop reading a key its own data never carries ---------------------------
//
// Measured on a v191 Svelte result that scored 50 with a clean console: the nav
// bound `href={item.hash}` over elements of `{ id, label }`, every anchor
// rendered without an href, and two screens became unreachable. Nothing static
// saw it — the walk reported two dead nav items, which names the symptom.
const navDoc = (items, markup, ext = 'svelte') => [
  '<!DOCTYPE html><html><body><div id="root"></div>',
  '@@@makeui:file src/routes.ts',
  `export const NAV_ITEMS = [${items}];`,
  '@@@makeui:endfile',
  `@@@makeui:file src/App.${ext}`,
  markup,
  '@@@makeui:endfile',
  '</body></html>',
].join('\n');

const HASH = navDoc(
  "{ id: 'a', label: '検索' }, { id: 'b', label: '結果' }",
  "{#each NAV_ITEMS as item (item.id)}<a href={item.hash}>{item.label}</a>{/each}"
);
check('a key the elements never define is reported',
  missingItemKeyDefects(HASH).map((d) => d.id), ['item-key-missing']);
check('the property and the keys that do exist are both named',
  /item\.hash/.test(missingItemKeyDefects(HASH)[0].instruction)
    && /id, label/.test(missingItemKeyDefects(HASH)[0].instruction), true);

check('a key they do define is not',
  missingItemKeyDefects(navDoc(
    "{ id: 'a', label: '検索', hash: '#/a' }",
    "{#each NAV_ITEMS as item}<a href={item.hash}>{item.label}</a>{/each}")), []);

// Vue and React reach the same elements by different syntax.
check('v-for is read the same way',
  missingItemKeyDefects(navDoc(
    "{ id: 'a', label: 'x' }",
    '<a v-for="item in NAV_ITEMS" :href="item.hash">{{ item.label }}</a>', 'vue'
  )).length, 1);
check('map is read the same way',
  missingItemKeyDefects(navDoc(
    "{ id: 'a', label: 'x' }",
    'export default () => <>{NAV_ITEMS.map((item) => <a href={item.hash}>{item.label}</a>)}</>', 'tsx'
  )).length, 1);

// A read belonging to a different loop in the same file is a different object.
// `item` is the name everything picks: measured across the corpus, this was most
// of what a whole-file search reported.
check('a read outside the loop is not attributed to it',
  missingItemKeyDefects(navDoc(
    "{ id: 'a', label: 'x' }",
    'export default () => { const n = cart.reduce((s, item) => s + item.qty, 0);\n' +
    'return <>{NAV_ITEMS.map((item) => <a>{item.label}</a>)}{n}</>; }', 'tsx'
  )), []);

// A name that is the tail of a longer one must not borrow its loop: `ITEMS`
// matched inside `NAV_ITEMS.map(` and reported four defects in a correct file.
check('a longer name is not matched by its tail',
  missingItemKeyDefects([
    '<!DOCTYPE html><html><body><div id="root"></div>',
    '@@@makeui:file src/routes.ts',
    "export const ITEMS = [{ id: 'x', price: 1 }];",
    "export const NAV_ITEMS = [{ id: 'a', label: 'x' }];",
    '@@@makeui:endfile',
    '@@@makeui:file src/App.tsx',
    'export default () => <>{NAV_ITEMS.map((item) => <a>{item.label}</a>)}</>;',
    '@@@makeui:endfile',
    '</body></html>',
  ].join('\n')), []);

// The literal has to be the whole contract before a read of it can be wrong.
check('a spread in the literal declines',
  missingItemKeyDefects(navDoc(
    "...BASE, { id: 'a', label: 'x' }",
    "{#each NAV_ITEMS as item}<a href={item.hash}>{item.label}</a>{/each}")), []);

// Optional in the type, not only in the pattern.
//
//     let { label, value, delta } = $props<{ label: string; delta?: number }>();
//     {#if delta !== undefined}{delta.toFixed(1)}%{/if}
//
// The pattern says `delta` and the type says `delta?`. Reported at v204 on a
// component that declares the prop optional and guards every use of it, called
// correctly by a parent that omits it. Across the corpus this took the detector
// from 28 findings to 21; the seven it dropped were all this shape.
const optionalDoc = rpDoc(
  dkFence('src/components/ui/KPICard.svelte',
    '<script lang="ts">\n' +
    '  let { label, value, delta } = $props<{\n' +
    '    label: string;\n' +
    '    value: string;\n' +
    '    delta?: number;\n' +
    '  }>();\n' +
    '</script>\n' +
    '<div>{label}{value}{#if delta !== undefined}{delta.toFixed(1)}{/if}</div>'),
  dkFence('src/screens/HomeScreen.svelte',
    '<KPICard label="売上" value="¥1,200" />')
);
check('a prop the type marks optional is not required',
  requiredPropNeverPassedDefects(optionalDoc).length, 0);

// The same component with the `?` removed is the finding this exists for.
const requiredDoc = optionalDoc.replace('delta?: number', 'delta: number');
check('and without the ? it is required again',
  requiredPropNeverPassedDefects(requiredDoc).length, 1);
check('and the finding names the prop',
  /delta/.test(requiredPropNeverPassedDefects(requiredDoc)[0].instruction), true);

// --- React written in a Svelte or Vue file ------------------------------------
//
// The one remaining Svelte failure in the corpus after every deterministic
// repair, measured 2026-08-28: an early return with markup in it, which is the
// most recognisable React habit there is. A detector rather than a fixup —
// turning it into `{#if}` means deciding where the conditional ends and what
// the other branch renders, and a wrong guess ships a WRONG interface instead
// of a blank one.
/*
 * The fenced transport, not the script-block one `block()` uses.
 *
 * A .svelte component's own `<script>` would close the outer wrapper of a
 * script-block document, so the file would be read as ending where its script
 * ends. The line sentinel has no such problem, which is most of why real
 * projects travel that way.
 */
const SCRIPT_CLOSE = '</scr' + 'ipt>';
const fenced = (files) =>
  files.map(([path, body]) => `@@@makeui:file ${path}\n${body}\n@@@makeui:endfile`).join('\n');
const svelteFile = (body) => '<scr' + 'ipt>' + body + SCRIPT_CLOSE + '\n<p>x</p>';

const CONFUSED = fenced([
  ['src/main.ts', "import App from './App.svelte'; App;"],
  ['src/App.svelte', svelteFile('let a = 1;')],
  ['src/screens/Detail.svelte',
    svelteFile('\n  let equipment = null;\n  if (!equipment) {\n    return (\n      <div class="empty">なし</div>\n    );\n  }\n')],
]);
const confused = frameworkConfusionDefects(CONFUSED, 'svelte');
check('the shape is reported', confused.length, 1);
check('and it names the file', /screens[/]Detail[.]svelte/.test(confused[0].instruction), true);
check('but not the innocent component', /App[.]svelte/.test(confused[0].instruction), false);
// The compiler points at a bracket; the instruction has to point at the habit.
check('the instruction says where markup belongs', /マークアップ部/.test(confused[0].instruction), true);
check('and what to use instead', /[{]#if[}]/.test(confused[0].instruction), true);

// React IS this shape. Reporting it there would be reporting the language.
check('a react project is never confused', frameworkConfusionDefects(CONFUSED, 'react'), []);

// Vue gets its own words, because `{#if}` would be wrong advice there.
const VUE = fenced([
  ['src/main.ts', "import App from './App.vue'; App;"],
  ['src/App.vue', '<scr' + 'ipt setup>\n  if (!x) {\n    return <div>none</div>;\n  }\n' + SCRIPT_CLOSE + '\n<template><p>x</p></template>'],
]);
check('vue is caught too', frameworkConfusionDefects(VUE, 'vue').length, 1);
check('and told about v-if', /v-if/.test(frameworkConfusionDefects(VUE, 'vue')[0].instruction), true);

// Markup inside a string is ordinary code in every framework.
const INNER = fenced([
  ['src/main.ts', "import App from './App.svelte'; App;"],
  ['src/App.svelte', svelteFile('\n  function f(el) { el.innerHTML = "<b>hi</b>"; return "<i/>"; }\n')],
]);
check('markup in a string is not a return of markup', frameworkConfusionDefects(INNER, 'svelte'), []);

// And an ordinary early return is the most common statement in the file.
const PLAIN = fenced([
  ['src/main.ts', "import App from './App.svelte'; App;"],
  ['src/App.svelte', svelteFile('\n  function f(a) { if (!a) return null; return a * 2; }\n')],
]);
check('a plain early return is left alone', frameworkConfusionDefects(PLAIN, 'svelte'), [])
/*
 * What these assertions do NOT cover, stated so nobody reads them as more than
 * they are: whether a model, handed this instruction, writes a working
 * component. That is the model's behaviour, not this module's, and no unit test
 * reaches it. The corpus holds the exact input, so one Haiku edit run would
 * answer it — worth doing on the back of the next verification round rather
 * than on its own, and worth reading afterwards as one model on one document,
 * not as settled.
 */;

// --- a comment is not an import ----------------------------------------------
//
// `from` is an English word, and the pattern allows a newline between it and
// the quote. So a JSDoc line ending in it turned the next quoted phrase into a
// module. This exact comment, from a real file:
//
//     * … tell "never rendered" from "rendered
//     * nothing" — two failures that look identical
//
// was reported as an import of `rendered\\n   * nothing`. Harmless as a warning;
// not harmless as a moduleDefects finding, which sends a repair pass after a
// file that has nothing wrong with it.
const COMMENTED = fenced([
  ['src/main.ts', "import App from './App.svelte'; App;"],
  ['src/App.svelte', '<scr' + 'ipt>\n  /**\n   * tell "never rendered" from "rendered\n   * nothing" — two failures.\n   */\n  let a = 1;\n' + SCRIPT_CLOSE + '\n<p>{a}</p>'],
]);
check('a comment that says "from" is not an import', unresolvedImports(COMMENTED), []);
check('and a line comment is not either',
  unresolvedImports(fenced([
    ['src/main.ts', "import App from './App.svelte'; App;"],
    ['src/App.svelte', '<scr' + 'ipt>\n  // copied from "react-router-dom"\n  let a = 1;\n' + SCRIPT_CLOSE + '\n<p>{a}</p>'],
  ])), []);
// The real thing still is one, so the strip has not blinded the check.
check('a real bare import is still reported',
  unresolvedImports(fenced([
    ['src/main.ts', "import App from './App.svelte'; App;"],
    ['src/App.svelte', '<scr' + 'ipt>\n  import { goto } from "$app/navigation";\n  goto;\n' + SCRIPT_CLOSE + '\n<p>x</p>'],
  ])).map((u) => u.spec), ['$app/navigation']);
// And a `//` inside a string is not the start of a comment.
check('a URL in a string does not blank the rest of the line',
  unresolvedImports(fenced([
    ['src/main.ts', "import App from './App.svelte'; App;"],
    ['src/App.svelte', '<scr' + 'ipt>\n  const u = "https://example.com"; import x from "nowhere";\n  x; u;\n' + SCRIPT_CLOSE + '\n<p>y</p>'],
  ])).map((u) => u.spec), ['nowhere']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
