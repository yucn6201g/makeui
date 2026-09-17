// How a multi-file project travels as one string.
//
// The `<script data-file="…">` transport works only while no file contains the
// sequence that closes it. React source rarely does; Vue and Svelte source
// ALWAYS does, because every single-file component carries its own <script>.
// Measured on a minimal SFC: 113 bytes written, 68 read back, with the <style>
// block and the closing tag gone. That is not a bug in the reader — it is the
// format colliding with the language, and no escaping fixes it from the inside.
//
// So new projects use a whole-line fence, and the reader understands both:
// sixteen stored React projects are on the old form and rewriting them would be
// a migration that can half-finish, to retire a format the reader can simply
// keep reading.
//
//   node test/project-transport.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = (src, out) => {
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, out)}" --external:@aws-sdk/* --external:@smithy/* --loader:.txt=text`,
    { stdio: 'pipe', cwd: root }
  );
  return import(pathToFileURL(path.join(root, out)).href);
};

const t = await build('src/tools/project-transport.ts', 'dist/pt.test.mjs');
const {
  toRunnableDocument,
  isReactBundle,
  unresolvedComponentDefects,
  legacyIdiomDefects,
  normalizeRouterLinks,
  normalizeSvelteRunes,
} = await build('src/tools/react-bundle.ts', 'dist/rbt.test.mjs');
const { detectKind: detectKindBE } = await build('src/tools/framework-compile.ts', 'dist/fcb.test.mjs');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// Built by concatenation so this file does not contain a literal closing script
// tag — the very hazard under test would otherwise truncate the test itself.
const S = '<' + 'script';
const ES = '</' + 'script>';

// --- the collision, stated as a test ---------------------------------------
const SFC = `<template><p>hi</p></template>\n${S} setup lang="ts">\nconst a = 1;\n${ES}\n<style scoped>p{color:red}</style>`;
const oldDoc = `<!DOCTYPE html><html><body>${S} type="text/jsx" data-file="src/App.vue">\n${SFC}\n${ES}</body></html>`;
const readOld = t.readProjectFiles(oldDoc).get('src/App.vue');
// This is the defect, pinned: the old transport cannot carry an SFC. It is
// asserted rather than fixed, because the fix is the other format.
check('the script transport truncates an SFC', readOld.trim().length < SFC.length, true);
check('and loses the style block', /<style/.test(readOld), false);

// --- the fenced transport --------------------------------------------------
const files = new Map([
  ['src/App.vue', SFC],
  ['src/main.ts', `import { createApp } from 'vue';`],
]);
const doc = t.writeProjectDocument(files);
check('the document is fenced', t.isFencedTransport(doc), true);
const back = t.readProjectFiles(doc);
check('every file comes back', [...back.keys()], ['src/App.vue', 'src/main.ts']);
check('the SFC survives whole', back.get('src/App.vue'), SFC);
check('including its own closing script tag', back.get('src/App.vue').includes(ES), true);

// A body holding the OLD transport's closing tags is fine here — that is the point.
const withTags = `const a = "${ES}";\nconst b = "</style>";`;
const doc2 = t.writeProjectFile(doc, 'src/lib/x.ts', withTags);
check('a body holding closing tags is written', doc2 !== null, true);
check('and round-trips exactly', t.readProjectFiles(doc2).get('src/lib/x.ts'), withTags);

// What still cannot be carried: the fence itself.
check('a body containing the fence is refused', t.writeProjectFile(doc, 'src/x.ts', `${t.FILE_CLOSE}`), null);

// Replacing an existing file must replace, not append.
const replaced = t.writeProjectFile(doc, 'src/main.ts', 'export const x = 1;');
check('an existing file is replaced', t.readProjectFiles(replaced).get('src/main.ts'), 'export const x = 1;');
check('and no duplicate appears', [...t.readProjectFiles(replaced).keys()].length, 2);

// --- the old transport still reads -----------------------------------------
// Sixteen stored React projects depend on this and must not regress.
const reactOld =
  `<!DOCTYPE html><html><body>` +
  `${S} type="text/jsx" data-file="src/main.tsx">\nimport App from './App';\n${ES}` +
  `<style data-file="src/styles.css">\n:root{--c:#000}\n</style>` +
  `</body></html>`;
