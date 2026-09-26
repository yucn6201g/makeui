import { transform } from 'sucrase'
import { reactFiles } from '../../orchestration/audit/interaction-audit.js'
import { RUNTIMES, compileFile, detectKind } from './framework-compile.js'
import { FRAMEWORKS, type OutputKind, DEFAULT_OUTPUT_KIND } from '../../config/frameworks.js'
import { isFencedTransport, readProjectFiles, writeProjectFile } from './project-transport.js'
import { renameFile } from './rename-extension.js'

/**
 * Compiles a generated React project into a document a browser can actually run.
 *
 * React output is not a page. It is one HTML file carrying
 * `<script type="text/jsx" data-file="src/App.tsx">` blocks — a transport format
 * for a project, and a browser executes none of it. Handing that document to the
 * verifier renders an empty `<div id="root">`, and the measurement that comes
 * back says: zero screens, zero empty boxes, zero console errors, a 5KB
 * screenshot of white. Measured across two runs, that is exactly what happened,
 * and it read as a clean bill of health. Verification was reporting on a page
 * that had never existed.
 *
 * The three jobs a bundler would do are done here: transform TSX to JS (Sucrase),
 * resolve every relative import to an absolute module id, and emit a small
 * CommonJS registry the page executes. React is inlined from the vendored UMD
 * build, so the page needs no network.
 *
 * This deliberately mirrors frontend/src/utils/preview/reactPreview.ts. The two exist
 * because they run in different places — the frontend compiles for the preview
 * iframe, this compiles for the verification browser — and they must agree,
 * because a defect the verifier cannot see is a defect that ships. Where they
 * differ, the frontend is the reference: it is what the user actually looks at.
 */

/**
 * Every extension the resolver may try, across all frameworks.
 *
 * A project holds one framework's files, so the extra candidates never match —
 * and one list means a `.vue` imported without its extension resolves by the
 * same rule a `.tsx` does.
 */
const SOURCE_EXT = ['.vue', '.tsx', '.ts', '.jsx', '.js', '.mjs']

function isSourceFile(path: string, kind: OutputKind = 'react'): boolean {
  return RUNTIMES[kind].sourceExt.some((e) => path.endsWith(e))
}

/**
 * True once the document carries source files — i.e. it is a project, not a page.
 *
 * Both transports, and by the *files* rather than by the wrapper: the fenced form
 * has no `data-file` attribute to look for, and a document it did not recognise
 * was handed back untouched with no error — which reads exactly like a page that
 * compiled fine and is how a Vue project reached the verifier as raw text.
 */
