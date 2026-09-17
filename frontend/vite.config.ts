import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

/**
 * Framework runtimes, as plain strings the preview can inline.
 *
 * The preview iframe runs generated projects with `sandbox="allow-scripts"` and
 * no network, so every runtime has to arrive as script text inside the document.
 * These read straight from node_modules, which keeps package.json the single
 * source of truth for the versions.
 *
 * React and Vue ship single-file browser builds that expose a global, so they
 * are read verbatim. Svelte does not — its runtime is many ESM modules — so it
 * is bundled here into one global at build time.
 */
function frameworkRuntimes(): Plugin {
  const files: Record<string, string> = {
    // The FULL build, not the runtime-only one: generated .vue files are compiled
    // in the browser and the result still needs Vue's own template runtime.
    'virtual:vue-global': 'vue/dist/vue.global.prod.js',
  };
  const bundled: Record<string, { entry: string; global: string }> = {
    /**
     * React, in ONE bundle that sets both globals.
     *
     * React 19 dropped the UMD builds, so the two files this used to read do not
     * exist. esbuild produces the same thing, and the mechanism was already here
     * for Svelte.
     *
     * One bundle and not two, which is the whole trick. Bundling react-dom on
     * its own inlines its own private copy of react, so the hook dispatcher
     * react-dom reads is not the one on `window.React`, and the first component
     * to call `useState` dies with "Cannot read properties of null". Measured by
     * doing it the obvious way first and watching the page fail.
     *
     * `createRoot` is lifted to the top level because that is where the React 18
     * UMD build had it, and where frameworkCompile's builtins map looks for it.
     */
    'virtual:react-runtime': {
      entry:
        `import * as React from 'react';` +
        `import * as ReactDOM from 'react-dom';` +
        `import { createRoot, hydrateRoot } from 'react-dom/client';` +
        `window.React = React;` +
        `window.ReactDOM = Object.assign({}, ReactDOM, { createRoot, hydrateRoot });`,
      global: '__react_runtime',
    },
    'virtual:svelte-runtime': {
      /**
       * The legacy flag is imported for its side effect, not its exports.
       *
       * Svelte's compiler emits `import 'svelte/internal/flags/legacy'` for any
       * component that does not use runes — which includes a shell component
       * that only composes other components and holds no state of its own.
       * Measured: without it the preview died with
       * `Module not found: svelte/internal/flags/legacy`. Importing it here sets
       * the flag once for the whole bundle, so the module map can answer that
       * specifier with an empty object.
       */
      entry:
        `import 'svelte/internal/flags/legacy';` +
        // Two namespaces, because they are two different modules: the compiler's
        // output imports 'svelte/internal/client', while `mount` — what an entry
        // module calls — is only on the public 'svelte' entry. Exposing just the
        // internal one left `mount` undefined and the app died on its first line.
        `export * from 'svelte/internal/client';` +
        `export * as __public from 'svelte';`,
      global: '__svelte_internal',
    },
  };
  return {
    name: 'framework-runtimes',
    resolveId: (id) => (id in files || id in bundled ? `\0${id}` : null),
    load(id) {
      if (!id.startsWith('\0')) return null;
      const key = id.slice(1);
      if (files[key]) {
        const file = fileURLToPath(new URL(`./node_modules/${files[key]}`, import.meta.url));
        return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
      }
      const spec = bundled[key];
      if (!spec) return null;
      const out = buildSync({
        stdin: { contents: spec.entry, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' },
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
      return `export default ${JSON.stringify(out.outputFiles[0].text)};`;
    },
  };
}

/**
 * The compilers, as browser modules.
 *
 * Vue's SFC compiler and Svelte's compiler both ship browser builds and both run
 * inside the page — measured, not assumed. They are dynamically imported by the
 * preview so they stay out of the main bundle until a project of that kind is
 * opened.
 */
export default defineConfig({
  plugins: [react(), frameworkRuntimes()],
  // amazon-cognito-identity-js references the Node `global` object, which does not
  // exist in the browser. Without this the dev server renders a blank page.
  define: {
    global: 'globalThis',
  },
});
