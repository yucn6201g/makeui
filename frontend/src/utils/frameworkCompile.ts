
/**
 * Turning one source file into a CommonJS module the preview registry can run.
 *
 * The registry, the import resolution and the document shell are the same for
 * every framework — what differs is only how a file becomes JavaScript and which
 * globals its bare imports point at. So that is all this holds.
 *
 * Everything ends up as CommonJS because the registry is a `require` map, and
 * every framework's compiler emits ES modules. Sucrase's `imports` transform is
 * what bridges them, which is why even a `.vue` or `.svelte` file goes through
 * Sucrase after its own compiler has run.
 */

/**
 * Re-exported, not defined here.
 *
 * The kind predicate now lives in `frameworkKind`, because asking what a project
 * is written in should not drag in the three vendored framework runtimes this
 * module imports as text. Everything that already imports these names from here
 * keeps working — the point of the split is the dependency, not the spelling.
 */
export { isOutputKind, detectKind } from './frameworkKind';
export type { OutputKind } from './frameworkKind';
import type { OutputKind } from './frameworkKind';

export interface FrameworkRuntime {
  /** Extensions whose files are modules in the registry. */
  sourceExt: string[];
  /** Entry points to look for, in order of preference. */
  entries: string[];
  /** Scripts inlined ahead of the registry, in order. */
  runtimeScripts(): Promise<string[]>;
  /**
   * The `__builtin` map, as a JavaScript expression evaluated inside the frame.
   * Bare specifiers resolve here; anything else must be a file in the project.
   */
  builtins: string;
  /**
   * Wraps the mount so the shell can tell "never rendered" from "rendered
   * nothing" — two failures that look identical in an empty container and need
   * different fixes.
   */
  renderProbe: string;
}


