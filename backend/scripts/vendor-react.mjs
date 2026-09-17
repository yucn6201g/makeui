/**
 * Copies React's UMD builds into src/vendor as text, for esbuild to inline.
 *
 * Browser verification runs the generated React project for real, and the page it
 * runs needs React in it. It cannot come from a CDN: the point of rendering inside
 * an AgentCore Browser session is that the user's generated work never leaves AWS,
 * and a page that fetches a script from the internet to start is also a page that
 * silently renders blank the day the fetch is blocked — which is exactly the
 * failure this whole change exists to remove.
 *
 * So the runtime is inlined at build time. React is a devDependency here: nothing
 * in the backend imports it, this script only reads two files out of it.
 *
 *   node scripts/vendor-react.mjs
 */
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/vendor');

// React 19 dropped the UMD builds. The pin is ^18.3 for that reason, and this
// message is what a future upgrade will read when it breaks.
//
// Located via the package manifest rather than the file itself: React's "exports"
// map does not expose ./umd/*, so require.resolve on the UMD path fails even
// though the file is sitting right there. ./package.json is always exported.
const SOURCES = {
  // The FULL Vue build, not the runtime-only one: a generated .vue file is
  // compiled here and the result still needs Vue's own template runtime.
  'vue.global.txt': ['vue', 'dist/vue.global.prod.js'],
};

/**
 * Svelte has no single-file browser build, so one is made here.
 *
 * The legacy flag is imported for its side effect: the compiler emits
 * `import 'svelte/internal/flags/legacy'` for any component that does not use
 * runes, which includes a shell that only composes other components.
 */
const BUNDLES = {
  /**
   * React, in ONE bundle that sets both globals.
   *
   * React 19 dropped the UMD builds, so the two files this used to copy do not
   * exist. esbuild can produce the same thing — an IIFE that puts React on the
   * window — and the mechanism was already here for Svelte.
   *
   * One bundle, not two, and that is the whole trick. Bundling react-dom on its
   * own inlines its own private copy of react, so the hook dispatcher react-dom
   * reads is not the one on `window.React`, and the first component to call
   * `useState` dies with 「Cannot read properties of null」. Measured by doing it
   * the obvious way first and watching the page fail.
   *
   * `createRoot` is lifted to the top level because that is where the React 18
   * UMD build had it, and where `RUNTIMES.react.builtins` looks for it.
   */
  'react.runtime.txt': {
    entry:
      `import * as React from 'react';` +
      `import * as ReactDOM from 'react-dom';` +
      `import { createRoot, hydrateRoot } from 'react-dom/client';` +
      `window.React = React;` +
      `window.ReactDOM = Object.assign({}, ReactDOM, { createRoot, hydrateRoot });`,
    global: '__react_runtime',
  },
  'svelte.runtime.txt': {
    entry:
      `import 'svelte/internal/flags/legacy';` +
      `export * from 'svelte/internal/client';` +
      `export * as __public from 'svelte';`,
    global: '__svelte_internal',
  },
};

mkdirSync(out, { recursive: true });
for (const [name, [pkg, rel]] of Object.entries(SOURCES)) {
  const from = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel);
  try {
    statSync(from);
  } catch {
    throw new Error(`${pkg}/${rel} not found — check the ${pkg} version in devDependencies.`);
  }
  const to = path.join(out, name);
  copyFileSync(from, to);
  console.log(`vendored ${name}  ${Math.round(statSync(to).size / 1024)}KB`);
}


for (const [name, spec] of Object.entries(BUNDLES)) {
  const built = buildSync({
    stdin: { contents: spec.entry, resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: spec.global,
    platform: 'browser',
    minify: true,
    write: false,
    // React reads this to pick its production paths. Without it the bundle
    // carries the development build's warnings and its slower render.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
  const to = path.join(out, name);
  writeFileSync(to, built.outputFiles[0].text);
  console.log(`bundled ${name}  ${Math.round(statSync(to).size / 1024)}KB`);
}
