
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

/**
 * A screen that throws while it renders, shown as a message rather than as a
 * blank page.
 *
 * React unmounts the WHOLE root when a render throws and nothing catches it, so
 * one broken screen took the shell, the navigation and every other screen with
 * it — a white page and no way out but a reload. Over thirty days to 2026-09-23,
 * 15 of 123 generations shipped with a finding that can do that (console-error
 * 12, blank-render 6); the recent ones all render after this week's fixups, but
 * a fixup only closes a shape somebody has already seen.
 *
 * So the runtime wraps the app, not the project: a class component whose only
 * job is to catch, say what broke, and let the user leave. It resets itself on
 * hashchange, so 「前の画面に戻る」 and 「最初の画面へ」 remount the app on a
 * screen that works.
 *
 * It hides nothing from verification. The error still goes to console.error, so
 * the walk still reports console-error, and the panel carries
 * data-makeui-render-error so the walk measures the screen as failed rather
 * than as filled. What changes is what a person sees.
 *
 * Written twice — here, which is the preview the user actually looks at, and
 * in backend/src/tools/project/framework-compile.ts, which is what verification renders — and held equal by
 * test/render-boundary.test.mjs. ES5 and no backticks: it is spliced into a
 * template literal and runs in whatever the page's engine is.
 */
export const RENDER_BOUNDARY = `var __R = window.React;
      function MakeuiBoundary(props) {
        __R.Component.call(this, props);
        this.state = { error: null };
        var self = this;
        this.__reset = function() { if (self.state.error) self.setState({ error: null }); };
      }
      MakeuiBoundary.prototype = Object.create(__R.Component.prototype);
      MakeuiBoundary.prototype.constructor = MakeuiBoundary;
      MakeuiBoundary.getDerivedStateFromError = function(error) { return { error: error }; };
      MakeuiBoundary.prototype.componentDidCatch = function(error) {
        console.error('[makeui] 画面の描画中にエラーが発生しました: ' + ((error && error.message) || String(error)));
      };
      MakeuiBoundary.prototype.componentDidMount = function() { window.addEventListener('hashchange', this.__reset); };
      MakeuiBoundary.prototype.componentWillUnmount = function() { window.removeEventListener('hashchange', this.__reset); };
      MakeuiBoundary.prototype.render = function() {
        var e = this.state.error;
        if (!e) return this.props.children;
        var h = __R.createElement;
        var btn = { font: 'inherit', fontSize: '14px', padding: '8px 16px', borderRadius: '6px', border: '1px solid #c6c6c6', background: '#fff', color: '#1f1f1f', cursor: 'pointer' };
        return h('div', { 'data-makeui-render-error': '', role: 'alert', style: { maxWidth: '560px', margin: '64px auto', padding: '24px', fontFamily: 'system-ui, sans-serif', color: '#1f1f1f', border: '1px solid #e0e0e0', borderRadius: '8px', background: '#fafafa' } },
          h('p', { style: { margin: '0 0 8px', fontSize: '16px', fontWeight: 600 } }, 'この画面を表示中にエラーが発生しました'),
          h('p', { style: { margin: '0 0 16px', fontSize: '13px', color: '#5c5c5c', wordBreak: 'break-word' } }, String((e && e.message) || e).slice(0, 300)),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', { type: 'button', style: btn, onClick: function() { history.back(); } }, '前の画面に戻る'),
            h('button', { type: 'button', style: btn, onClick: function() { location.hash = ''; window.dispatchEvent(new HashChangeEvent('hashchange')); } }, '最初の画面へ')));
      };`

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
      ${RENDER_BOUNDARY}
      var shim = Object.create(window.ReactDOM);
      shim.createRoot = function(container) {
        var root = window.ReactDOM.createRoot(container);
        var orig = root.render.bind(root);
        // Wrapped once, at the root — see RENDER_BOUNDARY.
        root.render = function(el) { __rendered = true; return orig(__R.createElement(MakeuiBoundary, null, el)); };
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
  /**
   * A `.svelte.ts` module is not TypeScript that happens to be named oddly — it
   * is the only kind of plain module where runes work, and the compiler has a
   * separate entry point for it. Passed through as ordinary TS, `$state(...)`
   * survives into the output as a call to a function that does not exist.
   */
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