export const RUNTIMES: Record<OutputKind, FrameworkRuntime> = {
  react: {
    sourceExt: ['.jsx', '.tsx', '.js', '.ts', '.mjs'],
    entries: ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx'],
    async runtimeScripts() {
      // One script, not two: react-dom bundled apart from react carries its own
      // copy and the hook dispatcher stops matching. See vite.config.ts.
      const runtime = await import('virtual:react-runtime');
      return [runtime.default];
    },
    builtins: `(function(){
      var shim = Object.create(window.ReactDOM);
      shim.createRoot = function(container) {
        var root = window.ReactDOM.createRoot(container);
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
    renderProbe: '',
  },

  vue: {
    sourceExt: ['.vue', '.ts', '.js', '.mjs'],
    entries: ['src/main.ts', 'src/main.js'],
    async runtimeScripts() {
      const vue = await import('virtual:vue-global');
      return [vue.default];
    },
    /**
     * `createApp` is wrapped rather than the mount call, because a project can
     * call `.mount()` on the app in a different module from the one that made it.
     */
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
    renderProbe: '',
  },

  svelte: {
    sourceExt: ['.svelte', '.ts', '.js', '.mjs'],
    entries: ['src/main.ts', 'src/main.js'],
    async runtimeScripts() {
      const svelte = await import('virtual:svelte-runtime');
      return [svelte.default];
    },
    /**
     * Svelte 5's public API (`mount`, `unmount`) and the compiler's own import
     * target (`svelte/internal/client`) are the same bundle here, so both
     * specifiers point at it. `disclose-version` is a side-effect import the
     * compiler always emits and there is nothing behind it.
     */
    builtins: `(function(){
      var pub = window.__svelte_internal.__public;
      var s = Object.create(pub);
      s.mount = function() { __rendered = true; return pub.mount.apply(null, arguments); };
      return {
        'svelte': s,
        'svelte/internal/client': window.__svelte_internal,
        // Both are side-effect imports the compiler always emits. Their effects
        // are already in the bundle above, so there is nothing to hand back.
        'svelte/internal/disclose-version': {},
        'svelte/internal/flags/legacy': {}
      };
    })()`,
    renderProbe: '',
  },
};

export interface CompiledFile {
  /** CommonJS source for the registry. */
  code: string;
  /** Stylesheet the file carried, if any. */
  css?: string;
}

type Sucrase = typeof import('sucrase');

/**
 * Sucrase transforms for a plain script, keyed on extension.
 *
 * `.ts` deliberately omits the jsx transform: TypeScript's generic call syntax
 * and JSX are ambiguous, so enabling jsx makes `useRef<Route[]>([])` fail to
 * parse. That ambiguity is why TypeScript itself splits .ts and .tsx.
 */
function scriptTransforms(path: string): Array<'typescript' | 'jsx' | 'imports'> {
  if (path.endsWith('.tsx')) return ['typescript', 'jsx', 'imports'];
  if (path.endsWith('.ts')) return ['typescript', 'imports'];
  return ['jsx', 'imports'];
}

/** A stable, filename-derived id, so a rebuild does not reshuffle scoped styles. */
function scopeId(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (Math.imul(31, h) + path.charCodeAt(i)) | 0;
  return 'data-v-' + (h >>> 0).toString(36);
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

/** Compiles one file to CommonJS, whatever language it is written in. */
export async function compileFile(
  kind: OutputKind,
  path: string,
  source: string,
  sucrase: Sucrase
): Promise<CompiledFile> {
  if (kind === 'vue' && path.endsWith('.vue')) return compileVue(path, source, sucrase);
  if (kind === 'svelte' && path.endsWith('.svelte')) return compileSvelte(path, source, sucrase);
  /**
   * A `.svelte.ts` module is not TypeScript that happens to be named oddly — it
   * is the only kind of plain module where runes work, and the compiler has a
   * separate entry point for it. Passed through as ordinary TS, `$state(...)`
   * survives into the output as a call to a function that does not exist.
   */
  if (kind === 'svelte' && /\.svelte\.(ts|js)$/.test(path)) return compileSvelteModule(path, source, sucrase);
  return {
    code: sucrase.transform(addMissingFrameworkImports(kind, source), {
      transforms: scriptTransforms(path),
      production: true,
      filePath: path,
    }).code,
  };
}

async function compileVue(path: string, source: string, sucrase: Sucrase): Promise<CompiledFile> {
  const sfc = await import('@vue/compiler-sfc');
  // A component's <script setup> forgets an import as readily as a composable
  // does, and fails the same way — a ReferenceError on first render.
  source = addMissingFrameworkImports('vue', source);
  const { descriptor, errors } = sfc.parse(source, { filename: path });
  if (errors.length) throw new Error(errors[0].message ?? String(errors[0]));

  const id = scopeId(path);
  const scoped = descriptor.styles.some((s) => s.scoped);

  /**
   * Script and template are compiled separately, which is what
   * `@vitejs/plugin-vue` does and is the reason to do it here too.
   *
   * `compileScript`'s `inlineTemplate` option folds the render function into the
   * component object and needs one pass fewer, but it re-parses its own output
   * and threw `Unexpected token, expected "," (12:12)` on a perfectly ordinary
   * screen — a template with a click handler and an interpolation inside text.
   * Neither half reproduced it alone, which is the signature of an edge in that
   * path rather than in the input. The separate route is the well-trodden one.
   *
   * `bindingMetadata` is what ties the two halves back together: it tells the
   * template compiler which names `<script setup>` exposed, and without it every
   * reference in the template resolves against the wrong scope.
   */
  /**
   * `rewriteDefault` re-parses the compiled script with Babel to find the
   * `export default`, and Babel without this plugin reads a type annotation as
   * a broken expression: `let fn: (() => void) | null = null` throws
   * `Missing semicolon` at the colon. `compileScript` leaves TypeScript in its
   * output — stripping types is Sucrase's job further down — so the plugin has
   * to be handed over here or every `lang="ts"` component fails to compile.
   */
  const isTs = descriptor.scriptSetup?.lang === 'ts' || descriptor.script?.lang === 'ts';
  const parserPlugins: 'typescript'[] = isTs ? ['typescript'] : [];

  /**
   * A template-only SFC is ordinary Vue — every generated icon component is one
   * — but `compileScript` throws `SFC contains no <script> tags` on it. Such a
   * component is only a render function, so an empty object is the right base
   * and there are no bindings to hand to the template.
   */
  const hasScript = !!(descriptor.script || descriptor.scriptSetup);
  const script = hasScript ? sfc.compileScript(descriptor, { id }) : null;
  let esm = script
    ? sfc.rewriteDefault(script.content, '__sfc_main__', parserPlugins)
    : 'const __sfc_main__ = {};';

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
       * Static hoisting off, because the optimisation it unlocks needs eval.
       *
       * With hoisting on, `cacheStatic` hands runs of static nodes to
       * `transformHoist`, which compiler-dom hardcodes to `stringifyStatic` —
       * the pass that collapses them into one `createStaticVNode` string. To do
       * that it constant-folds their attributes through
       * `new Function('return (' + exp + ')')`, and the app is served under
       * `script-src 'self' 'unsafe-inline'`. No 'unsafe-eval', so the compile
       * throws:
       *
       *   Evaluating a string as JavaScript violates the following Content
       *   Security Policy directive…
       *
       * It fires at `nc >= 20 || ec >= 5` — twenty static nodes in a row, or
       * five with bindings — so it is invisible until a screen gets big enough,
       * and then it takes the whole project down. Reported on a Sonnet-built
       * `ChurnScreen.vue`; the same pipeline on Haiku had never produced a
       * static block long enough to reach the threshold.
       *
       * `transformHoist` cannot be overridden — compiler-dom sets it after the
       * caller's options — so the lever is the hoisting that feeds it. What is
       * lost is a render-time optimisation in a preview iframe, which is not a
       * thing worth having at the price of not compiling at all.
       *
       * Source maps go the same way: we never read `template.map`, and the
       * source-map library reaches for `new Function` in its own sort helper.
       */
      hoistStatic: false,
      sourceMap: false,
    },
  });
  /**
   * `template.errors` holds what the compiler RECOVERED from, not what failed.
   * A fatal template error throws out of `compileTemplate`; everything reported
   * through `onError` arrives here with compilation already finished and
   * correct. Measured: a generated `<img :alt="" />` reports `v-bind is missing
   * expression` and Vue still emits `alt: ""` — so treating this array as fatal
   * killed a whole 33-file project over one harmless attribute.
   *
   * The empty render function is the sentinel the compiler returns when it did
   * catch something, and that is the case worth failing on.
   */
  if (/export default function render\(\s*\)\s*\{\s*\}/.test(template.code)) {
    const first = template.errors[0];
    throw new Error(
      first
        ? typeof first === 'string'
          ? first
          : first.message
        : 'template produced no render function'
    );
  }
  esm += `\n${template.code}\n__sfc_main__.render = render;`;
  if (scoped) esm += `\n__sfc_main__.__scopeId = ${JSON.stringify(id)};`;
  esm += `\nexport default __sfc_main__;`;

  const css = descriptor.styles
    .map((s) => sfc.compileStyle({ source: s.content, filename: path, id, scoped: s.scoped }).code)
    .join('\n');

  // The compiler emits TypeScript when the block says lang="ts", so this pass is
  // doing two jobs: stripping types, and turning ESM into the registry's CommonJS.
  return {
    code: sucrase.transform(esm, { transforms: ['typescript', 'imports'], production: true, filePath: path }).code,
    css: css || undefined,
  };
}

/** The Svelte 5 runes, which are keywords rather than values. */
const RUNES = ['$state', '$derived', '$effect', '$props', '$bindable', '$inspect', '$host'];

/**
 * Removes `import { $state } from 'svelte'` and friends.
 *
 * A rune is compile-time syntax, not an export — nothing named `$state` exists
 * in the `svelte` package. Importing one is always wrong, and wrong invisibly:
 * the compiler treats it as an imported binding, declines to compile it away,
 * and emits a call to it. The build succeeds and the page dies on first render
 * with `_svelte.$state is not a function`, leaving an empty preview.
 *
 * Measured on a generated project: `src/lib/navigation.svelte.ts` began with
 * `import { $state } from 'svelte'`, all 25 files compiled, and nothing rendered.
 *
 * Applied in the compiler rather than at generation time so that projects
 * already saved are repaired too.
 */
function stripRuneImports(source: string): string {
  return source.replace(
    /import\s*\{([^}]*)\}\s*from\s*(['"])svelte\2\s*;?/g,
    (whole, clause: string, quote: string) => {
      const all = clause.split(',').map((s) => s.trim()).filter(Boolean);
      const kept = all.filter((spec) => !RUNES.includes(spec.split(/\s+as\s+/)[0].trim()));
      if (kept.length === all.length) return whole;
      return kept.length ? `import { ${kept.join(', ')} } from ${quote}svelte${quote};` : '';
    }
  );
}

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

async function compileSvelte(path: string, source: string, sucrase: Sucrase): Promise<CompiledFile> {
  const compiler: any = await import('svelte/compiler');
  const name = (path.split('/').pop() ?? 'Component').replace(/\.svelte$/, '').replace(/[^A-Za-z0-9_$]/g, '');
  source = fixShorthandProps(stripRuneImports(source));
  /**
   * TypeScript in a Svelte file is not handled by the Svelte compiler — that is
   * a preprocessor's job, and there is no preprocessor here — so types have to
   * be stripped first.
   *
   * EVERY script block is stripped, not only those declaring `lang="ts"`.
   * Keying off the attribute assumes it is present, and a generated component
   * routinely writes a bare `<script>` and puts TypeScript in it. Measured: a
   * sidebar with `import type { Route }` and `(screenId: string)` under a plain
   * `<script>` reached the compiler untouched and failed with `Unexpected
   * token`. The pass is free either way — Sucrase's typescript transform over
   * plain JavaScript is a no-op.
   */
  const prepared = source.replace(
    /(<script[^>]*>)([\s\S]*?)(<\/script>)/g,
    (_m, open: string, body: string, close: string) => {
      /**
       * `keepUnusedImports` is not optional here.
       *
       * Only the <script> block is handed to Sucrase, and a Svelte component
       * uses most of its imports in the *markup* — which is not in that string.
       * Left to decide for itself, Sucrase reads `import { store } from …` as an
       * unused type import and deletes it, and the Svelte compiler then emits a
       * component referencing `store` with nothing importing it. Measured:
       * `ReferenceError: store is not defined`, with the import simply absent.
       */
      /*
       * Sucrase must not lower class fields here.
       *
       * Its TypeScript transform rewrites `class R { cur = $state(...) }` into a
       * constructor calling `__init()` and assigning there — and Svelte then
       * refuses it, correctly, because `$state` is no longer a class field. The
       * generated code was valid Svelte and we broke it on the way in. Measured
       * on a real run: a class-based router in src/lib/navigation.svelte.ts, an
       * ordinary Svelte 5 idiom, took the whole project to a blank page.
       *
       * Nothing is lost. The preview runs in a current browser, which implements
       * class fields, optional chaining and nullish coalescing natively — the
       * three things this flag stops Sucrase rewriting. Types are still
       * stripped, which is the only reason Sucrase is in this path.
       */
      const js = sucrase.transform(body, {
        transforms: ['typescript'],
        keepUnusedImports: true,
        disableESTransforms: true,
        filePath: path,
      }).code;
      return `${open.replace(/\s+lang=["'][^"']*["']/, '')}${js}${close}`;
    }
  );
  const result = compiler.compile(prepared, { name, generate: 'client', filename: path });
  return {
    code: sucrase.transform(result.js.code, {
      transforms: ['imports'],
      production: true,
      filePath: path,
    }).code,
    css: result.css?.code || undefined,
  };
}

/**
 * A rune-bearing module (`*.svelte.ts`).
 *
 * `compileModule` is the compiler's entry for these. Types are stripped first,
 * for the same reason as in a component: nothing here preprocesses TypeScript,
 * and the Svelte compiler does not accept it.
 */
async function compileSvelteModule(path: string, source: string, sucrase: Sucrase): Promise<CompiledFile> {
  const compiler: any = await import('svelte/compiler');
  // Same reason as in a component: a rune module's bindings are read by code the
  // stripper is not looking at, so nothing may be elided as "unused". The rune
  // imports go first — this is the file where that mistake was measured.
  // disableESTransforms for the same reason as the component path above — see there.
  const js = sucrase.transform(stripRuneImports(source), {
    transforms: ['typescript'],
    keepUnusedImports: true,
    disableESTransforms: true,
    filePath: path,
  }).code;
  const result = compiler.compileModule(js, { filename: path, generate: 'client' });
  return {
    code: sucrase.transform(result.js.code, { transforms: ['imports'], production: true, filePath: path }).code,
  };
}
