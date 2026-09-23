import type { VFile } from './virtualFs';
import { RUNTIMES, compileFile, detectKind, type OutputKind } from './frameworkCompile';
import { anchorJsx, anchorVue } from './sourceAnchors';

/**
 * How each kind of file gets its elements traced back.
 *
 * All three, and measured in a browser against the real compilers: a Vue SFC and
 * a Svelte component both emit an unknown `data-` attribute as a static one, so
 * neither framework has to know it exists. What differs is only where the markup
 * is — a `<template>` block, everything outside `<script>`/`<style>`, or the JSX
 * itself.
 */
const ANCHOR_BY_EXT: { test: RegExp; anchor: (path: string, source: string) => string }[] = [
  { test: /\.[jt]sx$/, anchor: anchorJsx },
  { test: /\.vue$/, anchor: anchorVue },
];

/**
 * Compiles a generated React project into a single self-contained document that
 * runs inside the preview iframe.
 *
 * There is no bundler in the browser, so this does the three jobs a bundler would:
 * transform JSX/TS to plain JS (Sucrase), resolve every relative import to an
 * absolute module id at build time, and emit a tiny CommonJS registry that the
 * iframe executes. React itself is inlined from the app's own dependency rather
 * than a CDN, because the preview sandbox blocks external requests.
 */

/**
 * Every extension the resolver may try, across all frameworks.
 *
 * Deliberately not narrowed per framework: a project holds one framework's files,
 * so the extra candidates simply never match, and a single list means a `.vue`
 * imported without its extension resolves by the same rule a `.tsx` does.
 */
const SOURCE_EXT = ['.vue', '.jsx', '.tsx', '.js', '.ts', '.mjs'];

/**
 * Every `@import` in the joined stylesheets, moved to the front.
 *
 * A browser ignores an `@import` that follows any other rule, and the stylesheets
 * are concatenated — so a font import at the top of globals.css stopped loading the
 * moment another .css file, or a component's own style block, sorted ahead of it.
 * The design system token block starts with exactly such an import.
 */
export function hoistImports(css: string): string {
  const imports: string[] = [];
  const rest = css.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/g, (statement) => {
    if (!imports.includes(statement)) imports.push(statement);
    return '';
  });
  return imports.length ? `${imports.join('\n')}\n${rest}` : css;
}

export function isSourceFile(path: string, kind: OutputKind = 'react'): boolean {
  return RUNTIMES[kind].sourceExt.some((e) => path.endsWith(e));
}

/**
 * Whether these files are a project this module can compile.
 *
 * Asked of `detectKind` rather than of a file extension, because that is the
 * same question `buildReactPreview` answers a moment later when it picks a
 * runtime — and the two disagreeing is what broke Vue and Svelte previews.
 *
 * This used to be `.jsx || .tsx`, which is React and nothing else. A Vue project
 * carries `.vue` + `.ts` and a Svelte project `.svelte` + `.ts`, so both were
 * refused here, `Preview` returned early, and the frame fell back to rendering
 * the stored document as a web page — showing the project's own source text with
 * the HTML parser quietly discarding every component tag. The builder had
 * already been generalised; only this gate was left behind, so the failure
 * looked like a compiler problem when nothing had reached the compiler at all.
 *
 * Kept as a named export rather than inlined so the gate and the builder cannot
 * drift apart again without this comment being in the way.
 */
export function isCompilableProject(files: VFile[]): boolean {
  return detectKind(files) !== null;
}

/**
 * The project's own first screen, as a hash route.
 *
 * Generated apps are hash-routed and most default sensibly when the hash is
 * empty, but some derive the screen purely from `location.hash` and render
 * nothing on a fresh frame — which always starts with no hash. Knowing the first
 * route lets the bootstrap nudge those into their home screen instead of showing
 * an empty page. Returns null when the project does not follow the generated
 * layout, in which case no nudge is attempted.
 *
 * Returns an ordered list rather than a single guess. The guess used to be
 * NAV_ITEMS[0] — a *menu* entry, which on any app with a sign-in names a screen the
 * shell only renders once authenticated. Nudging there painted nothing, and the
 * watchdog then reported the project broken when it was not: this is the
 * "render() は呼ばれましたが画面が空です" error users were seeing.
 */