export function isReactBundle(html: string): boolean {
  if (/data-file=["'][^"']+\.(?:tsx|jsx|vue)["']/i.test(html)) return true
  if (!isFencedTransport(html)) return false
  return [...readProjectFiles(html).keys()].some((p) => /\.(tsx|jsx|vue)$/i.test(p))
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
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/**
 * Resolve an import specifier the way a bundler would: the literal path, then
 * each source extension, then an index file inside a directory of that name.
 */
function resolve(spec: string, importer: string, paths: Set<string>): string | null {
  const base = normalize(`${dirname(importer)}/${spec}`)
  if (paths.has(base)) return base
  for (const e of SOURCE_EXT) if (paths.has(base + e)) return base + e
  for (const e of SOURCE_EXT) if (paths.has(`${base}/index${e}`)) return `${base}/index${e}`

  // Generation sometimes gets the number of "../" hops wrong — '../lib/format'
  // from src/components/ui/ instead of '../../lib/format'. Match the tail against
  // the project instead, and accept it only when exactly one file fits, so a wrong
  // guess cannot silently bind to the wrong module.
  /**
   * The extension is stripped from the specifier as well as from the candidate.
   *
   * It was stripped from the candidate only, so this rescue could never fire for
   * a Vue or Svelte import — those always name the file in full (`./Card.vue`),
   * and `src/components/icons/TrashIcon` does not end with
   * `/components/icons/TrashIcon.vue`. Measured on a real Vue project: two
   * components imported with one `../` too many, both present in the project,
   * both reported unresolved, and the application rendered nothing.
   */
  const tail = spec.replace(/^(?:\.\.?\/)+/, '').replace(SOURCE_EXT_SUFFIX, '')
  if (!tail) return null
  const candidates: string[] = []
  for (const p of paths) {
    const stem = p.replace(SOURCE_EXT_SUFFIX, '')
    if (stem === tail || stem.endsWith(`/${tail}`) || stem.endsWith(`/${tail}/index`)) candidates.push(p)
  }
  return candidates.length === 1 ? candidates[0] : null
}

/** Rewrite `require('./x')` to `require('src/dir/x.tsx')` so the page needs no resolver. */
function rewriteRequires(
  code: string,
  importer: string,
  paths: Set<string>,
  onMissing: (spec: string) => void
): string {
  return code.replace(/require\((['"])(.*?)\1\)/g, (whole, quote, spec: string) => {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return whole // bare: react, etc.
    if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(spec)) return '({})' // asset side-effect
    const target = resolve(spec, importer, paths)
    if (!target) {
      onMissing(spec)
      // Throwing on first use puts the real cause in the console error. A stub
      // would make every use of the module undefined and React would fail
      // somewhere else entirely.
      return `(function(){ throw new Error(${JSON.stringify(
        `Module not found: '${spec}' (imported by ${importer})`
      )}); })()`
    }
    return `require(${quote}${target}${quote})`
  })
}

function findEntry(paths: Set<string>, files: Map<string, string>, kind: OutputKind): string | null {
  for (const c of RUNTIMES[kind].entries) if (paths.has(c)) return c
  // Whatever module actually starts the app. Each framework has its own word for
  // it, and a project that named its entry unexpectedly is still runnable.
  for (const [path, content] of files) {
    if (isSourceFile(path, kind) && /createRoot|ReactDOM\.render|createApp|mount\s*\(/.test(content)) return path
  }
  return null
}

/**
 * The project's own first screen, as hash routes to try.
 *
 * Generated apps are hash-routed and most default sensibly on an empty hash, but
 * some derive the screen purely from `location.hash` and paint nothing in a
 * fresh frame — which always starts with no hash. Without this the verifier
 * would measure a blank first screen and report the app broken when it is not.
 *
 * Ordered, not a single guess: the app's declared DEFAULT_ROUTE first, then
 * NAV_ITEMS[0], then the rest of the union. NAV_ITEMS[0] alone is wrong on any
 * app with a sign-in, where the first menu entry names a screen the shell only
 * renders once authenticated.
 */
function defaultRoutes(files: Map<string, string>): string[] {
  let nav = ''
  let router = ''
  for (const [path, content] of files) {
    if (/(?:^|\/)(routes|types-nav)\.tsx?$/.test(path)) nav = content
    if (/(?:^|\/)(useNavigation|navigation)\.tsx?$/.test(path)) router = content
  }

  const valueOf = new Map<string, string>()
  for (const src of [nav, router]) {
    for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"]([\w-]+)['"]/g)) {
      valueOf.set(m[1], m[2])
    }
  }

  const ids: string[] = []
  const push = (id: string | undefined) => {
    if (id && !ids.includes(id)) ids.push(id)
  }

  const dflt = /DEFAULT_ROUTE[^=]*=\s*\{[^}]*?\bscreen\s*:\s*(?:['"]([\w-]+)['"]|([A-Za-z_$][\w$]*))/s.exec(router)
  push(dflt?.[1] ?? valueOf.get(dflt?.[2] ?? ''))
  const first = /NAV_ITEMS[^=]*=\s*\[\s*\{[^}]*?\bid\s*:\s*(?:['"]([\w-]+)['"]|([A-Za-z_$][\w$]*))/s.exec(nav)
  push(first?.[1] ?? valueOf.get(first?.[2] ?? ''))
  const union = /type\s+ScreenId\s*=([\s\S]*?);/.exec(nav)?.[1] ?? ''
  for (const u of union.matchAll(/['"]([\w-]+)['"]|(?:typeof\s+)?([A-Za-z_$][\w$]*)/g)) {
    push(u[1] ?? valueOf.get(u[2] ?? ''))
  }
  return ids.map((id) => `#/${id}`)
}

/**
 * Renames `.ts` files that contain JSX to `.tsx`.
 *
 * The output contract says any file with JSX in it must be `.tsx`, and
 * generation breaks that rule regularly — a context provider that returns
 * markup is the usual one. Everything downstream then works around it: the
 * preview retries the file with the JSX transform and shows the user a warning
 * about a file naming rule they did not choose and cannot act on, and the
 * exported project ships a `.ts` file that `tsc` refuses, because TypeScript
 * reads `<` there as a type parameter.
 *
 * Renaming is safe precisely here: every import in a generated project omits
 * the extension, so no import has to change. The compiler decides which files
 * qualify rather than a regular expression — a file "containing JSX" is exactly
 * a file that fails to parse as TypeScript and parses with JSX enabled, and
 * that is a question only a parser can answer.
 */
export function normalizeReactExtensions(source: string): { html: string; renamed: string[] } {
  if (!isReactBundle(source)) return { html: source, renamed: [] }
  const renamed: string[] = []
  let out = source

  for (const [path, body] of reactFiles(source)) {
    if (!path.endsWith('.ts')) continue
    try {
      transform(body, { transforms: ['typescript', 'imports'], production: true, filePath: path })
      continue // parses as plain TypeScript: nothing to fix
    } catch {
      // Might be JSX, might just be broken. Only the first is renamed.
    }
    try {
      transform(body, { transforms: ['typescript', 'jsx', 'imports'], production: true, filePath: path })
    } catch {
      continue // broken either way; the audits and the compile gate will say so
    }
    const next = `${path}x`
    const replaced = renameFile(out, path, next)
    if (replaced) {
      out = replaced
      renamed.push(`${path} → ${next}`)
    }
  }
  return { html: out, renamed }
}

/**
 * Writes the barrel files the project imports but never wrote.
 *
 * `import { Search } from '../icons'` names a directory, and a directory is only
 * a module if it contains an index. Generation writes the seven icon components
 * and imports them through a barrel it does not create — measured on a real
 * project: seven files under src/components/icons, no index, and two different
 * modules importing '../icons' and '../components/icons'. The app then fails on
 * its first require, which is the entire screen, not a corner of it.
 *
 * Synthesising the barrel is the fix that makes the *project* correct rather
 * than only the preview: the exported ZIP has the same missing file, and `vite`
 * fails on it exactly as the browser did.
 *
 * The default export is only re-exported when the file has one — `export
 * { default as X }` against a module without a default is an error in real
 * TypeScript, and the point of this is to produce a project that builds.
 */
/**
 * Relative imports the bundler will not be able to resolve.
 *
 * Exists because "it parses" is not "it runs", and the gap took a whole app
 * down. Measured on a real generation: a repair pass rewrote Header.tsx to
 * import '../icons/UserIcon', created seven sibling icons and not that one, and
 * every gate passed it — the file was valid TypeScript and every other file was
 * too. The first require threw, nothing mounted, and a six-screen application
 * scored 30 as a blank page.
 *
 * A missing module is not a degraded import; it is the end of the program. So
 * anything that writes files needs to be able to ask this before it commits,
 * and it resolves exactly the way the bundler does — including the ambiguous
 * "../" hop recovery — so a file this accepts is a file that will load.
 */
/**
 * Source with its comments blanked, keeping every other offset intact.
 *
 * Newlines are preserved so a line number computed on the result still means
 * something, and string literals are stepped over so a `//` inside a URL is not
 * read as the start of a comment.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < source.length) {
        out += source[i]
        if (source[i] === '\\') { i++; if (i < source.length) out += source[i]; i++; continue }
        if (source[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Whether the preview will supply this bare specifier.
 *
 * Exported because two callers need the same answer and a second copy of it is
 * how the audit and the score came to disagree about the same document. The
 * bundle check below asks it of a finished project; the repair asks it of one
 * file a model just returned, before that file is spliced in.
 *
 * A deep import into a provided package is provided too: `react-dom/client` is
 * listed, and `svelte/internal/...` is what the Svelte compiler itself emits.
 */
export function isProvidedModule(spec: string, kind: OutputKind): boolean {
  const provided = FRAMEWORKS[kind].providedModules
  return provided.includes(spec) || provided.some((p) => spec.startsWith(`${p}/`))
}

export function unresolvedImports(source: string): { importer: string; spec: string }[] {
  if (!isReactBundle(source)) return []
  const files = reactFiles(source)
  /**
   * The framework's own source extensions, not React's.
   *
   * `isSourceFile(path)` defaults to React, so on a Vue or Svelte project this
   * considered only the `.ts` files and never looked at a single component —
   * which is where the imports are. The check reported clean on projects it had
   * not read.
   */
  const kind = detectKind(files.keys()) ?? DEFAULT_OUTPUT_KIND
  const sources = new Map<string, string>()
  for (const [path, body] of files) if (isSourceFile(path, kind)) sources.set(path, body)
  const paths = new Set(sources.keys())

  const out: { importer: string; spec: string }[] = []
  for (const [importer, raw] of sources) {
    /*
     * Comments are stripped before anything is read as an import.
     *
     * `from` is an English word and the pattern allows a newline between it and
     * the quote, so a JSDoc line ending in it turns the next quoted phrase into
     * a module. Measured on a real file:
     *
     *     * … tell "never rendered" from "rendered
     *     * nothing" — two failures that look identical
     *
     * was reported as an import of `rendered\\n   * nothing`. Harmless as a
     * warning; not harmless as a `moduleDefects` finding, which sends a repair
     * pass after a file that has nothing wrong with it.
     */
    const body = stripComments(raw)
    // Both spellings a source file can carry: `from './x'` and a bare
    // side-effect `import './x'`. Requires are the compiled form and are
    // checked by the transform itself.
    for (const m of body.matchAll(/(?:from|import)\s+['"](\.[^'"]*)['"]/g)) {
      /**
       * Assets are not modules, and the transform already knows that.
       *
       * `rewriteRequires` turns a stylesheet or image import into `({})` — the
       * CSS is inlined as its own <style> block and Vite does the same on
       * export, so `import '../styles/tokens.css'` is a side effect that
       * succeeds. Reporting it here made this check stricter than the bundler
       * it exists to predict, and a repair that correctly added a stylesheet
       * import to Footer.tsx was reverted for it. Measured in real use.
       */
      if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(m[1])) continue
      if (!resolve(m[1], importer, paths)) out.push({ importer, spec: m[1] })
    }
    /**
     * Bare specifiers, which nothing checked at all.
     *
     * A relative import that does not resolve was caught; a package import was
     * waved through, on the assumption that a package import means the framework
     * itself. Measured on a real Svelte run: `import { goto } from '$app/navigation'`
     * — SvelteKit's, on a project that is not a SvelteKit project. It compiled
     * cleanly, threw `Module not found: $app/navigation` at first require, and
     * the page was blank. The preview provides exactly the modules in
     * `providedModules` and nothing else, so anything outside that list is a
     * package nobody installed.
     */
    for (const m of body.matchAll(/(?:from|import)\s+['"]([^.'"][^'"]*)['"]/g)) {
      const spec = m[1]
      if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(spec)) continue
      if (isProvidedModule(spec, kind)) continue
      out.push({ importer, spec })
    }
  }
  return out
}

/** What a module exports, as far as its own text says. */
interface ExportShape {
  names: Set<string>
  hasDefault: boolean
  /** The identifier behind `export default`, when it is named. */
  defaultName?: string
  /** An `export *` that could not be followed: nothing about names can be said. */
  unknown: boolean
}

function exportShape(path: string, sources: Map<string, string>, paths: Set<string>, depth = 0): ExportShape {
  const shape: ExportShape = { names: new Set(), hasDefault: false, unknown: false }
  // A component file of another framework exports its component as default and
  // nothing a named import could be checked against.
  if (/\.(vue)$/.test(path)) return { ...shape, hasDefault: true, unknown: true }
  const body = stripComments(sources.get(path) ?? '')
  const def = /export\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)?/.exec(body)
  if (def) {
    shape.hasDefault = true
    if (def[1] && !/^(function|class|async)$/.test(def[1])) shape.defaultName = def[1]
  }
  for (const m of body.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|enum|type|interface|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) {
    shape.names.add(m[1])
  }
  for (const m of body.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s.trim())
      if (!orig) continue
      const exported = alias ?? orig
      if (exported === 'default') shape.hasDefault = true
      else shape.names.add(exported)
    }
  }
  for (const m of body.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) shape.names.add(m[1])
  for (const m of body.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    const target = m[1].startsWith('.') ? resolve(m[1], path, paths) : null
    if (!target || depth >= 3) {
      shape.unknown = true
      continue
    }
    const inner = exportShape(target, sources, paths, depth + 1)
    if (inner.unknown) shape.unknown = true
    for (const n of inner.names) shape.names.add(n)
  }
  return shape
}

/**
 * Named imports the module they name does not export.
 *
 * This bundle is a CommonJS registry, not a real module system: a missing name
 * is not a build error, it is `undefined`, and `<Undefined />` is React #130 —
 * 「Element type is invalid … got: undefined」, with no component named. Both live
 * generations on 2026-09-13 had repair passes rejected for exactly that, and the
 * log could say only that the page went blank, so the single-file revert tried
 * the screens one after another without knowing which import was wrong.
 *
 * The check reads the importer's `{ … }` and the target's exports, both from
 * text. It stays silent whenever it cannot be sure — a target of another
 * framework, an `export *` it cannot follow — because a false mismatch would
 * send a repair after an import that works.
 */
export function missingExports(source: string): {
  importer: string; target: string; name: string; targetHasDefault: boolean; defaultName?: string
}[] {
  if (!isReactBundle(source)) return []
  const files = reactFiles(source)
  const kind = detectKind(files.keys()) ?? DEFAULT_OUTPUT_KIND
  const sources = new Map<string, string>()
  for (const [path, body] of files) if (isSourceFile(path, kind) || /\.(tsx?|jsx?|mjs)$/.test(path)) sources.set(path, body)
  const paths = new Set(sources.keys())
  const shapes = new Map<string, ExportShape>()
  const out: ReturnType<typeof missingExports> = []
  for (const [importer, raw] of sources) {
    if (/\.(vue)$/.test(importer) && !/<script/.test(raw)) continue
    const body = stripComments(raw)
    for (const m of body.matchAll(/import\s+(?!type\s)(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolve(m[2], importer, paths)
      if (!target) continue
      const shape = shapes.get(target) ?? exportShape(target, sources, paths)
      shapes.set(target, shape)
      if (shape.unknown) continue
      for (const part of m[1].split(',')) {
        const spec = part.trim()
        if (!spec || /^type\s/.test(spec)) continue
        const name = spec.split(/\s+as\s+/)[0].trim()
        if (name === 'default' || shape.names.has(name)) continue
        out.push({ importer, target, name, targetHasDefault: shape.hasDefault, ...(shape.defaultName ? { defaultName: shape.defaultName } : {}) })
      }
    }
  }
  return out
}

/**
 * A named import of a module that exports that thing only as its default.
 *
 *     // src/components/ui/Button.tsx
 *     export default function Button(…) { … }
 *
 *     // src/screens/ListScreen.tsx
 *     import { Button } from '../components/ui/Button'   // undefined -> #130
 *
 * The reverse of `fixDefaultImportOfNamedExport`, which was already here; this
 * direction was not, and it is the one a repair writes when it creates a
 * component in one call and imports it from another. Rewritten only when the
 * name is unambiguously the default: it is the default's own identifier, or the
 * file is named for it — and the import has no default of its own to collide.
 */
export function fixNamedImportOfDefault(source: string): { html: string; fixed: string[] } {
  const mismatches = missingExports(source).filter((m) => {
    if (!m.targetHasDefault) return false
    const stem = m.target.slice(m.target.lastIndexOf('/') + 1).replace(SOURCE_EXT_SUFFIX, '')
    const fileName = stem === 'index' ? m.target.split('/').slice(-2, -1)[0] : stem
    return m.name === m.defaultName || m.name === fileName
  })
  if (mismatches.length === 0) return { html: source, fixed: [] }
  let html = source
  const fixed: string[] = []
  const files = reactFiles(source)
  const paths = new Set(files.keys())
  for (const importer of new Set(mismatches.map((m) => m.importer))) {
    let body = files.get(importer) ?? ''
    for (const m of mismatches.filter((x) => x.importer === importer)) {
      const stmt = new RegExp(
        `import\\s+\\{([^}]*)\\}\\s*from\\s*(['"])(\\.[^'"]+)\\2`, 'g'
      )
      body = body.replace(stmt, (whole, list: string, q: string, spec: string) => {
        // Only the statement that imports from THIS target: the same name can be
        // imported from two modules, and only one of them is wrong.
        if (resolve(spec, importer, paths) !== m.target) return whole
        const parts = list.split(',').map((p) => p.trim()).filter(Boolean)
        const i = parts.findIndex((p) => p.split(/\s+as\s+/)[0].trim() === m.name)
        if (i < 0) return whole
        const local = (parts[i].split(/\s+as\s+/)[1] ?? m.name).trim()
        const rest = parts.filter((_, j) => j !== i)
        fixed.push(`${local} ← ${m.target}`)
        return rest.length
          ? `import ${local}, { ${rest.join(', ')} } from ${q}${spec}${q}`
          : `import ${local} from ${q}${spec}${q}`
      })
    }
    const next = writeProjectFile(html, importer, body)
    if (next) html = next
  }
  return fixed.length
    ? { html, fixed: [`名前付き import を default import に修正（対象は default export のみで undefined が描画されます）: ${[...new Set(fixed)].slice(0, 5).join(', ')}`] }
    : { html: source, fixed: [] }
}

/**
 * The unresolved imports, phrased as something to fix.
 *
 * Structurally an `InteractionDefect`, declared inline rather than imported:
 * that type lives in interaction-audit.ts, which this module already imports
 * from, and the cycle is not worth the shared declaration.
 *
 * This exists because the failure it names is invisible to every other static
 * audit and arrives at the browser as one generic line. Measured: a generated
 * project whose Header imported an icon nobody wrote rendered nothing at all,
 * and the pipeline's only description of it was `console-error` carrying a
 * stack — from which the repair planner did not work out that the fix was to
 * write one file. Naming the file removes the inference.
 */
/**
 * Whether a file uses a name as a value — a call, an element, a member, an
 * argument — rather than only as a type.
 *
 * An import used only in type positions is erased by the TypeScript transform,
 * so a missing type export costs nothing at runtime; a missing component or
 * function is `undefined` the moment it is reached. Only the second is a defect
 * worth a repair call. Deliberately generous: a use it cannot classify counts as
 * a value, because a missed runtime failure is the expensive direction.
 */
function usedAsValue(body: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$')
  const code = stripComments(body)
    // The import statement itself is not a use.
    .replace(/import\s[^;]*?from\s*['"][^'"]+['"];?/g, '')
  const typeOnly = new RegExp(`(?:[:<|&,]\\s*|\\bas\\s+|\\bextends\\s+|\\bimplements\\s+)${n}\\b(?!\\s*[.(])`, 'g')
  const all = [...code.matchAll(new RegExp(`(?<![\\w$.])${n}(?![\\w$])`, 'g'))].length
  if (all === 0) return false
  const types = [...code.matchAll(typeOnly)].length
  const jsx = new RegExp(`<${n}[\\s/>]`).test(code)
  return jsx || all > types
}

/**
 * Named imports a module does not export, where the name is used at runtime.
 *
 * Found in 11 of 36 stored outputs by `missingExports`, including the booking
 * app whose 「確認へ進む」 did nothing when pressed by hand: its screen imports
 * `isPastDate` from a helpers module that does not export it, so the submit
 * handler throws on its first line and neither validates nor navigates.
 * Every one of them had passed the build, the audits and the walk.
 */
function exportDefects(source: string): { id: string; instruction: string; paths: string[] }[] {
  const files = reactFiles(source)
  const real = missingExports(source).filter((m) => usedAsValue(files.get(m.importer) ?? '', m.name))
  if (real.length === 0) return []
  return [{
    id: 'export-missing',
    instruction:
      '存在しない名前を import しているファイルがあります。実行時には undefined になり、' +
      'その部品を描画した時点・その関数を呼んだ時点で画面や操作が止まります:\n' +
      real.slice(0, 8).map((m) =>
        `- ${m.importer} が ${m.target} から ${m.name} を import していますが、${m.target} は ${m.name} を export していません` +
        (m.targetHasDefault ? '（default export はあります）' : '')
      ).join('\n') +
      '\n定義されているファイルから import し直すか、import 先のファイルで定義して export してください。' +
      'import を消して解決するのは、その機能が動かなくなるので避けてください。',
    paths: [...new Set(real.flatMap((m) => [m.importer, m.target]))].slice(0, 6),
  }]
}

export function moduleDefects(source: string): { id: string; instruction: string; paths?: string[] }[] {
  const exported = exportDefects(source)
  const missing = unresolvedImports(addMissingBarrels(source).html)
  if (missing.length === 0) return exported
  /*
   * A missing project file and a missing framework module need opposite repairs.
   *
   * The instruction said "不足しているファイルを新規作成してください" and
   * "import を消して解決するのは避けてください" for everything in the list. For
   * `$app/navigation` — SvelteKit's runtime, three of the ten corpus findings —
   * both halves are wrong: the module cannot be written, and deleting the
   * import is precisely the repair. This project is a hash-routed SPA with its
   * own navigation module, so the import is a habit from a framework that is
   * not here.
   *
   * A relative specifier is a file this project was supposed to contain;
   * anything else is a package it does not have.
   */
  const local = missing.filter((m) => m.spec.startsWith('.'))
  const external = missing.filter((m) => !m.spec.startsWith('.'))
  return [
    {
      id: 'import-missing',
      instruction:
        'プロジェクト内に存在しないモジュールを import しているファイルがあります。' +
        'この状態では最初の require で例外になり、画面が1つも描画されません:\n' +
        missing
          .slice(0, 8)
          .map((m) => `- ${m.importer} が '${m.spec}' を import していますが、解決できません`)
          .join('\n') +
        (local.length
          ? '\n' +
            local
              .slice(0, 6)
              .map((m) => `'${m.spec}'`)
              .join('、') +
            ' はこのプロジェクトのファイルです。既存の同じフォルダのファイルと同じ書き方で' +
            '新規作成し、import 側が期待している名前でエクスポートしてください。' +
            'import を消して解決するのは、その要素が画面から消えるということなので避けてください。'
          : '') +
        (external.length
          ? '\n' +
            external
              .slice(0, 6)
              .map((m) => `'${m.spec}'`)
              .join('、') +
            ' はこのプロジェクトに存在しないパッケージです。書いても入りません。' +
            '**その import を削除し**、同じことをこのプロジェクトの手段で行ってください' +
            '（画面遷移なら src/ の navigation モジュール、状態なら src/store）。'
          : ''),
    },
    ...exported,
  ]
}

/**
 * Turns router-package links back into anchors.
 *
 * This is a deterministic repair rather than a defect handed to a model,
 * because the rewrite is mechanical and the alternative is shipping broken
 * navigation. `<router-link to="#/x">` and `<a href="#/x">` do the same thing in
 * a hash-routed app — but the first resolves to nothing, so it renders as an
 * inert unknown element. Measured on a generated project: 9 controls, 8 of them
 * dead, the hash never changed, and 1 of 7 screens was reachable.
 *
 * It matters most in the modes that cannot repair. `economy` and `fast` both run
 * `repairPasses: 0`, so a defect the audit merely reports is a defect that
 * ships. This costs no tokens and runs in every mode.
 *
 * Only the unambiguous form is touched: a `to` (or bound `:to`) becomes `href`,
 * and nothing else about the element changes — class, style and handlers are
 * carried through untouched. `<router-view>` is deliberately left alone; there
 * is no mechanical equivalent, and the audit reports it instead.
 */
export function normalizeRouterLinks(source: string, kind: OutputKind): { html: string; rewritten: number } {
  if (kind === 'react') return { html: source, rewritten: 0 }

  let n = 0
  const html = source
    .replace(/<(router-link|RouterLink)(\s[^>]*?)?(\/?)>/g, (_m, _tag, attrs: string | undefined, selfClose: string) => {
      n++
      const a = (attrs ?? '').replace(/(^|\s)(:?)to(\s*=)/g, (_x, lead: string, bind: string, eq: string) =>
        `${lead}${bind}href${eq}`
      )
      return `<a${a}${selfClose}>`
    })
    .replace(/<\/(router-link|RouterLink)>/g, '</a>')
  return { html, rewritten: n }
}

/**
 * Element names a template may use without importing anything.
 *
 * Not exhaustive HTML — it does not need to be. Only names carrying a capital or
 * a dash are checked, and no standard element has either, so this list exists
 * purely for the handful of built-ins the frameworks themselves provide.
 */
const FRAMEWORK_BUILTIN_TAGS = new Set([
  // Vue
  'component', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense', 'slot',
])

/**
 * SVG elements whose names carry a capital letter.
 *
 * The test for "this looks like a component" is a capital or a hyphen, and SVG
 * is full of camelCase element names — so `<linearGradient>` inside a chart
 * reads as a component nobody imported. It compiles, it paints, it is a
 * perfectly ordinary gradient, and it was reported on two of the three
 * frameworks in the v197 round.
 *
 * Worse than a stray finding, because the repair acts on it: told a component is
 * missing, it writes one. That round shipped
 * `src/components/illustrations/LinearGradient.vue` and
 * `src/components/charts/LineChartGradient.svelte` — files invented to satisfy a
 * complaint about the SVG specification.
 *
 * Matched case-insensitively like the framework tags above, so `<clipPath>` and
 * `<clippath>` are both let through.
 */
const SVG_CAMEL_TAGS = new Set(
  [
    'animateMotion', 'animateTransform', 'clipPath', 'feBlend', 'feColorMatrix',
    'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
    'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
    'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge',
    'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
    'feSpotLight', 'feTile', 'feTurbulence', 'foreignObject', 'glyphRef',
    'linearGradient', 'radialGradient', 'textPath',
  ].map((t) => t.toLowerCase())
)

/**
 * Components a template renders that nothing in the file defines.
 *
 * This is the failure mode that survives every other check. An unresolved
 * component is not a compile error in either framework — Vue emits a
 * `resolveComponent` call and Svelte an unknown element — so the bundle is
 * clean, the page renders, and the element is simply inert. Measured on a
 * generated Vue project: the sidebar was built from `<router-link to="#/…">`,
 * vue-router is not present and is banned by the contract, and every one of the
 * six screens was unreachable. Nothing reported anything: it compiled, it
 * painted, and no link worked.
 *
 * Only capitalised or dashed names are considered, because those are the only
 * ones the frameworks treat as components — everything else is a plain element.
 * That the contract forbids both packages and global registration is what makes
 * "not imported here" equal "does not exist".
 */
export function unresolvedComponentDefects(
  source: string,
  kind: OutputKind
): { id: string; instruction: string }[] {
  if (kind === 'react') return [] // JSX names are identifiers; an undefined one is already a reference error.

  const ext = '.vue'
  const found = new Map<string, Set<string>>()

  for (const [path, body] of readProjectFiles(source)) {
    if (!path.endsWith(ext)) continue

    // Vue keeps its markup in <template>; a Svelte component's markup is
    // everything the blocks do not cover.
    const markup =
      kind === 'vue'
        ? [...body.matchAll(/<template[^>]*>([\s\S]*?)<\/template>/g)].map((m) => m[1]).join('\n')
        : body.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '')
    if (!markup) continue

    const imported = new Set<string>()
    for (const m of body.matchAll(/import\s+(\w+)\s+from\s+['"][^'"]+['"]/g)) imported.add(m[1])
    // `import { A, B } from '…'` — a named import is just as valid a component.
    for (const m of body.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g))
      for (const n of m[1].split(',')) imported.add(n.trim().split(/\s+as\s+/).pop()!.trim())

    for (const m of markup.matchAll(/<([A-Za-z][\w.-]*)/g)) {
      const tag = m[1]
      if (!/[A-Z]|-/.test(tag)) continue
      if (FRAMEWORK_BUILTIN_TAGS.has(tag.toLowerCase())) continue
      if (SVG_CAMEL_TAGS.has(tag.toLowerCase())) continue
      // `<router-link>` and `<RouterLink>` are the same component, and a file
      // importing either name has resolved both.
      const camel = tag.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())
      if (imported.has(tag) || imported.has(camel)) continue
      if (!found.has(tag)) found.set(tag, new Set())
      found.get(tag)!.add(path)
    }
  }
  if (found.size === 0) return []

  const lines = [...found].slice(0, 8).map(([tag, files]) => `- <${tag}> (${[...files].slice(0, 3).join(', ')})`)
  return [
    {
      id: 'component-unresolved',
      instruction:
        'どのファイルからも import されていないコンポーネントをテンプレートで使っています。' +
        'コンパイルは通り画面も描画されますが、その要素は何も表示せず、クリックしても動きません:\n' +
        lines.join('\n') +
        '\nvue-router などのパッケージは使えません。' +
        '画面遷移は自前のハッシュルーターで行い、リンクは <a href="#/screen"> か ' +
        'クリックハンドラから navigate() を呼ぶ形に書き換えてください。' +
        '自作コンポーネントであれば、そのファイルを作成して import してください。',
    },
  ]
}

/**
 * A component returning markup from its script.
 *
 *     <script lang="ts">
 *       …
 *       if (!equipment) {
 *         return (
 *           <div class="screen-container">
 *
 *     src/screens/EquipmentDetailScreen.svelte:
 *       Unexpected token, expected ">" (93:12)
 *
 * React's shape written in a Svelte or Vue file. The early return with markup
 * in it is the single most recognisable React habit there is, and it is the one
 * remaining Svelte failure in the corpus after every deterministic repair — 1
 * of 73, measured at 2026-08-28.
 *
 * A detector rather than a fixup, deliberately. Turning this into `{#if}` means
 * deciding where the conditional ends, what the other branch renders, and where
 * in an existing template the markup belongs — judgement, and getting it wrong
 * ships a WRONG interface rather than a blank one, which is strictly worse. The
 * compiler's own message is a parser position in a file the planner cannot see,
 * and the position is not even the faulty line: the fault is 20 lines up, in the
 * decision to return markup at all.
 *
 * So the model is told what the shape is, not where the parser stopped.
 *
 * The test is a `return` whose expression opens with `<`. A string containing
 * markup is not matched — quotes are checked — because `el.innerHTML = '<b/>'`
 * is ordinary code in any of the three frameworks.
 */
export function frameworkConfusionDefects(
  source: string,
  kind: OutputKind
): { id: string; instruction: string }[] {
  if (kind === 'react') return []

  const ext = '.vue'
  const guilty: string[] = []
  for (const [path, body] of readProjectFiles(source)) {
    if (!path.endsWith(ext)) continue
    for (const m of body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      if (/\breturn\s*\(?\s*<[A-Za-z]/.test(m[1])) {
        guilty.push(path)
        break
      }
    }
  }
  if (guilty.length === 0) return []

  const where = kind === 'vue' ? '<template>' : 'マークアップ部'
  const how =
    kind === 'vue'
      ? '`v-if` / `v-else` で出し分けてください'
      : '`{#if}` / `{:else}` で出し分けてください'

  return [
    {
      id: 'framework-confusion',
      instruction:
        `次のファイルは、script の中から JSX を return しています: ${guilty.slice(0, 6).join(', ')}\n` +
        `これは React の書き方です。${ext} の script は値と関数だけを持ち、` +
        `**画面は ${where} が持ちます**。script から markup を返すことはできず、` +
        'ファイル全体がコンパイルできません（コンパイラは括弧の位置を指しますが、' +
        '原因はその20行ほど上にある「markup を return する」という判断です）。\n' +
        `早期 return をやめ、条件は ${how}。表示される内容は変えないでください。`,
    },
  ]
}

export function addMissingBarrels(source: string): { html: string; added: string[] } {
  if (!isReactBundle(source)) return { html: source, added: [] }

  const files = reactFiles(source)
  const sources = new Map<string, string>()
  for (const [path, body] of files) if (isSourceFile(path)) sources.set(path, body)
  const paths = new Set(sources.keys())

  const hasIndex = (dir: string) => SOURCE_EXT.some((e) => paths.has(`${dir}/index${e}`))
  const resolvesToFile = (base: string) =>
    paths.has(base) || SOURCE_EXT.some((e) => paths.has(base + e))

  // Directories that are imported as modules but have no index of their own.
  const wanted = new Set<string>()
  for (const [importer, body] of sources) {
    for (const m of body.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      const base = normalize(`${dirname(importer)}/${m[1]}`)
      if (!base || resolvesToFile(base) || hasIndex(base)) continue
      // Only when the directory actually holds modules; anything else is a
      // genuinely broken import and inventing a file would hide it.
      if ([...paths].some((p) => p.startsWith(`${base}/`))) wanted.add(base)
    }
  }
  if (wanted.size === 0) return { html: source, added: [] }

  let out = source
  const added: string[] = []
  for (const dir of wanted) {
    // Direct children only. A barrel that reaches into subdirectories is not
    // what `./X` in the sibling files resolves to.
    const children = [...paths]
      .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .sort()
    if (children.length === 0) continue

    const lines: string[] = [
      '// Generated: the project imports this directory as a module.',
    ]
    for (const child of children) {
      const name = child.slice(dir.length + 1).replace(/\.(tsx|ts|jsx|js|mjs)$/, '')
      if (name === 'index') continue
      lines.push(`export * from './${name}';`)
      if (/export\s+default\b/.test(sources.get(child) ?? '')) {
        lines.push(`export { default as ${name.replace(/[^A-Za-z0-9_$]/g, '')} } from './${name}';`)
      }
    }
    const path = `${dir}/index.ts`
    const source = lines.join('\n')
    /**
     * Written through the transport, not as a script block.
     *
     * This appended `<script type="text/jsx" data-file=…>` unconditionally — the
     * transport React projects used before line fences. In a fenced document that
     * block is invisible to readProjectFiles, so the barrel was reported as
     * added, logged as added, and did not exist: the directory import it was
     * created to resolve stayed broken and the user got Module not found.
     */
    const next = writeProjectFile(out, path, source)
    if (next) {
      out = next
    } else {
      const block = `<script type="text/jsx" data-file="${path}">\n${source}\n</script>\n`
      const at = out.lastIndexOf('</body>')
      out = at === -1 ? out + block : out.slice(0, at) + block + out.slice(at)
    }
    added.push(path)
  }
  return { html: out, added }
}

interface RunnableDocument {
  /** The document to render. Empty when compilation failed. */
  html: string
  /** True when the source was a React project and had to be compiled. */
  compiled: boolean
  /** A syntax error that stopped compilation — a real defect in the output. */
  error: string | null
  /** Import specifiers that did not resolve. Not fatal; they throw on first use. */
  warnings: string[]
}

/**
 * Returns a document the browser can render.
 *
 * Plain HTML output passes through untouched — it is already a page. React output
 * is compiled. A compilation error is returned rather than thrown: it means the
 * generated project does not build, which is a finding, not an outage.
 */
export function toRunnableDocument(source: string, kindHint?: OutputKind): RunnableDocument {
  if (!isReactBundle(source)) {
    return { html: source, compiled: false, error: null, warnings: [] }
  }

  const files = reactFiles(source)
  /**
   * Read from the files rather than taken on trust. The caller usually knows the
   * framework, but a stored project predates the field and the extensions are the
   * fact either way; the hint only breaks a tie no real project has.
   */
  const kind = detectKind(files.keys()) ?? kindHint ?? DEFAULT_OUTPUT_KIND
  const sources = new Map<string, string>()
  for (const [path, content] of files) if (isSourceFile(path, kind)) sources.set(path, content)
  const paths = new Set(sources.keys())

  const entry = findEntry(paths, sources, kind)
  if (!entry) {
    return {
      html: '',
      compiled: true,
      error: `エントリーポイント（${RUNTIMES[kind].entries[0]}）が見つかりません`,
      warnings: [],
    }
  }

  const warnings: string[] = []
  const modules: string[] = []
  /** Styles a component carried inside itself, e.g. a .vue <style> block. */
  const componentCss: string[] = []
  for (const [path, content] of sources) {
    let code: string
    try {
      const compiled = compileFile(kind, path, content)
      code = compiled.code
      if (compiled.css) componentCss.push(compiled.css)
    } catch (e) {
      /**
       * A context provider's JSX in a .ts file is a mistake real tooling would
       * reject, but failing the whole verification over a file extension tells us
       * less than rendering the app does. Retry with JSX on, and record it.
       *
       * `kind === 'react'` is load-bearing, and its absence was a real defect.
       * This rescue is React-shaped — "the only reason a .ts file fails to
       * compile is JSX inside it" — and a Svelte project's rune modules are also
       * named `.ts`. So when the Svelte compiler correctly REFUSED
       * `src/lib/navigation.svelte.ts` ("Cannot export derived state from a
       * module"), this branch caught it, recompiled the file as plain
       * TypeScript, and shipped it: the runes survived as ordinary calls,
       * `import { $state } from 'svelte'` became `require('svelte')`, and the
       * page died on load with `_svelte.$state is not a function`. It also
       * emitted a warning about `.tsx`, which had nothing to do with anything.
       *
       * A precise compile error turned into a silent blank screen. Outside
       * React the failure is now reported as what it is.
       */
      if (kind === 'react' && path.endsWith('.ts')) {
        try {
          code = transform(content, {
            transforms: ['typescript', 'jsx', 'imports'],
            production: true,
            filePath: path,
          }).code
          warnings.push(`${path}: JSX を含むため .tsx にすべきファイルです`)
        } catch {
          return { html: '', compiled: true, error: `${path}: ${msgOf(e)}`, warnings }
        }
      } else {
        return { html: '', compiled: true, error: `${path}: ${msgOf(e)}`, warnings }
      }
    }
    code = rewriteRequires(code, path, paths, (spec) => warnings.push(`${path}: '${spec}' を解決できませんでした`))
    modules.push(`${JSON.stringify(path)}: function(exports, require, module){\n${code}\n}`)
  }

  const css = hoistImports([
    ...[...files.entries()].filter(([path]) => path.endsWith('.css')).map(([, content]) => content),
    ...componentCss,
  ].join('\n\n'))

  return {
    html: page(modules, css, entry, defaultRoutes(files), kind),
    compiled: true,
    error: null,
    warnings,
  }
}

function msgOf(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300)
}

/**
 * A second container for the frameworks whose convention is `#app`.
 *
 * `#root` is this shell's container and everything downstream measures it: the
 * browser verifier, the thumbnail renderer and the empty-render probe all look
 * it up by that name. But `#app` is what Vue and Svelte projects mount to
 * everywhere outside this codebase, so that is what a model writes, and the
 * generation contract asks for it too. Measured on a real 33-file Vue project:
 * every file compiled, `createApp(App).mount('#app')` found nothing, and the
 * page reported `render() was called but #root is empty`.
 *
 * Nesting the alias inside `#root` rather than beside it is what makes this work
 * without a second measurement path — mounting into `#app` fills `#root` too.
 * `display: contents` keeps the extra element out of layout entirely, so the
 * app's own height and flex chains behave as if it were not there.
 *
 * It is no longer conditional on the framework, and that is a fix rather than a
 * simplification. React's convention is `#root` and it was given a bare one —
 * until a React project written by the per-file build opened with
 * `createRoot(document.getElementById('app')!)`. React threw error #299 (the
 * container is not a DOM element), the page was blank, and browser verification
 * reported `screens: []` with one console error on a project where every file
 * compiled cleanly.
 *
 * Which id an entry file picks is a guess the model makes, and no prompt makes a
 * guess reliable. Providing both costs one element with `display: contents` and
 * removes the whole class of failure for every framework at once — including the
 * exported project, which reads its mount id back out of the entry file.
 */
function mountAlias(): string {
  return '<div id="app" style="display:contents"></div>'
}

/**
 * Every `@import` in the joined stylesheets, moved to the front.
 *
 * A browser ignores an `@import` that follows any other rule, and the stylesheets
 * are concatenated — so a font import at the top of globals.css stopped loading the
 * moment another .css file, or a component's own style block, sorted ahead of it.
 * The design system token block starts with exactly such an import.
 */
export function hoistImports(css: string): string {
  const imports: string[] = []
  const rest = css.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/g, (statement) => {
    if (!imports.includes(statement)) imports.push(statement)
    return ''
  })
  return imports.length ? `${imports.join('\n')}\n${rest}` : css
}

/**
 * Web storage that works where the real one is refused.
 *
 * The browser verification renders the project in a document with an opaque
 * origin, and there reading `window.localStorage` throws — 「SecurityError:
 * Failed to read the 'localStorage' property from 'Window': Access is denied for
 * this document」. A generated app that restores its state from storage on first
 * render then renders nothing. Measured on 2026-09-14: a flashcard app scored 30
 * with every screen unreachable, and the repair loop spent a pass on a blank page
 * that was not blank anywhere a user could see it.
 *
 * Not anywhere a user could see it because the preview already carries this:
 * `frontend/src/utils/preview/previewGuard.ts` installs the same in-memory stand-in in
 * its sandboxed frame, so the frame the user looks at worked and the frame the
 * pipeline measured did not. The two copies are held equal by
 * `test/storage-fallback.test.mjs`; checked in a real sandboxed iframe, the
 * stand-in serves `window.localStorage`, a bare `localStorage` and
 * `sessionStorage` alike.
 *
 * It does nothing where storage works: the stand-in is installed only when
 * touching the real one throws, so an exported or published page keeps the
 * browser's own.
 */
export const STORAGE_FALLBACK = `(function() {
    var _stores = { localStorage: {}, sessionStorage: {} };
    ['localStorage', 'sessionStorage'].forEach(function(key) {
      try { window[key].getItem('__test__'); } catch(e) {
        var store = _stores[key];
        var api = {
          getItem: function(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
          setItem: function(k, v) { store[k] = String(v); },
          removeItem: function(k) { delete store[k]; },
          clear: function() { _stores[key] = store = {}; },
          key: function(i) { return Object.keys(store)[i] || null; },
          get length() { return Object.keys(store).length; }
        };
        try { Object.defineProperty(window, key, { get: function() { return api; }, configurable: true }); } catch(e2) {}
      }
    });
  })();`

function page(modules: string[], css: string, entry: string, routes: string[], kind: OutputKind): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script data-makeui-storage>${STORAGE_FALLBACK}</script>
<style>${css}</style>
</head>
<body>
<div id="root">${mountAlias()}</div>
${RUNTIMES[kind].scripts.map((r) => `<script>${r}</script>`).join('')}
<script>
(function(){
  var __defs = {
${modules.join(',\n')}
  };
  var __cache = {};
  // Whether the app ever asked React to render. An empty #root otherwise cannot
  // distinguish "render was never called" from "render produced nothing", and
  // those need different fixes.
  var __rendered = false;
  var __builtin = ${RUNTIMES[kind].builtins};
  function require(id){
    if (Object.prototype.hasOwnProperty.call(__builtin, id)) return __builtin[id];
    if (__cache[id]) return __cache[id].exports;
    var def = __defs[id];
    if (!def) throw new Error('Module not found: ' + id);
    var module = { exports: {} };
    __cache[id] = module;
    def(module.exports, require, module);
    return module.exports;
  }
  require(${JSON.stringify(entry)});

  // Work through the project's own routes if the first paint is empty, then stop.
  // The walk that measures this page runs after a fixed wait, so this has to
  // settle on its own rather than report outward.
  var tries = 0, nudged = 0, __routes = ${JSON.stringify(routes)};
  // "#root has children" stopped meaning "something rendered" the moment the
  // shell put an alias container inside it, so the alias has to be discounted —
  // otherwise every empty render reads as a successful one.
  function __hasOutput(){
    var root = document.getElementById('root');
    if (!root) return false;
    var alias = document.getElementById('app');
    if (alias && alias.parentNode === root && root.children.length === 1) return alias.children.length > 0;
    return root.children.length > 0;
  }
  (function check(){
    if (__hasOutput()) return;
    if (tries > 8 && __rendered && nudged < __routes.length) {
      location.hash = __routes[nudged++];
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      tries = 0;
      setTimeout(check, 25);
      return;
    }
    if (++tries > 40) {
      // Surfaced as a console error so it lands in the verifier's error list
      // rather than being reported as an app that simply looks empty.
      console.error(__rendered
        ? 'render() was called but #root is empty at route "' + (location.hash || '(none)') + '"'
        : 'the entry module ran but createRoot().render() was never called');
      return;
    }
    setTimeout(check, 25);
  })();
})();
</script>
</body>
</html>`
}

/**
 * A name destructured out of something that never had it.
 *
 *     // src/store/index.ts
 *     export function useStore() {
 *       return { state, dispatch }
 *     }
 *
 *     // src/App.vue
 *     const { state, toast } = useStore()
 *     …
 *     <Toast v-if="toast.visible" :message="toast.message" />
 *
 * `toast` is `undefined`, and the template dereferences it. Measured at v176,
 * where it blanked the app; the Svelte run in the same batch failed on the same
 * mistake in its own dialect:
 *
 *     let { currentToast } = $derived.by(() => ({ message: appState.toast }))
 *
 * which Svelte compiles to a derived reading `.currentToast` off an object that
 * only has `message`. Two frameworks, one error: the destructuring pattern and
 * the object it reads from were written at different times and drifted apart.
 *
 * Nothing catches it earlier. Both files parse, both compile, the bundle builds,
 * and the failure is a TypeError at first render — so every gate upstream of the
 * browser calls the project sound. It is also invisible to the eye, because the
 * declaration is correct-looking and the object it refers to lives in another
 * file.
 *
 * Reported rather than repaired. The two cases above want opposite fixes — the
 * Svelte one should lose its braces, the Vue one wants `state.toast` — and
 * choosing between them means knowing what the author meant. Naming the fact is
 * what the repair pass cannot work out for itself; deciding it is what it is
 * good at.
 *
 * Only same-file factories and project-local imports are checked, and only when
 * the source function returns a plain object literal. Anything else is not
 * decidable from the text.
 */
/** A relative specifier against the project's own paths. */
function resolveSpec(files: Map<string, string>, from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const dir = from.slice(0, from.lastIndexOf('/'))
  const stack: string[] = []
  for (const seg of `${dir}/${spec}`.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  const base = stack.join('/')
  return [...files.keys()].find(
    (k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue)$/, '') === base ||
           k.replace(/\/index\.(tsx|ts|jsx|js)$/, '') === base
  )
}

/**
 * The body of a list iteration, so a property read can be attributed to it.
 *
 * Searching the whole file instead was measured across the corpus and it is not
 * close: `item` is the name everything picks, and a screen with a nav and a cart
 * binds it twice. `state.cart.reduce((sum, item) => sum + item.qty, 0)` sitting
 * forty lines below `NAV_ITEMS.map((item) => …)` reported `qty` missing from the
 * nav — a correct document, four findings.
 *
 * Declining whenever a name is bound twice was the cheaper answer and it throws
 * away the true positive in the same file: the nav really was reading
 * `item.href` off elements that carry only `id` and `label`. So the extent is
 * measured rather than guessed at.
 */
const iterationBody = (file: string, at: number, form: 'each' | 'map' | 'for'): string => {
  if (form === 'each') {
    let depth = 0
    for (let i = at; i < file.length; i++) {
      if (file.startsWith('{#each', i)) depth++
      else if (file.startsWith('{/each}', i)) {
        depth--
        if (depth === 0) return file.slice(at, i)
      }
    }
    return file.slice(at)
  }
  if (form === 'map') {
    const open = file.indexOf('(', at)
    if (open < 0) return ''
    let depth = 0
    for (let i = open; i < file.length; i++) {
      if (file[i] === '(') depth++
      else if (file[i] === ')') {
        depth--
        if (depth === 0) return file.slice(open, i)
      }
    }
    return file.slice(open)
  }
  /*
   * `v-for` is an attribute, so its scope is the element carrying it. The tag
   * name is read backwards from the attribute and the subtree forwards by
   * depth, because a nav item is very often a `<li>` inside a `<ul>` of them.
   */
  const lt = file.lastIndexOf('<', at)
  if (lt < 0) return ''
  const tag = /^<([A-Za-z][\w.-]*)/.exec(file.slice(lt))?.[1]
  if (!tag) return ''
  const gt = file.indexOf('>', at)
  if (gt < 0) return ''
  if (file[gt - 1] === '/') return file.slice(lt, gt)
  let depth = 0
  for (let i = lt; i < file.length; i++) {
    if (file.startsWith(`<${tag}`, i) && !/[\w.-]/.test(file[i + tag.length + 1] ?? '')) depth++
    else if (file.startsWith(`</${tag}`, i)) {
      depth--
      if (depth === 0) return file.slice(lt, i)
    }
  }
  return file.slice(lt)
}

/**
 * A loop reading a property its own data never carries.
 *
 *     export const NAV_ITEMS: NavItem[] = [
 *       { id: 'search_form', label: '検索' },
 *       { id: 'search_list', label: '結果' },
 *     ];
 *
 *     {#each NAV_ITEMS as item (item.id)}
 *       <a href={item.hash} …>{item.label}</a>
 *     {/each}
 *
 * There is no `hash`. Every anchor renders without an href, which is not a
 * broken link — it is not a link at all, and clicking it does nothing at all.
 * The document compiles, the nav is drawn, the labels are right, and the whole
 * of the application behind it is unreachable.
 *
 * Measured on a v191 Svelte result: two dead nav items, two unreachable
 * screens, and the walk was the only thing that noticed. It reported them as
 * `nav-dead-runtime` — true, and it names the symptom rather than the cause, so
 * the repair pass was told a button did nothing and left to guess why.
 *
 * The array has to be certain before the reading can be called wrong, so this
 * declines on anything it cannot see all of: a spread inside the literal, an
 * element that is not an object literal, a later `push` or reassignment, or a
 * second declaration of the same name. It also declines on an empty seed array,
 * which carries no keys because it carries nothing.
 */
export function missingItemKeyDefects(source: string): { id: string; instruction: string }[] {
  const files = readProjectFiles(source)
  if (files.size === 0) return []

  const all = [...files.entries()].filter(([p]) => !p.endsWith('.md'))
  const text = all.map(([, t]) => t).join('\n')

  const found: { id: string; instruction: string }[] = []
  const seen = new Set<string>()

  for (const [, body] of all) {
    // `const NAME = [ … ]` / `const NAME: T[] = [ … ]`, balanced from the bracket.
    for (const m of body.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*|[a-z][\w$]*)\s*(?::[^=\n]+)?=\s*\[/g)) {
      const name = m[1]
      const open = m.index! + m[0].length - 1
      let depth = 0
      let close = -1
      for (let i = open; i < body.length; i++) {
        if (body[i] === '[') depth++
        else if (body[i] === ']') { depth--; if (depth === 0) { close = i; break } }
      }
      if (close < 0) continue
      const literal = body.slice(open + 1, close)
      if (literal.trim() === '') continue
      if (literal.includes('...')) continue

      // Every element an object literal, and every key visible. A computed key
      // or a nested array is a shape this cannot vouch for.
      const elements = [...literal.matchAll(/\{[^{}]*\}/g)].map((e) => e[0])
      if (elements.length === 0) continue
      const stripped = literal.replace(/\{[^{}]*\}/g, '').replace(/[\s,]/g, '')
      if (stripped !== '') continue

      const keys = new Set<string>()
      for (const el of elements) {
        for (const k of el.matchAll(/(?:^|[{,])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g))
          keys.add(k[1] ?? k[2] ?? k[3])
        // A shorthand — `{ id, label }` — names a key just as well.
        for (const k of el.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) keys.add(k[1])
      }
      if (keys.size === 0) continue

      // Grown or replaced somewhere in the project: the literal is a starting
      // point, not the contract.
      if (new RegExp(`(?<![.\\w$])${name}\\s*(?:\\.(?:push|unshift|splice)\\s*\\(|=(?!=))`).test(text.replace(m[0], '')))
        continue
      if ([...text.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b`, 'g'))].length > 1) continue

      /*
       * Every way the three frameworks name the element of a list. The binding
       * is captured because the property reads are checked against that name and
       * nothing else — `other.hash` in the same file is another object.
       */
      for (const [path, file] of all) {
        const binders: { item: string; at: number; form: 'each' | 'map' | 'for' }[] = []
        for (const b of file.matchAll(new RegExp(`\\{#each\\s+${name}(?![\\w$])(?:\\s*\\.[\\w$().]+)?\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g')))
          binders.push({ item: b[1], at: b.index!, form: 'each' })
        for (const b of file.matchAll(new RegExp(`v-for\\s*=\\s*["']\\s*\\(?\\s*([A-Za-z_$][\\w$]*)[^"']*\\bin\\s+${name}\\b`, 'g')))
          binders.push({ item: b[1], at: b.index!, form: 'for' })
        for (const b of file.matchAll(new RegExp(`(?<![.\\w$])${name}(?:\\s*\\.[\\w$().]+)?\\.map\\s*\\(`, 'g'))) {
          const item = /\(\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(file.slice(b.index! + b[0].length - 1))?.[1]
          if (item) binders.push({ item, at: b.index! + b[0].length - 1, form: 'map' })
        }
        for (const b of binders) {
          const body = iterationBody(file, b.at, b.form)
          for (const use of body.matchAll(new RegExp(`(?<![.\\w$])${b.item}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
            const key = use[1]
            if (keys.has(key)) continue
            // Anything a plain object answers to is not a missing key.
            if (['length', 'toString', 'valueOf', 'constructor', 'hasOwnProperty'].includes(key)) continue
            const tag = `${name}.${key}`
            if (seen.has(tag)) continue
            seen.add(tag)
            found.push({
              id: 'item-key-missing',
              instruction:
                `${path} は ${name} の要素の \`${b.item}.${key}\` を読んでいますが、${name} の要素に ${key} は存在しません（あるのは ${[...keys].join(', ')} です）。` +
                `${name} の各要素に ${key} を持たせるか、読み出し側を既存のキーに変えてください。` +
                `href や onclick がこの値を受けている場合、その操作は何も起こしません。`,
            })
          }
        }
      }
    }
  }
  return found
}

export function destructuredKeyDefects(source: string): { id: string; instruction: string }[] {
  const files = readProjectFiles(source)
  if (files.size === 0) return []

  /** `return { a, b: x, c() {} }` → the names it actually provides. */
  const returnedKeys = (body: string, fnName: string): Set<string> | null => {
    const at = body.search(new RegExp(`(?:function\\s+${fnName}\\s*\\(|(?:const|let|var)\\s+${fnName}\\s*=)`))
    if (at < 0) return null
    const tail = body.slice(at)
    /*
     * The function's OWN return, not the first one inside it.
     *
     * `useNavigation` opens with a `parseHash` helper that returns
     * `{ screen }`, and taking the first `return {` read that as the hook's
     * contract — so every real key looked missing and a React project that
     * worked perfectly reported two. Depth one is the function body itself;
     * anything deeper belongs to something nested in it.
     */
    let scan = 0
    let ret = -1
    for (let i = tail.indexOf('{'); i < tail.length && i >= 0; i++) {
      const ch = tail[i]
      if (ch === '{') scan++
      else if (ch === '}') {
        scan--
        if (scan === 0) break
      } else if (scan === 1 && ch === 'r' && /^return\s*\{/.test(tail.slice(i))) {
        ret = i
        break
      }
    }
    if (ret < 0) return null
    // Balance braces from the opening one so a nested object cannot end it early.
    const open = ret + tail.slice(ret).indexOf('{')
    let depth = 0
    let close = -1
    for (let i = open; i < tail.length; i++) {
      if (tail[i] === '{') depth++
      else if (tail[i] === '}') {
        depth--
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) return null
    const literal = tail.slice(open + 1, close)
    const keys = new Set<string>()
    // Top level of the literal only — a nested `toast: { visible }` provides
    // `toast`, not `visible`.
    let d = 0
    let field = ''
    for (const ch of literal) {
      if (ch === '{' || ch === '[' || ch === '(') d++
      else if (ch === '}' || ch === ']' || ch === ')') d--
      if (d === 0 && ch === ',') { field = ''; continue }
      if (d === 0) field += ch
      if (d === 0 && (ch === ':' || ch === '(')) {
        const m = /([A-Za-z_$][\w$]*)\s*[:(]$/.exec(field.trim())
        if (m) keys.add(m[1])
      }
    }
    for (const m of literal.matchAll(/(?:^|,)\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[,}]|$)/g)) keys.add(m[1])
    for (const m of literal.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*[:(]/g)) keys.add(m[1])
    /*
     * Accessors and modified methods provide a key too. `useNavigation()`
     * returning `get route() { … }` was read as providing no `route`, so a
     * project that worked perfectly reported a missing key on every pass —
     * a false positive that spends repair budget on nothing.
     */
    for (const m of literal.matchAll(/(?:^|,)\s*(?:get|set|async)\s+([A-Za-z_$][\w$]*)\s*[(:]/g))
      keys.add(m[1])
    // A spread means the object carries names this cannot see.
    if (/\.\.\./.test(literal)) return null
    return keys
  }

  const found: { where: string; name: string; from: string; has: string[] }[] = []

  /*
   * The same mistake without the destructuring:
   *
   *     const store = useStore()      // returns { state, toggleFavorite, … }
   *     <span v-if="store.favorites.length">
   *
   * `favorites` lives under `state`, so `store.favorites` is undefined and
   * `.length` throws. Measured at v189, where it blanked a Vue project that
   * had nothing else wrong with it — five screens, icons, a real store.
   *
   * Reported for the same reason as the destructured spelling: the fix is
   * either to add the key to the factory or to read through the one that
   * holds it, and which is right depends on what the value is.
   */
  for (const [path, body] of files) {
    for (const m of body.matchAll(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\)/g
    )) {
      const holder = m[1]
      const fn = m[2]
      if (!/^use[A-Z]/.test(fn) && !/Store|State|Context/.test(fn)) continue

      let sourceBody: string | null = new RegExp(
        `(?:function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=)`
      ).test(body)
        ? body
        : null
      if (!sourceBody) {
        const imp = new RegExp(
          `import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`
        ).exec(body)
        if (!imp) continue
        const target = resolveSpec(files, path, imp[1])
        if (!target) continue
        sourceBody = files.get(target) ?? null
      }
      if (!sourceBody) continue

      const keys = returnedKeys(sourceBody, fn)
      if (!keys || keys.size === 0) continue

      const seen = new Set<string>()
      for (const use of body.matchAll(
        new RegExp(`(?<![\\w$])${holder}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
      )) {
        const key = use[1]
        if (keys.has(key) || seen.has(key)) continue
        /*
         * `navigation.params?.id` says the author knows it can be absent, and
         * the chain short-circuits rather than throwing. Reporting it would
         * be reporting a handled case — measured on a React project that
         * scored 82 with no console errors at all.
         */
        const after = body.slice((use.index ?? 0) + use[0].length)
        if (/^\s*\?\./.test(after)) continue
        seen.add(key)
        found.push({ where: path, name: `${holder}.${key}`, from: fn, has: [...keys] })
      }
    }
  }

  for (const [path, body] of files) {
      /*
       * The same mistake in Svelte's dialect, where the factory is inline:
       *
       *     let { currentToast } = $derived.by(() => ({ message: … }))
       *
       * Svelte compiles a destructured rune into a derived that reads that key
       * off the value, so a name the returned literal does not carry is
       * `undefined` on every render. There is no other module to consult — the
       * object is right there — which makes this the more clearly decidable
       * half of the same defect.
       */
      for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*\$derived(?:\.by)?\s*\(/g)) {
        const names = m[1]
          .split(',')
          .map((n) => n.split(':')[0].split('=')[0].trim())
          .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
        if (names.length === 0) continue

        // The object the arrow hands back, whichever form it was written in.
        const tail = body.slice((m.index ?? 0) + m[0].length)
        const at = tail.search(/return\s*\{|=>\s*\(\s*\{|=>\s*\{/)
        if (at < 0) continue
        const open = at + tail.slice(at).indexOf('{')
        let depth = 0
        let close = -1
        for (let i = open; i < tail.length; i++) {
          if (tail[i] === '{') depth++
          else if (tail[i] === '}') {
            depth--
            if (depth === 0) { close = i; break }
          }
        }
        if (close < 0) continue
        const literal = tail.slice(open + 1, close)
        // A `return { … }` inside a `=> { … }` body is the real literal.
        const inner = /^\s*return\s*\{/.exec(literal)
        const text = inner ? literal.slice(literal.indexOf('{', inner[0].length - 1) + 1) : literal
        if (/\.\.\./.test(text)) continue

        const keys = new Set<string>()
        for (const k of text.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*[:(]/g)) keys.add(k[1])
        for (const k of text.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[,}]|$)/g)) keys.add(k[1])
        if (keys.size === 0) continue

        for (const name of names) {
          if (keys.has(name)) continue
          if (!new RegExp(`\\b${name}\\s*(?:\\.|\\?\\.)\\s*[A-Za-z_$]`).test(body)) continue
          found.push({ where: path, name, from: '$derived', has: [...keys] })
        }
      }

    for (const m of body.matchAll(
      /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:\$derived(?:\.by)?\s*\(\s*)?([A-Za-z_$][\w$]*)\s*\(/g
    )) {
      const names = m[1]
        .split(',')
        .map((n) => n.split(':')[0].split('=')[0].trim())
        .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
      const fn = m[2]
      if (names.length === 0) continue

      // The factory: this file, or the project file it is imported from.
      let sourceBody: string | null = files.has(path) && new RegExp(`(?:function\\s+${fn}\\b|(?:const|let|var)\\s+${fn}\\s*=)`).test(body) ? body : null
      if (!sourceBody) {
        const imp = new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`).exec(body)
        if (!imp) continue
        const spec = imp[1]
        if (!spec.startsWith('.')) continue
        const dir = path.slice(0, path.lastIndexOf('/'))
        const stack: string[] = []
        for (const seg of `${dir}/${spec}`.split('/')) {
          if (seg === '.' || seg === '') continue
          if (seg === '..') stack.pop()
          else stack.push(seg)
        }
        const base = stack.join('/')
        const target = [...files.keys()].find(
          (k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue)$/, '') === base ||
                 k.replace(/\/index\.(tsx|ts|jsx|js)$/, '') === base
        )
        if (!target) continue
        sourceBody = files.get(target) ?? null
      }
      if (!sourceBody) continue

      const keys = returnedKeys(sourceBody, fn)
      if (!keys || keys.size === 0) continue
      for (const name of names) {
        if (keys.has(name)) continue
        // Only worth reporting when something actually reads through it.
        if (!new RegExp(`\\b${name}\\s*(?:\\.|\\?\\.)\\s*[A-Za-z_$]`).test(body)) continue
        found.push({ where: path, name, from: fn, has: [...keys] })
      }
    }
  }

  if (found.length === 0) return []
  const lines = found
    .slice(0, 6)
    .map((f) => `- ${f.where}: \`${f.name}\` を ${f.from}() から分割代入していますが、返り値は { ${f.has.join(', ')} } です`)
  return [
    {
      id: 'destructured-key-missing',
      instruction:
        '存在しないプロパティを分割代入しており、値が undefined のままテンプレートで参照されています。' +
        '**初回レンダリングで TypeError になり画面が真っ白になります。**\n' +
        lines.join('\n') +
        '\n次のどちらかに直してください。どちらが正しいかは、その値をどう使っているかで決まります。\n' +
        '1. 返り値の側にそのプロパティを足す（例: `return { state, dispatch, toast: state.toast }`）\n' +
        '2. 分割代入をやめて受け取ったオブジェクトごと使う（例: `const store = useStore()` として `store.state.toast` を参照）\n' +
        'なお `$derived` / `$derived.by` の分割代入は、返したオブジェクトの同名キーを読みます。' +
        'キー名が違えば undefined になるので、名前を一致させるか分割代入をやめてください。',
    },
  ]
}

/**
 * A hook called inside a branch.
 *
 *     if (state.ui.modalType === 'rejection') {
 *       const [reason, setReason] = React.useState('');
 *       const [error, setError] = React.useState('');
 *
 *     Minified React error #310  (rendered more hooks than during the
 *     previous render)
 *
 * React matches hooks to their state by call order, so a hook behind a condition
 * shifts every hook after it the moment the condition changes — and the screen
 * that was working goes down mid-interaction rather than on load, which is the
 * expensive kind of broken. Measured at v177 on a modal that branched on its own
 * type and declared each branch's state inside the branch.
 *
 * Reported, not rewritten. Hoisting the call is the fix, and whether it CAN be
 * hoisted depends on what it closes over: `useState('')` moves freely, and one
 * initialised from a value the branch computed does not. Naming the file, the
 * hook and the condition is the part a repair pass cannot work out for itself.
 *
 * Only inside a component — a name starting with a capital — and only for the
 * `if` / `for` / `while` / `switch` forms. That is where the mistake actually
 * gets made, and it keeps the check away from the callback bodies where a
 * deeper hook call means something else is wrong.
 */
export function conditionalHookDefects(source: string): { id: string; instruction: string }[] {
  const found: { where: string; hook: string; cond: string }[] = []

  for (const [path, body] of readProjectFiles(source)) {
    if (!/\.(tsx|jsx)$/.test(path)) continue
    const lines = body.split('\n')

    let inComponent = false
    let componentDepth = 0
    let depth = 0
    // Depths at which a conditional block was opened, innermost last.
    const branches: { depth: number; text: string }[] = []

    for (const line of lines) {
      if (!inComponent && /(?:export\s+default\s+)?function\s+[A-Z]\w*\s*\(|(?:const|let)\s+[A-Z]\w*\s*=\s*\(?[^=]*\)?\s*=>/.test(line)) {
        inComponent = true
        componentDepth = depth
      }

      if (inComponent) {
        const cond = /^\s*(?:\}\s*)?(?:else\s+)?(if|for|while|switch)\s*\(/.exec(line)
        const hook = /(?:^|[^\w$.])(?:React\.)?(use[A-Z]\w*)\s*\(/.exec(line)
        if (hook && branches.length > 0) {
          found.push({ where: path, hook: hook[1], cond: branches[branches.length - 1].text })
        }
        if (cond && /\{\s*$/.test(line)) branches.push({ depth, text: line.trim().slice(0, 60) })
      }

      for (const ch of line) {
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          while (branches.length && branches[branches.length - 1].depth >= depth) branches.pop()
          if (inComponent && depth <= componentDepth) { inComponent = false; branches.length = 0 }
        }
      }
    }
  }

  if (found.length === 0) return []
  const seen = new Set<string>()
  const lines = found
    .filter((f) => !seen.has(f.where + f.hook) && seen.add(f.where + f.hook) !== undefined)
    .slice(0, 6)
    .map((f) => `- ${f.where}: \`${f.hook}()\` が \`${f.cond}\` の中で呼ばれています`)

  return [
    {
      id: 'conditional-hook',
      instruction:
        'フックが条件分岐の中で呼ばれています。React はフックを**呼び出し順**で state に対応づけるため、' +
        '条件が変わった瞬間に以降のフックがずれ、`Minified React error #310` で画面が落ちます。\n' +
        lines.join('\n') +
        '\n分岐の外、コンポーネント本体の先頭で必ず呼ばれるように移動してください。' +
        '分岐ごとに違う初期値が必要な場合は、フック自体は1回だけ呼び、初期値の方を条件で選んでください。' +
        '例: `const [reason, setReason] = useState("")` を先頭に出し、分岐では setReason で設定する。',
    },
  ]
}

/**
 * A response that stopped in the middle of a file.
 *
 * The transport counts its own fences, so this is arithmetic rather than a
 * guess: eight `@@@makeui:file` openings and seven `@@@makeui:endfile` closings
 * means the last file was never finished. Measured at v178 — a Vue project that
 * got as far as App.vue's `<script setup>` and stopped, leaving the block to
 * swallow the document's own `</body></html>`.
 *
 * What the compiler then says is `src/App.vue: Invalid end tag.`, which sends
 * the repair pass looking for a markup bug in a file whose real problem is that
 * it is only half there — and the screens and components that were never
 * written do not even appear as missing, because nothing references them yet.
 *
 * Worth naming for that reason alone: the honest instruction is "this was cut
 * off, write it again", and no amount of reading the visible markup arrives at
 * it.
 */
export function truncatedDocumentDefects(source: string): { id: string; instruction: string }[] {
  const opens = (source.match(/^@@@makeui:file /gm) ?? []).length
  const closes = (source.match(/^@@@makeui:endfile$/gm) ?? []).length
  if (opens === 0 || opens <= closes) return []

  // The file that never closed is the last one opened.
  const last = [...source.matchAll(/^@@@makeui:file (.+)$/gm)].pop()?.[1]?.trim() ?? '(不明)'

  return [
    {
      id: 'response-truncated',
      instruction:
        `生成が途中で終わっています（ファイル開始 ${opens} 件に対し終了 ${closes} 件）。` +
        `\`${last}\` が閉じられていないため、以降のファイルも書かれていません。\n` +
        'これは構文の誤りではなく出力が途中で切れたものです。マークアップを直そうとせず、' +
        `\`${last}\` を最初から書き直し、続けて残りのファイルを出力してください。` +
        '1ファイルあたりの記述を短くし、装飾より画面の数と動作を優先してください。',
    },
  ]
}

/**
 * A root component waiting for props nothing can pass.
 *
 *     // src/main.ts
 *     mount(App, { target: document.getElementById('root') });
 *
 *     // src/App.svelte
 *     let { currentRoute } = $props();
 *     …
 *     {#if currentRoute.screen === 'feed'}
 *
 * The entry mounts the root with a target and nothing else, so `currentRoute` is
 * `undefined` on every render and the first dereference throws. Nothing above
 * the root can ever supply it — there is no parent — which is what separates
 * this from an ordinary missing prop.
 *
 * Measured at v181. The same file imported a `route` store it then never used,
 * so the value it wanted was in scope under another name.
 *
 * Reported rather than repaired. The fix is either to read the state the root
 * actually has or to pass it at the mount call, and which one is right depends
 * on what the value is — the import sitting unused nearby is a strong hint and
 * not a certainty.
 *
 * Only names the root dereferences. An unused prop declaration is untidy, not
 * broken, and spending a repair pass on it would be worse than leaving it.
 */
export function rootPropsNeverPassedDefects(source: string): { id: string; instruction: string }[] {
  const files = readProjectFiles(source)
  if (files.size === 0) return []

  const entryPath = [...files.keys()].find((p) => /^src\/main\.(ts|js|tsx|jsx)$/.test(p))
  if (!entryPath) return []
  const entry = files.get(entryPath) ?? ''

  // What the entry mounts, and whether it hands over anything besides a target.
  const mounted =
    /mount\s*\(\s*([A-Z][\w$]*)\s*,\s*\{([\s\S]*?)\}\s*\)/.exec(entry) ||
    /createApp\s*\(\s*([A-Z][\w$]*)\s*\)/.exec(entry) ||
    /render\s*\(\s*<\s*([A-Z][\w$]*)\s*\/?\s*>/.exec(entry)
  if (!mounted) return []
  const rootName = mounted[1]
  const mountOptions = mounted[2] ?? ''
  if (/\bprops\s*:/.test(mountOptions)) return []
  // React and Vue pass props as attributes on the element itself.
  if (new RegExp(`<\\s*${rootName}\\s+[^/>]*[\\w-]+\\s*=`).test(entry)) return []

  const rootPath = [...files.keys()].find((p) =>
    new RegExp(`(?:^|/)${rootName}\\.(vue|tsx|jsx)$`).test(p)
  )
  if (!rootPath) return []
  const root = files.get(rootPath) ?? ''

  const declared: string[] = []
  const props =
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*\$props\s*\(/.exec(root) ||
    /defineProps\s*<\s*\{([^}]+)\}\s*>/.exec(root) ||
    /function\s+[A-Z][\w$]*\s*\(\s*\{([^}]+)\}/.exec(root)
  if (!props) return []
  for (const raw of props[1].split(',')) {
    const name = raw.split(':')[0].split('=')[0].trim().replace(/\?$/, '')
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
    // Only what the root actually reads through.
    if (new RegExp(`\\b${name}\\s*(?:\\.|\\?\\.)\\s*[A-Za-z_$]`).test(root)) declared.push(name)
  }
  if (declared.length === 0) return []

  return [
    {
      id: 'root-props-never-passed',
      instruction:
        `${rootPath} が \`${declared.join('`, `')}\` を props として受け取る前提で書かれていますが、` +
        `${entryPath} は ${rootName} を props なしでマウントしています。**ルートには親がいないため、この値が渡されることはありません。**` +
        '初回レンダリングで undefined を参照して例外になり、画面全体が真っ白になります。\n' +
        'どちらかに直してください。\n' +
        `1. ルート側で props をやめ、ストアやモジュールから直接読む（${rootPath} が既に import しているモジュールを確認してください）\n` +
        `2. ${entryPath} のマウント時に値を渡す`,
    },
  ]
}

/**
 * A prop the child requires and the parent never passes.
 *
 *     // src/screens/SearchScreen.svelte
 *     let { navigate } = $props<{ navigate: (s: ScreenId) => void }>();
 *
 *     // src/App.svelte
 *     <SearchScreen />
 *
 *     TypeError: $$props.navigate is not a function
 *
 * Measured at v189: App held `navigate` from `useNavigation()` and handed it to
 * none of its five screens, every one of which declared it required. Five
 * console errors, and a score of 30 on a project that was otherwise complete.
 *
 * `rootPropsNeverPassedDefects` covers the root, where no parent exists to
 * supply anything. This is the ordinary case one level down, where the parent
 * is right there and usually holds a binding of exactly that name.
 *
 * The first version of this was thrown away for firing on thirty-three of a
 * hundred and thirty stored documents, including one that scored 79 with no
 * errors at all: it looked for `property=` and Svelte writes
 * `<PropertyCard {property} />`. Every spelling a framework accepts is a
 * spelling this has to read, so they are all listed below and the corpus is the
 * check on whether the list is complete.
 */
export function requiredPropNeverPassedDefects(source: string): { id: string; instruction: string }[] {
  const files = readProjectFiles(source)
  if (files.size === 0) return []

  const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

  /** Every way a parent can hand `prop` to a child, across the three frameworks. */
  const passes = (attrs: string, prop: string): boolean => {
    const k = kebab(prop)
    return (
      // prop={x}  prop="x"  :prop=  v-bind:prop=  bind:prop=
      new RegExp(`(?:^|\\s)(?::|v-bind:|bind:)?(?:${prop}|${k})\\s*=`).test(attrs) ||
      // Svelte shorthand {prop} and bind:prop with no value
      new RegExp(`\\{\\s*${prop}\\s*\\}`).test(attrs) ||
      new RegExp(`(?:^|\\s)bind:(?:${prop}|${k})(?![\\w-])`).test(attrs) ||
      // a spread carries names this cannot see
      /\{\s*\.\.\./.test(attrs) ||
      /v-bind\s*=/.test(attrs)
    )
  }

  const found: { child: string; parent: string; prop: string }[] = []

  for (const [path, body] of files) {
    if (!/\.(vue|tsx|jsx)$/.test(path)) continue
    const name = path.split('/').pop()?.replace(/\.\w+$/, '') ?? ''
    if (!/^[A-Z]/.test(name)) continue

    const decl =
      /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*\$props\s*[<(]/.exec(body) ||
      /defineProps\s*<\s*\{([^}]+)\}\s*>/.exec(body) ||
      new RegExp(`function\\s+${name}\\s*\\(\\s*\\{([^}]+)\\}`).exec(body) ||
      new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*\\(\\s*\\{([^}]+)\\}`).exec(body)
    if (!decl) continue

    /*
     * Optional in the type, not only in the pattern.
     *
     * The `?` was read out of the destructuring pattern, and that is not where
     * it lives:
     *
     *     let { label, value, delta, isIncrease } = $props<{
     *       label: string;
     *       delta?: number;
     *     }>();
     *
     *     {#if delta !== undefined}{delta.toFixed(1)}%{/if}
     *
     * The pattern says `delta` and the type says `delta?`. Reported at v204 —
     * a component that declares the prop optional and guards every use of it,
     * called correctly by a parent that omits it.
     *
     * Every `name?:` in the file is collected rather than only the ones inside
     * this component's own props type. That over-collects when an unrelated
     * interface in the same file happens to use the name, and the direction of
     * that error is to stay quiet — which is the right direction for a check
     * whose false positives cost a repair pass.
     */
    const optional = new Set(
      [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\?\s*:/g)].map((m) => m[1])
    )
    const required: string[] = []
    for (const raw of decl[1].split(',')) {
      const bare = raw.trim()
      // A default or a `?` makes it optional, and the child copes without it.
      if (!bare || bare.includes('=') || bare.includes('?')) continue
      const key = bare.split(':')[0].trim()
      if (optional.has(key)) continue
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue
      // Read or called somewhere in the child, or it costs nothing to omit.
      if (!new RegExp(`(?<![\\w$.])${key}\\s*(?:[.(]|\\?\\.)`).test(body)) continue
      required.push(key)
    }
    if (required.length === 0) continue

    for (const [parentPath, parentBody] of files) {
      if (parentPath === path) continue
      /*
       * An attribute value can contain `>`. `onCardClick={() => navigate(…)}`
       * has one in the arrow, so stopping at the first `>` cut the tag short and
       * every attribute after it read as absent — two false positives on a React
       * project that scored 82 with no errors at all.
       */
      for (const open of parentBody.matchAll(new RegExp(`<${name}(?![\\w$])`, 'g'))) {
        let depth = 0
        let end = -1
        for (let i = (open.index ?? 0) + open[0].length; i < parentBody.length; i++) {
          const ch = parentBody[i]
          if (ch === '{') depth++
          else if (ch === '}') depth--
          else if (ch === '>' && depth === 0) { end = i; break }
        }
        if (end < 0) continue
        const attrs = parentBody.slice((open.index ?? 0) + open[0].length, end)
        /*
         * `children` is passed by the element's body, not by an attribute.
         *
         * `<Button variant="primary" onclick={…}>カートに追加</Button>` passes
         * children — as a snippet in Svelte 5, as JSX children in React — and
         * this looked for a `children=` attribute, found none, and reported the
         * parent for not passing it. Thirty-one of the 78 findings across the
         * corpus were that, all on `<Button>` and `<Shell>` elements with a
         * body sitting right there in the markup.
         *
         * A self-closing `<Button />` still reports: a component whose whole
         * job is to render what it wraps, given nothing to wrap, renders an
         * empty control.
         */
        const selfClosing = /\/\s*$/.test(attrs)
        for (const prop of required) {
          if (prop === 'children' && !selfClosing) continue
          if (passes(attrs, prop)) continue
          found.push({ child: path, parent: parentPath, prop })
        }
      }
    }
  }

  if (found.length === 0) return []
  const seen = new Set<string>()
  const lines = found
    .filter((f) => {
      const k = `${f.child}|${f.prop}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 6)
    .map((f) => `- ${f.parent} が ${f.child} を描画する際に \`${f.prop}\` を渡していません`)

  return [
    {
      id: 'required-prop-missing',
      instruction:
        '子コンポーネントが必須として宣言している props を、親が渡していません。' +
        '**その props を使う操作で TypeError になり、画面が落ちます。**\n' +
        lines.join('\n') +
        '\n親の描画箇所に属性として渡してください。親に同名の値がある場合はそれをそのまま渡します。' +
        '子側で実際には使わないなら、宣言のほうを削除してください。',
    },
  ]
}
