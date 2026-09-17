import { transform } from 'sucrase'
import REACT_RUNTIME from '../vendor/react.runtime.txt'
import VUE_GLOBAL from '../vendor/vue.global.txt'
import SVELTE_RUNTIME from '../vendor/svelte.runtime.txt'
import type { OutputKind } from '../config/frameworks.js'
/**
 * The browser builds, on the server, on purpose.
 *
 * `@vue/compiler-sfc`'s Node entry pulls in `consolidate`, which optionally
 * requires two dozen template engines that are not installed — esbuild cannot
 * resolve any of them and the bundle fails outright. The browser build is
 * self-contained and compiles the same SFCs. It is also the build the frontend
 * uses, which is the property that matters most here: the two halves must agree
 * about what compiles, or a defect the verifier cannot see is a defect that ships.
 */
import * as vueSfc from '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
import * as svelteCompiler from 'svelte/compiler'

/**
 * Turning one generated source file into a CommonJS module, per framework.
 *
 * The twin of the frontend's `frameworkCompile.ts`, and deliberately the same
 * shape: verification renders the same document the user's preview does, so a
 * project that compiles in one and not the other would mean the pipeline is
 * checking something nobody will see. The four bugs found while proving the
 * browser side — inlineTemplate re-parsing its own output, Svelte's legacy flag,
 * `mount` living on the public entry, and the type stripper eliding imports the
 * markup uses — are all fixed the same way here.
 */

export interface CompiledFile {
  code: string
  css?: string
}

export interface FrameworkRuntime {
  /** Scripts inlined ahead of the module registry. */
  scripts: string[]
  /** The `__builtin` map, as an expression evaluated inside the page. */
  builtins: string
  entries: string[]
  sourceExt: string[]
}

