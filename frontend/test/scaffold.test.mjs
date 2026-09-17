// What turns generated sources into a project a developer can continue.
//
// The claim this module makes is "npm install && npm run dev", and it was true
// of exactly one of the three formats. `toProjectFiles` opened with a `hasReact`
// test and returned the input untouched for anything else, so a Vue or Svelte
// project downloaded as a bare `src/` — no manifest, no vite config, no entry
// document, no readme. Nothing to install and nothing to run.
//
// The second failure would have survived adding a manifest, and is the reason
// the mount assertions are here. The entry document hard-coded `<div id="root">`
// while Vue mounts on `#app` and Svelte targets `#app`, so a downloaded Vue
// project installed, built, served — and rendered a blank page. The preview
// could not show it, because the preview injects its own mount element.
//
// The dependency assertions come from running the thing: pairing vite 5 with
// @sveltejs/vite-plugin-svelte@5 fails `npm install` outright with ERESOLVE,
// which a file-list test cannot see.
//
//   node test/scaffold.test.mjs      (from frontend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const [src, out] of [
  ['src/utils/scaffold.ts', 'dist-test/scaffold.test.mjs'],
  ['src/utils/virtualFs.ts', 'dist-test/vfs-scaffold.test.mjs'],
]) {
  execSync(
    `npx esbuild "${path.join(root, src)}" --bundle --platform=node --format=esm ` +
      `--outfile="${path.join(root, out)}"`,
    { stdio: 'pipe', cwd: root }
  );
}
const { toProjectFiles } = await import(
  pathToFileURL(path.join(root, 'dist-test/scaffold.test.mjs')).href
);
const { splitHtmlToFiles } = await import(
  pathToFileURL(path.join(root, 'dist-test/vfs-scaffold.test.mjs')).href
);

let pass = 0,
  fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const fence = (p, body) => `@@@makeui:file ${p}\n${body}\n@@@makeui:endfile\n`;
const doc = (...blocks) =>
  `<!DOCTYPE html><html><body><div id="root"></div>\n${blocks.join('')}</body></html>`;

const REACT = doc(
  fence('src/main.tsx', `import { createRoot } from 'react-dom/client';\ncreateRoot(document.getElementById('root')).render(<App />);`),
  fence('src/App.tsx', `export default function App() { return <div />; }`),
  fence('src/routes.ts', `export type ScreenId = 'list';`),
  fence('src/screens/ListScreen.tsx', `export default function ListScreen() { return <section />; }`),
  fence('src/styles/globals.css', ':root{--a:#000}')
);
const VUE = doc(
  fence('src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`),
  fence('src/App.vue', `<template><div /></template>\n<script setup lang="ts"></script>`),
  fence('src/routes.ts', `export type ScreenId = 'list';`),
  fence('src/screens/ListScreen.vue', `<template><section /></template>`),
  fence('src/styles/globals.css', ':root{--a:#000}')
);
const SVELTE = doc(
  fence('src/main.ts', `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app') });`),
  fence('src/App.svelte', `<div />`),
  fence('src/routes.ts', `export type ScreenId = 'list';`),
  fence('src/screens/ListScreen.svelte', `<section />`),
  fence('src/styles/globals.css', ':root{--a:#000}')
);

const build = (source) => {
  const files = toProjectFiles(splitHtmlToFiles(source), 'Stock App');
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  return {
    paths: files.map((f) => f.path),
    read: (p) => byPath.get(p),
    pkg: JSON.parse(byPath.get('package.json') ?? '{}'),
  };
};

// --- every framework gets a project, not just React ------------------------
const REQUIRED = ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'README.md', '.gitignore'];
for (const [name, source] of [['react', REACT], ['vue', VUE], ['svelte', SVELTE]]) {
  const p = build(source);
  check(`${name}: the files that make it a project are all there`,
    REQUIRED.filter((f) => !p.paths.includes(f)), []);
  check(`${name}: the generated sources are still in it`,
    p.paths.includes('src/routes.ts'), true);
  check(`${name}: npm install has something to install`,
    Object.keys(p.pkg.devDependencies ?? {}).length > 0, true);
  check(`${name}: npm run dev exists`, p.pkg.scripts?.dev, 'vite');
}

// --- the entry document has to match the code ------------------------------
check('react mounts on #root', /<div id="root">/.test(build(REACT).read('index.html')), true);
check('vue mounts on #app', /<div id="app">/.test(build(VUE).read('index.html')), true);
check('svelte mounts on #app', /<div id="app">/.test(build(SVELTE).read('index.html')), true);
check('and the script tag points at the real entry file',
  /src="\/src\/main\.ts"/.test(build(VUE).read('index.html')), true);

// A project that names its own mount element wins over the convention: the
// document is generated around the code, not the other way round.
const ODD = doc(
  fence('src/main.ts', `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#makeui-root');`),
  fence('src/App.vue', `<template><div /></template>`)
);
check('an unconventional mount id is honoured',
  /<div id="makeui-root">/.test(build(ODD).read('index.html')), true);

// --- the toolchain each framework actually needs ---------------------------
check('react gets the react plugin', Object.keys(build(REACT).pkg.devDependencies).includes('@vitejs/plugin-react'), true);
check('vue gets the vue plugin', Object.keys(build(VUE).pkg.devDependencies).includes('@vitejs/plugin-vue'), true);
check('svelte gets the svelte plugin', Object.keys(build(SVELTE).pkg.devDependencies).includes('@sveltejs/vite-plugin-svelte'), true);

// `tsc` cannot read a .vue or a .svelte file, so a typecheck script that says
// `tsc --noEmit` for them checks none of the components and reports success.
check('vue typechecks with vue-tsc', build(VUE).pkg.scripts.typecheck, 'vue-tsc --noEmit');
check('svelte typechecks with svelte-check',
  build(SVELTE).pkg.scripts.typecheck.startsWith('svelte-check'), true);
check('react typechecks with tsc', build(REACT).pkg.scripts.typecheck, 'tsc --noEmit');

// @sveltejs/vite-plugin-svelte@5 declares `peer vite@^6.0.0`. With vite ^5 the
// install fails with ERESOLVE and the developer never reaches the app.
check('the svelte plugin and vite agree on a major',
  build(SVELTE).pkg.devDependencies.vite.startsWith('^6'), true);
// vite.config.ts is inside `include`, and Vite's types reference Node's.
for (const [name, source] of [['react', REACT], ['vue', VUE], ['svelte', SVELTE]]) {
  check(`${name}: the types vite.config.ts needs are declared`,
    Object.keys(build(source).pkg.devDependencies).includes('@types/node'), true);
}

// --- a document that is not a project is left alone ------------------------
// A stored HTML mock predates the project formats. Wrapping it in a Vite
// manifest would describe a build that does not exist.
const LEGACY = `<!DOCTYPE html><html><body><h1>hi</h1>
<style data-file="styles/base.css">body{margin:0}</style></body></html>`;
const legacy = toProjectFiles(splitHtmlToFiles(LEGACY), 'Legacy');
check('a plain HTML document gains no manifest',
  legacy.some((f) => f.path === 'package.json'), false);

// --- the readme describes the tree that is really there --------------------
const readme = build(VUE).read('README.md');
check('the readme names the framework', /Vue 3/.test(readme), true);
check('and the directories the project actually has', /src\/screens\//.test(readme), true);
check('and the mount element, so a blank page is diagnosable', /id="app"/.test(readme), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