function findDefaultRoutes(files: VFile[]): string[] {
  // Both layouts are in circulation: src/routes.ts is current, src/app/types-nav.ts
  // is what older saved projects carry. Neither can be assumed.
  const nav = files.find((f) => /(?:^|\/)(routes|types-nav)\.tsx?$/.test(f.path));
  const router = files.find((f) => /(?:^|\/)(useNavigation|navigation)\.tsx?$/.test(f.path));

  const ids: string[] = [];
  const push = (id: string | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };

  /**
   * Screen ids are as often constants as string literals:
   *   const DEFAULT_ROUTE: Route = { screen: FEED_SCREEN };
   *   type ScreenId = typeof LOGIN_SCREEN | typeof FEED_SCREEN;
   * A literals-only reader finds nothing in that shape — which is the shape most
   * generated projects use — so every extraction below resolves an identifier
   * through the declarations in the routes file before giving up on it.
   */
  const valueOf = new Map<string, string>();
  for (const f of [nav, router]) {
    if (!f) continue;
    for (const m of f.content.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"]([\w-]+)['"]/g)) {
      valueOf.set(m[1], m[2]);
    }
  }

  // The app's own declared fallback comes first. It is the only candidate the app
  // has committed to rendering; NAV_ITEMS is a menu, and its first entry is very
  // often a screen the shell reaches only after signing in.
  if (router) {
    const m = /DEFAULT_ROUTE[^=]*=\s*\{[^}]*?\bscreen\s*:\s*(?:['"]([\w-]+)['"]|([A-Za-z_$][\w$]*))/s.exec(router.content);
    push(m?.[1] ?? valueOf.get(m?.[2] ?? ''));
  }
  if (nav) {
    const m = /NAV_ITEMS[^=]*=\s*\[\s*\{[^}]*?\bid\s*:\s*(?:['"]([\w-]+)['"]|([A-Za-z_$][\w$]*))/s.exec(nav.content);
    push(m?.[1] ?? valueOf.get(m?.[2] ?? ''));
    // Then every id in the union. If the first candidates paint nothing, one of the
    // remaining screens almost certainly does, and landing on the wrong screen
    // beats reporting a working project as broken.
    const union = /type\s+ScreenId\s*=([\s\S]*?);/.exec(nav.content)?.[1] ?? '';
    for (const u of union.matchAll(/['"]([\w-]+)['"]|(?:typeof\s+)?([A-Za-z_$][\w$]*)/g)) {
      push(u[1] ?? valueOf.get(u[2] ?? ''));
    }
  }
  return ids.map((id) => `#/${id}`);
}

export function findEntry(files: VFile[], kind: OutputKind = 'react'): string | null {
  const paths = new Set(files.map((f) => f.path));
  for (const c of RUNTIMES[kind].entries) if (paths.has(c)) return c;
  // Fall back to whichever module actually starts the app. Each framework has its
  // own word for that, and a project that named its entry something unexpected is
  // still runnable if we can find the call.
  const boot = files.find(
    (f) => isSourceFile(f.path, kind) && /createRoot|ReactDOM\.render|createApp|\bmount\s*\(/.test(f.content)
  );
  return boot?.path ?? null;
}

/**
 * Every source extension at the end of a path, including a compound one.
 *
 * It was a single "\.(vue|svelte|tsx|ts|jsx|js|mjs)$" applied once, and Svelte 5
 * rune modules are named "store.svelte.ts". Stripping one extension leaves
 * "src/lib/store.svelte", which does not end with "/lib/store" — so the rescue
 * that resolves an import written with one "../" too few could never fire for
 * the exact files every Svelte project shares its state through. Measured: nine
 * components importing "../lib/store.svelte", every one of them present in the
 * project, every one reported unresolved, and the application rendered nothing.
 */
const SOURCE_EXT_SUFFIX = /(?:\.(?:vue|tsx|ts|jsx|js|mjs))+$/

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/**
 * Resolve an import specifier the way a bundler would: try the literal path, then
 * each source extension, then an index file inside a directory of that name.
 */
function resolve(spec: string, importer: string, paths: Set<string>): string | null {
  const base = normalize(`${dirname(importer)}/${spec}`);
  if (paths.has(base)) return base;
  for (const e of SOURCE_EXT) if (paths.has(base + e)) return base + e;
  for (const e of SOURCE_EXT) if (paths.has(`${base}/index${e}`)) return `${base}/index${e}`;
  // A directory with modules in it but no index. Generation writes the icon
  // components and imports them through a barrel it never creates, which stops
  // the whole app on its first require. New projects get the barrel written
  // into them; this is what lets one saved before that still run.
  if (barrelFor(base, paths)) return `${base}/index.ts`;

  // Fallback: generation sometimes gets the number of "../" hops wrong — e.g.
  // '../lib/format' from src/components/ui/ instead of '../../lib/format'.
  // Match the specifier's tail against the project instead, and accept it only
  // when exactly one file fits, so a wrong guess can't silently bind.
  // The extension comes off the specifier too. Stripping it only from the
  // candidate meant this rescue could never fire for a Vue or Svelte import,
  // which always names the file in full — and the verifier's copy of this
  // resolver had the same bug, so the two agreed and both were wrong.
  const tail = spec.replace(/^(?:\.\.?\/)+/, '').replace(SOURCE_EXT_SUFFIX, '');
  if (!tail) return null;
  const candidates: string[] = [];
  for (const p of paths) {
    const stem = p.replace(SOURCE_EXT_SUFFIX, '');
    if (stem === tail || stem.endsWith(`/${tail}`) || stem.endsWith(`/${tail}/index`)) candidates.push(p);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * The direct children of a directory imported as a module, or null.
 *
 * Null when the directory holds nothing — a genuinely wrong import, which should
 * keep failing loudly rather than resolve to an empty module.
 */
function barrelFor(dir: string, paths: Set<string>): string[] | null {
  const children = [...paths]
    .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
    .sort();
  return children.length > 0 ? children : null;
}

/** Rewrite `require('./x')` to `require('src/dir/x.jsx')` so the iframe needs no resolver. */
function rewriteRequires(
  code: string,
  importer: string,
  paths: Set<string>,
  onMissing: (spec: string) => void
): string {
  return code.replace(/require\((['"])(.*?)\1\)/g, (whole, quote, spec: string) => {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return whole; // bare: react, etc.
    if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(spec)) return '({})'; // asset side-effect
    const target = resolve(spec, importer, paths);
    if (!target) {
      onMissing(spec);
      // A stub would make every use of this module undefined, and React fails far
      // from the cause. Throw on first use so the message names the real problem.
      return `(function(){ throw new Error(${JSON.stringify(`Module not found: '${spec}' (imported by ${importer})`)}); })()`;
    }
    return `require(${quote}${target}${quote})`;
  });
}

export interface ReactBuildResult {
  /** Document to feed the preview iframe. Null when compilation failed. */
  html: string | null;
  error: string | null;
  /** Specifiers that could not be resolved — surfaced as warnings, not failures. */
  warnings: string[];
}

export interface BuildOptions {
  /**
   * Which framework the project is written in. Detected from the files when the
   * caller does not know — a stored project predates the field, and the file
   * extensions are the fact anyway.
   */
  kind?: OutputKind;
  /**
   * Emit the error overlay and the empty-render watchdog. Off for thumbnails: a
   * card is decoration, and a red diagnostic panel in a 200px tile tells the user
   * nothing they can act on.
   */
  diagnostics?: boolean;
  /**
   * Write each host element's source line into the DOM, so a click in the frame
   * can be traced back to the code that produced it. The editable preview only —
   * see the note on `ANCHORABLE`.
   */
  anchors?: boolean;
}

/**
 * Whether a failure is a chunk this page can no longer fetch.
 *
 * The framework compilers are dynamic imports, so they are requested the first
 * time someone previews a project of that kind — which can be a long while after
 * the tab was opened. If a deploy has removed that build's chunks in between,
 * the request fails, and on this distribution it fails misleadingly: 404 is
 * mapped to /index.html with status 200, so the loader receives an HTML document
 * where it expected JavaScript.
 *
 * Worth naming, because the raw message arrives attached to a filename —
 * `src/App.svelte: Failed to fetch dynamically imported module` — which reads
 * like the generated project is broken when nothing is wrong with it at all.
 */
function isStaleChunk(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(msg);
}

const STALE_CHUNK_MESSAGE =
  'アプリが更新されています。ページを再読み込みしてください（このタブは更新前の版を読み込んでいます）。';

/**
 * Compilation, one at a time.
 *
 * `buildReactPreview` lazily imports Sucrase and the framework compiler, and two
 * calls entering that at the same moment do not both come out — measured with
 * two comparison frames mounting together: one produced a document and the other
 * sat on 「読み込み中…」 indefinitely, with no error to show for it.
 *
 * `ProjectThumbnail` had its own copy of this queue and its own note saying
 * several cards becoming visible at once must not race. That note was right and
 * the guard belonged here, next to the function that needs it, rather than in
 * one of its callers — where the next caller cannot see it. This is that queue,
 * shared: a thumbnail and a live frame are as capable of racing each other as
 * two thumbnails are.
 */
let buildQueue: Promise<unknown> = Promise.resolve();

export function enqueueBuild<T>(task: () => Promise<T>): Promise<T> {
  const run = buildQueue.then(task, task);
  buildQueue = run.catch(() => {});
  return run;
}

export async function buildReactPreview(
  files: VFile[],
  options: BuildOptions = {}
): Promise<ReactBuildResult> {
  const diagnostics = options.diagnostics !== false;
  /*
   * Anchoring is for the editable preview and nowhere else.
   *
   * A thumbnail is never clicked into, and the published document must not carry
   * an attribute that exists to serve an editor. Off by default so the two
   * builds that are not the editor cannot acquire it by accident.
   */
  const anchors = options.anchors === true;
  const warnings: string[] = [];
  const kind = options.kind ?? detectKind(files) ?? 'react';
  const runtime = RUNTIMES[kind];
  const entry = findEntry(files, kind);
  if (!entry) {
    return {
      html: null,
      error: `エントリーポイントが見つかりません（${runtime.entries[0]} を生成してください）`,
      warnings,
    };
  }

  let sucrase: typeof import('sucrase');
  let runtimeScripts: string[];
  try {
    // Loaded on demand so each framework's compiler and runtime stay out of the
    // main bundle until a project of that kind is actually opened.
    const [mod, scripts] = await Promise.all([import('sucrase'), runtime.runtimeScripts()]);
    sucrase = mod;
    runtimeScripts = scripts;
  } catch (e) {
    if (isStaleChunk(e)) return { html: null, error: STALE_CHUNK_MESSAGE, warnings };
    return { html: null, error: `プレビューランタイムの読み込みに失敗しました: ${String(e)}`, warnings };
  }
  const transform = sucrase.transform;

  const realSources = files.filter((f) => isSourceFile(f.path, kind));
  const paths = new Set(realSources.map((f) => f.path));

  /**
   * Barrels the project imports but does not contain, written on the fly.
   *
   * Resolving `../icons` to `src/components/icons/index.ts` is only half the
   * job — that module has to exist in the registry or the require fails with the
   * same message from one step further along. New projects get a real barrel
   * written into them at generation; this is what makes one saved before that
   * run at all.
   */
  const virtual: VFile[] = [];
  for (const file of realSources) {
    for (const m of file.content.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      const base = normalize(`${dirname(file.path)}/${m[1]}`);
      if (!base || paths.has(base)) continue;
      if (SOURCE_EXT.some((e) => paths.has(base + e) || paths.has(`${base}/index${e}`))) continue;
      const indexPath = `${base}/index.ts`;
      if (paths.has(indexPath)) continue;
      const children = barrelFor(base, paths);
      if (!children) continue;
      const lines: string[] = [];
      for (const child of children) {
        const name = child.slice(base.length + 1).replace(SOURCE_EXT_SUFFIX, '');
        lines.push(`export * from './${name}';`);
        const body = realSources.find((f) => f.path === child)?.content ?? '';
        if (/export\s+default\b/.test(body)) {
          lines.push(`export { default as ${name.replace(/[^A-Za-z0-9_$]/g, '')} } from './${name}';`);
        }
      }
      virtual.push({ path: indexPath, content: lines.join('\n'), lang: 'ts' });
      paths.add(indexPath);
      warnings.push(`${base}: index が無いためバレルを補完しました`);
    }
  }

  const sources = [...realSources, ...virtual];
  const defaultRoutes = findDefaultRoutes(files);

  const modules: string[] = [];
  /** Stylesheets a component carried inside itself, e.g. a .vue <style> block. */
  const componentCss: string[] = [];
  for (const file of sources) {
    let code: string;
    try {
      const anchorer = anchors ? ANCHOR_BY_EXT.find((a) => a.test.test(file.path)) : undefined;
      const source = anchorer ? anchorer.anchor(file.path, file.content) : file.content;
      const compiled = await compileFile(kind, file.path, source, sucrase);
      code = compiled.code;
      if (compiled.css) componentCss.push(compiled.css);
    } catch (e) {
      // The framework compiler is loaded lazily inside compileFile, so a stale
      // chunk surfaces here wearing this file's name. It is not this file's
      // fault and no retry will help.
      if (isStaleChunk(e)) return { html: null, error: STALE_CHUNK_MESSAGE, warnings };
      /**
       * Generation sometimes puts a context provider's JSX in a .ts file. Real
       * tooling would reject it, but failing the whole preview over a file
       * extension is worse than compiling it — retry with JSX enabled.
       *
       * Only for React. This rescue assumes the one reason a `.ts` file fails is
       * JSX inside it, which is true of React and false everywhere else: a
       * Svelte project's rune modules are `.svelte.ts`, so a legitimate refusal
       * from the Svelte compiler landed here, was recompiled as plain
       * TypeScript, and shipped with the runes intact — a page that loaded and
       * then threw `_svelte.$state is not a function`, with a warning about
       * `.tsx` that had nothing to do with the problem.
       */
      const recoverable = kind === 'react' && file.path.endsWith('.ts');
      if (recoverable) {
        try {
          code = transform(file.content, {
            transforms: ['typescript', 'jsx', 'imports'],
            production: true,
            filePath: file.path,
          }).code;
          warnings.push(`${file.path}: JSX を含むため .tsx にすべきファイルです`);
        } catch {
          const msg = e instanceof Error ? e.message : String(e);
          return { html: null, error: `${file.path}: ${msg}`, warnings };
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        return { html: null, error: `${file.path}: ${msg}`, warnings };
      }
    }
    code = rewriteRequires(code, file.path, paths, (spec) =>
      warnings.push(`${file.path}: '${spec}' を解決できませんでした`)
    );
    modules.push(
      `${JSON.stringify(file.path)}: function(exports, require, module){\n${code}\n}`
    );
  }

  const css = hoistImports([
    ...files.filter((f) => f.path.endsWith('.css')).map((f) => f.content),
    ...componentCss,
  ].join('\n\n'));

  /*
   * The project's own title, from the `index.html` the scaffold writes.
   *
   * It does not matter inside the preview frame, which has no tab. It matters
   * on a share link, where the document IS the page someone opens — and until
   * this was here every published project arrived with a blank browser tab.
   * Read from the scaffold rather than passed in, so the tab and the `index.html`
   * in the downloaded ZIP cannot say different things.
   */
  const indexHtml = files.find((f) => f.path === 'index.html')?.content ?? '';
  const title = /<title>([^<]*)<\/title>/.exec(indexHtml)?.[1]?.trim() || 'MakeUI App';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</title>
<style>${css}</style>
<style>
#__preview_error{position:fixed;inset:0;z-index:2147483647;background:#1b1b1f;color:#ffb4b4;
font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px;white-space:pre-wrap;
overflow:auto;display:none}
#__preview_error b{color:#fff;display:block;margin-bottom:8px;font-size:14px}
</style>
</head>
<body>
<div id="root"><div id="app" style="display:contents"></div></div>
<pre id="__preview_error"></pre>
${runtimeScripts.map((r) => `<script>${r}</script>`).join('')}
<script>
(function(){
  // The frame is sandboxed to an opaque origin, so the host app cannot read into
  // it. Report status outward instead, so failures surface in the UI rather than
  // only inside the frame.
  function report(kind, detail){
    try { parent.postMessage({ type: 'react-preview', kind: kind, detail: detail }, '*'); } catch (e) {}
  }
  function showError(title, detail){
    var el = ${diagnostics ? `document.getElementById('__preview_error')` : `null`};
    if (el) {
      el.style.display = 'block';
      el.innerHTML = '<b></b>';
      el.firstChild.textContent = title;
      el.appendChild(document.createTextNode(detail));
    }
    report('error', title + ': ' + detail);
  }
  window.addEventListener('error', function(e){
    showError('実行時エラー', (e.error && e.error.stack) || e.message || String(e));
  });
  window.addEventListener('unhandledrejection', function(e){
    showError('未処理のPromise拒否', String((e.reason && e.reason.stack) || e.reason));
  });

  var __defs = {
${modules.join(',\n')}
  };
  var __cache = {};
  // Record whether the app actually asked React to render. Without this, an empty
  // #root is indistinguishable between "render was never called" and "render was
  // called but the tree produced nothing" — which need different fixes.
  var __rendered = false;
  var __builtin = ${runtime.builtins};
  function require(id){
    if (Object.prototype.hasOwnProperty.call(__builtin, id)) return __builtin[id];
    if (__cache[id]) return __cache[id].exports;
    var def = __defs[id];
    if (!def) throw new Error("Module not found: " + id);
    var module = { exports: {} };
    __cache[id] = module;
    def(module.exports, require, module);
    return module.exports;
  }
  try {
    require(${JSON.stringify(entry)});
    // createRoot().render() commits asynchronously, so an immediate read of #root
    // always sees it empty. Poll briefly instead of waiting on a frame —
    // requestAnimationFrame never fires while the preview is off-screen.
    var tries = 0;
    var nudged = 0;
    var __routes = ${JSON.stringify(defaultRoutes)};
    // Vue and Svelte mount to '#app' by convention, so the shell nests an alias
    // container of that name inside #root (display:contents, so it is not in
    // layout). That means #root always has one child, and "has children" no
    // longer means "something rendered" — the alias must be discounted or every
    // empty render reports as ready.
    function __output(){
      var root = document.getElementById('root');
      if (!root) return 0;
      var alias = document.getElementById('app');
      if (alias && alias.parentNode === root && root.children.length === 1) return alias.children.length;
      return root.children.length;
    }
    (function check(){
      var n = __output();
      if (n > 0) { report('ready', n); return; }
      // A hash-routed App that derives its screen purely from location.hash paints
      // nothing on a fresh frame, because the frame starts with no hash at all.
      // Work through the project's own routes before calling it a failure.
      if (tries > 8 && __rendered && nudged < __routes.length) {
        location.hash = __routes[nudged++];
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        tries = 0;
        setTimeout(check, 25);
        return;
      }
      if (++tries > 40) {
${diagnostics ? `        // Distinguish the two causes: they need different fixes.
        if (!__rendered) {
          showError('描画エラー', 'エントリーモジュールは実行されましたが createRoot().render() が呼ばれていません。src/main.tsx を確認してください。');
        } else {
          showError('描画エラー',
            'render() は呼ばれましたが画面が空です。現在のルート: "' + (location.hash || '(なし)') +
            '" — App の画面分岐がこのルートに対応していない可能性があります。');
        }` : `        report('empty', location.hash || '');`}
        return;
      }
      setTimeout(check, 25);
    })();
  } catch (err) {
    ${diagnostics ? `showError('起動エラー', (err && err.stack) || String(err));` : `report('error', String(err));`}
  }
})();
</script>
</body>
</html>`;

  return { html, error: null, warnings };
}