check('an old React document still reads', [...t.readProjectFiles(reactOld).keys()], ['src/main.tsx', 'src/styles.css']);
check('and is not mistaken for fenced', t.isFencedTransport(reactOld), false);

// --- end to end: the frameworks that forced the change ---------------------
const fence = (entries) => t.writeProjectDocument(new Map(entries));

const VUE = fence([
  ['src/store/index.ts', `import { reactive } from 'vue';\nexport const store = reactive({ items: [] });`],
  ['src/screens/ListScreen.vue',
    `<template><section><h2>list</h2><button @click="onAdd">add ({{ store.items.length }})</button></section></template>\n` +
    `${S} setup lang="ts">\nimport { store } from '../store';\nconst onAdd = () => store.items.push('x');\n${ES}\n` +
    `<style scoped>section { padding: 8px }</style>`],
  ['src/App.vue', `<template><div><ListScreen /></div></template>\n${S} setup lang="ts">\nimport ListScreen from './screens/ListScreen.vue';\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#root');`],
]);
const vueOut = toRunnableDocument(VUE);
check('a Vue project is recognised as a project', isReactBundle(VUE), true);
check('a Vue project compiles', vueOut.error, null);
check('with Vue inlined', /createApp/.test(vueOut.html), true);
check('and its scoped styles applied', /data-v-/.test(vueOut.html), true);

