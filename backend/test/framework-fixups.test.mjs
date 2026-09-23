// Deterministic repairs for idioms that stop a framework compiling outright.
//
// Every case here is a real generation that reached a user as a build error or a
// blank page instead of a UI. The bar for living in this module is narrow: the
// failure is fatal, the correct form is unambiguous, and the rewrite is
// mechanical — anything needing judgement belongs in the repair loop.
//
//   node test/framework-fixups.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/tools/framework-fixups.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/fxt.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair-files.ts')}" --bundle --platform=node --format=esm ` +
    `--loader:.txt=text --outfile="${path.join(root, 'dist/rft.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { fixVueMacros, fixReactMissingProvider, fixRequireNamedDefault, fixVueUnclosedHandler,
  fixImportRequireHybrid, fixVueUncapturedProps, fixVueUnboundProps, fixDefaultImportOfNamedExport,
  fixArrowFunctionCast, salvageUnparsableStyles, fixupProject, fixVueNonReactiveHash,
  stubUnbuildableComponents, unbuildableFiles, fixPlaceholderImageBoxes, fixDetailIdNotPassed, dropSuppliedFiles } = await import(
  pathToFileURL(path.join(root, 'dist/fxt.test.mjs')).href
);
const { parses } = await import(pathToFileURL(path.join(root, 'dist/rft.test.mjs')).href);
execSync(
  `npx esbuild "${path.join(root, 'src/tools/react-bundle.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist/rbt.test.mjs')}" --external:@aws-sdk/* --external:@smithy/*`,
  { stdio: 'inherit', cwd: root }
);
const { toRunnableDocument } = await import(pathToFileURL(path.join(root, 'dist/rbt.test.mjs')).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- Vue: a second defineProps() -------------------------------------------
//
// Reported by a user with the compiler's own message:
//   src/components/ProductCard.vue: [@vue/compiler-sfc] duplicate defineProps() call
const DUPLICATE_PROPS = [
  '<template><article class="card">{{ product.name }}</article></template>',
  '<script setup lang="ts">',
  'interface Props { product: { id: string; name: string } }',
  'const props = withDefaults(defineProps<Props>(), {',
  "  product: () => ({ id: '', name: '' }),",
  '})',
  '',
  'const p2 = defineProps<Props>()',
  '',
  'const label = () => p2.product.name',
  '</script>',
].join('\n');

check('a duplicate defineProps is a compile error before the fix',
  /duplicate defineProps/.test(parses('src/components/ProductCard.vue', DUPLICATE_PROPS) ?? ''), true);

// A component with one defineProps is left exactly as it is.
const SINGLE = DUPLICATE_PROPS.replace('const p2 = defineProps<Props>()', 'const p2 = props');

// --- Svelte: an export whose name shadows a rune ----------------------------
//
// The mechanism is worth restating because nothing about it is obvious. With a
// binding called `state` in scope, Svelte reads `$state(...)` as a store
// subscription on it rather than as the rune, so the component compiles to
// `store_get(state, '$state')`. The module is a rune module, not a store, so
// `subscribe` is not a function and the page throws on first render:
//   TypeError: e.subscribe is not a function
// Nothing fails at build time. Measured: eight files poisoned by one import.
const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const project = (...blocks) => `<!DOCTYPE html><html><body>\n${blocks.join('')}</body></html>`;

const STORE = [
  'export interface AppState { cart: string[] }',
  'export const state = $state<AppState>({ cart: [] });',
  'export function addToCart(id: string) { state.cart.push(id); }',
].join('\n');

// --- $state created lazily inside a function ---------------------------------
// Measured at v138. Svelte rejects it outright — state_invalid_placement — and
// one file that will not compile takes the whole project with it: blank page,
// score 30, nothing else in the project wrong.
//
// The shape is not carelessness. It is how a singleton is written in every
// other language, and "create the store once" invites it, which is why the
// instruction has a failure rate and this does not.
const LAZY = [
  'let appState: State | null = null;',
  '',
  'export function getStore(): State {',
  '  if (!appState) {',
  '    appState = $state({',
  '      cart: [],',
  '      toast: null,',
  '    });',
  '  }',
  '  return appState;',
  '}',
].join('\n');

// --- an at-rule wrapped in :global() -----------------------------------------
// Measured at v139 in src/App.svelte:
//   :global(@media (prefers-reduced-motion: reduce)) { … }
// Svelte parses every component's <style>, this is not a selector, and the whole
// project stops building: `Expected a valid CSS identifier`. A blank page from a
// media query.
const AT_RULE = [
  ':global(@media (prefers-reduced-motion: reduce)) {',
  '  :global(*) { transition: none; }',
  '}',
].join('\n');

// --- last resort: an unparsable <style> costs the block, not the page ---------
// Three consecutive Svelte runs failed to build for three unrelated reasons and
// only one had been foreseen. A list of known mistakes is never finished, and
// the requirement it serves does not allow for that.
const svelteDoc = (appBody) => project(
  fence('src/main.ts', "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });"),
  fence('src/App.svelte', appBody)
);
const BROKEN_CSS = svelteDoc('<h1>店</h1>\n\n<style>\n  .header { color: red; }\n  ??? { color: blue; }\n</style>');

// A document that builds is returned exactly as it came in — this only ever
// runs on the failing case.
const OK = svelteDoc('<h1>店</h1>\n\n<style>\n  .header { color: red; }\n</style>');

// A fault in the script is never worked around by deleting CSS: that would hide
// a real defect behind a cosmetic change and still not build.
const BROKEN_SCRIPT = svelteDoc(
  "<script>\n  const x = ;\n</script>\n\n<h1>店</h1>\n\n<style>\n  .header { color: red; }\n</style>"
);

// --- a class field holding a rune, which we were breaking ourselves -----------
// Svelte accepts `class R { cur = $state({…}) }` — the error message it raises
// elsewhere lists "a class field declaration" as one of the legal places.
//
// We ran Sucrase's TypeScript transform over the file first, and its class-field
// lowering rewrites that into a constructor calling __init() and assigning
// there. `$state` is then inside a method, Svelte refuses it, and the project is
// a blank page. Measured at v145: a class-based router in
// src/lib/navigation.svelte.ts — an ordinary Svelte 5 idiom — took the whole
// project down, and the generated code had been correct.
//
// Fixed with `disableESTransforms`, which leaves class fields, optional chaining
// and nullish coalescing alone. The preview runs in a current browser that
// implements all three; types are still stripped, which is the only reason
// Sucrase is in this path.
const CLASS_STORE = [
  'export interface Route { screen: string }',
  'class Router {',
  '  private current = $state<Route>({ screen: "home" });',
  '  private seen: Route[] = [];',
  '  get route() { return this.current; }',
  '  go(next: Route) { this.current = next; this.seen.push(next); }',
  '}',
  'export const router = new Router();',
].join('\n');

// --- a rune returned from a getter, which the model gets wrong -----------------
// `get route() { return $derived(() => this.current); }` — measured at v145 in
// the same file. Genuinely invalid: a rune initialises a declaration or a field
// and is not an expression that can be returned. It is also unnecessary, because
// the getter reads a field that is already $state and reading $state is reactive
// on its own. And `$derived(() => x)` is a second mistake in one expression:
// the callback form is $derived.by.
const GETTER = [
  'class Router {',
  '  private current = $state({ screen: "home" });',
  '  get route() { return $derived(() => this.current); }',
  '  get screen() { return $derived(this.current.screen); }',
  '}',
  'export const router = new Router();',
].join('\n');

// A rune used correctly must survive: this runs over every Svelte file.
const CORRECT = [
  'let n = $state(0);',
  'const doubled = $derived(n * 2);',
  'export function get() { return doubled; }',
].join('\n');

// --- derived state exported from a rune module --------------------------------
// `export const currentRoute = $derived(route);` — Svelte refuses it outright,
// and the restriction is on the binding rather than the syntax: `export { d }`
// and `export default d` are refused the same way, so nothing preserves the
// import sites. Measured in a real run.
//
// Rewriting every read of an identifier would normally be too much to do
// mechanically. Here it is not: the input is already a guaranteed blank page, so
// the rewrite can only improve it or leave it equally broken.
const DERIVED_MODULE = [
  "import { route } from './router.svelte';",
  'export const currentRoute = $derived(route);',
].join('\n');
const READER = [
  '<script lang="ts">',
  "  import { currentRoute } from '../lib/nav.svelte';",
  '</script>',
  '<h1>{currentRoute.screen}</h1>',
].join('\n');

// --- a button inside a button -------------------------------------------------
// Only Svelte treats it as fatal; React and Vue render it. So the same markup is
// a working card in two frameworks and a blank page in the third, which is why
// it keeps being written. Svelte is right — it is invalid HTML.
const NESTED = [
  '<button class="card" onclick={open}>',
  '  <h3>{item.name}</h3>',
  '  <button class="action" onclick={add}>追加</button>',
  '</button>',
].join('\n');

// --- the attribute shorthand with a value inside it ---------------------------
// `<svg {width={size}} …>` — Svelte has two forms and this collides them:
// `{width}` passes a variable of the same name, `width={size}` passes an
// expression. Putting the expression inside the braces is a parse error, and the
// file — and therefore the project — does not build.
//
// Measured at v151, in src/components/icons/CartIcon.svelte. One icon of nine
// had it and it took the whole application to a blank page. The contract's own
// Svelte example writes `width={size}` correctly, so this is not something being
// taught; it is the slip a compiler is meant to catch.
const ICON = [
  '<script>',
  '  let { size = 20 } = $props();',
  '</script>',
  '',
  '<svg',
  '  {width={size}}',
  '  height={size}',
  '  viewBox="0 0 24 24"',
  '>',
  '  <circle cx="9" cy="21" r="1" />',
  '</svg>',
].join('\n');

// --- what it must not touch ---------------------------------------------------
// The same shape is ordinary JavaScript inside <script>: a destructuring pattern
// with a default. Rewriting it destroys the declaration. Measured as a
// regression on a document that had been compiling — caught by re-running every
// stored Svelte project rather than only the one being fixed.
const DESTRUCTURE = [
  '<script lang="ts">',
  '  let { params = {}, opts = {} } = $props();',
  '</script>',
  '<h1>{params.id}</h1>',
].join('\n');

// --- $props() called more than once -------------------------------------------
// Svelte refuses it, so the component and the whole project fail to build. This
// is the Svelte spelling of a fault a user already reported in Vue — `duplicate
// defineProps() call` — and the cause is the same in both: a component acquires
// a second prop while being written, and declaring it looks exactly like
// declaring the first.
const twoCalls = [
  '<script lang="ts">',
  '  let { params = {} } = $props();',
  '  let { onSelect } = $props();',
  '</script>',
  '<h1>{params.id}</h1>',
].join('\n');

// A type annotation puts a second brace group between the pattern and the `=`,
// and taking the first one found gives the type instead of the pattern.
const typed = [
  '<script lang="ts">',
  '  let { a }: { a: string } = $props();',
  '  let { b = {} } = $props();',
  '</script>',
  '<b>{a}</b>',
].join('\n');

// Three calls collapse to one, in the order first written.
const three = ['<script>', '  let { a } = $props();', '  let { b = 1 } = $props();', '  let { c } = $props();', '</script>', '<b>{a}{b}{c}</b>'].join('\n');

// --- {#const}, which is not a Svelte block ------------------------------------
// Svelte has five block types — if, each, await, key, snippet — and const is not
// one of them. Declaring a value inside markup is `{@const …}`, with an at-sign.
// Measured at v153, in two screens of one project: one character each, and the
// application rendered nothing.
const CONST_BLOCK = [
  '<script>let xs = [1]; function f() { return xs }</script>',
  '{#if xs.length === 0}',
  '  <p>empty</p>',
  '{:else}',
  '  {#const ys = f()}',
  '  {#each ys as y}<b>{y}</b>{/each}',
  '{/if}',
].join('\n');

// --- Svelte 4 props in a file that also uses runes -----------------------------
// One rune anywhere switches the file to runes mode, and there `export let` is
// not a prop declaration any more: "Cannot use `export let` in runes mode".
// Measured across one generated project — five components written this way, all
// five refused, and the application showed nothing.
//
// The mixture is not careless. Svelte 4 is most of what has been written about
// Svelte, and $state is what a model reaches for when it wants reactivity, so
// the two arrive in the same file from different memories.
const MIXED = [
  '<script>',
  "  export let variant = 'primary';",
  '  export let disabled = false;',
  "  let additionalClass = '';",
  '  export { additionalClass as class };',
  '',
  '  let isLoading = $state(false);',
  '</script>',
  '<button class="btn {additionalClass}" {disabled}>{variant}</button>',
].join('\n');

// A component with NO rune is a legitimate Svelte 4 file. The point is the
// contradiction, not the syntax.
const SVELTE4 = [
  '<script>',
  "  export let variant = 'primary';",
  '</script>',
  '<button class="btn">{variant}</button>',
].join('\n');

// `export { local as outward }` spells two different things, and only one of
// them is a prop. Where the local is a function it is a component method, which
// Svelte 5 accepts as written — so this file compiles BEFORE the fixup runs.
// Read as a prop it becomes `open: openModal` in the destructuring while
// `function openModal` stays where it was, and the component dies on
// "Identifier 'openModal' has already been declared". Measured on one corpus
// document: valid Svelte in, blank page out.
const ACCESSOR = [
  '<script>',
  '  let { onConfirm } = $props();',
  '  let isOpen = $state(false);',
  '',
  '  function openModal() {',
  '    isOpen = true;',
  '  }',
  '',
  '  export { openModal as open };',
  '</script>',
  '{#if isOpen}<button onclick={onConfirm}>OK</button>{/if}',
].join('\n');

// The discriminator is the declaration, not the syntax: a `let` export in the
// same shape is a real prop and must still convert.
const RENAMED = [
  '<script>',
  "  let additionalClass = '';",
  '  export { additionalClass as class };',
  '  let n = $state(0);',
  '</script>',
].join('\n');

// A file carrying both: the prop converts, the method is left alone, and the
// destructuring lands where the prop was rather than at the method.
const BOTH = [
  '<script>',
  "  let additionalClass = '';",
  '  export { additionalClass as class };',
  '  let isOpen = $state(false);',
  '',
  '  function openModal() {',
  '    isOpen = true;',
  '  }',
  '',
  '  export { openModal as open };',
  '</script>',
  '<div class={additionalClass}>{isOpen}</div>',
].join('\n');

// --- a shorthand naming something that does not exist -------------------------
// `{width}` is Svelte's shorthand for `width={width}`. The component below has
// no `width`, only `size`. It COMPILES — Svelte does not resolve the identifier
// at build time — and throws the first time it renders:
//
//     ReferenceError: width is not defined
//       at CartIcon  at Header  at App
//
// Measured at v165. Three icons, and the whole application rendered nothing.
// Every static check and the compile gate passed; it took running the document
// in a real browser to see it.
//
// The third spelling of one mistake — an icon wanting to be sized by a prop:
//     v151  {width={size}}   the shorthand with a value inside it — parse error
//     v153  {#const …}       a tag written as a block        — parse error
//     v165  {width}          the shorthand with nothing behind it — ReferenceError
const UNDEF_ICON = [
  '<script>',
  '  let { size = 24 } = $props();',
  '</script>',
  '',
  '<svg {width} {height} viewBox="0 0 24 24">',
  '  <circle cx="9" cy="21" r="1" />',
  '</svg>',
].join('\n');

// --- what it must not touch ---------------------------------------------------
// The markup binds names the script never mentions. `{#each xs as product}` and
// then `<ProductCard {product} />` is the idiomatic way to pass a row along, and
// the first version of this DELETED it — measured on a real grid before it
// shipped, where the repair for a blank page would have emptied the product list.
const GRID = [
  '<script>',
  "  import ProductCard from './ProductCard.svelte';",
  '  let { filteredItems } = $props();',
  '</script>',
  '{#each filteredItems as product}',
  '  <ProductCard {product} />',
  '{/each}',
].join('\n');

// --- a React entry that forgets its own provider -------------------------------
// The provider is written, exported and complete; the entry renders <App />
// without it, so every useApp() hits the guard the provider wrote for itself:
//
//     Error: useApp must be used within AppProvider
//
// Measured at v166. The project compiled, twelve components and five screens
// were present and correct, and the application rendered nothing — one wrapper

// missing from one line. React's version of the failure Svelte kept producing:
// files that are individually valid, in a project that cannot run.
const PROVIDER = [
  "import { createContext, useContext, useReducer } from 'react';",
  'const AppContext = createContext(null);',
  'export function AppProvider({ children }) {',
  '  const [state, dispatch] = useReducer((s) => s, {});',
  '  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;',
  '}',
  'export function useApp() {',
  '  const ctx = useContext(AppContext);',
  "  if (!ctx) throw new Error('useApp must be used within AppProvider');",
  '  return ctx;',
  '}',
].join('\n');
const ENTRY = [
  "import React from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import App from './App';",
  'createRoot(document.getElementById(\'root\')!).render(',
  '  <React.StrictMode>',
  '    <App />',
  '  </React.StrictMode>',
  ');',
].join('\n');

const SCREEN_USES = [
  "import { useApp } from '../store/AppProvider';",
  'export default function HomeScreen() { const { state } = useApp(); return <main /> }',
].join('\n');

const noProviderYet = new Map([
  ['src/main.tsx', ENTRY],
  ['src/App.tsx', "import HomeScreen from './screens/HomeScreen'\nexport default function App() { return <HomeScreen /> }"],
  ['src/store/AppProvider.tsx', PROVIDER],
  ['src/screens/HomeScreen.tsx', SCREEN_USES],
]);
const providered = fixReactMissingProvider(noProviderYet);
check('the missing provider is reported', providered.fixed.length, 1);
const entryAfter = providered.files.get('src/main.tsx');
check('the root element is wrapped', /<AppProvider><App \/><\/AppProvider>/.test(entryAfter), true);
check('and the import is added', /import \{ AppProvider \} from '\.\/store\/AppProvider';/.test(entryAfter), true);
// StrictMode is the entry's own choice and must survive.
check('StrictMode is kept', /<React\.StrictMode>/.test(entryAfter), true);
check('no other file is touched',
  providered.files.get('src/store/AppProvider.tsx'), PROVIDER);

// --- what it must not do ------------------------------------------------------
// Already mounted: there is nothing to fix and wrapping twice would break it.
const already = new Map(noProviderYet);
already.set('src/main.tsx', ENTRY.replace('<App />', '<AppProvider><App /></AppProvider>'));
check('an entry that already mounts it is left alone', fixReactMissingProvider(already).fixed, []);

// No provider in the project: it is not missing one.
const noProvider = new Map(noProviderYet);
noProvider.delete('src/store/AppProvider.tsx');
noProvider.set('src/screens/HomeScreen.tsx', 'export default function HomeScreen() { return <main /> }');
check('a project with no provider is left alone', fixReactMissingProvider(noProvider).fixed, []);

// A provider nothing consumes: wrapping is a change nobody asked for.
const unused = new Map(noProviderYet);
unused.set('src/screens/HomeScreen.tsx', 'export default function HomeScreen() { return <main /> }');
check('an unconsumed provider is left alone', fixReactMissingProvider(unused).fixed, []);

// --- an exported $state the module reassigns -----------------------------------
// Svelte states two rules with one shape:
//     export const d = $derived(x)   always refused
//     export let  s = $state(x)      refused ONLY if s is reassigned
// The second cost a blank page at v167, in a router that kept the current route
// in module state and wrote to it on every hashchange:
//     Cannot export state from a module if it is reassigned.
// Neither shape can be rescued by the component stub — a module is imported for
// the values it exports, so replacing it breaks every reader.
const NAV = [
  "import { parseHash, toHash } from './hash';",
  'export let currentRoute = $state(parseHash(location.hash));',
  'export function navigate(next) {',
  '  location.hash = toHash(next);',
  '}',
  'export function sync() {',
  '  currentRoute = parseHash(location.hash);',
  '}',
].join('\n');
const NAV_READER = [
  '<script lang="ts">',
  "  import { currentRoute } from '../lib/nav.svelte';",
  '</script>',
  '<h1>{currentRoute.screen}</h1>',
].join('\n');

// An exported $state that is only MUTATED is legal and must not be rewritten —
// `appState.cart.push(x)` is how a shared store is meant to be used.
const MUTATED = [
  'export const appState = $state({ cart: [] });',
  'export function addToCart(id) { appState.cart.push(id); }',
].join('\n');

// --- a private binding and its accessor sharing one name ------------------------
//     let appState = $state({ cart: [] });
//     export function appState() { return appState; }
//     SyntaxError: Identifier 'appState' has already been declared
//
// Measured at v168, and not an accident: Svelte's own message for exported rune
// state says to "export a function returning its value", and this is that advice
// carried out with the name reused. It is also the shape fixSvelteDerivedExport
// produces when it rescues an exported rune — which gets it right by giving the
// binding a private name — so the repair is to arrive at the same place.
const CLASH = [
  'let appState = $state({ cart: [] });',
  '',
  'export function appState() {',
  '  return appState;',
  '}',
  '',
  'export function addToCart(id) { appState.cart.push(id); }',
].join('\n');

// A local inside a function does not clash with a top-level export — it shadows
// it, which is legal, and the module this came from compiled. Measured on a
// v191 Svelte result: `navigation.svelte.ts` exported `route()` and declared a
// `const route: Route` inside `parseHash`, and the "repair" rewrote the
// module's own `route()` call to `__makeui_route()`. That is not a binding in
// that scope, so every hashchange threw — every navigation — while the page
// loaded clean. Zero console errors, two dead nav items, thirty-one points.
const SHADOW = [
  'function parseHash(hash) {',
  '  const route = { screen: hash.slice(2) };',
  '  return route;',
  '}',
  '',
  'export function route() {',
  '  return parseHash(location.hash);',
  '}',
  '',
  "addEventListener('hashchange', () => { const r = route(); use(r); });",
].join('\n');

// And even where the clash is real, a call can only mean the exported function.
// The genuine shape is a value that is read and never called, so this costs the
// repair nothing — and on its own it would have prevented the defect above.
const CALLED = [
  'let appState = $state({ n: 0 });',
  'export function appState() { return appState; }',
  'export function read() { return appState().n; }',
].join('\n');

// --- a rune store the rest of the project subscribes to -------------------------
//
//   function createStore() {
//     let state = $state(initial);
//     return { get currentState() { return state; }, add(x) { … } };
//   }
//   export const appState = createStore();
//
//   // six screens, all of them
//   appState.subscribe((s) => { … });
//
// Each half is idiomatic on its own — a textbook Svelte 5 rune store, and
// subscribe is how the rest of Svelte reads shared state. They never meet, and
// the page is blank with `appState.subscribe is not a function`.
const RUNE_STORE = [
  'function createStore() {',
  '  let state = $state({ items: [] });',
  '',
  '  return {',
  '    get currentState() {',
  '      return state;',
  '    },',
  '    add(x) { state.items = [x, ...state.items]; },',
  '  };',
  '}',
  '',
  'export const appState = createStore();',
].join('\n');

// --- an array sorted where it stands, on the way to being rendered --------------
//
//   let filtered = state.expenses;     // the $state proxy itself
//   filtered.sort((a, b) => …);        // sorts state, in place
//   return filtered;                   // …from a template expression
//
// https://svelte.dev/e/state_unsafe_mutation. This had been sitting unreached:
// the screen's store was broken, `state` stayed null, and the function returned
// from its guard before it ever got to the sort. Fixing the store is what
// surfaced it — the second defect was the one that would blank the screen.
const IN_PLACE_SORTED = [
  'function getFiltered() {',
  '  let filtered = state.expenses;',
  '  filtered.sort((a, b) => a.date - b.date);',
  '  return filtered;',
  '}',
].join('\n');

// --- a rune value called as though it were a function --------------------------
//
//   const recentApplications = $derived.by(() => { … });
//   {#each recentApplications() as app}
//
// $derived produces a value, so the markup calls the array — $.get(x)() in the
// compiled output — and the page throws `$.get(...) is not a function`. The
// accessor shape is everywhere in Svelte 5 because it IS how you export rune
// state across a module boundary; inside the declaring file it is wrong.
const RUNE_CALL = [
  'const recentApplications = $derived.by(() => rows.slice(0, 5));',
  'let count = $state(0);',
  '',
  '{#each recentApplications() as app}',
  '  <Row {app} />',
  '{/each}',
  '<span>{count()}</span>',
].join('\n');

// --- a default export pulled in by name through require -------------------------
//
//   // ClockIcon.tsx
//   export default function ClockIcon({ size }) { … }
//
//   // ApplicationsScreen.tsx
//   const { ClockIcon } = require('../components/icons/ClockIcon');
//
// The module has no named ClockIcon, so the binding is undefined and React
// refuses it with error #130 — element type is invalid. Nothing here is
// malformed: the module resolves and the destructuring succeeds. The value is
// simply not there, which is why `unresolvedComponentDefects` skipping React —
// on the reasoning that an undefined JSX name already throws — does not cover
// it. That is true of a free identifier; this is a const bound to undefined.
const REQ = new Map([
  ['src/components/icons/ClockIcon.tsx', 'export default function ClockIcon({ size }) { return null; }'],
  ['src/screens/A.tsx', "const { ClockIcon } = require('../components/icons/ClockIcon');\nexport default () => <ClockIcon size={12} />;"],
]);
const req = fixRequireNamedDefault(REQ);
check('the require is reported', req.fixed.length, 1);
check('it reads the default',
  /const ClockIcon = require\('\.\.\/components\/icons\/ClockIcon'\)\.default;/.test(req.files.get('src/screens/A.tsx')), true);
// Left where it stands: a require inside a function runs when it is called, and
// hoisting it to an import changes when the module is evaluated.
check('the icon module is untouched',
  req.files.get('src/components/icons/ClockIcon.tsx'), REQ.get('src/components/icons/ClockIcon.tsx'));

// A module that exports both is offering the named one deliberately.
check('a real named export is left alone',
  fixRequireNamedDefault(new Map([
    ['src/lib/x.ts', 'export const helper = 1;\nexport default 2;'],
    ['src/screens/A.tsx', "const { helper } = require('../lib/x');"],
  ])).fixed, []);
// And a module with no default has nothing to redirect to.
check('a module without a default is left alone',
  fixRequireNamedDefault(new Map([
    ['src/lib/x.ts', 'export const other = 1;'],
    ['src/screens/A.tsx', "const { helper } = require('../lib/x');"],
  ])).fixed, []);

// --- a class directive whose name was written as an expression -----------------
//
//   <div class:{'toast--success'}={cond}>   →   src/App.svelte: Expected token =
//
// `class:` takes a literal name and the parser wants the `=` straight after it.
// Braces are how a dynamic key is written everywhere else in the language, which
// is presumably why it gets written here — and it is a parse error, so the file
// never compiles and the project goes with it. Measured at v177 across two
// screens of one project.
const CLASS_DIR = `<div class="toast" class:{'toast--success'}={t.type === 'success'} class:{"toast--error"}={t.type === 'error'}>x</div>`;

// --- an event handler missing its closing parenthesis --------------------------
//
//   @click="navigate('cart'"   ->  Unexpected token, expected "," (1:17)
//
// The attribute value is a whole expression, so a count exactly one short has
// exactly one repair.
const handler = fixVueUnclosedHandler(`<div @click="navigate('cart'" role="button">x</div>`);
check('the unclosed handler is reported', handler.fixed.length, 1);
check('the paren is added', /@click="navigate\('cart'\)"/.test(handler.source), true);
check('a balanced handler is left alone',
  fixVueUnclosedHandler(`<div @click="navigate('cart')">x</div>`).fixed, []);
// Two missing is a different mistake, and a stray bracket is not this one.
check('two missing parens are left alone',
  fixVueUnclosedHandler(`<div @click="a(b(c">x</div>`).fixed, []);
check('an unbalanced bracket is left alone',
  fixVueUnclosedHandler(`<div @click="f(items[0">x</div>`).fixed, []);

// --- an import written half as an import and half as a require -----------------
//
//   import { route, navigate } = require('./lib/navigation.svelte');
//   Error transforming src/App.svelte: Unexpected token (6:30)
//
// Neither language has this form: `import { … }` wants `from`, `= require()`
// wants a `const`. Column 30 is the `=`. Measured at v179, sitting among five
// correct `import … from` lines in the same block.
const hybrid = fixImportRequireHybrid(
  "import Home from './Home.svelte';\nimport { route, navigate } = require('./lib/navigation.svelte');");
check('the hybrid import is reported', hybrid.fixed.length, 1);
// The default-binding spelling of the same mistake.
check('a default binding is handled too',
  /import nav from '\.\/nav';/.test(fixImportRequireHybrid("import nav = require('./nav');").source), true);
// A real require assigned to a const is ordinary CommonJS and not this.
check('a const require is left alone',
  fixImportRequireHybrid("const { a } = require('./x');").fixed, []);
check('an ordinary import is left alone',
  fixImportRequireHybrid("import { a } from './x';").fixed, []);

// --- props used in the script of a <script setup> that never captured them ------
//
//   defineProps<{ data: MonthlySalesData[] }>()
//   const maxAmount = computed(() => Math.max(...data.map(d => d.amount)))
//   ReferenceError: data is not defined
//
// `defineProps` returns the props object; the template gets the names bound for
// free, script code does not. So the same name works in the markup and throws
// ten lines above it — measured at v183 on four chart components at once.
const UNCAPTURED = '<template><g v-if="data.length > 0" /></template>\n<script setup lang="ts">\nimport { computed } from \'vue\'\ndefineProps<{ data: number[] }>()\nconst maxAmount = computed(() => Math.max(...data))\nconst count = () => data.length\n</script>';
const captured = fixVueUncapturedProps(UNCAPTURED);
check('the uncaptured props are reported', captured.fixed.length, 1);
check('the return is captured', /const props = defineProps<\{ data: number\[\] \}>\(\)/.test(captured.source), true);
check('script uses go through it', /Math\.max\(\.\.\.props\.data\)/.test(captured.source), true);
check('every script use, not just the first', /props\.data\.length/.test(captured.source), true);
// The template binds the names itself and must not be touched.
check('the template is left alone', /v-if="data\.length > 0"/.test(captured.source), true);

// Starting a line is not the same as starting a statement. `withDefaults(` puts
// defineProps on its own indented line and the props ARE captured — by the call
// around it. Rewriting that produced `const props = withDefaults(` followed by
// `const __props = defineProps<{`, which does not parse: the repair broke two
// documents that were already correct.
check('a withDefaults wrapper is left alone',
  fixVueUncapturedProps('<script setup lang="ts">\nconst props = withDefaults(\n  defineProps<{ id: string }>(),\n  { id: \'x\' }\n)\nconst k = props.id\n</script>').fixed, []);
// Declared but only used in the template is the normal case.
check('props used only in the template are left alone',
  fixVueUncapturedProps('<template><b>{{ a }}</b></template>\n<script setup lang="ts">\ndefineProps<{ a: string }>()\n</script>').fixed, []);
// A local binding of the same name resolves, so this is not the defect.
check('a shadowing local is left alone',
  fixVueUncapturedProps('<script setup lang="ts">\ndefineProps<{ a: string }>()\nconst a = 1\nconst k = a + 1\n</script>').fixed, []);

// The type may be a NAME rather than a literal, and reading only the literal is
// what let this ship again. 2026-09-18, a Vue storefront: every product card's
// click handler read a bare `product`, so pressing one threw
// `ReferenceError: product is not defined` and the page looked perfect until
// someone pressed it. The interface was eight lines above the call.
const NAMED_PROPS = [
  '<template><div @click="handleClick">{{ product.name }}</div></template>',
  '<script setup lang="ts">',
  "import type { Product } from '../../data/products'",
  '',
  'interface Props {',
  '  product: Product',
  '}',
  '',
  'defineProps<Props>()',
  '',
  'function handleClick(): void {',
  "  navigate({ screen: 'product', params: { id: product.id } })",
  '}',
  '</script>',
].join('\n');
const named = fixVueUncapturedProps(NAMED_PROPS);
check('a named props type is read too', named.fixed.length, 1);
check('the return is captured', /const props = defineProps<Props>\(\)/.test(named.source), true);
check('and the script reads through it', /id: props\.product\.id/.test(named.source), true);
check('the interface itself is untouched', /interface Props \{\n  product: Product\n\}/.test(named.source), true);
check('the template is left alone', /\{\{ product\.name \}\}/.test(named.source), true);
// Only members the type declares at its own level: a nested member is a
// property of a prop, not a prop, and rewriting it would break a local.
check('a nested member is not taken for a prop',
  fixVueUncapturedProps([
    '<script setup lang="ts">',
    'interface Props { item: { id: string } }',
    'defineProps<Props>()',
    'const id = 1',
    'const k = id + 1',
    '</script>',
  ].join('\n')).fixed, []);
check('a type declared nowhere leaves the call alone',
  fixVueUncapturedProps('<script setup lang="ts">\ndefineProps<Elsewhere>()\nconst k = product.id\n</script>').fixed, []);

// --- a default import of a file that only has named exports ---------------------
//
//   // src/components/icons/TrendIcon.tsx
//   export function TrendIcon({ size }) { … }
//   // src/components/KPICards.tsx
//   import TrendIcon from './icons/TrendIcon';
//   Minified React error #130 — element type is invalid: got undefined
//
// The same silent shape as fixRequireNamedDefault, in the spelling ESM uses.
// Measured at v185, on the run where the icons and illustrations instructions
// first took effect: two of the three occurrences were in exactly those new
// files. Asking for more components produced more of them, and a new way for
// them to be wired up wrong.
const namedDefault = fixDefaultImportOfNamedExport(new Map([
  ['src/components/icons/TrendIcon.tsx', 'export function TrendIcon({ size = 16 }) { return null; }'],
  ['src/components/KPICards.tsx', "import TrendIcon from './icons/TrendIcon';\nexport default () => <TrendIcon />;"],
]));
check('the mismatch is reported', namedDefault.fixed.length, 1);
check('the import becomes named',
  /import \{ TrendIcon \} from '\.\/icons\/TrendIcon';/.test(namedDefault.files.get('src/components/KPICards.tsx')), true);
// The export is what other files may already read correctly, so the importer is
// what changes.
check('the exporting file is untouched',
  namedDefault.files.get('src/components/icons/TrendIcon.tsx'),
  'export function TrendIcon({ size = 16 }) { return null; }');

// A local name that differs keeps every use in the file working via the alias.
check('a differing local name is aliased',
  /import \{ EmptyState as EmptyStateIllustration \}/.test(
    fixDefaultImportOfNamedExport(new Map([
      ['src/components/illustrations/EmptyState.tsx', 'export const EmptyState = () => null;'],
      ['src/components/Panel.tsx', "import EmptyStateIllustration from './illustrations/EmptyState';"],
    ])).files.get('src/components/Panel.tsx')),
  true);

// A real default export is ordinary code.
check('a file with a default export is left alone',
  fixDefaultImportOfNamedExport(new Map([
    ['src/a.tsx', 'export default function A() { return null; }'],
    ['src/b.tsx', "import A from './a';"],
  ])).fixed, []);
// Two candidates, neither named like the import, would be a guess about which was meant.
check('two component exports neither matching the import are left alone',
  fixDefaultImportOfNamedExport(new Map([
    ['src/a.tsx', 'export const A = () => null;\nexport const B = () => null;'],
    ['src/b.tsx', "import Panel from './a';"],
  ])).fixed, []);
// But the importer's own name among several is not a guess. 4 of the 5 repair
// candidates rejected for breaking the app on 2026-09-14 were this shape: a
// shared layout file holding several components, imported by the one it is named after.
{
  const screen = fixDefaultImportOfNamedExport(new Map([
    ['src/components/ui/Screen.tsx', 'export function Screen({ children }) { return <main>{children}</main>; }\nexport function PageTitle() { return null; }\nexport function Button() { return null; }'],
    ['src/screens/SettingsScreen.tsx', "import Screen from '../components/ui/Screen';\nimport { Button } from '../components/ui/Screen';\nexport function SettingsScreen() { return <Screen><Button /></Screen>; }"],
    ['src/components/ui/TableSection.tsx', "import Card from './Card';\nexport const TableSection = () => <Card />;"],
    ['src/components/ui/Card.tsx', 'export interface CardProps {}\nexport function Card() { return null; }\nexport function CardHeader() { return null; }\nexport function CardBody() { return null; }'],
  ]));
  check('a default import named like one of several exports becomes that named import',
    /import \{ Screen \} from '\.\.\/components\/ui\/Screen';/.test(screen.files.get('src/screens/SettingsScreen.tsx')), true);
  check('the other imports from that file are untouched',
    screen.files.get('src/screens/SettingsScreen.tsx').includes("import { Button } from '../components/ui/Screen';"), true);
  check('and Card beside CardHeader and CardBody likewise',
    /import \{ Card \} from '\.\/Card';/.test(screen.files.get('src/components/ui/TableSection.tsx')), true);
}
// A lowercase export is not a component; nothing to substitute.
check('a non-component export is left alone',
  fixDefaultImportOfNamedExport(new Map([
    ['src/util.ts', 'export const helper = () => 1;'],
    ['src/b.tsx', "import helper from './util';"],
  ])).fixed, []);

// --- an arrow function cast without being wrapped first -------------------------
//
//   window.addEventListener('inquiry-confirmed', (e) => {
//     …
//   } as EventListener)
//   [vue/compiler-sfc] Unexpected token, expected "," (34:4)
//
// TypeScript will not take an arrow function as the left operand of `as`.
// Checked against the transformer rather than assumed: the bare form fails, the
// parenthesised form passes, and `handler as EventListener` was always fine.
// Measured at v186, where one occurrence took a whole Vue project down.
const arrowCast = fixArrowFunctionCast("window.addEventListener('x', (e) => {\n  go()\n} as EventListener)\n");
check('the arrow is wrapped', /\(\(e\) => \{\n  go\(\)\n\}\) as EventListener\)/.test(arrowCast.source), true);

// An async arrow keeps its keyword inside the parentheses.
check('async is kept inside the wrap',
  /\(async \(\) => \{\}\) as Handler/.test(fixArrowFunctionCast('f(async () => {} as Handler)').source), true);
// A single unparenthesised parameter is still a parameter list.
check('a bare parameter is wrapped too',
  /\(e => \{\}\) as Handler/.test(fixArrowFunctionCast('f(e => {} as Handler)').source), true);
check('a block before a variable named as-something is left alone',
  fixArrowFunctionCast('function f() {\n  go()\n}\nconst asItem = 1;').fixed, []);

// Inside a block it is legal, and hoisting it would change what it computes —
// `item` exists only within the each. Left alone, and left to the build repair
// if it is misplaced for some other reason.
const IN_EACH = [
  '<script lang="ts">',
  "  let { items } = $props();",
  '</script>',
  '',
  '{#each items as item}',
  '  {@const label = item.name.toUpperCase()}',
  '  <li>{label}</li>',
  '{/each}',
].join('\n');

// The expression is balanced from the tag's own brace, so an object literal
// inside it cannot end the tag early.
const OBJECT = [
  '<script lang="ts">let n = $state(1);</script>',
  '',
  '<main>',
  '  {@const style = { width: n, height: n }}',
  '  <div>{style.width}</div>',
  '</main>',
].join('\n');

// --- defineProps called and thrown away ----------------------------------------
//
//     defineProps<Props>()
//     const points = computed(() => props.data.map(…))
//     ReferenceError: props is not defined
//
// The macro returns the props object and this call discards it, so `props` is
// never bound. It compiles — `props` is a free identifier as far as the compiler
// is concerned — and throws on the first render that evaluates the expression.
// Measured at v200: three chart components in one Vue project, two of which
// threw during the walk, and the run scored its floor.
const S2 = '<' + 'script';
const ES2 = '</' + 'script>';
const chart = (script) => `<template><svg /></template>\n${S2} setup lang="ts">\n${script}\n${ES2}\n`;

const UNBOUND = chart([
  'interface Props { data: number[] }',
  'defineProps<Props>()',
  'const points = props.data.map((d, i) => i * d);',
].join('\n'));
const bound = fixVueUnboundProps(UNBOUND);
check('the discarded call is reported', bound.fixed.length, 1);
check('and the call gets its variable',
  /const props = defineProps<Props>\(\)/.test(bound.source), true);
check('and nothing else moves',
  bound.source.replace('const props = defineProps', 'defineProps'), UNBOUND);

// Already bound is already correct.
check('an assigned call is left alone',
  fixVueUnboundProps(chart('const props = defineProps<Props>()\nconst x = props.data;')).fixed, []);

// A component that calls defineProps for its template only is correct as
// written, and binding it would leave an unused variable.
check('a call nothing reads is left alone',
  fixVueUnboundProps(chart('defineProps<Props>()\nconst x = 1;')).fixed, []);

// `props` bound some other way is still bound.
check('props declared elsewhere is left alone',
  fixVueUnboundProps(chart('defineProps<Props>()\nconst props = useAttrs();\nconst x = props.data;')).fixed, []);

// Not a setup block, so there is no macro to bind.
check('a plain script is left alone',
  fixVueUnboundProps('<template><i /></template>\n<' + 'script>\ndefineProps()\nconst x = props.a;\n' + ES2).fixed, []);

// --- two top-level <script> blocks ---------------------------------------------
//
//     A component can have a single top-level <script> element and/or a single
//     top-level <script module> element
//
// Fatal, and at v203 it was in App.svelte — which cannot be stubbed, so four
// screens and four components rendered nothing and the run scored 30 with a
// 45-point reach deduction on top. The second block is usually appended after
// the markup, carrying more state and the handlers the markup calls.
const TWO_SCRIPTS = [
  '<script>',
  "  let period = $state('month');",
  '</script>',
  '',
  '<div id="app">',
  '  <button onclick={apply}>{period}</button>',
  '</div>',
  '',
  '<script>',
  "  let errorMessage = '';",
  '  function apply() { errorMessage = period; }',
  '</script>',
].join('\n');

// `<script module>` is the legal second block.
const WITH_MODULE = [
  '<script module>',
  '  export const NAME = "x";',
  '</script>',
  '<script>',
  '  let n = $state(0);',
  '</script>',
  '<b>{n}</b>',
].join('\n');

// --- $: as a block, which is a side effect rather than a value -----------------
//
// `$derived` is wrong here — there is nothing to derive — so it becomes
// `$effect`, which is what a Svelte 4 reactive block always meant. Across the
// corpus these are the only two forms that have ever appeared: three
// assignments and one block.
const REACTIVE_BLOCK = [
  '<script>',
  "  let title = $state('売上');",
  '  $: {',
  '    document.title = title;',
  '  }',
  '</script>',
  '<b>{title}</b>',
].join('\n');

// --- a TypeScript cast in the markup -----------------------------------------
const CAST = [
  '<script lang="ts">',
  '  let v = $state(0);',
  '</script>',
  '',
  '<input onchange={(e) => set(parseInt((e.target as HTMLInputElement).value, 10))} />',
].join('\n');

/*
 * The three ways this repair can do damage, each measured on the corpus before
 * it shipped. Two of them it actually did.
 */
