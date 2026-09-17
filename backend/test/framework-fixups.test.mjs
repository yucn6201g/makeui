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
const { fixVueMacros, fixSvelteRuneShadowing, fixSvelteRuneImports, fixSvelteLazyRuneState, fixSvelteRuneInGetter, fixSvelteDerivedExport, fixSvelteNestedButton, fixSvelteAttributeShorthand, fixSvelteUndefinedShorthand, fixReactMissingProvider, fixSvelteDuplicateAccessor, fixSvelteRuneStoreSubscribe, fixSvelteInPlaceSort, fixSvelteRuneCalledAsFunction, fixRequireNamedDefault, fixSvelteClassDirectiveExpression, fixSvelteReactiveStatement, fixSvelteRuneShadowLocal, fixSvelteRuneInObjectLiteral, fixSvelteMarkupTypeAssertion, fixSvelteRedeclaredImport, fixVueUnclosedHandler, fixImportRequireHybrid, fixSvelteOrphanEffect, fixVueUncapturedProps, fixVueUnboundProps, fixDefaultImportOfNamedExport, fixArrowFunctionCast, fixSvelteDuplicateProps, fixSvelteConstBlock, fixSvelteDuplicateScript, fixSvelteConstPlacement, fixSvelteLegacyProps, fixSvelteDerivedThunk, fixSvelteGlobalAtRule, salvageUnparsableStyles, fixupProject, fixVueNonReactiveHash } = await import(
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

const vueFixed = fixVueMacros(DUPLICATE_PROPS);
check('the fixup reports what it did', vueFixed.fixed.length > 0, true);
check('and the result compiles', parses('src/components/ProductCard.vue', vueFixed.source), null);
// The second declaration is usually referenced below it, so deleting the
// statement outright would trade a compile error for an undefined binding.
check('the second binding is kept, pointing at the surviving call',
  /const p2 = props/.test(vueFixed.source), true);
check('and the defaults on the first call survive',
  /withDefaults\(defineProps<Props>\(\)/.test(vueFixed.source), true);

// A component with one defineProps is left exactly as it is.
const SINGLE = DUPLICATE_PROPS.replace('const p2 = defineProps<Props>()', 'const p2 = props');
check('a component with one defineProps is untouched', fixVueMacros(SINGLE).source, SINGLE);

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
const SCREEN = [
  '<script lang="ts">',
  "  import { state, addToCart } from '../lib/store.svelte';",
  '  let toastVisible = $state(false);',
  '</script>',
  '<button onclick={() => addToCart(\'a\')}>{state.cart.length}</button>',
].join('\n');

const shadow = fixSvelteRuneShadowing(new Map([
  ['src/lib/store.svelte.ts', STORE],
  ['src/screens/HomeScreen.svelte', SCREEN],
]));
check('an export named state is renamed', shadow.fixed.length, 1);
check('in the module that declares it',
  /export const appState = \$state/.test(shadow.files.get('src/lib/store.svelte.ts')), true);
check('and in the file that imports it',
  /import \{ appState, addToCart \}/.test(shadow.files.get('src/screens/HomeScreen.svelte')), true);
// The rune itself must survive untouched — it is the thing being rescued.
check('while the rune is left alone',
  /let toastVisible = \$state\(false\)/.test(shadow.files.get('src/screens/HomeScreen.svelte')), true);
check('and the usage is rewritten with it',
  /\{appState\.cart\.length\}/.test(shadow.files.get('src/screens/HomeScreen.svelte')), true);

// A project whose store is named safely is not rewritten.
const SAFE = new Map([
  ['src/lib/store.svelte.ts', STORE.replace(/\bstate\b/g, 'appState')],
  ['src/screens/HomeScreen.svelte', SCREEN.replace('{ state,', '{ appState,').replace('{state.', '{appState.')],
]);
check('a safely named store is untouched', fixSvelteRuneShadowing(SAFE).fixed, []);

// A React project must never be put through the Svelte rewrite.
check('the rename only runs for Svelte',
  fixupProject(project(fence('src/lib/store.ts', 'export const state = { a: 1 };')), 'react').fixed, []);

// --- end to end through the document ---------------------------------------
const doc = project(fence('src/lib/store.svelte.ts', STORE), fence('src/screens/HomeScreen.svelte', SCREEN));
const fixedDoc = fixupProject(doc, 'svelte');
check('the whole document is rewritten together', fixedDoc.fixed.length, 1);
check('and no binding named state survives',
  /import \{ state[,}]/.test(fixedDoc.html), false);

// --- runes imported as values ------------------------------------------------
// Measured at v138, in src/lib/store.svelte.ts and src/lib/navigation.svelte.ts:
//   import { $state } from 'svelte';
// The framework contract already forbids this in as many words, and the run did
// it anyway. An instruction followed most of the time still ships a blank page
// the rest of the time.
check('a rune import is dropped',
  fixSvelteRuneImports("import { $state } from 'svelte';\nlet n = $state(0);").source.trim(),
  'let n = $state(0);');
check('and reported',
  fixSvelteRuneImports("import { $state, $derived } from 'svelte';").fixed.length, 1);
// Real imports from svelte have to survive — mount() is how the entry file works.
check('a real import from svelte is untouched',
  fixSvelteRuneImports("import { mount } from 'svelte';").fixed, []);
check('and is kept when mixed with a rune',
  fixSvelteRuneImports("import { mount, $state } from 'svelte';").source.trim(),
  "import { mount } from 'svelte';");
// Another module may legitimately export a $-prefixed name.
check('only svelte itself is rewritten',
  fixSvelteRuneImports("import { $custom } from './helpers';").fixed, []);

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
const hoisted = fixSvelteLazyRuneState(LAZY);
check('the rune is hoisted to a module-level const',
  /^const appState = \$state\(\{/m.test(hoisted.source), true);
check('the whole object literal comes with it',
  /cart: \[\],[\s\S]*toast: null,/.test(hoisted.source), true);
// Only the hoisted declaration may remain. An assignment that is not a
// declaration is the exact thing Svelte rejects, so matching `appState =
// $state` alone would pass on the bug and on the fix equally.
check('no assignment to the rune survives outside a declaration',
  /(^|[^\w.$])(?<!(?:let|const|var) )appState\s*=\s*\$state/m.test(hoisted.source), false);
check('and the rune is created exactly once',
  (hoisted.source.match(/\$state\s*\(/g) || []).length, 1);
check('and so is the if that guarded it',
  /if\s*\(\s*!\s*appState\s*\)/.test(hoisted.source), false);
check('the accessor still returns it',
  /return appState;/.test(hoisted.source), true);
check('the rewrite is reported', hoisted.fixed.length, 1);
// The legal forms must be left exactly as they are.
check('a top-level const declaration is untouched',
  fixSvelteLazyRuneState('const appState = $state({ cart: [] });').fixed, []);
check('and so is a plain let declaration',
  fixSvelteLazyRuneState('let count = $state(0);').fixed, []);
// With no `let name = null` to hoist to, the rewrite cannot be made safely — so
// it is left for the repair loop rather than guessed at.
check('an assignment with nothing to hoist to is left alone',
  fixSvelteLazyRuneState('function f() { window.x = $state({}); }').fixed, []);

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
const unwrapped = fixSvelteGlobalAtRule(AT_RULE);
check('the at-rule is unwrapped',
  unwrapped.source.startsWith('@media (prefers-reduced-motion: reduce) {'), true);
check('its own parens survive the balanced match',
  /\(prefers-reduced-motion: reduce\)/.test(unwrapped.source), true);
// The :global() on the selectors inside is correct and is what keeps the rule
// applying outside the component — it must not be unwrapped with the at-rule.
check('the selectors inside keep theirs',
  /:global\(\*\)/.test(unwrapped.source), true);
check('the rewrite is reported', unwrapped.fixed.length, 1);
check('a plain :global selector is untouched',
  fixSvelteGlobalAtRule(':global(body) { margin: 0; }').fixed, []);
check('and a bare at-rule is already right',
  fixSvelteGlobalAtRule('@media (min-width: 700px) { .a { color: red; } }').fixed, []);

// --- last resort: an unparsable <style> costs the block, not the page ---------
// Three consecutive Svelte runs failed to build for three unrelated reasons and
// only one had been foreseen. A list of known mistakes is never finished, and
// the requirement it serves does not allow for that.
const svelteDoc = (appBody) => project(
  fence('src/main.ts', "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });"),
  fence('src/App.svelte', appBody)
);
const BROKEN_CSS = svelteDoc('<h1>店</h1>\n\n<style>\n  .header { color: red; }\n  ??? { color: blue; }\n</style>');
check('the document does not build to begin with',
  Boolean(toRunnableDocument(BROKEN_CSS, 'svelte').error), true);
// Nothing above recognises `???` — that is the point of the test.
check('and no targeted repair claims to know this one',
  fixupProject(BROKEN_CSS, 'svelte').fixed, []);
const rescued = salvageUnparsableStyles(BROKEN_CSS, 'svelte', toRunnableDocument);
check('the offending block is dropped', rescued.stripped, ['src/App.svelte']);
check('and the project builds', toRunnableDocument(rescued.html, 'svelte').error, null);
check('the markup is untouched', /<h1>店<\/h1>/.test(rescued.html), true);

// A document that builds is returned exactly as it came in — this only ever
// runs on the failing case.
const OK = svelteDoc('<h1>店</h1>\n\n<style>\n  .header { color: red; }\n</style>');
check('a building document is left alone', salvageUnparsableStyles(OK, 'svelte', toRunnableDocument).stripped, []);
check('and comes back byte for byte',
  salvageUnparsableStyles(OK, 'svelte', toRunnableDocument).html === OK, true);

// A fault in the script is never worked around by deleting CSS: that would hide
// a real defect behind a cosmetic change and still not build.
const BROKEN_SCRIPT = svelteDoc(
  "<script>\n  const x = ;\n</script>\n\n<h1>店</h1>\n\n<style>\n  .header { color: red; }\n</style>"
);
check('a script error does not cost the styles',
  salvageUnparsableStyles(BROKEN_SCRIPT, 'svelte', toRunnableDocument).stripped, []);

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

check('a rune in a class field compiles', parses('src/lib/navigation.svelte.ts', CLASS_STORE), null);
// The same shape inside a component's <script>, which takes the other path.
check('and inside a component',
  parses('src/App.svelte', `<script lang="ts">\n${CLASS_STORE}\n</script>\n<div>{router.route.screen}</div>`), null);

// Optional chaining and nullish coalescing go through the same flag, so they are
// worth a line here: if the flag were ever removed to "fix" something, these
// would keep working and the class field would silently break again.
check('optional chaining still compiles',
  parses('src/lib/util.svelte.ts', 'export const id = (r?: { params?: { id?: string } }) => r?.params?.id ?? "";'), null);

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

check('the document does not compile to begin with',
  parses('src/lib/navigation.svelte.ts', GETTER) !== null, true);

const runeless = fixSvelteRuneInGetter(GETTER);
check('the rune wrapper is removed', runeless.fixed.length, 1);
check('the thunk form is unwrapped too',
  /get route\(\) \{ return this\.current; \}/.test(runeless.source), true);
check('and the plain form',
  /get screen\(\) \{ return this\.current\.screen; \}/.test(runeless.source), true);
check('the result compiles', parses('src/lib/navigation.svelte.ts', runeless.source), null);
check('and no rune is left being returned', /return \$derived/.test(runeless.source), false);

// A rune used correctly must survive: this runs over every Svelte file.
const CORRECT = [
  'let n = $state(0);',
  'const doubled = $derived(n * 2);',
  'export function get() { return doubled; }',
].join('\n');
check('a correctly placed rune is untouched', fixSvelteRuneInGetter(CORRECT).fixed, []);
check('and comes back unchanged', fixSvelteRuneInGetter(CORRECT).source, CORRECT);
// Returning something that merely mentions a rune-derived binding is not this.
check('returning a derived binding is not rewritten',
  fixSvelteRuneInGetter('function f() { return doubled; }').fixed, []);

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

const exported = fixSvelteDerivedExport(new Map([
  ['src/lib/nav.svelte.ts', DERIVED_MODULE],
  ['src/screens/HomeScreen.svelte', READER],
]));
check('an exported derived is reported', exported.fixed.length, 1);
// `let`, not `const`: the same rewrite now also rescues an exported `$state`
// that the module reassigns, and that one has to stay assignable. Declaring a
// `$derived` with `let` is legal in Svelte, so one form serves both.
check('the module keeps the derived privately',
  /let __makeui_currentRoute = \$derived\(route\)/.test(exported.files.get('src/lib/nav.svelte.ts')), true);
check('and exports a function of the same name',
  /export function currentRoute\(\) \{ return __makeui_currentRoute; \}/.test(exported.files.get('src/lib/nav.svelte.ts')), true);
check('the reader now calls it',
  /\{currentRoute\(\)\.screen\}/.test(exported.files.get('src/screens/HomeScreen.svelte')), true);
// The import binds the same name, so it must not become `currentRoute()`.
check('the import statement is left alone',
  /import \{ currentRoute \} from/.test(exported.files.get('src/screens/HomeScreen.svelte')), true);

// Nothing imports it: the export was pointless and dropping it touches no one.
const private_ = fixSvelteDerivedExport(new Map([
  ['src/lib/nav.svelte.ts', DERIVED_MODULE],
]));
check('an unimported derived just loses its export',
  /^const currentRoute = \$derived\(route\)/m.test(private_.files.get('src/lib/nav.svelte.ts')), true);
check('and no function is invented',
  /export function/.test(private_.files.get('src/lib/nav.svelte.ts')), false);

// Exported $state is legal and must survive untouched.
check('exported $state is not a defect',
  fixSvelteDerivedExport(new Map([['src/lib/s.svelte.ts', 'export const n = $state(0);']])).fixed, []);

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
const flattened = fixSvelteNestedButton(NESTED);
check('the nested button is reported', flattened.fixed.length, 1);
check('the outer becomes a div', /^<div class="card" onclick=\{open\}/.test(flattened.source), true);
check('and closes as one', /<\/div>$/.test(flattened.source.trim()), true);
check('it keeps its handler', /onclick=\{open\}/.test(flattened.source), true);
check('and stays reachable', /role="button"/.test(flattened.source) && /tabindex="0"/.test(flattened.source), true);
check('the inner button survives intact',
  /<button class="action" onclick=\{add\}>追加<\/button>/.test(flattened.source), true);
// A lone button is correct markup and must not be touched.
check('a button with no button inside is left alone',
  fixSvelteNestedButton('<button class="btn" onclick={go}>次へ</button>').fixed, []);
// `disabled` means nothing on a div and would read as a stray attribute.
check('disabled is dropped from the outer element',
  /disabled/.test(fixSvelteNestedButton('<button disabled={x}><button>a</button></button>').source), false);

// --- $derived given a callback ------------------------------------------------
// `$derived(expr)` takes an expression, `$derived.by(fn)` takes a callback.
// Reaching for the callback and then invoking it — because the value plainly
// should not be a function — gives `$derived(...)()`, a call rather than a
// declaration initialiser. Measured in a real run, computing a filtered list.
check('an invoked thunk becomes $derived.by',
  fixSvelteDerivedThunk('let r = $derived(() => { return xs.filter(f); })();').source,
  'let r = $derived.by(() => { return xs.filter(f); });');
check('a bare thunk becomes $derived.by too',
  fixSvelteDerivedThunk('let r = $derived(() => xs.length);').source,
  'let r = $derived.by(() => xs.length);');
check('and it is reported',
  fixSvelteDerivedThunk('let r = $derived(() => xs.length);').fixed.length, 1);
// An expression is the correct form and must survive — including one that opens
// with a parenthesis, which is the shape most likely to be mistaken for a thunk.
check('a plain expression is untouched',
  fixSvelteDerivedThunk('let r = $derived(n * 2);').fixed, []);
check('a parenthesised expression is untouched',
  fixSvelteDerivedThunk('let r = $derived((a + b) * c);').fixed, []);
check('and $derived.by is already right',
  fixSvelteDerivedThunk('let r = $derived.by(() => xs.length);').fixed, []);

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

const shorthand = fixSvelteAttributeShorthand(ICON);
check('the collided attribute is reported', shorthand.fixed.length, 1);
check('and rewritten to the normal form', /\n  width=\{size\}\n/.test(shorthand.source), true);
check('the correct attribute beside it is untouched', /\n  height=\{size\}\n/.test(shorthand.source), true);
check('the result compiles', parses('src/components/icons/CartIcon.svelte', shorthand.source), null);

// A quoted value goes the same way.
check('a string value is handled too',
  fixSvelteAttributeShorthand('<div {class="card"}>x</div>').source, '<div class="card">x</div>');

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
check('a destructuring default is left alone', fixSvelteAttributeShorthand(DESTRUCTURE).fixed, []);
check('and the script comes back byte for byte',
  fixSvelteAttributeShorthand(DESTRUCTURE).source, DESTRUCTURE);
check('which still compiles', parses('src/screens/DetailScreen.svelte', DESTRUCTURE), null);

// The real shorthand is correct and must survive.
check('the bare shorthand is untouched',
  fixSvelteAttributeShorthand('<svg {width} {height} />').fixed, []);
// Block syntax is not an attribute.
check('an if block is untouched',
  fixSvelteAttributeShorthand('{#if a === b}<p>x</p>{/if}').fixed, []);

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
check('two calls do not compile', parses('src/screens/D.svelte', twoCalls) !== null, true);
const merged = fixSvelteDuplicateProps(twoCalls);
check('the calls are merged', merged.fixed.length, 1);
check('into one declaration keeping both names and the default',
  /let \{ params = \{\}, onSelect \} = \$props\(\);/.test(merged.source), true);
check('and the result compiles', parses('src/screens/D.svelte', merged.source), null);
check('only one $props call is left',
  (merged.source.match(/\$props\s*\(/g) || []).length, 1);

// A default value is itself a brace, so the pattern is found by counting rather
// than by a regex. `[^}]*` stops at the wrong one — the first version of this
// matched nothing at all, which looks exactly like success.
check('a default containing braces is kept intact',
  /params = \{\}/.test(merged.source), true);

// A type annotation puts a second brace group between the pattern and the `=`,
// and taking the first one found gives the type instead of the pattern.
const typed = [
  '<script lang="ts">',
  '  let { a }: { a: string } = $props();',
  '  let { b = {} } = $props();',
  '</script>',
  '<b>{a}</b>',
].join('\n');
check('a typed pattern is merged too', fixSvelteDuplicateProps(typed).fixed.length, 1);
check('and compiles', parses('src/screens/D.svelte', fixSvelteDuplicateProps(typed).source), null);

// Three calls collapse to one, in the order first written.
const three = ['<script>', '  let { a } = $props();', '  let { b = 1 } = $props();', '  let { c } = $props();', '</script>', '<b>{a}{b}{c}</b>'].join('\n');
check('three calls collapse in order',
  /let \{ a, b = 1, c \} = \$props\(\);/.test(fixSvelteDuplicateProps(three).source), true);

// One call is correct and must not be rewritten.
check('a single call is untouched',
  fixSvelteDuplicateProps('<script>\n  let { a, b = {} } = $props();\n</script>').fixed, []);
// A call that is not destructured cannot be merged without guessing, so it is
// left for the repair loop rather than mangled.
check('an undestructured call is left alone',
  fixSvelteDuplicateProps('<script>\n  const p = $props();\n  const q = $props();\n</script>').fixed, []);

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

check('the block form does not compile', parses('src/screens/H.svelte', CONST_BLOCK) !== null, true);
const atConst = fixSvelteConstBlock(CONST_BLOCK);
check('it is rewritten to the tag form', /\{@const ys = f\(\)\}/.test(atConst.source), true);
check('and reported', atConst.fixed.length, 1);
check('the result compiles', parses('src/screens/H.svelte', atConst.source), null);
// The real blocks share the `{#` sigil and must not be touched.
check('the if block survives', /\{#if xs\.length === 0\}/.test(atConst.source), true);
check('and the each block', /\{#each ys as y\}/.test(atConst.source), true);
check('a project with no {#const} is untouched',
  fixSvelteConstBlock('{#if a}{#each b as c}<i>{c}</i>{/each}{/if}').fixed, []);
check('and one already using {@const} is right',
  fixSvelteConstBlock('{#if a}{@const d = 1}<i>{d}</i>{/if}').fixed, []);

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

check('the mixture does not compile', parses('src/components/ui/Button.svelte', MIXED) !== null, true);
const runes = fixSvelteLegacyProps(MIXED);
check('it is reported', runes.fixed.length, 1);
check('every prop lands in one $props() destructuring',
  /let \{ variant = 'primary', disabled = false, class: additionalClass = '' \} = \$props\(\);/.test(runes.source), true);
check('and no export let survives', /export\s+let/.test(runes.source), false);
check('nor the rename form', /export\s*\{/.test(runes.source), false);
check('the result compiles', parses('src/components/ui/Button.svelte', runes.source), null);
// The renamed prop is how a reserved word is spelled in runes mode too, so the
// two problems have one answer.
check('the reserved word keeps its local name',
  /class: additionalClass/.test(runes.source), true);
// The rune that put the file in runes mode must survive.
check('the rune is untouched', /let isLoading = \$state\(false\)/.test(runes.source), true);
// Removing several declarations leaves their blank lines behind, and the output
// is something a developer opens and continues from.
check('no run of blank lines is left', /\n[ \t]*\n[ \t]*\n/.test(runes.source), false);
check('and the following statement keeps its indentation',
  /\n  let isLoading/.test(runes.source), true);

// A component with NO rune is a legitimate Svelte 4 file. The point is the
// contradiction, not the syntax.
const SVELTE4 = [
  '<script>',
  "  export let variant = 'primary';",
  '</script>',
  '<button class="btn">{variant}</button>',
].join('\n');
check('a pure Svelte 4 component is left alone', fixSvelteLegacyProps(SVELTE4).fixed, []);
check('and comes back byte for byte', fixSvelteLegacyProps(SVELTE4).source, SVELTE4);
check('which still compiles', parses('src/components/ui/Button.svelte', SVELTE4), null);

// A component already using $props() has nothing to convert.
check('a runes-mode component with no export let is untouched',
  fixSvelteLegacyProps('<script>\n  let { a } = $props();\n  let n = $state(0);\n</script>').fixed, []);

// A typed prop keeps its default; the annotation goes, because in runes mode the
// type belongs on the whole pattern rather than on one name.
check('a typed prop converts',
  /let \{ size = 24 \} = \$props\(\);/.test(
    fixSvelteLegacyProps('<script lang="ts">\n  export let size: number = 24;\n  let n = $state(0);\n</script>').source), true);
// A prop with no default converts to a bare name.
check('a prop with no default converts',
  /let \{ items \} = \$props\(\);/.test(
    fixSvelteLegacyProps('<script>\n  export let items;\n  let n = $state(0);\n</script>').source), true);

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

check('the accessor form compiles on its own', parses('src/components/ui/Modal.svelte', ACCESSOR), null);
const accessor = fixSvelteLegacyProps(ACCESSOR);
check('so there is nothing to report', accessor.fixed, []);
check('and it comes back byte for byte', accessor.source, ACCESSOR);
check('the function is not turned into a prop', /open: openModal/.test(accessor.source), false);
check('it still compiles afterwards', parses('src/components/ui/Modal.svelte', accessor.source), null);

// The discriminator is the declaration, not the syntax: a `let` export in the
// same shape is a real prop and must still convert.
const RENAMED = [
  '<script>',
  "  let additionalClass = '';",
  '  export { additionalClass as class };',
  '  let n = $state(0);',
  '</script>',
].join('\n');
check('a let export in the same shape still converts',
  /let \{ class: additionalClass = '' \} = \$props\(\);/.test(fixSvelteLegacyProps(RENAMED).source), true);

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
const both = fixSvelteLegacyProps(BOTH);
check('the prop converts', /let \{ class: additionalClass = '' \} = \$props\(\);/.test(both.source), true);
check('the method survives untouched', /export \{ openModal as open \};/.test(both.source), true);
check('and the mixture compiles', parses('src/components/ui/Modal.svelte', both.source), null);

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

const iconBound = fixSvelteUndefinedShorthand(UNDEF_ICON);
check('the undefined shorthand is reported', iconBound.fixed.length, 1);
check('and iconBound to the one prop the component has',
  /<svg width=\{size\} height=\{size\} viewBox/.test(iconBound.source), true);
check('the result compiles', parses('src/components/icons/CartIcon.svelte', iconBound.source), null);

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
check('an each binding is not an undefined name', fixSvelteUndefinedShorthand(GRID).fixed, []);
check('and the shorthand survives', /<ProductCard \{product\} \/>/.test(fixSvelteUndefinedShorthand(GRID).source), true);

// Every other way the markup introduces a name.
for (const [name, markup] of [
  ['the each index', '{#each xs as x, i}<b {i} />{/each}'],
  ['a keyed each', '{#each xs as row (row.id)}<b {row} />{/each}'],
  ['a destructured each', '{#each xs as { id, label }}<b {label} />{/each}'],
  ['an await value', '{#await p then value}<b {value} />{/await}'],
  ['an @const', '{#if a}{@const total = 1}<b {total} />{/if}'],
  ['a snippet parameter', '{#snippet row(item)}<b {item} />{/snippet}'],
  ['a let: directive', '<List let:entry><b {entry} /></List>'],
]) {
  check(`${name} is not treated as undefined`, fixSvelteUndefinedShorthand(markup).fixed, []);
}

// A name the script does declare, in each of the ways it can.
check('script declarations are seen',
  fixSvelteUndefinedShorthand('<script>\n  let width = 10;\n</script>\n<svg {width} />').fixed, []);
check('imports are seen',
  fixSvelteUndefinedShorthand("<script>\n  import { size } from './x';\n</script>\n<svg {size} />").fixed, []);

// An expression in TEXT content is not an attribute. Deleting it would remove
// what the screen exists to show.
check('an expression in text is untouched',
  fixSvelteUndefinedShorthand('<p>{unknownThing}</p>').fixed, []);

// With no single prop to bind to, the attribute goes rather than the page.
check('an undefined shorthand with nothing to bind to is dropped',
  /<svg viewBox="0 0 24 24"/.test(
    fixSvelteUndefinedShorthand('<script>\n  let { a, b } = $props();\n</script>\n<svg {width} viewBox="0 0 24 24" />').source), true);

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
const SCREEN_USES = [
  "import { useApp } from '../store/AppProvider';",
  'export default function HomeScreen() { const { state } = useApp(); return <main /> }',
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

// The hook in a different file from the provider — the digital-agency run of 2026-09-14,
// which shipped blank because only the provider's own file was searched for the hook.
{
  const split = new Map([
    ['src/main.tsx', ENTRY],
    ['src/App.tsx', "import { useApp } from './store';\nexport default function App() { const { state } = useApp(); return <main /> }"],
    ['src/store/index.ts', [
      "import { createContext, useContext } from 'react';",
      'export const AppContext = createContext(null);',
      'export function useApp() {',
      '  const ctx = useContext(AppContext);',
      "  if (!ctx) throw new Error('useApp must be used within AppProvider');",
      '  return ctx;',
      '}',
    ].join('\n')],
    ['src/store/AppProvider.tsx', "import { AppContext } from './index';\nexport function AppProvider({ children }) { return <AppContext.Provider value={{}}>{children}</AppContext.Provider> }"],
  ]);
  const fixedSplit = fixReactMissingProvider(split);
  check('a hook whose guard names the provider, in another file, still counts', fixedSplit.fixed.length, 1);
  check('and the entry is wrapped with the provider from its own file',
    /<AppProvider><App \/><\/AppProvider>/.test(fixedSplit.files.get('src/main.tsx')) &&
      /import \{ AppProvider \} from '\.\/store\/AppProvider';/.test(fixedSplit.files.get('src/main.tsx')), true);
  const unguarded = new Map(split);
  unguarded.set('src/store/index.ts', split.get('src/store/index.ts').replace("throw new Error('useApp must be used within AppProvider')", 'return null'));
  check('a hook elsewhere that does not name the provider is not evidence', fixReactMissingProvider(unguarded).fixed, []);
  const notCalled = new Map(split);
  notCalled.set('src/App.tsx', 'export default function App() { return <main /> }');
  check('nor is a guarded hook nobody calls', fixReactMissingProvider(notCalled).fixed, []);
}

// Svelte and Vue projects must not be put through it.
check('it only runs for React',
  fixupProject(project(fence('src/main.ts', "import App from './App.svelte'"),
                       fence('src/App.svelte', '<main></main>')), 'svelte')
    .fixed.filter((f) => f.includes('包んでいなかった')), []);

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

const reass = fixSvelteDerivedExport(new Map([
  ['src/lib/nav.svelte.ts', NAV],
  ['src/screens/HomeScreen.svelte', NAV_READER],
]));
check('a reassigned exported $state is reported', reass.fixed.length, 1);
const navAfter = reass.files.get('src/lib/nav.svelte.ts');
check('it becomes a private, assignable binding',
  /let __makeui_currentRoute = \$state\(parseHash/.test(navAfter), true);
check('the reassignment inside the module follows the rename',
  /__makeui_currentRoute = parseHash\(location\.hash\)/.test(navAfter), true);
check('nothing still assigns to the old name',
  /(^|[^\w$.])currentRoute\s*=(?!=)/m.test(navAfter), false);
check('and a function of the original name is exported',
  /export function currentRoute\(\) \{ return __makeui_currentRoute; \}/.test(navAfter), true);
check('the reader calls it', /\{currentRoute\(\)\.screen\}/.test(reass.files.get('src/screens/HomeScreen.svelte')), true);

// An exported $state that is only MUTATED is legal and must not be rewritten —
// `appState.cart.push(x)` is how a shared store is meant to be used.
const MUTATED = [
  'export const appState = $state({ cart: [] });',
  'export function addToCart(id) { appState.cart.push(id); }',
].join('\n');
check('an exported $state that is only mutated is left alone',
  fixSvelteDerivedExport(new Map([['src/lib/store.svelte.ts', MUTATED]])).fixed, []);
// Comparison is not assignment.
check('a comparison is not a reassignment',
  fixSvelteDerivedExport(new Map([
    ['src/lib/s.svelte.ts', 'export const n = $state(0);\nexport const isZero = () => n == 0;'],
  ])).fixed, []);

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

check('the clash does not compile', parses('src/lib/store.svelte.ts', CLASH) !== null, true);
const renamed = fixSvelteDuplicateAccessor(CLASH);
check('the collision is reported', renamed.fixed.length, 1);
check('the binding is renamed', /let __makeui_appState = \$state/.test(renamed.source), true);
// The export is what every reader holds, so its name must not move.
check('the exported name is untouched',
  /export function appState\(\) \{/.test(renamed.source), true);
check('the return follows the binding',
  /return __makeui_appState;/.test(renamed.source), true);
check('and so does every other use',
  /__makeui_appState\.cart\.push/.test(renamed.source), true);
check('the result compiles', parses('src/lib/store.svelte.ts', renamed.source), null);

// A module where the two names differ is already correct.
check('a distinct accessor is left alone',
  fixSvelteDuplicateAccessor('let inner = $state(0);\nexport function value() { return inner; }').fixed, []);
// A binding with no accessor of that name is ordinary.
check('a plain binding is left alone',
  fixSvelteDuplicateAccessor('let count = $state(0);\nexport function bump() { count += 1; }').fixed, []);
// A property access must not be swept up with the identifier.
check('a property of the same name is not renamed',
  /obj\.appState/.test(fixSvelteDuplicateAccessor(
    'let appState = $state(0);\nconst x = obj.appState;\nexport function appState() { return appState; }').source), true);

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
check('a local shadowing an export is left alone', fixSvelteDuplicateAccessor(SHADOW).fixed, []);
check('the call it broke still stands',
  /const r = route\(\);/.test(fixSvelteDuplicateAccessor(SHADOW).source), true);

// And even where the clash is real, a call can only mean the exported function.
// The genuine shape is a value that is read and never called, so this costs the
// repair nothing — and on its own it would have prevented the defect above.
const CALLED = [
  'let appState = $state({ n: 0 });',
  'export function appState() { return appState; }',
  'export function read() { return appState().n; }',
].join('\n');
check('a call is not renamed',
  /return appState\(\)\.n;/.test(fixSvelteDuplicateAccessor(CALLED).source), true);
check('the binding still is',
  /let __makeui_appState = \$state/.test(fixSvelteDuplicateAccessor(CALLED).source), true);


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
const RUNE_SCREEN = "import { appState } from '../lib/store.svelte';\nappState.subscribe((s) => { rows = s.items; });";

const bridged = fixSvelteRuneStoreSubscribe(new Map([
  ['src/lib/store.svelte.ts', RUNE_STORE],
  ['src/screens/A.svelte', RUNE_SCREEN],
]));
check('the bridge is reported', bridged.fixed.length, 1);
const store = bridged.files.get('src/lib/store.svelte.ts');
check('subscribe is added', /subscribe\(run\) \{/.test(store), true);
// Synchronously first: a store hands over the current value before it returns,
// and consumers clear their own loading flag on that call. With only the
// effect — which is scheduled, not immediate — the screen renders its
// 「読み込み中...」 placeholder and stays there, with no error to show for it.
check('the current value is emitted synchronously',
  /subscribe\(run\) \{\s*\n\s*run\(state\);/.test(store), true);
// And keeps emitting: $effect.root returns its own teardown, which is exactly
// the unsubscribe contract the caller expects back.
check('later changes are tracked', /\$effect\.root\(\(\) => \{/.test(store), true);
check('the teardown is returned', /return \$effect\.root/.test(store), true);
check('the rune it reads is the one the factory declared',
  /\$effect\(\(\) => \{ run\(state\); \}\);/.test(store), true);
check('the consumer is untouched', bridged.files.get('src/screens/A.svelte'), RUNE_SCREEN);

// A module nobody subscribes to is correct as written.
check('an unsubscribed rune module is left alone',
  fixSvelteRuneStoreSubscribe(new Map([
    ['src/lib/store.svelte.ts', RUNE_STORE],
    ['src/screens/A.svelte', 'import { appState } from "../lib/store.svelte";\nconst v = appState.currentState;'],
  ])).fixed, []);
// One that already is a store needs no bridge.
check('a real store is left alone',
  fixSvelteRuneStoreSubscribe(new Map([
    ['src/lib/store.svelte.ts', 'function make() {\n  let state = $state(0);\n  return { subscribe(r) { r(state); return () => {}; } };\n}\nexport const appState = make();'],
    ['src/screens/A.svelte', 'appState.subscribe((s) => {});'],
  ])).fixed, []);

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
const sorted = fixSvelteInPlaceSort(IN_PLACE_SORTED);
check('the in-place sort is reported', sorted.fixed.length, 1);
check('it becomes a copy', /filtered = \[\.\.\.filtered\]\.sort\(/.test(sorted.source), true);
check('the indent is kept', /\n  filtered = /.test(sorted.source), true);

// Only the bare statement form, whose result is thrown away — that is the one
// that exists purely for the mutation. A value being used is left alone.
check('a returned sort is left alone',
  fixSvelteInPlaceSort('let xs = [];\nreturn xs.sort((a, b) => a - b);').fixed, []);
check('an assigned sort is left alone',
  fixSvelteInPlaceSort('let xs = [];\nconst ys = xs.sort((a, b) => a - b);').fixed, []);
// And only when the name is a `let`, since the rewrite assigns to it.
check('a const is left alone',
  fixSvelteInPlaceSort('const xs = [1, 2];\nxs.sort((a, b) => a - b);').fixed, []);


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
const runeCall = fixSvelteRuneCalledAsFunction(RUNE_CALL);
check('the calls are reported', runeCall.fixed.length, 1);
check('the $derived call loses its parens',
  /\{#each recentApplications as app\}/.test(runeCall.source), true);
check('and so does the $state one', /\{count\}/.test(runeCall.source), true);
check('the declaration is untouched',
  /const recentApplications = \$derived\.by\(\(\) => rows\.slice\(0, 5\)\);/.test(runeCall.source), true);

// Arguments mean it was never this rune being called.
check('a call with arguments is left alone',
  fixSvelteRuneCalledAsFunction('let fmt = $state(0);\nconst s = fmt(12);').fixed, []);
// A name this file does not declare as a rune is somebody else's function.
check('a plain function call is left alone',
  fixSvelteRuneCalledAsFunction('function total() { return 1; }\nconst n = total();').fixed, []);
// A property of the same name must not be swept up.
check('a method call of the same name survives',
  /obj\.count\(\)/.test(fixSvelteRuneCalledAsFunction('let count = $state(0);\nobj.count();').source), true);

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
const classDir = fixSvelteClassDirectiveExpression(CLASS_DIR);
check('the braces are reported', classDir.fixed.length, 1);
check('the name becomes literal',
  /class:toast--success=\{t\.type === 'success'\}/.test(classDir.source), true);
check('double quotes too', /class:toast--error=/.test(classDir.source), true);
check('the condition is untouched',
  /=\{t\.type === 'error'\}/.test(classDir.source), true);
// Already correct, and must not be touched.
check('an ordinary class directive is left alone',
  fixSvelteClassDirectiveExpression(`<div class:active={isOn}>x</div>`).fixed, []);
// A name with a space is two classes and cannot be one directive; interpolation
// really is dynamic. Both are left for the repair pass.
check('a multi-word name is left alone',
  fixSvelteClassDirectiveExpression(`<div class:{'a b'}={x}>y</div>`).fixed, []);

// --- a Svelte 4 reactive statement in a runes file -----------------------------
//
//   $: filteredExpenses = getFilteredExpenses();
//   `$:` is not allowed in runes mode, use `$derived` or `$effect` instead
//
// One leftover line takes the project down: the moment any rune appears, the
// whole file is in runes mode.
const reactive = fixSvelteReactiveStatement('  $: filteredExpenses = getFilteredExpenses();');
check('the reactive statement is reported', reactive.fixed.length, 1);
check('it becomes $derived',
  reactive.source.trim(), 'const filteredExpenses = $derived(getFilteredExpenses());');
check('the indent survives', /^ {2}const/.test(reactive.source), true);

// Only when the name belongs to this statement alone. Declared elsewhere means
// this is a reassignment, and `const` would not do.
check('a name declared elsewhere is left alone',
  fixSvelteReactiveStatement('let total = 0;\n$: total = a + b;').fixed, []);
check('a name assigned elsewhere is left alone',
  fixSvelteReactiveStatement('$: total = a + b;\nfunction reset() { total = 0; }').fixed, []);
// An effect is not a value, and turning one into `$effect` changes when it runs
// — so a bare statement is still left alone. There has never been one.
check('a bare statement is left for the repair pass',
  fixSvelteReactiveStatement('$: console.log(count);').fixed, []);
// The block form was left alone for the same reason, and v203 overturned it.
//
// "It changes when it runs" compares two programs that both run. `$:` in a
// runes file does not compile, so the comparison is against a blank page — and
// the repair pass was handed exactly this file and shipped one: App.svelte,
// four screens, four components, nothing rendered, score 30 with a 45-point
// reach deduction on top. `$effect` is what a Svelte 4 reactive block always
// meant, and it is the only translation that leaves the application running.
const asEffect = fixSvelteReactiveStatement('$: {\n  document.title = title;\n}');
check('a block becomes an effect', /\$effect\(\(\) => \{/.test(asEffect.source), true);
check('and the body is carried over', /document\.title = title;/.test(asEffect.source), true);


// --- a local binding that turns a rune back into a store read ------------------
//
//   const state = appStore;
//   let currentScreen = $state('home');
//     -> const $state = () => $.store_get(state, '$state', $$stores);
//        TypeError: e.subscribe is not a function
//
// `$name` is a store subscription whenever `name` is in scope, and that rule
// outranks the rune — so naming a variable `state` disables `$state` for the
// rest of the file. Compiles, then dies on mount. Measured at v178.
const shadowLocal = fixSvelteRuneShadowLocal(
  "const state = appStore;\nlet screen = $state('home');\n<div>{state.x}{screen}</div>");
check('the shadowing local is reported', shadowLocal.fixed.length, 1);
check('it is renamed', /const appState = appStore;/.test(shadowLocal.source), true);
check('and its uses move with it', /\{appState\.x\}/.test(shadowLocal.source), true);
check('the rune is untouched', /\$state\('home'\)/.test(shadowLocal.source), true);

// The new name has to be free. On the run this was written for, the module
// ALREADY had an `appState` — renaming into it made two bindings of one name
// and a file that no longer parsed. The fix broke what it was repairing.
const taken = fixSvelteRuneShadowLocal(
  "const state = 1;\nexport const appState = { get v() { return state; } };\nlet n = $state(0);\n<b>{n}</b>");
check('a taken name is stepped over', /localState/.test(taken.source), true);
check('and the existing binding survives', /export const appState =/.test(taken.source), true);

// No rune, nothing shadowed.
check('a plain state variable is left alone',
  fixSvelteRuneShadowLocal('const state = {};\n<div>{state.a}</div>').fixed, []);
// A prop of that name is the parent's word.
check('a prop named state is left alone',
  fixSvelteRuneShadowLocal("let { state } = $props();\nlet n = $state(0);").fixed, []);

// --- a rune as an object literal property --------------------------------------
//
//   export const appState = { get state() {…}, filteredRequests: $derived.by(…) }
//   `$derived.by(...)` can only be used as a variable declaration initializer
//
// The object beside it already answers the question: a computed property here is
// a getter, which is what fixSvelteRuneInGetter arrives at from the other side.
const runeObj = fixSvelteRuneInObjectLiteral(
  'export const s = {\n  get a() {\n    return 1;\n  },\n  b: $derived.by(() => {\n    const x = 2;\n    return x;\n  }),\n};');
check('the property rune is reported', runeObj.fixed.length, 1);
check('it becomes a getter', /get b\(\) \{/.test(runeObj.source), true);
check('the body is kept', /const x = 2;/.test(runeObj.source), true);
check('the neighbour getter is untouched', /get a\(\) \{/.test(runeObj.source), true);
check('and the object still closes', /\},\n\};/.test(runeObj.source), true);
// The concise form has no block to unwrap.
check('an expression body becomes a return',
  /get b\(\) \{\n\s*return items\.length;\n\s*\},/.test(
    fixSvelteRuneInObjectLiteral('const s = {\n  b: $derived(items.length),\n};').source), true);
// A declaration is where a rune belongs.
check('a rune in a declaration is left alone',
  fixSvelteRuneInObjectLiteral('const total = $derived(a + b);').fixed, []);

// --- a TypeScript assertion left in the markup ---------------------------------
//
//   onConfirm={() => deleteRequest(confirmDeleteId!)}
//
// Only <script> blocks go through Sucrase, because only they are JavaScript. The
// markup is Svelte's own language, so the assertion never meets the stripper.
const markupTs = fixSvelteMarkupTypeAssertion(
  '<script lang="ts">let id: string | null = null;</script>\n<X onC={() => del(id!)} />');
check('the assertion is reported', markupTs.fixed.length, 1);
check('it is removed from the markup', /del\(id\)/.test(markupTs.source), true);
check('the script block is untouched', /let id: string \| null = null;/.test(markupTs.source), true);
// Prefix NOT and the inequality operators must survive.
check('logical not survives',
  /\{!open\}/.test(fixSvelteMarkupTypeAssertion('<div>{!open}</div>').source), true);
check('inequality survives',
  /a !== b/.test(fixSvelteMarkupTypeAssertion('<div>{a !== b}</div>').source), true);

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
check('it becomes an import', /import \{ route, navigate \} from '\.\/lib\/navigation\.svelte';/.test(hybrid.source), true);
check('the correct import beside it is untouched',
  /import Home from '\.\/Home\.svelte';/.test(hybrid.source), true);
// The default-binding spelling of the same mistake.
check('a default binding is handled too',
  /import nav from '\.\/nav';/.test(fixImportRequireHybrid("import nav = require('./nav');").source), true);
// A real require assigned to a const is ordinary CommonJS and not this.
check('a const require is left alone',
  fixImportRequireHybrid("const { a } = require('./x');").fixed, []);
check('an ordinary import is left alone',
  fixImportRequireHybrid("import { a } from './x';").fixed, []);


// --- an effect at the top level of a module ------------------------------------
//
//   // src/lib/navigation.svelte.ts
//   $effect(() => { window.addEventListener('hashchange', h); return () => … })
//   https://svelte.dev/e/effect_orphan
//
// `$effect` needs an owner and a module has none, so it throws while the module
// is being required — before any component renders, which is why the whole app
// is blank rather than one screen.
//
// Wrapping it in `$effect.root` was the obvious repair and does not work: the
// body calls its own handler synchronously to set the starting value, so the
// effect writes state during its own run and Svelte stops it with
// state_unsafe_mutation instead. Measured — the fix moved the failure. At module
// scope this body is initialisation, not reaction.
const orphan = fixSvelteOrphanEffect(
  "let route = $state(null);\n$effect(() => {\n  const h = () => { route = parse(location.hash) };\n  h();\n  window.addEventListener('hashchange', h);\n  return () => window.removeEventListener('hashchange', h);\n});");
check('the orphan effect is reported', orphan.fixed.length, 1);
check('the body is lifted out', /window\.addEventListener\('hashchange', h\);/.test(orphan.source), true);
check('the effect wrapper is gone', /\$effect\s*\(/.test(orphan.source), false);
// A bare `return` at module scope is a syntax error, and the teardown has no
// owner once the effect is gone.
check('the teardown is dropped', /removeEventListener/.test(orphan.source), false);
check('the result parses', (() => { try { new Function(orphan.source.replace(/\$state\(/g, 'Object(')); return true; } catch { return false; } })(), true);

// An effect inside a function is owned by whatever calls it.
check('a nested effect is left alone',
  fixSvelteOrphanEffect('export function init() {\n  $effect(() => { go(); });\n}').fixed, []);

// --- a sort in the middle of an expression -------------------------------------
//
//   return appState.expenses
//     .sort((a, b) => …)
//     .slice(0, 5)
//
// Reads as a query and is a mutation. Called from a $derived, which is where
// Svelte stops it. This had been hiding behind the effect_orphan above, which
// threw first.
const chained = fixSvelteInPlaceSort(
  'function recent() {\n  return appState.expenses\n    .sort((a, b) => a - b)\n    .slice(0, 5)\n}');
check('the chained sort is reported', chained.fixed.length, 1);
check('the receiver is copied', /\[\.\.\.appState\.expenses\]/.test(chained.source), true);
check('the chain still continues', /\.slice\(0, 5\)/.test(chained.source), true);

// A receiver that is already a fresh array needs no copy.
check('a sort after filter is left alone',
  fixSvelteInPlaceSort('const x = items.filter(f).sort(cmp);').fixed, []);
check('a sort on a spread is left alone',
  fixSvelteInPlaceSort('const x = [...items].sort(cmp);').fixed, []);
// The statement form still assigns back rather than copying into nothing.
check('the statement form still assigns back',
  /filtered = \[\.\.\.filtered\]\.sort\(/.test(
    fixSvelteInPlaceSort('let filtered = state.rows;\nfiltered.sort((a, b) => 0);').source), true);


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
check('an already-captured defineProps is left alone',
  fixVueUncapturedProps('<script setup lang="ts">\nconst props = defineProps<{ a: string }>()\nconst k = props.a\n</script>').fixed, []);
// Declared but only used in the template is the normal case.
check('props used only in the template are left alone',
  fixVueUncapturedProps('<template><b>{{ a }}</b></template>\n<script setup lang="ts">\ndefineProps<{ a: string }>()\n</script>').fixed, []);
// A local binding of the same name resolves, so this is not the defect.
check('a shadowing local is left alone',
  fixVueUncapturedProps('<script setup lang="ts">\ndefineProps<{ a: string }>()\nconst a = 1\nconst k = a + 1\n</script>').fixed, []);


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
check('the bare cast is reported', arrowCast.fixed.length, 1);
check('the arrow is wrapped', /\(\(e\) => \{\n  go\(\)\n\}\) as EventListener\)/.test(arrowCast.source), true);

// An async arrow keeps its keyword inside the parentheses.
check('async is kept inside the wrap',
  /\(async \(\) => \{\}\) as Handler/.test(fixArrowFunctionCast('f(async () => {} as Handler)').source), true);
// A single unparenthesised parameter is still a parameter list.
check('a bare parameter is wrapped too',
  /\(e => \{\}\) as Handler/.test(fixArrowFunctionCast('f(e => {} as Handler)').source), true);

// A `}` before `as` can also close an object literal or a block, and neither
// wants parentheses.
check('an object literal cast is left alone',
  fixArrowFunctionCast('const a = { id: 1 } as Item;').fixed, []);
check('a block before a variable named as-something is left alone',
  fixArrowFunctionCast('function f() {\n  go()\n}\nconst asItem = 1;').fixed, []);
// Already correct.
check('a wrapped cast is left alone',
  fixArrowFunctionCast('f(((e) => {}) as Handler)').fixed, []);

// --- {@const} where Svelte does not allow one ---------------------------------
//
// The tag is spelled right and the expression is valid; only the position is
// wrong, and the whole project fails to build. Measured at v195 in App.svelte —
// five screens, seventeen components, a page that rendered nothing, and a shell
// that cannot be stubbed, so nothing rescued it.
const MISPLACED = [
  '<script lang="ts">',
  "  import { state } from './lib/store.svelte';",
  '  function renderScreen() { return Home; }',
  '</script>',
  '',
  '<main class="content">',
  '  {@const Screen = renderScreen()}',
  '  <Screen />',
  '</main>',
].join('\n');

check('the misplaced tag does not compile', parses('src/App.svelte', MISPLACED) !== null, true);
const placed = fixSvelteConstPlacement(MISPLACED);
check('it is reported', placed.fixed.length, 1);
check('and the result compiles', parses('src/App.svelte', placed.source), null);
check('the binding moved to the script as $derived',
  /const Screen = \$derived\(renderScreen\(\)\);/.test(placed.source), true);
check('and is gone from the markup', /\{@const/.test(placed.source), false);

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
check('a const inside a block is untouched', fixSvelteConstPlacement(IN_EACH).fixed, []);
check('and the file is returned unchanged', fixSvelteConstPlacement(IN_EACH).source === IN_EACH, true);

// A file with no script has nowhere to hoist to.
check('a file with no script is left alone',
  fixSvelteConstPlacement('<main>{@const x = 1}</main>').fixed, []);

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
check('an object literal in the expression survives',
  /const style = \$derived\(\{ width: n, height: n \}\);/.test(fixSvelteConstPlacement(OBJECT).source), true);
check('and that file compiles too',
  parses('src/App.svelte', fixSvelteConstPlacement(OBJECT).source), null);

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

check('the duplicate script does not compile',
  parses('src/App.svelte', TWO_SCRIPTS) !== null, true);
const oneScript = fixSvelteDuplicateScript(TWO_SCRIPTS);
check('it is reported', oneScript.fixed.length, 1);
check('and the result compiles', parses('src/App.svelte', oneScript.source), null);
check('only one script survives',
  (oneScript.source.match(/<script/g) || []).length, 1);
// Nothing is dropped: both halves have to be in the one block that is left.
check('the first block is still there', /let period = \$state/.test(oneScript.source), true);
check('and so is the second', /function apply\(\)/.test(oneScript.source), true);
check('the markup is untouched', /<div id="app">/.test(oneScript.source), true);

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
check('a module script is not a duplicate', fixSvelteDuplicateScript(WITH_MODULE).fixed, []);
check('nor is the Svelte 4 spelling',
  fixSvelteDuplicateScript(WITH_MODULE.replace('<script module>', '<script context="module">')).fixed, []);
check('one script is left alone',
  fixSvelteDuplicateScript('<script>\n  let n = $state(0);\n</script>\n<b>{n}</b>').fixed, []);

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
check('the reactive block does not compile',
  parses('src/App.svelte', REACTIVE_BLOCK) !== null, true);
const blockEffect = fixSvelteReactiveStatement(REACTIVE_BLOCK);
check('it becomes an effect', /\$effect\(\(\) => \{/.test(blockEffect.source), true);
check('the body is carried over', /document\.title = title;/.test(blockEffect.source), true);
check('and the result compiles', parses('src/App.svelte', blockEffect.source), null);
// The assignment form still becomes $derived, not $effect.
check('an assignment is still derived',
  /const total = \$derived\(a \+ b\);/.test(
    fixSvelteReactiveStatement('<script>\n  let a = $state(1); let b = $state(2);\n  $: total = a + b;\n</script>').source
  ), true);

// --- an imported value re-declared as a rune ---------------------------------
//
// A Svelte 4 habit with no Svelte 5 meaning: a `$state` exported from a
// `.svelte.ts` module is already reactive at every import site, so wrapping it
// does nothing except collide with the import it wraps. Fatal for the component.
const REDECLARED = [
  '<script lang="ts">',
  "  import { addToCart, appState } from '../lib/store.svelte';",
  "  const appState = $derived(appState());",
  '  const filtered = $derived(getProducts());',
  '</script>',
].join('\n');
const redec = fixSvelteRedeclaredImport(REDECLARED);
check('the re-declaration is deleted', /const appState/.test(redec.source), false);
check('the import survives', /import \{ addToCart, appState \}/.test(redec.source), true);
check('and the unrelated derived is untouched', /const filtered = \$derived\(getProducts\(\)\);/.test(redec.source), true);
check('it says which name', /appState/.test(redec.fixed[0] ?? ''), true);
// `fixSvelteRuneCalledAsFunction` may reach the line first and drop the call, so
// both spellings have to be matched or the order of two repairs decides the fix.
check('the already-uncalled spelling goes too',
  /const appState/.test(fixSvelteRedeclaredImport(REDECLARED.replace('appState())', 'appState)')).source), false);
// Deleting this would silently drop a computation, not a no-op wrapper.
check('a real computation over an imported name stays',
  /const total = \$derived\(cart\.length\)/.test(
    fixSvelteRedeclaredImport("<script>\n  import { total, cart } from './s.svelte';\n  const total = $derived(cart.length);\n</script>").source
  ), true);

// --- a TypeScript cast in the markup -----------------------------------------
const CAST = [
  '<script lang="ts">',
  '  let v = $state(0);',
  '</script>',
  '',
  '<input onchange={(e) => set(parseInt((e.target as HTMLInputElement).value, 10))} />',
].join('\n');
const cast = fixSvelteMarkupTypeAssertion(CAST);
check('the cast is removed', / as HTMLInputElement/.test(cast.source), false);
check('the expression is otherwise intact', /parseInt\(\(e\.target\)\.value, 10\)/.test(cast.source), true);
check('and it is reported as a cast', /as/.test(cast.fixed.join(' ')), true);

/*
 * The three ways this repair can do damage, each measured on the corpus before
 * it shipped. Two of them it actually did.
 */
// 1. `as` is Svelte syntax in a block tag. Stripping it broke three projects
//    that compiled: "An {#each ...} block without an as clause cannot have a key".
const EACH = '<script></script>\n{#each rows as row (row.id)}\n  <li>{row.name}</li>\n{/each}';
check('an {#each ... as ...} keyword is not a cast',
  fixSvelteMarkupTypeAssertion(EACH).source, EACH);
// 2. Outside an expression, `as` is an English word and this is the page's text.
const PROSE = '<script></script>\n<p>HTML (also known as HyperText) is fine.</p>';
check('prose is not an expression', fixSvelteMarkupTypeAssertion(PROSE).source, PROSE);
// 3. Inside a string, it is the text one level down.
const INSTR = '<script></script>\n<p>{label || "known as HTML"}</p>';
check('a string inside an expression is left alone',
  fixSvelteMarkupTypeAssertion(INSTR).source, INSTR);

// --- a Vue router watching location.hash, which Vue cannot watch ---------------------------------
// The spindle Vue run of 2026-09-15: no button navigated, and neither the repair nor the user's edit fixed it.
{
  const NAV = [
    "import { ref, watch } from 'vue'",
    "import type { Route } from '../routes'",
    '',
    "const route = ref<Route>(parse(location.hash))",
    'export function useNavigation() {',
    "  function navigate(to: string) { location.hash = `#/${to}` }",
    '  watch(() => location.hash, (hash) => { route.value = parse(hash) })',
    '  return { route, navigate }',
    '}',
  ].join('\n');
  const broken = new Map([['src/composables/useNavigation.ts', NAV], ['src/App.vue', '<template><main /></template>']]);
  const r = fixVueNonReactiveHash(broken);
  const after = r.files.get('src/composables/useNavigation.ts');
  check('the non-reactive watch is found', r.fixed.length, 1);
  check('its source becomes a ref Vue can watch', after.includes('watch(() => __makeuiHash.value, (hash) =>'), true);
  check('kept current by a hashchange listener at module scope, after the imports',
    /import type \{ Route \} from '\.\.\/routes'\n\n\/\/ A ref Vue can watch[^\n]*\nconst __makeuiHash = ref\(location\.hash\)\nwindow\.addEventListener\('hashchange', \(\) => \{ __makeuiHash\.value = location\.hash \}\)/.test(after), true);
  check('writes to location.hash are left alone', after.includes('location.hash = `#/${to}`'), true);
  check('ref is not imported twice', (after.match(/\bref\b,?/g) ?? []).length >= 1 && !/import \{ ref, ref/.test(after), true);

  const noRefImport = new Map([['src/router.ts', "import { watch, computed } from 'vue'\nexport const current = computed(() => parse(window.location.hash))"]]);
  const c = fixVueNonReactiveHash(noRefImport).files.get('src/router.ts');
  check('a computed getter reading the hash is fixed too, and ref is added to the vue import',
    c.includes('computed(() => parse(__makeuiHash.value))') && c.startsWith("import { ref, watch, computed } from 'vue'"), true);

  const inSfc = new Map([['src/App.vue', "<script setup lang=\"ts\">\nimport { ref, watch } from 'vue'\nconst r = ref('')\nwatch(() => location.hash, (h) => { r.value = h })\n</script>\n<template><main>{{ r }}</main></template>"]]);
  const v = fixVueNonReactiveHash(inSfc).files.get('src/App.vue');
  check('inside a .vue script block, the template untouched', v.includes('watch(() => __makeuiHash.value') && v.endsWith('<template><main>{{ r }}</main></template>'), true);

  const listening = new Map([...broken, ['src/main.ts', "window.addEventListener('hashchange', () => sync())"]]);
  check('a project that already listens for hashchange is left alone', fixVueNonReactiveHash(listening).fixed, []);
  check('and it runs for Vue projects in fixupProject',
    fixupProject(project(fence('src/composables/useNavigation.ts', NAV), fence('src/App.vue', '<template><main /></template>')), 'vue')
      .fixed.some((f) => f.includes('location.hash を watch')), true);
  check('but not for React', fixupProject(project(fence('src/nav.ts', NAV), fence('src/App.tsx', 'export default function App() { return null }')), 'react')
    .fixed.some((f) => f.includes('location.hash を watch')), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