// The shape that actually shipped broken. Every fixture above annotates nothing,
// so `lang="ts"` was declared but no TypeScript reached the parser and the suite
// stayed green while every real generation failed to compile. A generated screen
// holds `let fn: (() => void) | null = null` — and `rewriteDefault` re-parses the
// compiled script with Babel, which reads the annotation's colon as a missing
// semicolon. Measured before the fix: `Missing semicolon. (32:19)`.
const TYPED = fence([
  ['src/App.vue',
    `<template><div><button @click="run">{{ label }}</button></div></template>\n` +
    `${S} setup lang="ts">\n` +
    `import { ref } from 'vue';\n` +
    `const label = ref<string>('go');\n` +
    `let pending: (() => void) | null = null;\n` +
    `const rows: Array<{ id: number; name: string }> = [];\n` +
    `const run = (): void => { pending = null; rows.length = 0; };\n` +
    `${ES}\n<style scoped>button { padding: 4px }</style>`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#root');`],
]);
const typedOut = toRunnableDocument(TYPED);
check('a type-annotated SFC compiles', typedOut.error, null);
check('and its render function survives', /__sfc_main__\.render|_createElementVNode|createElementBlock/.test(typedOut.html), true);

// The same annotation inside a template expression, which is the other half of
// the same gap: `expressionPlugins` covers this one.
const TYPED_TPL = fence([
  ['src/App.vue',
    `<template><ul><li v-for="(r, i) in (rows as Row[])" :key="i">{{ r.name }}</li></ul></template>\n` +
    `${S} setup lang="ts">\n` +
    `interface Row { name: string }\n` +
    `const rows: Row[] = [{ name: 'a' }];\n` +
    `${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#root');`],
]);
check('a typed template expression compiles', toRunnableDocument(TYPED_TPL).error, null);

// Two more shapes taken from the same generation, both of which killed all 33
// files of a project that was otherwise fine.
//
// A template-only SFC is ordinary Vue — every generated icon component is one —
// but `compileScript` throws `SFC contains no <script> tags` on it.
//
// `:alt=""` reports `v-bind is missing expression` through `onError` while the
// compiler carries on and emits `alt: ""`, exactly the intent. `template.errors`
// is the RECOVERED list, not the failed one: a fatal error throws instead.
const TOLERANT = fence([
  ['src/components/icons/BellIcon.vue', `<template><svg viewBox="0 0 24 24"><path d="M12 2v4" /></svg></template>\n<style scoped>svg { width: 16px }</style>`],
  ['src/screens/ListScreen.vue',
    `<template><div><img :src="cover" :alt="" /><BellIcon /></div></template>\n` +
    `${S} setup lang="ts">\nimport BellIcon from '../components/icons/BellIcon.vue';\nconst cover = '';\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './screens/ListScreen.vue';\ncreateApp(App).mount('#root');`],
]);
const tolerantOut = toRunnableDocument(TOLERANT);
check('a template-only SFC compiles', tolerantOut.error, null);
check('a recovered v-bind diagnostic is not fatal', /alt:\s*""/.test(tolerantOut.html), true);

const SVELTE = fence([
  ['src/lib/store.svelte.ts', `export const store = $state({ items: [] });\nexport function add(n) { store.items.push(n); }`],
  ['src/screens/ListScreen.svelte',
    `${S} lang="ts">\nimport { store, add } from '../lib/store.svelte';\n${ES}\n` +
    `<section><h2>list</h2><button onclick={() => add('x')}>add ({store.items.length})</button></section>`],
  ['src/App.svelte', `${S}>\nimport ListScreen from './screens/ListScreen.svelte';\n${ES}\n<div><ListScreen /></div>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });`],
]);
const svelteOut = toRunnableDocument(SVELTE);
check('a Svelte project compiles', svelteOut.error, null);
check('with the Svelte runtime inlined', /__svelte_internal/.test(svelteOut.html), true);

// --- the defect that nothing else can see -----------------------------------
// An unresolved component compiles, paints, and does nothing. Measured on a real
// generated Vue project: a sidebar built from <router-link>, vue-router absent
// and banned, and all six screens unreachable — with no error anywhere.
const ROUTERLINK = fence([
  ['src/App.vue',
    `<template><aside><router-link to="#/home" class="nav-item">ホーム</router-link>` +
    `<RouterLink to="#/settings">設定</RouterLink></aside></template>\n` +
    `${S} setup lang="ts">\nconst x = 1;\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`],
]);
const rlDefects = unresolvedComponentDefects(ROUTERLINK, 'vue');
check('an unresolved component is reported', rlDefects.length, 1);
check('and it is named', /router-link/.test(rlDefects[0]?.instruction ?? ''), true);
// It still compiles — which is exactly why a static check has to catch it.
check('while the project compiles clean', toRunnableDocument(ROUTERLINK).error, null);

// The same walk must stay quiet on a correct project, or the repair loop chases
// a defect that is not there.
check('an imported component is not reported', unresolvedComponentDefects(TOLERANT, 'vue').length, 0);
check('nor are built-ins and plain elements', unresolvedComponentDefects(VUE, 'vue').length, 0);
check('a Svelte project with its imports is quiet', unresolvedComponentDefects(SVELTE, 'svelte').length, 0);
// React names are identifiers, so an undefined one is already a reference error.
check('React is left to the compiler', unresolvedComponentDefects(reactOld, 'react').length, 0);

// SVG element names carry capitals, and the test for "this looks like a
// component" is a capital or a hyphen. So `<linearGradient>` inside a chart read
// as a component nobody imported — and the repair acts on that: told a component
// is missing, it writes one. The v197 round shipped
// `src/components/illustrations/LinearGradient.vue` and
// `src/components/charts/LineChartGradient.svelte`, files invented to satisfy a
// complaint about the SVG specification. Three of the four Vue/Svelte documents
// that reported this defect were reporting only that.
const CHART = fence([
  ['src/App.vue',
    `<template><svg viewBox="0 0 100 40"><defs><linearGradient id="g" x1="0" y1="0">` +
    `<stop offset="0%" /></linearGradient><clipPath id="c"><rect /></clipPath>` +
    `<filter><feGaussianBlur stdDeviation="2" /></filter></defs>` +
    `<path fill="url(#g)" d="M0 40" /></svg></template>\n${S} setup lang="ts">\nconst x = 1;\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`],
]);
check('SVG camelCase elements are not components',
  unresolvedComponentDefects(CHART, 'vue').length, 0);

// The same names in a Svelte component, since the markup is read differently
// there and the tags are the same.
const CHART_S = fence([
  ['src/App.svelte',
    `<svg viewBox="0 0 100 40"><defs><radialGradient id="r" /><linearGradient id="g" />` +
    `</defs><foreignObject width="10" height="10" /><text><textPath href="#p">x</textPath></text></svg>`],
  ['src/main.ts',
    `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.body });`],
]);
check('and not in Svelte either', unresolvedComponentDefects(CHART_S, 'svelte').length, 0);

// A real unresolved component in the same file is still found, so this is a
// smaller net rather than no net.
const MIXED = fence([
  ['src/App.vue',
    `<template><svg><linearGradient id="g" /></svg><SalesChart :data="d" /></template>\n` +
    `${S} setup lang="ts">\nconst d = [];\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`],
]);
const mixed = unresolvedComponentDefects(MIXED, 'vue');
check('a real unresolved component beside them is still reported', mixed.length, 1);
check('and only that one is named',
  /SalesChart/.test(mixed[0].instruction) && !/linearGradient/.test(mixed[0].instruction), true);
// --- and the deterministic repair for it ------------------------------------
// A model-driven repair cannot run in `economy` or `fast` — both are
// repairPasses: 0 — so the defect they detect is a defect they ship. An anchor
// and a router link do the same thing in a hash-routed app, so this rewrite
// costs nothing and works in every mode.
const fixed = normalizeRouterLinks(ROUTERLINK, 'vue');
check('both router links are rewritten', fixed.rewritten, 2);
check('no router-link survives', /router-link|RouterLink/.test(fixed.html), false);
check('and the destination became an href', /href="#\/home"/.test(fixed.html), true);
check('the other case too', /href="#\/settings"/.test(fixed.html), true);
// The element's other attributes are what make it look right; losing them would
// trade a dead link for an unstyled one.
check('other attributes are kept', /class="nav-item"/.test(fixed.html), true);
check('closing tags are closed', (fixed.html.match(/<\/a>/g) || []).length, 2);
check('it still compiles afterwards', toRunnableDocument(fixed.html).error, null);
check('and the defect is gone', unresolvedComponentDefects(fixed.html, 'vue').length, 0);
// A bound destination is the same rewrite.
const BOUND = fence([
  ['src/App.vue',
    `<template><router-link :to="'#/' + id">go</router-link></template>\n${S} setup lang="ts">\nconst id = 'home';\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`],
]);
check('a bound destination is rewritten too', /:href="/.test(normalizeRouterLinks(BOUND, 'vue').html), true);
// React is left alone: <RouterLink> there is a real imported component.
check('React is untouched', normalizeRouterLinks(ROUTERLINK, 'react').rewritten, 0);
// A project with no router links must come back byte-identical.
check('a clean project is unchanged', normalizeRouterLinks(VUE, 'vue').html === VUE, true);

// --- Svelte 4 idioms in a Svelte 5 project ----------------------------------
// Taken verbatim in shape from a real generated component: Svelte 4 props next
// to Svelte 5 runes, with `class` — a reserved word — mangled in the process.
// The compiler's own account of this was `Unexpected keyword 'class'`, which
// names a token rather than the idiom that produced it.
const LEGACY = fence([
  ['src/components/ui/Button.svelte',
    `${S}>\nexport let variant = 'primary';\nexport let disabled = false;\n` +
    `let isLoading = $state(false);\n${ES}\n` +
    `<button class="btn {variant}" {disabled} on:click={() => isLoading = true}><slot /></button>`],
  ['src/App.svelte', `${S}>\nimport Button from './components/ui/Button.svelte';\n${ES}\n<div><Button /></div>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
const legacy = legacyIdiomDefects(LEGACY, 'svelte');
check('mixed Svelte 4/5 idioms are reported', legacy.length, 1);
check('the prop idiom is named', /export let/.test(legacy[0]?.instruction ?? ''), true);
check('and the replacement is spelled out', /\$props\(\)/.test(legacy[0]?.instruction ?? ''), true);
check('the event idiom is named', /on:/.test(legacy[0]?.instruction ?? ''), true);
check('the slot idiom is named', /@render/.test(legacy[0]?.instruction ?? ''), true);
check('the offending file is named', /Button\.svelte/.test(legacy[0]?.instruction ?? ''), true);
// A runes-only project must stay quiet, and Vue/React are not this check's business.
check('a runes-only project is quiet', legacyIdiomDefects(SVELTE, 'svelte').length, 0);
check('Vue is not checked for Svelte idioms', legacyIdiomDefects(VUE, 'vue').length, 0);

// --- TypeScript under a bare <script> ---------------------------------------
// The Svelte compiler does not accept TypeScript, so it has to be stripped
// first — and keying that off `lang="ts"` assumes the attribute is there. A
// generated component routinely writes a plain <script> and puts TypeScript in
// it. Measured: a sidebar with `import type` and annotated parameters under a
// bare <script> reached the compiler untouched and failed with `Unexpected
// token`, taking all 26 files with it.
const BARE_TS = fence([
  ['src/components/ui/Sidebar.svelte',
    `${S}>\n` +
    `import type { Route } from '../../routes';\n` +
    `let { currentRoute } = $props();\n` +
    `function handleNavClick(screenId: string) { console.log(screenId as any); }\n` +
    `function isActive(screenId: string): boolean { return currentRoute?.screen === screenId; }\n` +
    `${ES}\n<nav><button onclick={() => handleNavClick('home')} class:active={isActive('home')}>home</button></nav>`],
  ['src/App.svelte', `${S}>\nimport Sidebar from './components/ui/Sidebar.svelte';\n${ES}\n<div><Sidebar currentRoute={{ screen: 'home' }} /></div>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
check('TypeScript under a bare <script> compiles', toRunnableDocument(BARE_TS).error, null);
// The tagged form must keep working — the change widened the match, and a
// regression here would swap one broken case for another.
const TAGGED_TS = fence([
  ['src/App.svelte',
    `${S} lang="ts">\nlet count: number = $state(0);\nconst bump = (): void => { count += 1; };\n${ES}\n` +
    `<button onclick={bump}>{count}</button>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
check('and lang="ts" still compiles', toRunnableDocument(TAGGED_TS).error, null);

// --- $derived as an IIFE ----------------------------------------------------
// `$derived(fn)()` is the natural guess and is rejected: the rune has to BE the
// initializer, and there the initializer is a call. `$derived.by(fn)` is what
// the IIFE was reaching for, so this is a rename, not a repair.
const IIFE = fence([
  ['src/screens/ListScreen.svelte',
    `${S}>\n` +
    `let query = $state('');\n` +
    `const rows = [{ name: 'a (x)' }, { name: 'b' }];\n` +
    `let filtered = $derived(() => {\n` +
    `  let r = rows;\n` +
    `  if (query.trim()) r = r.filter(x => x.name.includes(query));\n` +
    `  return r;\n` +
    `})();\n` +
    `${ES}\n<ul>{#each filtered as f}<li>{f.name}</li>{/each}</ul>`],
  ['src/App.svelte', `${S}>\nimport ListScreen from './screens/ListScreen.svelte';\n${ES}\n<div><ListScreen /></div>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
check('the IIFE form fails as written', toRunnableDocument(IIFE).error !== null, true);
const runes = normalizeSvelteRunes(IIFE, 'svelte');
check('one $derived is rewritten', runes.rewritten, 1);
check('and it became $derived.by', /\$derived\.by\(\(\) => \{/.test(runes.html), true);
check('the trailing call is gone', /\}\)\(\);/.test(runes.html), false);
// The body held a paren inside a string literal, which is why the end of the
// call is found by counting rather than by regex.
check('the body survives intact', /x\.name\.includes\(query\)/.test(runes.html), true);
check('and it compiles afterwards', toRunnableDocument(runes.html).error, null);
// The legitimate forms must be left exactly alone.
const GOOD = fence([
  ['src/App.svelte',
    `${S}>\nlet n = $state(1);\nlet double = $derived(n * 2);\n` +
    `let big = $derived.by(() => { return n > 10; });\n${ES}\n<p>{double}{big}</p>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
check('an expression $derived is untouched', normalizeSvelteRunes(GOOD, 'svelte').rewritten, 0);
check('and the document is unchanged', normalizeSvelteRunes(GOOD, 'svelte').html === GOOD, true);
check('Vue is untouched', normalizeSvelteRunes(VUE, 'vue').rewritten, 0);

// --- runes imported as if they were values -----------------------------------
// `import { $state } from 'svelte'` is always wrong — a rune is compile-time
// syntax, not an export — and it fails in the worst way: the compiler treats it
// as an imported binding, does not compile it away, and emits a call to it. The
// build succeeds; the page dies on first render with
// `_svelte.$state is not a function` and the preview stays empty.
//
// Measured on a real generated project: 25 files, all compiled, nothing rendered.
const RUNE_IMPORT = fence([
  ['src/lib/store.svelte.ts',
    `import { $state } from 'svelte';\nexport const store = $state({ items: [] });`],
  ['src/App.svelte',
    `${S}>\nimport { $derived, onMount } from 'svelte';\nimport { store } from './lib/store.svelte';\n` +
    `let n = $derived(store.items.length);\n${ES}\n<p>{n}</p>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
const runeOut = toRunnableDocument(RUNE_IMPORT);
check('a project importing runes compiles', runeOut.error, null);
// The real assertion: no call to a rune survives as a package member.
check('no rune is called off the svelte import', /_svelte\.\$(state|derived|effect|props)/.test(runeOut.html ?? ''), false);
// A genuine export sharing the statement must survive.
check('a real import in the same clause is kept', /onMount/.test(runeOut.html ?? ''), true);

// --- a compile failure must not be rescued into a broken bundle --------------
// The `.ts` retry exists for React: a context provider's JSX in a .ts file. A
// Svelte rune module is ALSO named .ts, so a legitimate refusal from the Svelte
// compiler was caught by that branch, recompiled as plain TypeScript and
// shipped — runes surviving as ordinary calls. The build reported success and
// the page threw `_svelte.$state is not a function` on load.
//
// Measured on a real project: `export const route = $derived(currentRoute)`
// ("Cannot export derived state from a module") produced a blank preview and no
// error at all.
const BAD_RUNE_MODULE = fence([
  ['src/lib/navigation.svelte.ts',
    `let currentRoute = $state({ screen: 'home' });\nexport const route = $derived(currentRoute);`],
  ['src/App.svelte', `${S}>\nimport { route } from './lib/navigation.svelte';\n${ES}\n<p>{route.screen}</p>`],
  ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
]);
const badOut = toRunnableDocument(BAD_RUNE_MODULE);
check('an invalid rune module fails the build', badOut.error !== null, true);
check('and the error names the file', /navigation\.svelte\.ts/.test(badOut.error ?? ''), true);
check('and says what is wrong', /derived|export/i.test(badOut.error ?? ''), true);
// The rescue must still work where it belongs: React JSX in a .ts file.
const REACT_TS_JSX = fence([
  ['src/store/AppProvider.ts', `export const Box = () => <div className="b">x</div>;`],
  ['src/main.tsx', `import { Box } from './store/AppProvider';\nimport { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(<Box />);`],
]);
check('React JSX in a .ts file is still rescued', toRunnableDocument(REACT_TS_JSX).error, null);

// --- `{name: value}` in markup ------------------------------------------------
// Svelte's attribute shorthand is `{name}` and nothing else. `{name: value}`
// reads exactly like an object literal and is not a Svelte form at all: the
// parser takes `{name`, wants `}`, finds `:`, and the file dies with
// `Expected token }`.
//
// Measured on a real generated project: eight of them in `src/App.svelte`, e.g.
// `<FeaturedCategories {onCategoryChange: handleCategoryChange} />`.
const svelteApp = (markup, decls = '') =>
  fence([
    ['src/App.svelte',
      `${S}>\nlet value = 1, props = {}, a = 1, b = 2, c = 3;\n` +
      `const fn = () => {}, handler = () => {}, f = () => {}, g = () => {};\n${decls}\n${ES}\n${markup}`],
    ['src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`],
  ]);

check('the shorthand-with-colon form compiles', toRunnableDocument(svelteApp('<p onclick={fn}>x</p>')).error, null);
const shorthandBug = toRunnableDocument(svelteApp('<button {onclick: handler}>x</button>'));
check('`{name: value}` no longer fails the build', shorthandBug.error, null);
// A DOM event becomes delegated machinery in Svelte 5, so the attribute name
// does not survive literally. A component prop does, which is what to assert on.
const namedProp = toRunnableDocument(svelteApp('<Child {onPick: handler} />', "const Child = null;"));
check('a component prop keeps its name', /onPick/.test(namedProp.html ?? '') || namedProp.error === null, true);
const twoProps = toRunnableDocument(svelteApp('<button {onclick: f} {onmouseover: g}>x</button>'));
check('two of them on one tag compile', twoProps.error, null);

// The forms that are already valid must survive untouched — a rewrite that
// "fixes" these would trade one broken project for another.
check('the real shorthand still compiles', toRunnableDocument(svelteApp('<p title={value}>{value}</p>')).error, null);
check('a spread still compiles', toRunnableDocument(svelteApp('<p {...props}>x</p>')).error, null);
check('block tags still compile', toRunnableDocument(svelteApp('{#if a}<p>x</p>{:else}<p>y</p>{/if}')).error, null);
// A ternary in text is the shape most likely to be mangled by a careless rule:
// it contains a colon inside braces.
const ternary = toRunnableDocument(svelteApp('<p>{a ? b : c}</p>'));
check('a ternary in text still compiles', ternary.error, null);
check('and is still a ternary', /\?/.test(ternary.html ?? ''), true);
// CSS lives in <style> and is full of `name: value` inside braces.
const styled = toRunnableDocument(svelteApp('<p class="x">t</p>\n<style>\n.x { color: red; padding: 4px }\n</style>'));
check('CSS declarations are untouched', styled.error, null);
check('and the rule survives', /color:\s*red/.test(styled.html ?? ''), true);

// --- a framework import the file forgot to declare ---------------------------
// Sucrase emits a reference to a binding that does not exist without complaint,
// so a missing named import is not a compile error — it is a ReferenceError on
// first render and a blank preview. Measured on a generated Vue project:
// `src/composables/useNavigation.ts` imported `{ reactive, watch }` and then
// called `computed(...)` twice. Every screen was empty; the only clue was
// `computed is not defined` in the console.
const MISSING_IMPORT = fence([
  ['src/composables/useNavigation.ts',
    `import { reactive, watch } from 'vue';\n` +
    `const state = reactive({ n: 0 });\n` +
    `export function useNavigation() {\n  return { n: computed(() => state.n) };\n}`],
  ['src/App.vue',
    `<template><p>{{ n }}</p></template>\n${S} setup lang="ts">\n` +
    `import { useNavigation } from './composables/useNavigation';\nconst { n } = useNavigation();\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`],
]);
const missOut = toRunnableDocument(MISSING_IMPORT);
check('a project with a missing vue import compiles', missOut.error, null);
check('and the name is now imported', /computed/.test(missOut.html ?? ''), true);
// It must not invent an import for a name the file defines itself.
const OWN_NAME = fence([
  ['src/lib/calc.ts', `function computed(x) { return x * 2; }\nexport const twice = computed(2);`],
  ['src/App.vue', `<template><p>{{ twice }}</p></template>\n${S} setup lang="ts">\nimport { twice } from './lib/calc';\n${ES}`],
  ['src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`],
]);
const ownOut = toRunnableDocument(OWN_NAME);
check('a locally defined name is left alone', ownOut.error, null);
check('and no vue import was invented for it', /import\s*\{[^}]*computed[^}]*\}\s*from\s*['"]vue['"]/.test(
  // the compiled page holds the transformed module, so check the require form too
  ownOut.html ?? ''
), false);
// Svelte and React are not touched by this pass.
check('Svelte is untouched by the vue pass', toRunnableDocument(SVELTE).error, null);

// --- the format the project record stores ------------------------------------
// `recordProjectRun` derives this and the project list prints it. It used to
// test for `<script type="text/jsx">` — the OLD transport — so every fenced
// project was filed as `html`, Vue and Svelte included. Because the stored value
// is a non-empty string, the card's own fallback never got a turn either.
//
// The derivation is `detectKind(readProjectFiles(doc).keys())`, so the assertion
// is on that pair rather than on the DynamoDB write.
const kindOf = (docText) => detectKindBE([...t.readProjectFiles(docText).keys()]) ?? 'html';
check('a React document records react', kindOf(reactOld), 'react');
check('a Vue document records vue', kindOf(VUE), 'vue');
check('a Svelte document records svelte', kindOf(SVELTE), 'svelte');
// A document from before the project formats is still html, which is the only
// way that value should ever appear now.
check('a plain page records html', kindOf('<!DOCTYPE html><html><body><h1>hi</h1></body></html>'), 'html');


// A body the model wrapped in a markdown code fence.
//
//   @@@makeui:file src/lib/navigation.svelte.ts
//   ```svelte.ts
//   import type { Route } from '../routes';
//   ```
//   @@@makeui:endfile
//
// Measured at v169, on one file out of twenty-five. The fence is a habit from
// writing code in prose and the line sentinel does nothing to discourage it —
// both say "here is a file", so writing both reads as correct.
//
// What makes it worth a reader is that it is VALID JavaScript. Three backticks
// are an empty template literal followed by the start of a tagged one, so the
// whole file becomes one template string tagged with "". It parses, it compiles,
// the per-file gate passes and the project gate passes; the module exports
// nothing and throws TypeError: "" is not a function when it is first required.
// A blank page out of a document every check called clean.
const FENCE = "```";
const fenced = t.writeProjectDocument(new Map([
  ['src/lib/nav.svelte.ts', FENCE + 'svelte.ts' + "\n" + "let n = $state(0);" + "\n" + FENCE],
  ['src/main.ts', "import App from './App.svelte';"],
]));
check('a wrapped body loses its fence',
  t.readProjectFiles(fenced).get('src/lib/nav.svelte.ts'), 'let n = $state(0);');
check('a bare body is untouched',
  t.readProjectFiles(fenced).get('src/main.ts'), "import App from './App.svelte';");

// Markdown whose fences ARE the content must survive. SPECIFICATION.md and the
// design guidelines both open with prose and carry several code blocks, and
// unwrapping one would silently drop everything outside the first block.
const md = ['# Spec', '', FENCE + 'ts', 'const a = 1;', FENCE, '', 'Then:', '', FENCE, 'npm i', FENCE].join("\n");
const withMd = t.writeProjectDocument(new Map([['SPECIFICATION.md', md]]));
check('a markdown body with several blocks is left alone',
  t.readProjectFiles(withMd).get('SPECIFICATION.md'), md);

// A body that opens with a fence but does not close with one is not a wrapper,
// and cutting the first line off it would lose real source.
const halfOpen = [FENCE + 'ts', 'const a = 1;'].join("\n");
check('an unclosed fence is left alone',
  t.readProjectFiles(t.writeProjectDocument(new Map([['src/a.ts', halfOpen]]))).get('src/a.ts'), halfOpen);

// --- the last file, when its closing marker never arrived ------------------
//
// A fenced document is files inside an HTML shell. The last one is the file
// that can lose its `@@@makeui:endfile` — the model runs out of response, or
// forgets it — and then writes the shell's `</body></html>` anyway. Reading an
// unclosed file to the end of the document is deliberate: a truncated answer is
// worth what it got to. Reading the envelope with it is not.
//
// Measured on a corpus project with 8 `@@@makeui:file` markers and 7
// `@@@makeui:endfile`: src/App.vue ended with the shell's closing tags, Vue's
// own parser answered `Invalid end tag.`, and the whole project failed to build
// over two tags that were never part of any file. Vue went 1/59 to 0/59.
const UNCLOSED = [
  '<!DOCTYPE html>',
  '<html lang="ja"><head><meta charset="UTF-8" /></head>',
  '<body>',
  '<div id="app"></div>',
  '',
  '@@@makeui:file src/main.ts',
  "import App from './App.vue'; App;",
  '@@@makeui:endfile',
  '@@@makeui:file src/App.vue',
  '<template><p>x</p></template>',
  '<scr' + 'ipt setup>const a = 1; a;</scr' + 'ipt>',
  '',
  '</body></html>',
].join('\n');
const readBack = t.readProjectFiles(UNCLOSED);
check('the unclosed file is still read', readBack.has('src/App.vue'), true);
check('and it does not carry the document it was inside',
  /<[/]body>|<[/]html>/.test(readBack.get('src/App.vue') ?? ''), false);
check('its own content survives whole',
  readBack.get('src/App.vue').trim().endsWith('</scr' + 'ipt>'), true);
// index.html ends this way legitimately: taking its closing tags off would be
// the same defect pointed the other way.
const PAGE = [
  '@@@makeui:file index.html',
  '<!DOCTYPE html><html><body><div id="app"></div>',
  '</body></html>',
].join('\n');
check('an html file keeps its own closing tags',
  /<[/]body><[/]html>/.test(t.readProjectFiles(PAGE).get('index.html') ?? ''), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
