// The preview's own compiler, which is a deliberate twin of the backend's
// (backend/src/tools/framework-compile.ts). They are separate because one runs
// in a Lambda and one in a browser, and the cost of that is drift: a fix made on
// one side and forgotten on the other shows up as "it previews fine but the
// stored project is broken", or the reverse.
//
// So this pins the cases that actually broke, on this side. All three came from
// one real generated Vue project, and each of them took the whole project down.
//
//   node test/framework-compile.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as sucrase from 'sucrase';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/utils/frameworkCompile.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/fc.test.mjs')}" "--external:virtual:*" ` +
    // Node resolves the bare specifier to the CJS build, which drags in
    // consolidate's optional template engines and cannot be bundled. Vite gives
    // the app the browser build; this is the same choice, stated for node.
    `"--alias:@vue/compiler-sfc=@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js"`,
  { stdio: 'pipe', cwd: root }
);
const fc = await import(pathToFileURL(path.join(root, 'dist-test/fc.test.mjs')).href);

let pass = 0,
  fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const compile = async (path_, src) => {
  try {
    return { ok: true, ...(await fc.compileFile('vue', path_, src, sucrase)) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
};

// Built by concatenation so this file holds no literal closing script tag.
const S = '<' + 'script';
const ES = '</' + 'script>';

// 1. Type annotations. `rewriteDefault` re-parses the COMPILED script with Babel
//    and `compileScript` leaves the types in, so without the typescript plugin
//    the annotation's colon reads as a missing semicolon. Measured on a real
//    generation: `Missing semicolon. (32:19)`.
const typed = await compile(
  'src/App.vue',
  `<template><button @click="run">{{ label }}</button></template>\n` +
    `${S} setup lang="ts">\n` +
    `import { ref } from 'vue';\n` +
    `const label = ref<string>('go');\n` +
    `let pending: (() => void) | null = null;\n` +
    `const rows: Array<{ id: number; name: string }> = [];\n` +
    `const run = (): void => { pending = null; rows.length = 0; };\n` +
    `${ES}\n<style scoped>button { padding: 4px }</style>`
);
check('a type-annotated SFC compiles', typed.ok, true);
check('and keeps its scoped style', typeof typed.css === 'string' && typed.css.includes('data-v-'), true);

// 2. A template-only SFC is ordinary Vue — every generated icon is one — but
//    `compileScript` throws `SFC contains no <script> tags` on it.
const iconOnly = await compile(
  'src/components/icons/BellIcon.vue',
  `<template><svg viewBox="0 0 24 24"><path d="M12 2v4" /></svg></template>\n<style scoped>svg { width: 16px }</style>`
);
check('a template-only SFC compiles', iconOnly.ok, true);
check('and still renders something', /createElementVNode|createElementBlock|openBlock/.test(iconOnly.code ?? ''), true);

// 3. `template.errors` is what the compiler RECOVERED from, not what failed — a
//    fatal error throws instead. `:alt=""` reports `v-bind is missing
//    expression` and Vue emits `alt: ""` anyway, which is the intent.
const recovered = await compile(
  'src/screens/ListScreen.vue',
  `<template><img :src="cover" :alt="" /></template>\n${S} setup lang="ts">\nconst cover = '';\n${ES}`
);
check('a recovered v-bind diagnostic is not fatal', recovered.ok, true);
check('and the attribute survives', /alt:\s*""/.test(recovered.code ?? ''), true);

// The tolerance above must not become "nothing ever fails". The script is where
// a fatal error actually comes from — measured, the template compiler recovered
// from every malformation tried against it (unparseable interpolation, `v-for="x in"`,
// an unclosed tag, a truncated handler, a truncated v-if: five errors reported,
// five render functions emitted). So the script is what this checks.
const badScript = await compile(
  'src/Bad.vue',
  `<template><p>{{ x }}</p></template>\n${S} setup lang="ts">\nconst x = ;\n${ES}`
);
check('a broken script still fails', badScript.ok, false);
// And the parse stage, which is the other place a fatal error can come from.
const badBlocks = await compile('src/Bad2.vue', `<template><p>hi</p></template>\n<template><p>again</p></template>`);
check('a malformed SFC still fails', badBlocks.ok, false);

// --- the gate in front of all of this ----------------------------------------
// `Preview` asks one question before compiling anything: is this a project I can
// build? That gate was `.jsx || .tsx` — React and nothing else — so a Vue or
// Svelte project was refused, the frame fell back to rendering the stored
// document as a page, and the user saw the project's own source text.
//
// The builder had already been generalised. Only the gate was left behind, which
// is why the symptom looked like a compiler failure when nothing had reached the
// compiler. It is asked of `detectKind` now, the same function the builder uses
// to choose a runtime, so the two cannot disagree.
execSync(
  `npx esbuild "${path.join(root, 'src/utils/frameworkCompile.ts')}" --bundle --platform=node --format=esm ` +
    `--outfile="${path.join(root, 'dist-test/dk.test.mjs')}" "--external:virtual:*" ` +
    `"--alias:@vue/compiler-sfc=@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js"`,
  { stdio: 'pipe', cwd: root }
);
const dk = await import(pathToFileURL(path.join(root, 'dist-test/dk.test.mjs')).href);
const asFiles = (paths) => paths.map((p) => ({ path: p, content: '', lang: 'js' }));

check('React is detected', dk.detectKind(asFiles(['src/main.tsx', 'src/App.tsx'])), 'react');
check('Vue is detected', dk.detectKind(asFiles(['src/main.ts', 'src/App.vue'])), 'vue');
// A stored document that is genuinely just a page must still be refused, or the
// preview would try to compile a web page.
check('a plain page is not a project', dk.detectKind(asFiles(['index.html'])), null);

// --- compiling must never evaluate a string ------------------------------------
//
// The app is served under `script-src 'self' 'unsafe-inline'`. No 'unsafe-eval',
// so anything reaching for `new Function` during a compile takes the whole
// project down with a CSP error rather than a build error anyone can act on:
//
//   src/screens/ChurnScreen.vue: Evaluating a string as JavaScript violates the
//   following Content Security Policy directive…
//
// Vue's own optimiser does exactly that. With static hoisting on, `cacheStatic`
// hands runs of static nodes to `transformHoist` — hardcoded by compiler-dom to
// `stringifyStatic` — which collapses them into one `createStaticVNode` string
// and constant-folds their bound attributes through `new Function`.
//
// Two conditions have to meet, which is why it stayed hidden: a run of twenty
// static nodes (`nc >= 20 || ec >= 5`) AND a constant binding among them to
// fold. Plain static attributes stringify without evaluating anything. Reported
// on a Sonnet-built ChurnScreen; the same pipeline on Haiku had never written a
// static block long enough to reach the threshold.
//
// The Function constructor is trapped here because node has no CSP of its own,
// and the property under test is exactly "did the compile evaluate a string".
const churnScreen = (binding) => {
  const rows = Array.from({ length: 24 }, (_, i) =>
    `<li class="row"${binding ? ` :style="{ width: '${40 + i}%' }"` : ''}><span>指標${i}</span></li>`
  ).join('\n');
  return [
    '<template>', '<section class="churn">', '<h1>解約分析</h1>', '<ul>', rows, '</ul>',
    '</section>', '</template>',
    '<script setup lang="ts">', "const label = '解約率';", '</script>',
  ].join('\n');
};

const compileUnderCsp = async (src) => {
  const RealFunction = globalThis.Function;
  let attempts = 0;
  globalThis.Function = new Proxy(RealFunction, {
    construct() {
      attempts++;
      throw new EvalError('Evaluating a string as JavaScript violates the following Content Security Policy directive');
    },
  });
  try {
    const out = await fc.compileFile('vue', 'src/screens/ChurnScreen.vue', src, sucrase);
    return { ok: true, attempts, staticVNode: /createStaticVNode/.test(out.code) };
  } catch (e) {
    return { ok: false, attempts, error: String(e.message || e) };
  } finally {
    globalThis.Function = RealFunction;
  }
};

const bound = await compileUnderCsp(churnScreen(true));
check('a static-heavy screen with constant bindings compiles under CSP', bound.ok, true);
check('and evaluated nothing on the way', bound.attempts, 0);
// The direct cause: no stringification means nothing to constant-fold.
check('static stringification stayed off', bound.staticVNode, false);

// The same screen without bindings was always survivable — it stringified but
// had no expression to fold — so it must not regress either.
const plain = await compileUnderCsp(churnScreen(false));
check('the same screen without bindings still compiles', plain.ok, true);
check('and it too evaluates nothing', plain.attempts, 0);

// Below the threshold, and never affected; here so the fix is not silently
// doing something to ordinary components.
const small = await compileUnderCsp('<template><div :style="{ width: \'50%\' }">こんにちは</div></template>');
check('an ordinary small component is unaffected', small.ok, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
