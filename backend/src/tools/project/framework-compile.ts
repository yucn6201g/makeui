import { transform } from 'sucrase'
import REACT_RUNTIME from '../../vendor/react.runtime.txt'
import VUE_GLOBAL from '../../vendor/vue.global.txt'
import type { OutputKind } from '../../config/frameworks.js'
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

/**
 * Turning one generated source file into a CommonJS module, per framework.
 *
 * The twin of the frontend's `frameworkCompile.ts`, and deliberately the same
 * shape: verification renders the same document the user's preview does, so a
 * project that compiles in one and not the other would mean the pipeline is
 * checking something nobody will see. The four bugs found while proving the
 * browser side — inlineTemplate re-parsing its own output,
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
 * Written twice — here and in frontend/src/utils/preview/frameworkCompile.ts, which is
 * the preview the user actually looks at — and held equal by
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
    // One script, not two: react-dom bundled apart from react carries its own
    // copy and the hook dispatcher stops matching. See scripts/vendor-react.mjs.
    scripts: [REACT_RUNTIME],
    builtins: `(function(){
      ${RENDER_BOUNDARY}
      var shim = Object.create(window.ReactDOM);
      shim.createRoot = function(c) {
        var root = window.ReactDOM.createRoot(c);
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
}

/** A project of this kind, judged by the files it carries. */
export function detectKind(paths: Iterable<string>): OutputKind | null {
  const all = [...paths]
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