export const RUNTIMES: Record<OutputKind, FrameworkRuntime> = {
  react: {
    // One script, not two: react-dom bundled apart from react carries its own
    // copy and the hook dispatcher stops matching. See scripts/vendor-react.mjs.
    scripts: [REACT_RUNTIME],
    builtins: `(function(){
      var shim = Object.create(window.ReactDOM);
      shim.createRoot = function(c) {
        var root = window.ReactDOM.createRoot(c);
        var orig = root.render.bind(root);
        root.render = function(el) { __rendered = true; return orig(el); };
        return root;
      };
      /*
       * React 19 removed ReactDOM.render. Nothing in the contract asks a
       * generated project to call it, and this was only ever a safety net — but
       * a net that throws "Cannot read properties of undefined" explains
       * nothing, so it says what is wrong instead.
       *
       * No backticks in here: this whole value is a template literal.
       */
      shim.render = function() {
        throw new Error('ReactDOM.render was removed in React 19. Use createRoot(container).render(element).');
      };
      return { 'react': window.React, 'react-dom': shim, 'react-dom/client': shim };
    })()`,
    entries: ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/index.tsx'],
    sourceExt: ['.tsx', '.jsx', '.ts', '.js', '.mjs'],
  },
  vue: {
    scripts: [VUE_GLOBAL],
    builtins: `(function(){
      var v = Object.create(window.Vue);
      v.createApp = function() {
        var app = window.Vue.createApp.apply(null, arguments);
        var mount = app.mount.bind(app);
        app.mount = function() { __rendered = true; return mount.apply(null, arguments); };
        return app;
      };
      return { 'vue': v };
    })()`,
    entries: ['src/main.ts', 'src/main.js'],
    sourceExt: ['.vue', '.ts', '.js', '.mjs'],
  },
  svelte: {
    scripts: [SVELTE_RUNTIME],
    /**
     * `svelte/store` is provided by hand rather than vendored.
     *
     * Measured at v171: a Svelte project imported `writable` from 'svelte/store'
     * and the page was blank with `Module not found: svelte/store`. That module
     * is not a Svelte 4 leftover — it is a current, documented Svelte 5 API, and
     * reaching for it to share state across components is a reasonable thing for
     * the model to have done. The bundle simply never carried it.
     *
     * Forty lines beats regenerating the vendored runtime. The store contract is
     * small and stable — subscribe(run, invalidate) calls run immediately and
     * returns an unsubscribe — and component-level `$store` does not even go
     * through here: the compiler turns it into `store_get` from the internal
     * client, which accepts anything with `.subscribe`. So this only has to
     * satisfy explicit imports, which is exactly what it does.
     *
     * `toStore` and `fromStore` are deliberately absent. They bridge runes and
     * stores and need rune context to mean anything; importing one unused costs
     * nothing, and a wrong implementation would fail somewhere much harder to
     * read than a missing export.
     */
    builtins: `(function(){
      var pub = window.__svelte_internal.__public;
      var s = Object.create(pub);
      s.mount = function() { __rendered = true; return pub.mount.apply(null, arguments); };

      function not_equal(a, b) {
        return a != a ? b == b : a !== b || (a && typeof a === 'object') || typeof a === 'function';
      }
      function writable(value, start) {
        var stop = null, subs = new Set();
        function set(v) {
          if (!not_equal(value, v)) return;
          value = v;
          if (stop) subs.forEach(function (sub) { sub[1](); sub[0](value); });
        }
        function update(fn) { set(fn(value)); }
        function subscribe(run, invalidate) {
          var sub = [run, invalidate || function () {}];
          subs.add(sub);
          if (subs.size === 1) stop = (start && start(set, update)) || function () {};
          run(value);
          return function () {
            subs.delete(sub);
            if (subs.size === 0 && stop) { stop(); stop = null; }
          };
        }
        return { set: set, update: update, subscribe: subscribe };
      }
      function readable(value, start) { return { subscribe: writable(value, start).subscribe }; }
      function get(store) {
        var out;
        store.subscribe(function (v) { out = v; })();
        return out;
      }
      function derived(stores, fn, initial) {
        var single = !Array.isArray(stores);
        var list = single ? [stores] : stores;
        var auto = fn.length < 2;
        return readable(initial, function (set, update) {
          var started = false, values = [], pending = 0, cleanup = function () {};
          function sync() {
            if (pending) return;
            cleanup();
            var result = fn(single ? values[0] : values, set, update);
            if (auto) set(result);
            else cleanup = typeof result === 'function' ? result : function () {};
          }
          var unsubs = list.map(function (store, i) {
            return store.subscribe(
              function (v) { values[i] = v; pending &= ~(1 << i); if (started) sync(); },
              function () { pending |= (1 << i); }
            );
          });
          started = true;
          sync();
          return function () {
            unsubs.forEach(function (u) { u(); });
            cleanup();
            cleanup = function () {};
          };
        });
      }
      function readonly(store) { return { subscribe: store.subscribe.bind(store) }; }

      return {
        'svelte': s,
        'svelte/store': { writable: writable, readable: readable, derived: derived, get: get, readonly: readonly },
        'svelte/internal/client': window.__svelte_internal,
        'svelte/internal/disclose-version': {},
        'svelte/internal/flags/legacy': {}
      };
    })()`,
    entries: ['src/main.ts', 'src/main.js'],
    sourceExt: ['.svelte', '.ts', '.js', '.mjs'],
  },
}

/** A project of this kind, judged by the files it carries. */
export function detectKind(paths: Iterable<string>): OutputKind | null {
  const all = [...paths]
  if (all.some((p) => p.endsWith('.svelte'))) return 'svelte'
  if (all.some((p) => p.endsWith('.vue'))) return 'vue'
  if (all.some((p) => p.endsWith('.tsx') || p.endsWith('.jsx'))) return 'react'
  return null
}

function scriptTransforms(path: string): Array<'typescript' | 'jsx' | 'imports'> {
  if (path.endsWith('.tsx')) return ['typescript', 'jsx', 'imports']
  if (path.endsWith('.ts')) return ['typescript', 'imports']
  return ['jsx', 'imports']
}

function scopeId(path: string): string {
  let h = 0
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0
  return 'data-v-' + (h >>> 0).toString(36)
}

/**
 * The Vue Composition API names a generated file is likely to reach for.
 *
 * Not the whole package surface — only what a mock actually uses, because every
 * name here is one this module is willing to import on the author's behalf and
 * a wrong entry would introduce a binding rather than fix one.
 */
const VUE_EXPORTS = [
  'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'nextTick', 'readonly',
  'onMounted', 'onUnmounted', 'onBeforeMount', 'onBeforeUnmount', 'onUpdated',
  'provide', 'inject', 'toRef', 'toRefs', 'unref', 'isRef', 'shallowRef', 'markRaw',
  'defineComponent', 'h', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport',
]