// 1. `as` is Svelte syntax in a block tag. Stripping it broke three projects
//    that compiled: "An {#each ...} block without an as clause cannot have a key".
const EACH = '<script></script>\n{#each rows as row (row.id)}\n  <li>{row.name}</li>\n{/each}';
// 2. Outside an expression, `as` is an English word and this is the page's text.
const PROSE = '<script></script>\n<p>HTML (also known as HyperText) is fine.</p>';
// 3. Inside a string, it is the text one level down.
const INSTR = '<script></script>\n<p>{label || "known as HTML"}</p>';

// --- the tooling MakeUI supplies, written by the model anyway ---------------------
/*
 * A Vue build of 2026-09-23 wrote vite.config.ts, package.json and tsconfig.json.
 * The preview never loads them, but `import { defineConfig } from 'vite'` reads
 * to the module audit as a missing package — a display-stopping finding for a
 * file that does nothing.
 */
{
  const fenceOf = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile`;
  const project = ['<!DOCTYPE html><html><body><div id="root"></div>',
    fenceOf('src/main.ts', "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).mount('#app')"),
    fenceOf('src/App.vue', '<template><main /></template>'),
    fenceOf('vite.config.ts', "import { defineConfig } from 'vite'\nimport vue from '@vitejs/plugin-vue'\nexport default defineConfig({ plugins: [vue()] })"),
    fenceOf('package.json', '{"name":"x"}'),
    fenceOf('tsconfig.json', '{}'),
    fenceOf('src/config/vite.config.ts', 'export const x = 1'),
    '</body></html>'].join('\n');
  const r = dropSuppliedFiles(project);
  check('the supplied tooling is dropped', r.dropped.sort(), ['package.json', 'tsconfig.json', 'vite.config.ts']);
  check('and nothing of it is left behind', /defineConfig|"name":"x"/.test(r.html), false);
  check("the project's own files stay", ['src/main.ts', 'src/App.vue', 'src/config/vite.config.ts'].every((p) => r.html.includes(`@@@makeui:file ${p}`)), true);
  check('fixupProject does it and says so', fixupProject(project, 'vue').fixed.some((f) => f.includes('vite.config.ts')), true);
  check('a project without them is untouched', dropSuppliedFiles(r.html).html, r.html);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