/**
 * Adds framework imports a file uses but forgot to declare.
 *
 * A missing named import is not a compile error here — Sucrase happily emits a
 * reference to a binding that does not exist — so it becomes a `ReferenceError`
 * on first render and an empty preview. Measured on a generated Vue project:
 * `src/composables/useNavigation.ts` imported `{ reactive, watch }` and then
 * called `computed(...)` twice; every screen was blank and the only clue was
 * `computed is not defined` in the console.
 *
 * Only names the framework genuinely exports are added, only when the file uses
 * them as a bare identifier, and only when nothing local already binds the name.
 * Adding a real export the code is already calling cannot change behaviour — the
 * alternative is a page that does not run at all.
 *
 * Done in the compiler so stored projects are repaired too, not only new ones.
 */
function addMissingFrameworkImports(kind: OutputKind, source: string): string {
  if (kind !== 'vue') return source

  const already = new Set<string>()
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]vue['"]/g)) {
    for (const spec of m[1].split(',')) {
      const name = spec.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) already.add(name)
    }
  }

  const missing = VUE_EXPORTS.filter((name) => {
    if (already.has(name)) return false
    if (!new RegExp(`(^|[^\\w.$])${name}\\s*[(<]`).test(source)) return false
    // A local declaration of the same name means the file meant its own thing.
    return !new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(source)
  })
  if (missing.length === 0) return source

  const existing = /import\s*\{([^}]*)\}\s*from\s*(['"])vue\2\s*;?/
  if (existing.test(source)) {
    return source.replace(existing, (_m, clause: string, q: string) => {
      const names = clause.split(',').map((s) => s.trim()).filter(Boolean)
      return `import { ${[...names, ...missing].join(', ')} } from ${q}vue${q};`
    })
  }
  return `import { ${missing.join(', ')} } from 'vue';\n${source}`
}

export function compileFile(kind: OutputKind, path: string, source: string): CompiledFile {
  if (kind === 'vue' && path.endsWith('.vue')) return compileVue(path, source)
  if (kind === 'svelte' && path.endsWith('.svelte')) return compileSvelte(path, source)
  if (kind === 'svelte' && /\.svelte\.(ts|js)$/.test(path)) return compileSvelteModule(path, source)
  return {
    code: transform(addMissingFrameworkImports(kind, source), {
      transforms: scriptTransforms(path),
      production: true,
      filePath: path,
    }).code,
  }
}

function compileVue(path: string, source: string): CompiledFile {
  const sfc = vueSfc as any
  // A component's <script setup> forgets an import exactly as readily as a
  // composable does, and fails the same way — a ReferenceError on first render.
  source = addMissingFrameworkImports('vue', source)
  const { descriptor, errors } = sfc.parse(source, { filename: path })
  if (errors.length) throw new Error(errors[0].message ?? String(errors[0]))

  const id = scopeId(path)
  const scoped = descriptor.styles.some((s: any) => s.scoped)
  // Script and template separately — `inlineTemplate` re-parses its own output
  // and fails on ordinary screens. `bindingMetadata` is what ties them back
  // together, so a name exposed by <script setup> resolves in the template.
  /**
   * Both steps below re-parse with Babel, and neither infers TypeScript from the
   * descriptor — the plugin has to be handed over.
   *
   * `rewriteDefault` is the one that actually bites. It re-parses the *compiled
   * script* to find `export default`, and `compileScript` leaves the types in
   * (stripping them is Sucrase's job further down). Measured on a real
   * generation: `let confirmActionFn: (() => void) | null = null` threw
   * `Missing semicolon. (32:19)` — column 19 is the annotation's colon. The
   * error names the SFC, so it reads like a broken script; the stack points at
   * `parseVarStatement`.
   *
   * `expressionPlugins` covers the same ground on the template side, where a
   * generated `v-for="(b: Book) in books"` would fail the same way.
   */
  const isTs = descriptor.scriptSetup?.lang === 'ts' || descriptor.script?.lang === 'ts'
  const parserPlugins: string[] = isTs ? ['typescript'] : []

  /**
   * A template-only SFC is ordinary Vue — every icon component the generator
   * writes is one — but `compileScript` throws `SFC contains no <script> tags`
   * on it. Measured: `src/components/icons/BellIcon.vue` took down the whole
   * project. Such a component is just a render function, so an empty object is
   * the correct base and there are no bindings to carry into the template.
   */
  const hasScript = !!(descriptor.script || descriptor.scriptSetup)
  const script = hasScript ? sfc.compileScript(descriptor, { id }) : null
  let esm = script
    ? sfc.rewriteDefault(script.content, '__sfc_main__', parserPlugins)
    : 'const __sfc_main__ = {};'
  const template = sfc.compileTemplate({
    source: descriptor.template?.content ?? '',
    filename: path,
    id,
    scoped,
    compilerOptions: {
      bindingMetadata: script?.bindings,
      scopeId: scoped ? id : undefined,
      expressionPlugins: parserPlugins,
      /*
       * Kept identical to the frontend's options, which is the whole point of
       * compiler-parity.test.mjs: this compiler decides whether a document
       * "builds" and what it scores, and the other one renders what the user
       * sees. Divergence is the worst-shaped failure here — verified sound,
       * scored well, reported successful, blank on screen.
       *
       * The frontend has to turn static hoisting off because the optimisation
       * it unlocks, `stringifyStatic`, constant-folds bound attributes through
       * `new Function`, and the app is served under a CSP with no
       * 'unsafe-eval'. Node has no such restriction, so this side could keep
       * it — and then the two would emit different code for the same file.
       *
       * Matching also means this compiler stops depending on eval at all, which
       * is worth having on its own: nothing about verifying a document needs
       * to evaluate its attribute expressions.
       */
      hoistStatic: false,
      sourceMap: false,
    },
  })
  /**
   * `template.errors` is not a list of failures — it is what the compiler
   * RECOVERED from. `doCompileTemplate` calls the compiler unguarded, so a
   * fatal template error throws out of `compileTemplate` and never lands here;
   * anything in this array was reported through `onError` while compilation
   * carried on and produced correct code.
   *
   * Treating the array as fatal is therefore wrong, and it was not theoretical:
   * a generated `<img :alt="" />` reports `v-bind is missing expression` and
   * Vue still emits `alt: ""` — precisely the intent — yet the throw killed all
   * 33 files of the project over it.
   *
   * The one case worth failing on is the sentinel the guarded branch returns
   * when it caught something: an empty render function, meaning nothing
   * compiled at all.
   *
   * That sentinel is close to unreachable, which is the point. Measured against
   * five deliberately broken templates — an unparseable interpolation, a
   * truncated `v-for`, an unclosed tag, a truncated handler and a truncated
   * `v-if` — the compiler reported five errors and emitted five working render
   * functions. It recovers from essentially anything. A fatal error in a `.vue`
   * file comes from `parse` or from the script, both of which throw.
   */
  if (/export default function render\(\s*\)\s*\{\s*\}/.test(template.code)) {
    const first = template.errors[0]
    throw new Error(
      first ? (typeof first === 'string' ? first : first.message) : 'template produced no render function'
    )
  }
  esm += `\n${template.code}\n__sfc_main__.render = render;`
  if (scoped) esm += `\n__sfc_main__.__scopeId = ${JSON.stringify(id)};`
  esm += `\nexport default __sfc_main__;`

  const css = descriptor.styles
    .map((s: any) => sfc.compileStyle({ source: s.content, filename: path, id, scoped: s.scoped }).code)
    .join('\n')

  return {
    code: transform(esm, { transforms: ['typescript', 'imports'], production: true, filePath: path }).code,
    css: css || undefined,
  }
}

/** The Svelte 5 runes, which are keywords rather than values. */
const RUNES = ['$state', '$derived', '$effect', '$props', '$bindable', '$inspect', '$host']

/**
 * Removes `import { $state } from 'svelte'` and friends.
 *
 * A rune is compile-time syntax, not an export — there is nothing named `$state`
 * in the `svelte` package. Importing one is therefore always wrong, and it is
 * wrong in the worst way: the compiler sees an imported binding rather than a
 * rune, declines to compile it away, and emits code that calls it. Nothing fails
 * at build time. The page then dies on first render with
 * `_svelte.$state is not a function` and the preview shows nothing.
 *
 * Measured on a generated project: `src/lib/navigation.svelte.ts` opened with
 * `import { $state } from 'svelte'`, all 25 files compiled, and the app rendered
 * an empty container.
 *
 * Done in the compiler rather than at generation time so it also repairs the
 * projects already stored — a rewrite that only runs on new output would leave
 * every saved project broken.
 */
function stripRuneImports(source: string): string {
  return source.replace(
    /import\s*\{([^}]*)\}\s*from\s*(['"])svelte\2\s*;?/g,
    (whole, clause: string, quote: string) => {
      const kept = clause
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((spec) => !RUNES.includes(spec.split(/\s+as\s+/)[0].trim()))
      if (kept.length === clause.split(',').map((s) => s.trim()).filter(Boolean).length) return whole
      // Dropping the statement entirely when the rune was all it named; `svelte`
      // has no side effects worth keeping an empty import for.
      return kept.length ? `import { ${kept.join(', ')} } from ${quote}svelte${quote};` : ''
    }
  )
}

/**
 * `<C {onPick: handler} />` → `<C onPick={handler} />`.
 *
 * Svelte's attribute shorthand is `{name}`, meaning `name={name}`, and that is
 * all it is. `{name: value}` looks like it should pass `value` under the name
 * `name` — it reads exactly like an object literal — but Svelte has no such
 * form: the parser takes `{name` and then wants `}`, so the file dies with
 * `Expected token }` and the whole project fails to build.
 *
 * Measured on a generated project: `<FeaturedCategories {onCategoryChange:
 * handleCategoryChange} />`, one of eight such attributes in `src/App.svelte`.
 *
 * The rewrite is confined to the inside of a tag, and to a single identifier
 * followed by an expression containing no braces of its own. Everything else
 * that uses braces in Svelte markup is left alone by construction: block tags
 * (`{#if}`, `{:else}`, `{/each}`) and `{@render}` do not start with an
 * identifier character, `{...spread}` does not either, and CSS declarations
 * inside `<style>` are never scanned because only tag interiors are.
 */
/**
 * Rewrites `{name: value}` attributes within one tag, and only those.
 *
 * Brace depth is counted rather than pattern-matched, because the pattern alone
 * has a false positive that matters: `<C prop={{ screen: 'home' }} />` passes an
 * object literal, which is ordinary correct Svelte, and a regex looking for
 * `{ident: …}` finds the INNER braces and turns it into
 * `prop={screen={'home'}}`. Measured — it broke a fixture that had been passing.
 *
 * So a group is only considered when it opens at depth zero (an attribute
 * position, not a value) and is preceded by whitespace (so `={…}` is excluded).
 */
function rewriteTagAttributes(tag: string): string {
  let out = ''
  let i = 0
  let quote = ''
  while (i < tag.length) {
    const c = tag[i]
    if (quote) {
      out += c
      if (c === quote) quote = ''
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c !== '{') {
      out += c
      i++
      continue
    }
    // A brace group at attribute level. Find its match, tracking nesting.
    let depth = 0
    let j = i
    let q2 = ''
    for (; j < tag.length; j++) {
      const d = tag[j]
      if (q2) {
        if (d === q2) q2 = ''
        continue
      }
      if (d === '"' || d === "'") q2 = d
      else if (d === '{') depth++
      else if (d === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const group = tag.slice(i, Math.min(j + 1, tag.length))
    const before = i > 0 ? tag[i - 1] : ' '
    const inner = group.slice(1, -1)
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([^{}]+?)\s*$/.exec(inner)
    // `={` means this group is a value, not an attribute of its own.
    out += m && /\s/.test(before) ? `${m[1]}={${m[2].trim()}}` : group
    i = j + 1
  }
  return out
}

function fixShorthandProps(source: string): string {
  // Only the markup: a colon inside <script> or <style> is ordinary code or CSS.
  const blocks: Array<[number, number]> = []
  for (const m of source.matchAll(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g)) {
    blocks.push([m.index!, m.index! + m[0].length])
  }
  const inBlock = (i: number) => blocks.some(([a, b]) => i >= a && i < b)

  let out = ''
  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      out += source.slice(i)
      break
    }
    // Everything before the tag is copied through untouched. Forgetting this is
    // how a first attempt at this deleted the body of every component and left
    // the compiler reporting `<script> was left open`.
    out += source.slice(i, lt)
    if (inBlock(lt)) {
      out += '<'
      i = lt + 1
      continue
    }
    // Walk to the end of this tag, respecting quotes so a `>` inside an
    // attribute value does not end it early.
    let j = lt + 1
    let quote = ''
    while (j < source.length) {
      const c = source[j]
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      j++
    }
    out += rewriteTagAttributes(source.slice(lt, Math.min(j + 1, source.length)))
    i = j + 1
  }
  return out
}

function compileSvelte(path: string, source: string): CompiledFile {
  const compiler = svelteCompiler as any
  const name = (path.split('/').pop() ?? 'Component').replace(/\.svelte$/, '').replace(/[^A-Za-z0-9_$]/g, '')
  source = fixShorthandProps(stripRuneImports(source))
  /**
   * EVERY script block is stripped, not only the ones declaring `lang="ts"`.
   *
   * The Svelte compiler does not handle TypeScript — that is a preprocessor's
   * job and there is none here — so a block carrying types has to be stripped
   * first. Keying that off `lang="ts"` assumes the attribute is present, and a
   * generated component routinely writes a bare `<script>` and then puts
   * TypeScript in it. Measured: a sidebar with `import type { Route }`,
   * `handleNavClick(screenId: string)` and `isActive(...): boolean` under a
   * plain `<script>` reached the compiler untouched and failed with `Unexpected
   * token`, taking the project with it.
   *
   * Running the pass unconditionally is free: Sucrase's typescript transform
   * over plain JavaScript is a no-op, so the only thing the attribute changed
   * was whether correct code compiled.
   */
  const prepared = source.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/g,
    (_m, open: string, body: string, close: string) => {
      /**
       * `keepUnusedImports` is load-bearing: only the <script> block is handed to
       * Sucrase, and a component uses most of its imports in the markup, which is
       * not in that string. Without it the import is deleted as "unused" and the
       * compiled component references a binding nothing imported.
       */
      /*
       * Sucrase must not lower class fields here.
       *
       * Its TypeScript transform rewrites `class R { cur = $state(...) }` into
       * a constructor calling `__init()` and assigning there — and Svelte then
       * refuses it, correctly, because `$state` is no longer a class field:
       *
       *   `$state(...)` can only be used as a variable declaration initializer,
       *   a class field declaration, or the first assignment to a class field
       *   at the top level of the constructor.
       *
       * The generated code was valid Svelte and we broke it on the way in.
       * Measured on a real run: a class-based router in
       * src/lib/navigation.svelte.ts, which is an ordinary Svelte 5 idiom,
       * failed to compile and took the whole project to a blank page.
       *
       * Nothing is lost by disabling it. The preview runs in a current
       * browser, which implements class fields, optional chaining and nullish
       * coalescing natively — the three things this flag stops Sucrase
       * rewriting. Types are still stripped, which is the only reason Sucrase
       * is in this path at all.
       */
      const js = transform(body, {
        transforms: ['typescript'],
        keepUnusedImports: true,
        disableESTransforms: true,
        filePath: path,
      }).code
      return `${open.replace(/\s+lang=["'][^"']*["']/, '')}${js}${close}`
    }
  )
  const result = compiler.compile(prepared, { name, generate: 'client', filename: path })
  return {
    code: transform(result.js.code, { transforms: ['imports'], production: true, filePath: path }).code,
    css: result.css?.code || undefined,
  }
}

/** A rune-bearing module. Runes only work in `*.svelte.ts`, via `compileModule`. */
function compileSvelteModule(path: string, source: string): CompiledFile {
  const compiler = svelteCompiler as any
  // Same reason as in a component, and this is where it was actually measured:
  // the rune module is the file a generator is most likely to open with an
  // `import { $state } from 'svelte'`.
  // Same reason as in the component path above — see there.
  const js = transform(stripRuneImports(source), {
    transforms: ['typescript'],
    keepUnusedImports: true,
    disableESTransforms: true,
    filePath: path,
  }).code
  const result = compiler.compileModule(js, { filename: path, generate: 'client' })
  return { code: transform(result.js.code, { transforms: ['imports'], production: true, filePath: path }).code }
}
