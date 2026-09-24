import { FRAMEWORKS, type OutputKind } from '../config/frameworks.js'
import { readProjectFiles, writeProjectFile } from './project-transport.js'
import { dropSuppliedFiles } from './supplied-files.js'
import { fixCountBadges, fixFlowScreensInNav, fixIconBaseline } from './shell-fixes.js'
import { fixResponsiveDisplay } from './responsive-display.js'
import { fixSourceConsistency } from './source-consistency.js'
export { dropSuppliedFiles }
import { fixNamedImportOfDefault } from './react-bundle.js'
import { replaceEmoji } from './emoji-icons.js'
import { PHOTO_SLOT } from './stock-images.js'
import { UTILITY_CLASS, definedClasses, paletteOf, roleOf, utilityCss } from './utility-css.js'
import { listIsStyled, navCss, VERTICAL_NAV, type NavRoot } from './nav-css.js'
import { reachByKeyboard } from './keyboard-reach.js'
import { fixRenderNavigation } from './render-navigation.js'
import { PICTURE_FRAME, iconsOnPhotographs, pictureFrames } from './picture-frames.js'
import {
  ICON_BUTTON_CSS,
  ICON_BUTTON_MARKER,
  ICON_DIR,
  glyphSource,
  iconPlacements,
  type IconPlacement,
} from './action-icons.js'
import { raiseControlFonts } from './form-controls.js'
import {
  ART_DIR,
  CREATED_ART,
  artName,
  emptyStateArt,
  findArtHosts,
  type ArtHost,
  importPath,
  isDefaultExport,
  pickArtwork,
  renderedFrom,
} from './artwork.js'

/**
 * Deterministic repairs for idioms that stop a framework compiling outright.
 *
 * The rule for what belongs here is narrow: the failure must be fatal (the user
 * sees a build error instead of a UI), the correct form must be unambiguous, and
 * the rewrite must be mechanical. Anything needing judgement belongs in the
 * repair loop, which costs a model call and can be wrong.
 *
 * These run on both build paths and in every effort profile, including the two
 * that pay for no repair passes at all — which is the point. A project that will
 * not build is not a less complete interface; it is not an interface.
 */

/** A statement's extent, found by matching brackets from a starting offset. */
function statementRange(source: string, at: number): { start: number; end: number } | null {
  // Back to the start of the statement: the previous `;`, `{`, `}` or newline
  // that is not inside the expression we are in.
  let start = at
  while (start > 0) {
    const c = source[start - 1]
    if (c === ';' || c === '{' || c === '}' || c === '\n') break
    start--
  }
  /**
   * Counted from the start of the statement, not from the macro.
   *
   * Starting at the macro was wrong for the shape this exists to fix:
   * `withDefaults(defineProps<Props>(), {…})` opens its bracket BEFORE the
   * macro, so the scan met that closing `)` at depth -1 and gave up — which
   * silently disabled the whole repair on the only case reported.
   */
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const c = source[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth < 0) return null
    } else if ((c === ';' || c === '\n') && depth === 0) {
      return { start, end: c === ';' ? i + 1 : i }
    }
  }
  return { start, end: source.length }
}

/** The identifier a `const X = …` statement declares, if it declares one. */
function declaredName(statement: string): string | null {
  const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(statement)
  return m ? m[1] : null
}

/**
 * Vue rejects a second `defineProps()` in the same component, and generated
 * components write one.
 *
 * Measured, reported by a user with the compiler's own message:
 *
 *     src/components/ProductCard.vue: [@vue/compiler-sfc] duplicate defineProps() call
 *     88 |  const props = defineProps<Props>()
 *
 * The shape is always the same — a `withDefaults(defineProps<Props>(), {…})`
 * establishing the props, and then a second plain `defineProps<Props>()` a few
 * lines down, usually because the file wanted a local `props` binding and forgot
 * it already had one. The first call is the one carrying the defaults, so it is
 * the one to keep; the later statement is deleted and, when it declared a name
 * the rest of the file uses, that name is bound to the first call's result
 * instead.
 *
 * `defineEmits` duplicates the same way and is refused the same way.
 */
export function fixVueMacros(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (const macro of ['defineProps', 'defineEmits']) {
    for (;;) {
      const sites: number[] = []
      // `defineProps` as a call, not as a word inside a comment or a string.
      for (const m of out.matchAll(new RegExp(`\\b${macro}\\s*[<(]`, 'g'))) {
        sites.push(m.index ?? 0)
      }
      if (sites.length < 2) break

      const keepRange = statementRange(out, sites[0])
      const dropRange = statementRange(out, sites[1])
      if (!keepRange || !dropRange || dropRange.start < keepRange.end) break

      const keptName = declaredName(out.slice(keepRange.start, keepRange.end))
      const droppedName = declaredName(out.slice(dropRange.start, dropRange.end))

      let replacement = ''
      if (droppedName) {
        // The binding is probably used below. Point it at the surviving call
        // rather than deleting it and breaking every reference.
        replacement = keptName
          ? `\nconst ${droppedName} = ${keptName}`
          : `\nconst ${droppedName} = __makeuiProps`
        if (!keptName) {
          // The kept call was not assigned to anything, so give it a name first.
          out = `${out.slice(0, keepRange.start)}\nconst __makeuiProps = ${out
            .slice(keepRange.start, keepRange.end)
            .trim()}${out.slice(keepRange.end)}`
          // Offsets moved; redo this macro from the top.
          fixed.push(`${macro}: 重複した呼び出しを1つにまとめました`)
          continue
        }
      }
      out = out.slice(0, dropRange.start) + replacement + out.slice(dropRange.end)
      fixed.push(`${macro}: 重複した呼び出しを削除しました`)
    }
  }

  return { source: out, fixed }
}

/**
 * Runes imported as if they were values.
 *
 *     import { $state } from 'svelte';
 *
 * Measured on a real Svelte run at v138: that one line in
 * `src/lib/store.svelte.ts` failed to compile, and because a project is built
 * as a unit, one unbuildable file rendered the whole app as a blank page —
 * `syntax-error`, `blank-render`, `console-error`, score 30. Nothing else in
 * the project was wrong.
 *
 * The framework contract already says, in as many words, that runes are syntax
 * and not imports. It said so on this run too. An instruction that is followed
 * most of the time still ships a blank page the rest of the time, and a blank
 * page is the one outcome that has to be impossible — so the rule is enforced
 * here rather than asked for.
 *
 * Only names from 'svelte' itself are touched. A project's own module may
 * legitimately export something beginning with `$`, and `mount`, `tick` and
 * `onMount` are real imports from 'svelte' that must survive.
 */

/**
 * An at-rule wrapped in `:global()`.
 *
 *     :global(@media (prefers-reduced-motion: reduce)) { … }
 *
 * Svelte parses the `<style>` block of every component, and this is not a
 * selector, so it stops at `src/App.svelte: Expected a valid CSS identifier`
 * (svelte.dev/e/css_expected_identifier) and the project does not build — a
 * blank page from a media query. Measured on a real run at v139.
 *
 * The mistake is an over-correction rather than ignorance: Svelte scopes
 * component styles, `:global()` is how you opt out, and applying it to the whole
 * at-rule is the obvious next step. `@media` is never scoped in the first place,
 * so unwrapping it is what was meant — the `:global()` belongs on the selectors
 * inside, where any that are already there keep working.
 */

/** Every fixup that applies to one file of this framework. */
export function fixupFile(kind: OutputKind, path: string, body: string): { body: string; fixed: string[] } {
  /*
   * Whatever the framework: `import { x } = require(…)` is neither language's
   * syntax, and the file stops parsing at the `=`.
   */
  const arrowCast = fixArrowFunctionCast(body)
  body = arrowCast.source

  const hybrid = fixImportRequireHybrid(body)
  const hybridFixed = [...arrowCast.fixed, ...hybrid.fixed]
  body = hybrid.source

  if (kind === 'vue' && path.endsWith('.vue')) {
    const handler = fixVueUnclosedHandler(body)
    const captured = fixVueUncapturedProps(handler.source)
    // After the rewrite above, which binds `props` itself when it fires. This
    // one is for the case that one returns early on: the names live in a
    // separate interface, so it finds none, and the uses are already written
    // `props.data` — only the binding is missing.
    const bound = fixVueUnboundProps(captured.source)
    const r = fixVueMacros(bound.source)
    return {
      body: r.source,
      fixed: [...hybridFixed, ...handler.fixed, ...captured.fixed, ...bound.fixed, ...r.fixed],
    }
  }
  // React and anything else: the hybrid import is the only framework-agnostic
  // repair, and it has already been applied.
  return { body, fixed: hybridFixed }
}

/**
 * Applies the fixups across a whole transported document.
 *
 * Used by the single-call build path, which has no per-file step to hook into.
 */
export function fixupProject(html: string, kind: OutputKind): { html: string; fixed: string[] } {
  const supplied = dropSuppliedFiles(html)
  html = supplied.html
  let files = readProjectFiles(html)
  if (files.size === 0) return { html, fixed: [] }

  let out = html
  const fixed: string[] = supplied.dropped.length > 0
    ? [`MakeUI が用意するビルド設定を削除しました（${supplied.dropped.join(', ')}）`]
    : []

  /**
   * One repair, written back.
   *
   * Every pass below returns the files it changed and a line saying what it
   * did; putting them back was nine identical lines each, eighteen times, and
   * the file's own line ceiling started to be about the wiring rather than the
   * repairs. The order of the calls is the order of the passes and still
   * matters — each one reads what the one before it wrote.
   */
  const apply = (r: { files: Map<string, string>; fixed: string[] }): void => {
    if (r.fixed.length === 0) return
    for (const [path, body] of r.files) {
      const next = writeProjectFile(out, path, body)
      if (next) out = next
    }
    files = readProjectFiles(out)
    fixed.push(...r.fixed)
  }

  /**
   * Project-wide first, because renaming an export means rewriting its importers
   * and the two have to move together.
   */
  // Every framework: a `require` of a default export by name is the same
  // mistake whatever the component language is.
  apply(fixDefaultImportOfNamedExport(files))

  // And the reverse direction — see `fixNamedImportOfDefault`.
  const defaultNamed = fixNamedImportOfDefault(out)
  if (defaultNamed.fixed.length > 0) {
    out = defaultNamed.html
    files = readProjectFiles(out)
    fixed.push(...defaultNamed.fixed)
  }

  apply(fixRequireNamedDefault(files))

  if (kind === 'react') {
    apply(fixReactMissingProvider(files))
    // A page that navigates while it renders never returns to the event loop.
    // See tools/render-navigation.ts.
    apply(fixRenderNavigation(files))
  }

  if (kind === 'vue') {
    apply(fixVueNonReactiveHash(files))
  }

  /*
   * Two more from the storefront of 2026-09-18, both introduced by an EDIT
   * rather than by the build: a picture bound to a field the data does not
   * declare, and a route passed as a path. Project-wide because both need the
   * data types or the router to decide, which live in other files.
   */
  apply(fixImageFieldMisspelt(files))

  apply(fixPathAsScreenId(files))

  apply(fixFlowScreensInNav(files))

  apply(fixCountBadges(files))

  apply(fixIconBaseline(files))

  apply(fixResponsiveDisplay(files))

  // Four that compile and render and are wrong — see tools/source-consistency.ts.
  apply(fixSourceConsistency(files))

  /**
   * Two defects a user reported on one generated storefront, both invisible to
   * the compiler: every product card said 「商品画像」 instead of showing one, and
   * every product opened a detail screen that could not find it.
   */
  /*
   * After the repairs that write markup, because it reads the markup: a class
   * added by one of them is a class this has to define.
   */
  /*
   * Before the utility pass, which appends to the same stylesheet: the
   * navigation's rules belong with the project's own, above the block of
   * utilities.
   */
  /*
   * The input font, before the passes that append to the same stylesheet: this
   * edits rules the project already wrote, at the offsets it read them from.
   */
  const fonts = raiseControlFonts(files, out)
  if (fonts.raised.length > 0) {
    for (const [path, body] of fonts.files) {
      const next = writeProjectFile(out, path, body)
      if (next) out = next
    }
    files = readProjectFiles(out)
    const values = [...new Set(fonts.raised.map((r) => r.value))].join(' / ')
    fixed.push(
      `入力欄の font-size を 16px 以上にしました（${values} → 16px、規則${fonts.raised.length}件）` +
        '。16px 未満は iOS でフォーカス時にページが拡大されます'
    )
  }

  /*
   * Before the styling passes, because it only adds attributes: a class the
   * utility pass has to define is not one this writes.
   */
  apply(fixKeyboardUnreachable(files, kind))

  /*
   * The decoration on the photograph, before the artwork pass: both are about
   * what is drawn where, and this one only removes.
   */
  apply(fixIconOnPhotograph(files, kind))

  /*
   * The tokens the drawings read, before the drawings: a picture drawn in
   * `var(--border)` is invisible until something defines `--border`, and
   * putting it on screen first would report a fix nobody can see.
   */
  apply(fixUndefinedTokens(files))

  /*
   * And the drawing, before the styling passes for the same reason: the
   * element it inserts carries no class the utility pass would have to define.
   */
  apply(fixArtworkNotDrawn(files, kind))

  /*
   * The glyphs after the drawing: both read the markup, and a button given a
   * glyph is not a place an illustration would have gone.
   */
  apply(fixIconsNotDrawn(files, kind))

  apply(fixUnstyledNav(files))

  apply(fixDeadUtilityClasses(files))

  apply(fixCatalogueWithoutPhotos(files))

  apply(fixPlaceholderImageBoxes(files))

  apply(fixDetailIdNotPassed(files))

  for (const [path, body] of files) {
    const r = fixupFile(kind, path, body)
    if (r.fixed.length === 0) continue
    const next = writeProjectFile(out, path, r.body)
    if (!next) continue
    out = next
    fixed.push(`${path}: ${r.fixed.join(' / ')}`)
  }

  /*
   * Emoji last, and the one entry here that is not fatal — see emoji-icons.ts
   * for why it is here anyway: a model fixed it 6 times in 40, and 15 of the
   * last 80 documents shipped with it. Read fresh, because the loop above has
   * rewritten files since `files` was taken.
   */
  for (const [path, body] of readProjectFiles(out)) {
    const e = replaceEmoji(path, body, kind)
    if (e.body === body) continue
    const next = writeProjectFile(out, path, e.body)
    if (!next) continue
    out = next
    fixed.push(`${path}: emoji (${e.replaced} drawn as icons, ${e.removed} removed)`)
  }
  return { html: out, fixed }
}

/**
 * Renames any export whose name shadows a rune, across the whole project.
 *
 * Project-wide rather than per-file because the fix has two ends: the module
 * that exports the name and every file that imports it. Renaming one without the
 * other is worse than leaving it alone.
 *
 * The replacement is deliberately conservative — an identifier not preceded by a
 * dot or a dollar and not used as an object key — and the caller re-compiles
 * afterwards, so a rename that got something wrong declines the build rather
 * than shipping it.
 */
/**
 * Derived state exported from a rune module.
 *
 *     export const currentRoute = $derived(route);
 *
 * Svelte refuses it outright — "Cannot export derived state from a module. To
 * expose the current derived value, export a function returning its value" — so
 * the file does not compile and the project is a blank page. Measured in a real
 * Svelte run, and the framework contract already warns against it in one line,
 * which is evidently not enough.
 *
 * The restriction is on the binding rather than the syntax: `export { d }` and
 * `export default d` are refused the same way, so there is no rewrite that
 * leaves the import sites alone. Svelte's own advice is to export a function,
 * and that changes every reader — which is why this rewrites them too.
 *
 * Rewriting every read of an identifier would normally be too much to do without
 * a model in the loop. Here it is not, and the reason is worth stating plainly:
 * the input is ALREADY a guaranteed blank page. The rewrite can only improve it
 * or leave it equally broken, so the usual calculus does not apply.
 *
 * Two shapes, in order of safety:
 *   - nothing else imports the binding: drop the `export`, which is what the
 *     module meant and touches no other file.
 *   - it is imported: export a function of the same name and turn each read into
 *     a call, so `{currentRoute.screen}` becomes `{currentRoute().screen}`.
 *
 * Assignment is not a case to handle — derived state cannot be assigned to.
 */
/**
 * A button inside a button, which only Svelte treats as fatal.
 *
 *     <button class="card" onclick={open}>
 *       …
 *       <button class="action-button" onclick={add}>カートに追加</button>
 *     </button>
 *
 * Svelte stops the build:
 *
 *     `<button>` cannot be a descendant of `<button>`. The browser will 'repair'
 *     the HTML … which breaks Svelte's assumptions about the structure of your
 *     components.                        (svelte.dev/e/node_invalid_placement)
 *
 * React and Vue both compile it and render something, so the same markup is a
 * working card in two frameworks and a blank page in the third. That asymmetry
 * is why it keeps being written: nothing about the shape looks wrong, and it is
 * the natural way to express "the whole card is clickable, and it has a button
 * on it".
 *
 * Svelte is right, though — it is invalid HTML, and a browser really does move
 * the inner button out. So this is not a Svelte workaround: the outer element
 * becomes the div it should always have been, keeping its classes and its
 * handler, with role and tabindex so it stays reachable and announced.
 *
 * Measured in a real Svelte run, in src/components/ui/InventoryCard.svelte.
 *
 * Keyboard activation is not restored here. A div with role="button" needs its
 * own Enter/Space handler to be complete, and synthesising one means guessing at
 * the handler's signature. The audit still reports the accessibility gap; a
 * blank page reports nothing.
 */

/**
 * Svelte's attribute shorthand, written with a value inside it.
 *
 *     <svg {width={size}} height={size} …>
 *
 * Svelte has two forms and this is a collision of both: `{width}` passes a
 * variable of the same name, and `width={size}` passes an expression. Putting
 * the expression inside the braces is a parse error — "Expected token }" — and
 * the file, and therefore the project, does not build.
 *
 * Measured at v151, in src/components/icons/CartIcon.svelte. One icon of nine
 * had it, and it took the whole application to a blank page. The contract's own
 * Svelte example writes `width={size}` correctly, so this is not something being
 * taught; it is the kind of slip that a compiler is supposed to catch and a
 * generator has no way to notice.
 *
 * Unambiguous in both directions: `{name=…}` is never valid Svelte, and the
 * thing meant is always `name=…`. The braces around the value are kept exactly
 * as written, so an expression stays an expression and a string stays a string.
 */

/**
 * `{#const …}`, which is not a Svelte block.
 *
 *     {:else}
 *       {#const filtered = getFilteredProducts()}
 *
 * Svelte has five block types — if, each, await, key, snippet — and const is not
 * one of them. Declaring a value inside markup is `{@const …}`, with an at-sign,
 * and the compiler says so plainly:
 *
 *     Expected 'if', 'each', 'await', 'key' or 'snippet'
 *
 * Measured at v153, in src/screens/HomeScreen.svelte. One character, and the
 * project rendered nothing.
 *
 * `{#` and `{@` are the two sigils for two different things — a block that opens
 * and closes, and a tag that stands alone — and const is the only declaration
 * that lives in the second group while reading like the first. Nothing else maps
 * this way, so the rewrite is exactly one word wide and unambiguous: there is no
 * program in which `{#const}` means anything at all.
 */

/**
 * A React project whose entry forgets to mount its own provider.
 *
 *     // src/store/AppProvider.tsx  — written, exported, complete
 *     export function AppProvider({ children }) { … }
 *     export function useApp() {
 *       const ctx = useContext(AppContext)
 *       if (!ctx) throw new Error('useApp must be used within AppProvider')
 *       return ctx
 *     }
 *
 *     // src/main.tsx
 *     createRoot(root).render(<React.StrictMode><App /></React.StrictMode>)
 *
 * Every screen calls `useApp()`, the context is undefined, and the guard the
 * provider wrote for itself throws on first render:
 *
 *     Error: useApp must be used within AppProvider
 *
 * Measured at v166. The project compiled, twelve components and five screens
 * were all present and correct, and the application rendered nothing — because
 * one wrapper was missing from one line.
 *
 * This is React's version of the failure Svelte kept producing: a file that is
 * individually valid, in a project that cannot run. It is decidable in the same
 * way — the provider exists, something consumes it, and the entry does not mount
 * it, so there is no reading in which the current text is what was meant.
 *
 * Only when all three hold. A project with no provider is not missing one, and
 * an entry that already mounts it is left alone.
 */
export function fixReactMissingProvider(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const entryPath = [...files.keys()].find((p) => /^src\/main\.(tsx|jsx)$/.test(p))
  if (!entryPath) return { files, fixed: [] }
  const entry = files.get(entryPath) ?? ''
  if (!/\brender\s*\(/.test(entry)) return { files, fixed: [] }

  /*
   * The provider, and the hook that proves something needs it.
   *
   * The hook was looked for only in the provider's own file. Measured on the
   * digital-agency run of 2026-09-14: `AppProvider` in src/store/AppProvider.tsx,
   * `useApp` — with its 「useApp must be used within AppProvider」 guard — in
   * src/store/index.ts. No hook beside the provider, so nothing was wrapped, the
   * app threw on first render, five repair candidates were rejected for the same
   * error, and the run shipped blank.
   *
   * So a hook counts from either place: exported beside the provider, or exported
   * from a file whose guard names the provider. And every provider is considered
   * rather than the first one found, since a project can export two.
   */
  const exportedHooks = (body: string) =>
    [...body.matchAll(/export\s+(?:function|const)\s+(use[A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  let providerName = ''
  let providerPath = ''
  let hook = ''
  for (const [path, body] of files) {
    if (path === entryPath || !/\.(tsx|jsx)$/.test(path)) continue
    for (const m of body.matchAll(/export\s+(?:default\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*Provider)\b/g)) {
      const name = m[1]
      // Already mounted — including under a different local name via `as`.
      if (new RegExp(`<${name}[\\s/>]`).test(entry)) continue
      const guardNames = new RegExp(`['"\`][^'"\`]*\\b${name}\\b[^'"\`]*['"\`]`)
      const hooks = [
        ...exportedHooks(body),
        ...[...files].filter(([p, b]) => p !== path && /\bthrow\b/.test(b) && guardNames.test(b)).flatMap(([, b]) => exportedHooks(b)),
      ]
      // Something has to actually consume it, or wrapping is a change nobody asked for.
      const used = hooks.find((h) =>
        [...files].some(([p, b]) => p !== path && !exportedHooks(b).includes(h) && new RegExp(`\\b${h}\\s*\\(`).test(b))
      )
      if (used) { providerName = name; providerPath = path; hook = used; break }
    }
    if (providerName) break
  }
  if (!providerName) return { files, fixed: [] }

  // Wrap the root element the entry renders. `<App />` sits inside StrictMode
  // as often as not, so the innermost component element is the target rather
  // than the whole argument.
  const root = /<([A-Z][\w$]*)(\s[^>]*?)?\/>/.exec(entry)
  if (!root) return { files, fixed: [] }
  const wrapped = `<${providerName}>${root[0]}</${providerName}>`

  const importPath = `./${providerPath.replace(/^src\//, '').replace(/\.(tsx|jsx)$/, '')}`
  let next = entry.replace(root[0], () => wrapped)
  if (!new RegExp(`import\\s*\\{[^}]*\\b${providerName}\\b`).test(next)) {
    next = `import { ${providerName} } from '${importPath}';\n${next}`
  }

  const out = new Map(files)
  out.set(entryPath, next)
  return {
    files: out,
    fixed: [`${entryPath} が ${providerName} を包んでいなかったため追加（${hook}() が実行時に例外になる）`],
  }
}

/**
 * A Vue router that watches `location.hash`, which Vue cannot watch.
 *
 *     const route = ref(parseHash(location.hash))
 *     watch(() => location.hash, (hash) => { route.value = parseHash(hash) })
 *     function navigate(to) { location.hash = `#/${to}` }
 *
 * `location.hash` is not reactive, so the watcher's source is read once and never
 * again: `navigate()` changes the address, `route` never changes, and no button
 * in the app moves it. Measured on the spindle Vue run of 2026-09-15 (a clinic
 * booking app whose three home buttons all did nothing), and across 104 stored
 * projects: the watch appears in 9 of 24 Vue projects, and in 4 of them nothing
 * else listens for `hashchange` — every one a project whose navigation is dead.
 * A repair asked to fix "the buttons" rewrote the buttons, and the router stayed
 * broken; the edit the user asked for afterwards did the same.
 *
 * The answer is one line of Vue: give the watcher something reactive to watch. A
 * module-level ref kept current by a `hashchange` listener replaces each
 * non-reactive read in a `watch` source or a `computed` getter. Only when the
 * project has no `hashchange` listener anywhere — with one, navigation already
 * works and the watch is merely redundant.
 */
export function fixVueNonReactiveHash(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const code = [...files].filter(([p]) => /\.(ts|js|vue)$/.test(p))
  if (code.some(([, b]) => /addEventListener\(\s*['"]hashchange/.test(b))) return { files, fixed: [] }
  const out = new Map(files)
  const fixed: string[] = []
  const HASH_REF = '__makeuiHash'
  for (const [path, body] of code) {
    const script = path.endsWith('.vue') ? /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(body) : null
    const src = script ? script[1] : body
    let changed = 0
    let next = src.replace(/(watch\(\s*\(\)\s*=>\s*)(?:window\.)?location\.hash\b/g, (_w, head: string) => {
      changed++
      return `${head}${HASH_REF}.value`
    })
    next = next.replace(/(computed\(\s*\(\)\s*=>)([^)]*?)(?:window\.)?location\.hash\b(?!\s*=[^=])/g, (_w, head: string, mid: string) => {
      changed++
      return `${head}${mid}${HASH_REF}.value`
    })
    if (changed === 0) continue
    // `ref` from vue, added to an existing import or as a new one.
    const vueImport = /import\s*\{([^}]*)\}\s*from\s*['"]vue['"]/.exec(next)
    if (vueImport && !/\bref\b/.test(vueImport[1])) {
      next = next.replace(vueImport[0], vueImport[0].replace('{', '{ ref,'))
    } else if (!vueImport) {
      next = `import { ref } from 'vue'\n${next}`
    }
    const declaration =
      `\n// A ref Vue can watch: location.hash itself is not reactive, so a watch on it never fires.\n` +
      `const ${HASH_REF} = ref(location.hash)\n` +
      `window.addEventListener('hashchange', () => { ${HASH_REF}.value = location.hash })\n`
    // After the last import, so it is module scope and set up once however often a composable runs.
    const imports = [...next.matchAll(/^import[^\n]*\n/gm)]
    const at = imports.length ? (imports[imports.length - 1].index ?? 0) + imports[imports.length - 1][0].length : 0
    next = next.slice(0, at) + declaration + next.slice(at)
    out.set(path, script ? body.replace(script[1], () => next) : next)
    fixed.push(`${path}: location.hash を watch していたが Vue では反応しないため、hashchange で更新する ref に置き換え（画面遷移が一切機能しない状態の修正）`)
  }
  return fixed.length ? { files: out, fixed } : { files, fixed: [] }
}

/**
 * The id a list row chose never reaches the detail screen, so the detail screen
 * says the item does not exist.
 *
 * Measured on a real apparel storefront (2026-09-18, Spindle/React): tapping any
 * product opened 「商品が見つかりません」 and nothing could be added to the cart.
 * Three correct-looking pieces, wired to two different sources of truth:
 *
 *   ProductsScreen  dispatch({ type: 'SELECT_PRODUCT', payload: product.id })
 *                   navigate('product-detail')                    // no params
 *   App             <ProductDetailScreen productId={route.params?.id} />
 *   Detail          state.products.find(p => p.id === productId)  // undefined
 *
 * Nothing throws, the route changes, the screen renders — it renders its empty
 * state, which is precisely what the contract asks a detail screen to do when it
 * has no id. The build is one line short of working, and neither the compiler nor
 * the audits can see it: an empty state is a legitimate thing to render.
 *
 * The project contract says a row click passes the id through route params, so
 * the call site is what is wrong and the fix is local to it. The id comes from
 * whatever the same handler already knows the row to be — the payload it
 * dispatches, or the binding the list maps over.
 */
export function fixDetailIdNotPassed(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const code = [...files].filter(([p]) => /\.(tsx?|jsx?|vue)$/.test(p))
  if (code.length === 0) return { files, fixed: [] }

  /**
   * Screens rendered with an id read out of the route, and the key it is read
   * under. Taken from wherever the shell branches on `route.screen`, which is the
   * only place that knows which component a screen id renders.
   */
  const needsParam = new Map<string, string>()
  for (const [, body] of code) {
    /**
     * Each branch, then what that branch renders — not "a screen name somewhere
     * before a params read". Written the second way first, and on the real file
     * it matched `case 'products'` and ran on to the params read two branches
     * later, so the screen that actually needed the id was never seen.
     */
    for (const m of body.matchAll(/(?:case|route\.screen\s*===|screen\s*===|v-if\s*=\s*["'][^"']*===)\s*['"]([\w-]+)['"]/g)) {
      const screen = m[1]
      const branch = body.slice(m.index ?? 0, (m.index ?? 0) + 320)
      const key = /route\.params[!?]?\.(\w+)/.exec(branch)
      if (!key) continue
      if (!needsParam.has(screen)) needsParam.set(screen, key[1])
    }
  }
  if (needsParam.size === 0) return { files, fixed: [] }

  /**
   * How this project's `navigate` takes a parameter: the contract's shape is
   * `navigate(route: Route | ScreenId)`, but a build that wrote
   * `navigate(screen, params)` must be repaired in ITS shape, not in ours — a fix
   * that does not compile is worse than the defect.
   */
  const nav = code.find(([p]) => /useNavigation|router|navigation/i.test(p))?.[1] ?? ''
  const twoArgs = /navigate\s*=?\s*(?:useCallback\()?\(?\s*\(?\s*\w+\s*:\s*ScreenId\s*,\s*\w+\s*[?:]/.test(nav)
    || /function navigate\(\s*\w+\s*:\s*ScreenId\s*,/.test(nav)
  const acceptsRoute = /Route\s*\|\s*ScreenId|ScreenId\s*\|\s*Route/.test(nav)
  if (!twoArgs && !acceptsRoute) return { files, fixed: [] }

  const out = new Map(files)
  const fixed: string[] = []
  for (const [path, body] of code) {
    let next = body
    let changed = 0
    for (const [screen, key] of needsParam) {
      const call = new RegExp(`navigate\\(\\s*['"]${screen.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]\\s*\\)`, 'g')
      next = next.replace(call, (whole, at: number) => {
        const id = idExpressionNear(next, at)
        if (!id) return whole
        changed++
        return twoArgs
          ? `navigate('${screen}', { ${key}: String(${id}) })`
          : `navigate({ screen: '${screen}', params: { ${key}: String(${id}) } })`
      })
    }
    if (changed === 0) continue
    out.set(path, next)
    fixed.push(`${path}: 一覧から詳細へ遷移するときに id を渡していなかったため route params に載せた（詳細画面が「見つかりません」になる状態の修正・${changed}箇所）`)
  }
  return fixed.length ? { files: out, fixed } : { files, fixed: [] }
}

/**
 * What the handler already knows this row to be.
 *
 * In order of how certain each is: the id the same handler dispatches, the id it
 * assigns to state, and failing both, the binding the enclosing list maps over.
 * Nothing invented — with no candidate the call is left alone, because a wrong id
 * navigates to a detail screen for the wrong item, which is worse than one that
 * says it cannot find it.
 */
function idExpressionNear(source: string, at: number): string | null {
  const before = source.slice(Math.max(0, at - 500), at)
  const payload = [...before.matchAll(/payload\s*:\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g)].pop()
  if (payload && /\bid\b/i.test(payload[1])) return payload[1]
  const setter = [...before.matchAll(/\bset[A-Z]\w*(?:Id|ID)\s*\(\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\)/g)].pop()
  if (setter) return setter[1]
  if (payload && /^[A-Za-z_$][\w$]*$/.test(payload[1])) return `${payload[1]}.id`
  const mapped = [...before.matchAll(/\.map\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)].pop()
  if (mapped) return `${mapped[1]}.id`
  const each = [...before.matchAll(/v-for\s*=\s*["'][({]?\s*([A-Za-z_$][\w$]*)|#each\s+[\w.]+\s+as\s+([A-Za-z_$][\w$]*)/g)].pop()
  if (each) return `${each[1] ?? each[2]}.id`
  return null
}

/**
 * A card that draws a grey box with the word 「商品画像」 in it, instead of the
 * picture the item carries.
 *
 * Measured on the same storefront: every product had an `image` field, the card
 * rendered `<div className="card-image"><span>商品画像</span></div>`, and the page
 * shipped with no photograph on it at all. The pipeline's own photograph pass
 * cannot help — it replaces image URLs and slots, and there was no image element
 * to replace.
 *
 * The box is turned into the `<img>` it was standing in for. Deliberately narrow:
 * the element has to be a picture frame by its own class name, hold nothing but a
 * placeholder word, and the component has to receive an object whose type really
 * does declare an image field — otherwise the repair would write a src that does
 * not exist, which is the one outcome worse than a grey box.
 */
const PLACEHOLDER_WORD = /^(?:商品画像|画像|イメージ|写真|画像なし|no\s*image|image|photo|placeholder)$/i
/*
 * A picture field, whatever the project decided to call it.
 *
 * The list of exact names missed `thumbnailUrl: string` on an article feed of
 * 2026-09-11 — three photographs sitting in the data and the word
 * `thumbnailUrl` appearing nowhere else in the project. A suffix is allowed
 * now, and only the suffixes that still mean "this IS the picture":
 * `imageSrc`, `coverImage`, `photoUrl`. Not any suffix — `imageAlt` and
 * `imageWidth` are about a picture without being one, and writing a URL into
 * either would be worse than leaving the field alone.
 */
const PICTURE_NAME = '(?:image|img|thumbnail|thumb|photo|picture|cover|avatar|banner|hero)(?:Url|URL|Src|Image|Path)?'

const IMAGE_FIELD = new RegExp(`\\b(${PICTURE_NAME})\\s*\\??\\s*:\\s*string`)
const NAME_FIELD = /\b(name|title|label|productName)\s*\??\s*:\s*string/

/** Every field name the project's own record types declare. */
function declaredFields(files: Map<string, string>): Set<string> {
  const names = new Set<string>()
  for (const [path, body] of files) {
    if (!/^src\/(data|store|lib|types)\//.test(path) && !/types?\.ts$/.test(path)) continue
    for (const decl of body.matchAll(/(?:interface|type)\s+[A-Z][\w$]*\s*=?\s*\{([\s\S]*?)\n\}/g)) {
      for (const m of decl[1].matchAll(/(?:^|\n)\s*([a-z][\w$]*)\s*\??\s*:/g)) names.add(m[1])
    }
  }
  return names
}

/**
 * A picture bound to a field the data does not have.
 *
 * Measured 2026-09-18, on the edit a user asked for after 「商品をクリックしても何も
 * 起きません」. The model rewrote the whole screen rather than patching it, and in
 * the rewrite it replaced `<ProductCard :product="product" />` with markup of
 * its own:
 *
 *     <img :src="product.imageUrl" :alt="product.name" />
 *
 * `Product` declares `image`, not `imageUrl`, and the file it deleted had read
 * it correctly. Nothing could see this: the SFC compiles, the template type is
 * never checked, and `undefined` in `src` renders as a broken picture rather
 * than as an error. The user reported it as 「画像が表示されなくなりました」.
 *
 * Deliberately only picture sources, and only when the name is declared NOWHERE
 * in the project and exactly one declared name is a prefix of it. The same rule
 * applied to expressions generally would rewrite `store.cartTotal` to
 * `store.cart` — a legitimate computed whose name happens to start with a field.
 * An image source has no such shape: it is a value read straight off a record.
 */
export function fixImageFieldMisspelt(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const out = new Map<string, string>()
  const fixed: string[] = []
  const declared = declaredFields(files)
  if (declared.size === 0) return { files: out, fixed }

  /*
   * `:src` in a Vue template, `src={…}` in JSX, and either spread over several
   * lines — a bound attribute is rarely on the same line as its tag once the
   * element has three of them. The bind prefix is why the word boundary goes
   * before `src` and not before the colon: ` :src` has no boundary at the colon.
   */
  const SRC = /<img\b[^>]*?(?::src|\bsrc)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g
  for (const [path, body] of files) {
    if (!/\.(vue|tsx|jsx)$/.test(path)) continue
    let next = body
    let touched = false
    for (const m of body.matchAll(SRC)) {
      const expr = m[1] ?? m[2] ?? m[3] ?? ''
      const read = /^\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$/.exec(expr)
      if (!read) continue
      const [, item, field] = read
      if (declared.has(field)) continue
      const lower = field.toLowerCase()
      const candidates = [...declared].filter((d) => d.length >= 4 && lower.startsWith(d.toLowerCase()))
      if (candidates.length !== 1) continue
      next = next.split(`${item}.${field}`).join(`${item}.${candidates[0]}`)
      touched = true
      fixed.push(`${path}: ${item}.${field} -> ${item}.${candidates[0]}`)
    }
    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          '画像の src が、データに無いフィールドを読んでいたので宣言されている名前に修正' +
            `（undefined になり画像が出ません）: ${[...new Set(fixed)].join('、')}`,
        ]
      : [],
  }
}

/**
 * A route passed as a path where the router wants a screen and an id.
 *
 * From the same edit. The model wrote its own handler —
 *
 *     function handleProductClick(productId: string): void {
 *       navigate(`product/${productId}`)
 *     }
 *
 * — against a `navigate` whose string branch is `updateRoute({ screen: next })`.
 * So the screen becomes the literal 「product/p1」, no screen matches it, and the
 * detail screen that does eventually render through the hash listener reads
 * `route.params.id` off a route that has no params. It compiles: `ScreenId` is
 * a union of strings and a template literal is a string.
 *
 * Rewritten to the object form the same file already uses elsewhere, and only
 * when the router declares `params` — without that this is not the shape being
 * asked for and the string is simply a screen name.
 */
export function fixPathAsScreenId(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const out = new Map<string, string>()
  const fixed: string[] = []
  const routerTakesParams = [...files].some(
    // `params?: { id: string }` and `params?: Record<string, string>` are the
    // two spellings the generated routers use; both take an id.
    ([path, body]) =>
      /routes?\.(ts|js)$/.test(path) && /\bparams\??\s*:\s*(?:\{[^}]*\bid\b|Record<)/.test(body)
  )
  if (!routerTakesParams) return { files: out, fixed }

  // navigate(`screen/${expr}`) and navigate('screen/' + expr).
  const TEMPLATE = /\bnavigate\(\s*`([a-z][\w-]*)\/\$\{([^}]+)\}`\s*\)/g
  const CONCAT = /\bnavigate\(\s*['"]([a-z][\w-]*)\/['"]\s*\+\s*([A-Za-z_$][\w$.]*)\s*\)/g
  for (const [path, body] of files) {
    if (!/\.(vue|tsx|jsx|ts)$/.test(path)) continue
    let next = body
    let touched = false
    for (const re of [TEMPLATE, CONCAT]) {
      next = next.replace(re, (_whole, screen: string, expr: string) => {
        touched = true
        fixed.push(`${path}: navigate('${screen}/…')`)
        return `navigate({ screen: '${screen}', params: { id: String(${expr.trim()}) } })`
      })
    }
    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          'navigate() にパスを渡していたので画面名と id に分割' +
            `（画面名が「${'screen/id'}」になり、どの画面にも一致しません）: ${[...new Set(fixed)].join('、')}`,
        ]
      : [],
  }
}

export function fixPlaceholderImageBoxes(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const code = [...files].filter(([p]) => /\.(tsx?|jsx?|vue)$/.test(p))
  if (code.length === 0) return { files, fixed: [] }

  // Types that carry a picture, so a component holding one can be given an <img>.
  const withImage = new Map<string, { image: string; name: string | null }>()
  for (const [, body] of code) {
    for (const m of body.matchAll(/(?:interface|type)\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
      const image = IMAGE_FIELD.exec(m[2])
      if (!image) continue
      const name = NAME_FIELD.exec(m[2])
      withImage.set(m[1], { image: image[1], name: name ? name[1] : null })
    }
  }
  if (withImage.size === 0) return { files, fixed: [] }

  const out = new Map(files)
  const fixed: string[] = []
  for (const [path, body] of code) {
    // The object this file renders: a prop whose declared type carries a picture.
    let holder: { object: string; image: string; name: string | null } | null = null
    for (const m of body.matchAll(/(\w+)\s*\??\s*:\s*(\w+)\s*[;,\n]/g)) {
      const type = withImage.get(m[2])
      if (!type) continue
      if (!new RegExp(`\\b${m[1]}\\.`).test(body)) continue
      holder = { object: m[1], image: type.image, name: type.name }
      break
    }
    if (!holder) continue

    let changed = 0
    const next = body.replace(
      /<(div|span|figure|p)\b([^>]*)>\s*(?:<(?:span|p|div)\b[^>]*>\s*)?([^<>{}\n]{1,12}?)\s*(?:<\/(?:span|p|div)>\s*)?<\/\1>/g,
      (whole, tag: string, attrs: string, text: string) => {
        if (!PLACEHOLDER_WORD.test(text.trim())) return whole
        // It has to be the picture's own frame. A caption that happens to read
        // 「画像」 is not a frame, and replacing it would delete the caption.
        if (!/class(?:Name)?\s*=\s*["'{][^"'}]*(image|photo|thumb|picture|visual)/i.test(attrs)) return whole
        changed++
        const src = `${holder!.object}.${holder!.image}`
        const alt = holder!.name ? `${holder!.object}.${holder!.name}` : "''"
        const isTemplate = path.endsWith('.vue')
        const img = isTemplate
          ? `<img :src="${src}" :alt="${alt}" style="width:100%;height:100%;object-fit:cover" />`
          : `<img src={${src}} alt={${alt}} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />`
        const inner = img
        return `<${tag}${attrs}>${inner}</${tag}>`
      }
    )
    if (changed === 0) continue
    out.set(path, next)
    fixed.push(`${path}: 「${'商品画像'}」と書いた枠を、品目が持つ画像の <img> に置き換え（写真が1枚も出ない状態の修正・${changed}箇所）`)
  }
  return fixed.length ? { files: out, fixed } : { files, fixed: [] }
}

/**
 * A span of source with the strings taken out of consideration.
 *
 * The scanners below count braces, and a brace inside a Japanese product
 * description is not a brace they are counting. Cheap and sufficient: quotes do
 * not nest, and an escaped quote keeps its backslash.
 */
function skipString(src: string, at: number): number {
  const quote = src[at]
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === quote) return i
  }
  return src.length - 1
}

/** The index of the bracket closing the one at `at`, or -1. */
function closingBracket(src: string, at: number): number {
  const open = src[at]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue }
    if (c === open) depth++
    else if (c === close && --depth === 0) return i
  }
  return -1
}

/** The object literals directly inside an array literal, as [start, end] pairs. */
function recordsIn(src: string, arrayOpen: number): Array<[number, number]> {
  const arrayClose = closingBracket(src, arrayOpen)
  if (arrayClose === -1) return []
  const out: Array<[number, number]> = []
  for (let i = arrayOpen + 1; i < arrayClose; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue }
    if (c !== '{') continue
    const end = closingBracket(src, i)
    if (end === -1) break
    out.push([i, end])
    i = end
  }
  return out
}

/**
 * A catalogue whose records carry no picture, given one.
 *
 * Measured 2026-09-19, comparing React and Vue on the same storefront brief,
 * because the pictures 「Vueに比べてReactで生成したときに画像が出る枚数が少ない」.
 * On the catalogue-shaped documents in the corpus the difference is not in the
 * photograph pass at all — it is in what the build handed it:
 *
 *   vue    13 records, 13 image fields, 13 photographs
 *   react  12 records, `image?: string` declared and set by NOT ONE of them,
 *          and the card drawing `<div className="product-card__image">
 *          <ContentFrame /></div>` — a stand-in where the photograph goes
 *
 * `assignItemImages` replaces picture URLs and slots. With no URL and no slot
 * there is nothing for it to replace, so it correctly does nothing, and the
 * storefront ships with drawn panels where twelve garments should be. The type
 * says the picture was intended; the records simply never got one.
 *
 * So the slot is written where the model said it would be. `__PHOTO__` is the
 * token the assembler is already told to write for exactly this, and the pass
 * that resolves it reads the record's own `name` to decide what to photograph —
 * so a record that says 「ニットセーター」 gets knitwear, which is the whole point
 * of doing this here rather than picking a URL at random.
 *
 * Deliberately narrow, in three ways. The type must already DECLARE a picture —
 * adding a field nobody asked for is a claim about the design, not a repair.
 * Not one record may carry one — a catalogue where some items have photographs
 * and others do not is a decision, not an omission. And the frame keeps
 * whatever it was drawing as the fallback branch, so a project whose
 * illustrations are only rendered here does not lose them.
 *
 * ## The card can ask too (2026-09-20)
 *
 * The first of those three was too narrow, and a user's storefront is the
 * argument. 「商品一覧画面では商品の画像が表示されていない」 on a document where
 * `Product` declares id, name, price, category, colors, sizes, material and
 * dimensions — and no picture — while the card draws
 *
 *     <div className="da-card-image" aria-label={`${product.name}の画像`}>
 *       <svg …> … a gradient, a dot pattern, a circle and a rectangle
 *
 * an invented abstract composition, which the IMAGERY contract names as the
 * wrong answer for a catalogue in those words. The type never asked for a
 * picture; the CARD asked, by its class and by the label it reads out. So
 * "nobody asked for it" was not true of this shape, and the rule excluded a
 * storefront that shipped twelve garments as gradients.
 *
 * Measured over 76 stored documents: 9 have a catalogue and a picture frame at
 * all, 5 of those have a frame with no picture in it, and 2 of the 5 are this
 * shape. So it is 2 in 76 of everything and 2 in 5 of the population this pass
 * exists for.
 *
 * A frame declares a picture only with all of: a data array of at least three
 * records of one type, that type having a name field, a component drawing an
 * element whose class names it a picture BOUND to an item of that type, and no
 * `<img>` already in it. Then the field is written onto the interface as well
 * as into the records.
 */
const CATALOGUE_IMAGE = new RegExp(`\\b(${PICTURE_NAME})(\\s*\\?)?\\s*:\\s*string`)

/** Whether the project holds an array of at least three records of this type. */
function hasCatalogueOf(code: Array<[string, string]>, type: string): boolean {
  for (const [path, body] of code) {
    if (!/^src\/data\//.test(path)) continue
    for (const m of body.matchAll(new RegExp(`export\\s+const\\s+\\w+\\s*:\\s*${type}\\[\\]\\s*=\\s*\\[`, 'g'))) {
      if (recordsIn(body, (m.index ?? 0) + m[0].length - 1).length >= 3) return true
    }
  }
  return false
}

/**
 * Whether some component draws a picture frame for an item of this catalogue.
 *
 * Bound to the item, not merely present: a frame in a hero banner says nothing
 * about the records. The binding is the same one the markup step uses, so a
 * frame that argues for the field here is a frame that gets an `<img>` there.
 */
function frameAsksFor(code: Array<[string, string]>, nameField: string): boolean {
  for (const [path, body] of code) {
    if (/^src\/data\//.test(path)) continue
    for (const m of body.matchAll(/<(?:div|figure|span)\b([^>]*)>/g)) {
      if (!PICTURE_FRAME.test(m[1])) continue
      if (/skeleton|loading|shimmer/i.test(m[1])) continue
      const at = m.index ?? 0
      // Already drawing one, so nothing is missing here.
      if (/<img[\s>]/.test(body.slice(at, at + 400))) continue
      const item = itemBindingNear(body, at, nameField)
      if (item && new RegExp(`\\b${item}\\.${nameField}\\b`).test(body)) return true
    }
  }
  return false
}

export function fixCatalogueWithoutPhotos(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const code = [...files].filter(([p]) => /\.(tsx?|jsx?|vue)$/.test(p))
  if (code.length === 0) return { files, fixed: [] }

  /** Types that say they carry a picture, and where they say it. */
  const carriers = new Map<string, { field: string; optional: boolean; declaredIn: string; nameField: string }>()
  /** Record types with a name and no picture — candidates for the card to ask. */
  const nameOnly = new Map<string, { declaredIn: string; nameField: string; at: number; body: string }>()
  for (const [path, body] of code) {
    for (const m of body.matchAll(/(?:interface|type)\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
      const img = CATALOGUE_IMAGE.exec(m[2])
      const name = NAME_FIELD.exec(m[2])
      if (!name) continue
      if (!img) {
        nameOnly.set(m[1], { declaredIn: path, nameField: name[1], at: m.index ?? 0, body: m[0] })
        continue
      }
      carriers.set(m[1], { field: img[1], optional: Boolean(img[2]), declaredIn: path, nameField: name[1] })
    }
  }

  /*
   * And the types whose CARD asks, where the type did not. See the note above:
   * a frame classed for a picture and bound to an item of the type is the build
   * saying a photograph goes there, whatever the interface left out.
   */
  const declaredByFrame = new Set<string>()
  for (const [type, info] of nameOnly) {
    if (carriers.has(type)) continue
    if (!hasCatalogueOf(code, type)) continue
    if (!frameAsksFor(code, info.nameField)) continue
    carriers.set(type, { field: 'image', optional: false, declaredIn: info.declaredIn, nameField: info.nameField })
    declaredByFrame.add(type)
  }

  if (carriers.size === 0) return { files, fixed: [] }

  const out = new Map(files)
  const fixed: string[] = []
  /** Types whose records this pass filled, so the markup below knows to draw them. */
  const slotted = new Map<string, { field: string; nameField: string }>()

  for (const [path, body] of code) {
    if (!/^src\/data\//.test(path)) continue
    let next = out.get(path) ?? body
    for (const m of body.matchAll(/export\s+const\s+\w+\s*:\s*(\w+)\[\]\s*=\s*\[/g)) {
      const carrier = carriers.get(m[1])
      if (!carrier) continue
      const arrayOpen = (m.index ?? 0) + m[0].length - 1
      const records = recordsIn(body, arrayOpen)
      // Two records are a pair of examples; a catalogue is what this is for.
      if (records.length < 3) continue
      /*
       * The ones without a picture, which is usually not the whole catalogue.
       *
       * This began as "not one record may carry one", on the reasoning that a
       * catalogue where some items have photographs and others do not is a
       * decision rather than an omission. Measured against the storefront that
       * prompted this, that reasoning was wrong and it cost the repair: ONE of
       * the twelve garments carried a photograph and eleven did not, which is
       * not a decision — it is the shape the difference actually takes, and the
       * rule excluded exactly the document it was written for.
       *
       * Records that already have one keep it. Only the gaps are filled.
       */
      const held = new RegExp(`\\b${carrier.field}\\s*:`)
      const missing = records.filter(([a, b]) => !held.test(body.slice(a, b)))
      /*
       * A catalogue whose records ALREADY carry their pictures still reaches
       * the markup step below, and that is the whole of the 2026-09-20 report:
       * 「画像が一枚も挿入されていません」 on a document holding eleven real
       * photographs in `src/data/products.ts` and not one `<img>` anywhere —
       * the card drew `<div className="cds-product-image"><ContentFrame /></div>`.
       *
       * The data was complete, so this pass had nothing to slot, and gating the
       * markup on having slotted something meant the one thing that was wrong
       * went untouched. The two halves are independent: fill what is missing,
       * and draw what is there.
       */
      slotted.set(m[1], { field: carrier.field, nameField: carrier.nameField })
      if (missing.length === 0) continue

      /*
       * Written from the END of the file backwards, so an insertion does not
       * move the offsets of the records still to be edited.
       */
      for (const [start] of [...missing].reverse()) {
        const lineEnd = next.indexOf('\n', start)
        if (lineEnd === -1) continue
        const indent = /^[ \t]*/.exec(next.slice(lineEnd + 1))?.[0] ?? '    '
        next = `${next.slice(0, lineEnd + 1)}${indent}${carrier.field}: '${PHOTO_SLOT}',\n${next.slice(lineEnd + 1)}`
      }
      fixed.push(`${path}: ${records.length}件中${missing.length}件に ${carrier.field} を追加`)
    }
    if (next !== (out.get(path) ?? body)) out.set(path, next)
  }
  if (slotted.size === 0) return { files, fixed: [] }

  /*
   * Now every record has one, so the declaration is no longer optional. Left
   * optional, `src={item.image}` is `string | undefined` and `tsc` rejects the
   * project this system exists to hand someone.
   */
  for (const [type, { field }] of slotted) {
    const carrier = carriers.get(type)!
    const body = out.get(carrier.declaredIn) ?? files.get(carrier.declaredIn) ?? ''
    /*
     * A type the CARD asked for has no line to un-optional — it has no line at
     * all. Written beside the name field, because that is the field this pass
     * already read the type for and it puts the picture with what it pictures.
     */
    if (declaredByFrame.has(type)) {
      const decl = new RegExp(`(\\n([ \\t]*)${carrier.nameField}\\s*\\??\\s*:\\s*string;?)`)
      const withField = body.replace(decl, `$1\n$2${field}: string;`)
      if (withField !== body) {
        out.set(carrier.declaredIn, withField)
        fixed.push(`${carrier.declaredIn}: ${type} に ${field} を宣言（カードに写真枠があるのに型が写真を持っていませんでした）`)
      }
      continue
    }
    if (!carrier.optional) continue
    const fixedDecl = body.replace(new RegExp(`(\\b${field})\\s*\\?\\s*:(\\s*string)`), '$1:$2')
    if (fixedDecl !== body) out.set(carrier.declaredIn, fixedDecl)
  }

  /*
   * And the frame gets the picture it was holding a place for.
   *
   * The element has to be a picture frame by its own class name, and hold
   * nothing but a drawn stand-in — an empty box, or a single component. A frame
   * with real content in it is not a frame with a missing picture.
   */
  /*
   * A frame holding nothing, or holding one stand-in and nothing else.
   *
   * The stand-in was read as a capitalised self-closing component, which is
   * `<ContentFrame />` on the list screen and missed the detail screen's
   * `<div className="cds-image-placeholder" />` on the same document. Any
   * single childless element counts now; a frame with real content in it still
   * does not match, because the pattern allows exactly one and no text.
   */
  /*
   * `<svg>…</svg>` is a stand-in too, and it is the one the storefront of
   * 2026-09-20 used: sixty lines of gradient, dot pattern, circle and rectangle
   * inside `<div className="da-card-image">`. The frames are found by matching
   * tags rather than by a pattern — see tools/picture-frames.ts for the two
   * documents a pattern broke.
   */
  for (const [path, body] of code) {
    if (/^src\/data\//.test(path)) continue
    const source = out.get(path) ?? body
    const edits: Array<{ at: number; end: number; text: string }> = []
    for (const frame of pictureFrames(source)) {
      const { at, end, tag, attrs, child } = frame
      /*
       * A frame already drawing a picture is not a frame with a missing one.
       * Widening the child to any childless element once let this match an
       * `<img>`, so the repair replaced a working picture with its own.
       */
      if (/^<(?:img|picture|image)\b/i.test(child.trim())) continue
      const type = [...slotted].find(([, info]) => {
        const item = itemBindingNear(source, at, info.nameField)
        return item !== null && new RegExp(`\\b${item}\\.${info.nameField}\\b`).test(source)
      })
      if (!type) continue
      const item = itemBindingNear(source, at, type[1].nameField)
      if (!item) continue
      const { field, nameField } = type[1]
      const vue = path.endsWith('.vue')
      const img = vue
        ? `<img :src="${item}.${field}" :alt="${item}.${nameField}" style="width:100%;height:100%;object-fit:cover" />`
        : `<img src={${item}.${field}} alt={${item}.${nameField}} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />`
      const open = `<${tag}${attrs.replace(/\s*\/$/, '')}>`
      let inner: string
      if (!child.trim()) {
        inner = img
      } else if (/^<svg[\s>]/i.test(child.trim())) {
        /*
         * An inline `<svg>` stand-in is replaced outright. The other branch
         * exists so that a COMPONENT drawing the stand-in is still rendered
         * somewhere and does not become an unused file; drawn inline there is
         * no file, and sixty lines of invented gradient hanging off a ternary
         * whose condition is a slot we just wrote is dead weight.
         */
        inner = img
      } else {
        // Trimmed: the child carries the frame's indentation, and a newline
        // between `:` and the fallback makes the branch read as two statements.
        const standIn = child.trim()
        inner = vue
          ? `${img.replace('<img ', `<img v-if="${item}.${field}" `)}${standIn.replace('/>', 'v-else />')}`
          : `{${item}.${field} ? ${img} : ${standIn}}`
      }
      edits.push({ at, end, text: `${open}${inner}</${tag}>` })
    }
    if (edits.length === 0) continue
    let next = source
    // From the end, so an earlier rewrite does not move the offsets after it.
    for (const e of [...edits].reverse()) next = next.slice(0, e.at) + e.text + next.slice(e.end)
    out.set(path, next)
    fixed.push(`${path}: 品目の写真枠に <img> を入れた（${edits.length}箇所）`)
  }

  /*
   * A slot nothing draws is worse than no slot: `__PHOTO__` would ship as a
   * broken `src`, or as a string in a record the screens never read. So the
   * data change stands only when something renders the field — the frame this
   * pass just gave an `<img>`, or an `<img>` the build already wrote elsewhere
   * (a detail screen usually has one even when the cards do not).
   */
  /*
   * Nothing was written, so nothing is reported. With the two halves
   * independent this is reachable in a way it was not before: a catalogue that
   * already carries its pictures AND already draws them leaves both halves
   * with nothing to do, and the report below would otherwise announce a repair
   * with an empty list of what it repaired.
   */
  if (fixed.length === 0) return { files, fixed: [] }
  const drawnHere = fixed.some((f) => f.includes('<img>'))
  const slottedHere = fixed.some((f) => f.includes('を追加'))
  const drawnAlready = [...slotted].some(([, { field }]) =>
    code.some(([p, b]) => !/^src\/data\//.test(p) && new RegExp(`<img[^>]*\\.${field}\\b`).test(b))
  )
  if (!drawnHere && !drawnAlready) return { files, fixed: [] }
  /*
   * Said as what happened, because the two halves are independent now and the
   * commonest case is only the second: a catalogue whose records already carry
   * their photographs, drawn by nothing.
   */
  const what = slottedHere && drawnHere
    ? 'データに写真の枠を作り、カードに <img> を入れました（この後の工程が品名から実際の写真を割り当てます）'
    : slottedHere
      ? 'データに写真の枠を作りました（この後の工程が品名から実際の写真を割り当てます）'
      : '品目が持っている写真がどこにも描画されていなかったので、写真枠に <img> を入れました'
  return { files: out, fixed: [`${what}: ${fixed.join('、')}`] }
}

/**
 * The record a frame is being rendered for, or null.
 *
 * A list says so in its `.map()` or its `v-for`. A DETAIL screen does not —
 * it holds one record in a local, and the 2026-09-20 document's detail screen
 * was missed for exactly that reason. So the last resort is the name the
 * markup around the frame is already reading: whatever `X` is in `X.name`
 * beside it is the record this frame belongs to.
 */
function itemBindingNear(source: string, at: number, nameField = 'name'): string | null {
  const before = source.slice(Math.max(0, at - 1200), at)
  const mapped = [...before.matchAll(/\.map\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)].pop()
  if (mapped) return mapped[1]
  const each = [...before.matchAll(/v-for\s*=\s*["'][({]?\s*([A-Za-z_$][\w$]*)/g)].pop()
  if (each) return each[1]
  const window = source.slice(Math.max(0, at - 800), at + 600)
  const named = [...window.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\.${nameField}\\b`, 'g'))]
    .map((m) => m[1])
    .filter((name) => name !== 'props')
  return named[0] ?? null
}

/**
 * Utility classes that were written and never defined, given their CSS.
 *
 * `className="flex items-center gap-4 rounded-lg bg-white p-6 shadow-sm"` is
 * the vocabulary of a framework these projects do not carry, and every one of
 * those classes is inert. Measured over the last 102 stored documents, 23 (24%)
 * ship with three or more of them and the worst carries 95 — a page with no
 * padding, no card and no type scale, which is 「デザインが反映されておらず、
 * チープなデザインになってしまっている」.
 *
 * The audit has reported this as `utility-classes` for weeks and a model is
 * asked to rewrite the markup. It is still 24%. So the classes are made to work
 * instead, which is both the thing the user asked for — 「確実に効くように」 — and
 * the cheaper answer: a repair call not spent.
 *
 * See tools/utility-css.ts for what each class becomes and why colour, corners
 * and shadow go through the project's own tokens while spacing does not.
 * Classes it cannot map exactly are left alone and still reported.
 */
export function fixDeadUtilityClasses(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  // The largest stylesheet is the one carrying the tokens — the same choice
  // `stylesheetOf` makes, and for the same reason.
  const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))

  const defined = new Set<string>()
  for (const [, body] of sheets) {
    for (const c of definedClasses(body)) defined.add(c)
  }
  // A Vue project keeps its component CSS in the SFC, and a class defined there
  // is defined.
  for (const [path, body] of files) {
    if (!path.endsWith('.vue')) continue
    for (const style of body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      for (const c of definedClasses(style[1])) defined.add(c)
    }
  }

  const dead = new Set<string>()
  for (const [path, body] of files) {
    if (!/\.(tsx|jsx|vue)$/.test(path)) continue
    const values = [
      ...[...body.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]),
      ...[...body.matchAll(/\bclass(?:Name)?\s*=\s*\{\s*`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ' ')),
    ]
    for (const v of values) {
      for (const c of v.split(/\s+/)) {
        if (c && !defined.has(c) && UTILITY_CLASS.test(c)) dead.add(c)
      }
    }
  }
  /*
   * Three, the same floor the audit uses. One or two stray classes on a page
   * whose styling is otherwise its own is not the failure this is for, and
   * appending a stylesheet section for them would be louder than the problem.
   */
  if (dead.size < 3) return { files, fixed: [] }

  const written = utilityCss(dead, sheet[1])
  if (written.handled.length === 0) return { files, fixed: [] }

  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${written.css}\n`)
  return {
    files: out,
    fixed: [
      `${sheet[0]}: 定義の無いユーティリティクラス${written.handled.length}種類に CSS を書きました` +
        `（余白・寸法・文字はその名前の尺度どおり、色・角丸・影はこのプロジェクトのトークン経由）` +
        `${written.unhandled.length > 0 ? `。${written.unhandled.length}種類は対応表に無いのでそのままです` : ''}`,
    ],
  }
}

/**
 * A glyph on the button whose label already says what the glyph would say.
 *
 * `icons` on 22 of 76 stored documents. `tools/action-icons.ts` holds the
 * vocabulary, the shapes, and why this only touches buttons — two of the four
 * places the finding's own instruction names turned out to be wrong, and a user
 * reported both of them on one storefront.
 *
 * Reach: 17 of the 22 (77%), 53 pairings, every one read rather than counted.
 */
export function fixIconsNotDrawn(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const icons = renderedFrom(files, ICON_DIR, ext)
  if (icons.used.length > 0) return { files, fixed: [] }

  const own = icons.all.map((p): [string, string] => [artName(p), p])
  const places = iconPlacements(files, kind, own)
  if (places.length === 0) return { files, fixed: [] }

  const out = new Map(files)
  const created = new Set<string>()
  // Written from the end of each file, so an insertion does not move the
  // offsets of the buttons still to come.
  const byFile = new Map<string, IconPlacement[]>()
  for (const p of places) byFile.set(p.path, [...(byFile.get(p.path) ?? []), p])

  for (const [path, inFile] of byFile) {
    let body = out.get(path)
    if (body === undefined) continue
    const imports: string[] = []
    for (const p of [...inFile].sort((a, b) => b.at - a.at)) {
      let from = p.from
      if (!from) {
        from = `${ICON_DIR}${p.render}${ext}`
        if (!out.has(from)) { out.set(from, glyphSource(p.render, kind)); created.add(p.render) }
      }
      const source = out.get(from) ?? ''
      const clause = isDefaultExport(source) || created.has(p.render) ? p.render : `{ ${p.render} }`
      const statement = `import ${clause} from '${importPath(path, from)}'`
      if (!imports.includes(statement)) imports.push(statement)
      body = `${body.slice(0, p.at)}<${p.render} />${body.slice(p.at)}`
    }
    for (const statement of imports) body = withImport(body, statement, kind)
    out.set(path, body)
  }

  /*
   * And the rule that lines the glyph up with the words beside it. Without it
   * an inline `<svg>` sits on the text's baseline rather than beside it, which
   * is worse than the finding.
   */
  const sheets = [...out].filter(([p]) => p.endsWith('.css'))
  if (sheets.length > 0 && !sheets.some(([, b]) => b.includes(ICON_BUTTON_MARKER))) {
    const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))
    out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${ICON_BUTTON_CSS}\n`)
  }

  const labels = [...new Set(places.map((p) => p.render))]
  return {
    files: out,
    fixed: [
      `ラベルが動作を表しているボタン${places.length}個にアイコンを付けました（${labels.join('、')}` +
        `${created.size > 0 ? `。うち${[...created].join('、')}は新規作成` : ''}）`,
    ],
  }
}

/**
 * Takes the magnifier off the photograph — 「商品をクリックすると画像が表示される
 * が、中心に検索マークが表示されている」. What counts, and why it is narrow, is in
 * tools/picture-frames.ts.
 */
export function fixIconOnPhotograph(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const out = new Map(files)
  let removed = 0
  for (const [path, body] of files) {
    if (!path.endsWith(ext)) continue
    const found = iconsOnPhotographs(body)
    if (found.length === 0) continue
    let next = body
    for (const r of [...found].reverse()) next = next.slice(0, r.at) + next.slice(r.end)
    out.set(path, next)
    removed += found.length
  }
  if (removed === 0) return { files, fixed: [] }
  return {
    files: out,
    fixed: [`写真の上に重ねて描かれていた装飾アイコンを${removed}個取り除きました（写真が隠れます）`],
  }
}

export const TOKEN_ALIAS_MARKER = '/* makeui:token-aliases */'

/**
 * Custom properties the project reads everywhere and defines nowhere.
 *
 * Found by looking at a drawing that was not there. doc25's empty cart renders
 * `EmptyCartIllustration` at 160x160, in the DOM, and invisible: every stroke is
 * `var(--border)`, the stylesheet defines no `--border`, and an undefined
 * custom property on `stroke` computes to `none`.
 *
 * It is not one document. Measured 2026-09-20 over the 34 stored projects, 22
 * (65%) read a custom property nothing defines, and in all 22 it happens inside
 * `illustrations/` or `icons/`. Two names account for 304 of the roughly 360
 * uses: `--text-muted` (208) and `--border` (96).
 *
 * Those two names are not the model's invention. They are the ones the repair
 * instruction for this very finding dictates — 「空状態の線画は…var(--border) と
 * var(--text-muted) を使い」 — while the presets name the same colours
 * `--color-border-subtle` and `--color-text-secondary`. So the pipeline asks for
 * a drawing in tokens the stylesheet does not have, the model complies, and the
 * result is an invisible picture that the audit then reports as a missing one.
 * That is a decent part of why `imagery-missing` survives half the runs it
 * appears in: the repair does the work and nothing appears on screen.
 *
 * The fix ALIASES rather than invents. `--border: var(--color-border-subtle)`
 * introduces no colour the design system did not already choose, so
 * `palette-size` and `preset-drift` — which count distinct colours and values
 * outside the bound system — do not move. A name whose role cannot be read from
 * it (`--color-neutral-9`, `--color-semantic-error`) is left undefined, for the
 * same reason: guessing at it would put a colour in the stylesheet that nothing
 * chose.
 *
 * `var(--x, fallback)` is not touched. It already renders.
 */
export function fixUndefinedTokens(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))

  const defined = new Set<string>()
  for (const [path, body] of files) {
    if (/\.(md|markdown|txt)$/i.test(path)) continue
    for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
  }

  const missing = new Set<string>()
  for (const [path, body] of files) {
    if (/\.(md|markdown|txt)$/i.test(path)) continue
    for (const m of body.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.add(m[1])
    }
  }
  if (missing.size === 0) return { files, fixed: [] }

  const palette = paletteOf(sheet[1])
  const lines: string[] = []
  for (const name of [...missing].sort()) {
    const role = roleOf(name)
    if (!role) continue
    const their = palette[role]
    if (!their || their === name) continue
    lines.push(`  ${name}: var(${their});`)
  }
  if (lines.length === 0) return { files, fixed: [] }

  const block = `${TOKEN_ALIAS_MARKER}\n:root {\n${lines.join('\n')}\n}`
  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${block}\n`)
  return {
    files: out,
    fixed: [
      `${sheet[0]}: 定義の無いカスタムプロパティ${lines.length}件を、このプロジェクトの` +
        `同じ役割のトークンに結びつけました（${lines.map((l) => l.trim().split(':')[0]).join('、')}）` +
        '。未定義の var() は stroke なら none になるため、図版が描画されていても見えません',
    ],
  }
}

/**
 * The drawing an empty screen was supposed to have, actually drawn.
 *
 * `imagery-missing` on 15 of the 34 stored documents (44%), the largest
 * source-visible finding there is. `tools/artwork.ts` holds the measurement, the
 * two halves it splits into, where a drawing is put and why only one file is
 * created when none exists.
 */
export function fixArtworkNotDrawn(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const art = renderedFrom(files, ART_DIR, ext)
  if (art.used.length > 0) return { files, fixed: [] }

  const hosts = findArtHosts(files, kind)
  if (hosts.length === 0) return { files, fixed: [] }

  const out = new Map(files)
  let created = ''

  /*
   * Nothing to draw, so one is drawn. ONE file, and it is rendered: three files
   * with none of them on screen is the shape this finding exists to report.
   *
   * Not into a header, though. The drawing made here is a tray for an empty
   * list, and the header fallback exists for a wordmark the project already has
   * — inventing one and putting a tray in the brand corner would be worse than
   * the finding.
   */
  if (art.all.length === 0) {
    if (hosts[0].place !== 'empty') return { files, fixed: [] }
    created = `${ART_DIR}${CREATED_ART}${ext}`
    out.set(created, emptyStateArt(kind))
  }
  const available = created ? [created] : art.all

  // Grouped by file and applied from the end of each, so an earlier insertion
  // does not move the offsets of the hosts still to come.
  const byFile = new Map<string, ArtHost[]>()
  for (const h of hosts) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h])

  const drawn: string[] = []
  for (const [path, inFile] of byFile) {
    let body = out.get(path)
    if (body === undefined) continue
    const source = pickArtwork(available, inFile[0].place, path)
    if (!source) continue
    const exported = artName(source)
    /*
     * The name it is rendered under, which is not always its own.
     *
     * A project's empty-state COMPONENT and its empty-state DRAWING are both
     * called `EmptyState` often enough that this was the first case the corpus
     * produced: importing `EmptyState` into a file that declares one puts an
     * import binding beside a function declaration of the same name. Sucrase
     * compiles that; a real module loader does not.
     */
    const name = declares(body, exported) ? `${exported}Illustration` : exported
    const clause = isDefaultExport(out.get(source) ?? '') || source === created
      ? name
      : name === exported ? `{ ${exported} }` : `{ ${exported} as ${name} }`
    const statement = `import ${clause} from '${importPath(path, source)}'`

    for (const h of [...inFile].sort((a, b) => b.at - a.at)) {
      /*
       * An icon already standing in for the drawing is REPLACED, not joined.
       * 「カートが空のときの…妙な位置に検索マークが表示されている」 was
       * `<EmptyStateArt />` inserted above the `<SearchIcon />` the build had
       * already put in that empty state. See `ArtHost.replaces`.
       */
      body = h.replaces
        ? body.slice(0, h.replaces.at) + `<${name} />` + body.slice(h.replaces.end)
        : body.slice(0, h.at) + `\n${h.indent}  <${name} />` + body.slice(h.at)
    }
    out.set(path, withImport(body, statement, kind))
    drawn.push(`${path}${inFile.length > 1 ? ` (${inFile.length})` : ''}`)
  }
  if (drawn.length === 0) return { files, fixed: [] }

  const where = hosts[0].place === 'empty' ? '空状態' : 'ヘッダー'
  return {
    files: out,
    fixed: [
      `${where}に図版を描画しました（${drawn.join('、')}）` +
        `${created ? `。${created} を作成` : `。${art.all.length}個あって1つも描画されていませんでした`}`,
    ],
  }
}

/**
 * The same file with an import added, wherever this framework keeps them.
 *
 * After the last existing import, so it sits with its neighbours; failing that,
 * at the top of the module — which for a Vue SFC means inside `<script setup>`,
 * and means creating that block when the component has none.
 */
function withImport(source: string, statement: string, kind: OutputKind): string {
  if (source.includes(statement)) return source
  if (kind === 'vue') {
    const block = /<script[^>]*\bsetup\b[^>]*>/.exec(source)
    if (!block) {
      return `<script setup lang="ts">\n${statement};\n</script>\n\n${source}`
    }
    const at = (block.index ?? 0) + block[0].length
    const inner = source.slice(at)
    const last = lastImportEnd(inner)
    return source.slice(0, at + last) + `\n${statement};` + source.slice(at + last)
  }
  const last = lastImportEnd(source)
  return last === 0
    ? `${statement};\n${source}`
    : source.slice(0, last) + `\n${statement};` + source.slice(last)
}

/** Whether the file already binds this name — a declaration or an import. */
function declares(source: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    new RegExp(`\\b(?:function|const|let|var|class)\\s+${n}(?![\\w$])`).test(source) ||
    new RegExp(`\\bimport\\s[^\\n]*?(?<![\\w$])${n}(?![\\w$])[^\\n]*?from`).test(source) ||
    new RegExp(`\\bas\\s+${n}(?![\\w$])`).test(source)
  )
}

/** Just past the last top-level import, or 0 when there is none. */
function lastImportEnd(source: string): number {
  let end = 0
  for (const m of source.matchAll(/^import\s[^\n]*?;?\s*$/gm)) {
    end = (m.index ?? 0) + m[0].replace(/\s+$/, '').length
  }
  return end
}

/**
 * Cards and rows that open something when clicked, and nothing when tabbed to.
 *
 * Reported by a user as 「依頼された要件が反映されていません: 商品カードはTabキーで
 * 辿れる」 on a storefront whose product cards were `<div … onClick={…}>`. The
 * requirement was real and the finding was right; what neither the check nor the
 * repair instruction said is that Tab reachability is not something a Tab key
 * handler provides. See `requirements.ts` for that half.
 *
 * Measured over the 34 stored project documents: 21 (62%) have at least one
 * such element. `tools/keyboard-reach.ts` holds the scan, what it refuses to
 * touch, and why the key handler re-dispatches a click rather than copying the
 * click expression.
 *
 * Vue is edited inside `<template>` only: the `<script>` block of an SFC is full
 * of `<` that opens nothing.
 */
export function fixKeyboardUnreachable(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const out = new Map(files)
  let total = 0
  const touched: string[] = []
  for (const [path, body] of files) {
    if (!path.endsWith(ext)) continue
    if (kind === 'vue') {
      const template = /<template>([\s\S]*)<\/template>/.exec(body)
      if (!template) continue
      const { source, count } = reachByKeyboard(template[1], kind)
      if (count === 0) continue
      out.set(path, body.slice(0, template.index + 10) + source + body.slice(template.index + 10 + template[1].length))
      total += count
      touched.push(path)
      continue
    }
    const { source, count } = reachByKeyboard(body, kind)
    if (count === 0) continue
    out.set(path, source)
    total += count
    touched.push(path)
  }
  if (total === 0) return { files, fixed: [] }
  return {
    files: out,
    fixed: [
      `クリックできるがキーボードで辿れない要素${total}個に tabindex と Enter/Space の処理を付けました` +
        `（${touched.slice(0, 3).join('、')}${touched.length > 3 ? ` ほか${touched.length - 3}件` : ''}）`,
    ],
  }
}

/**
 * A navigation left in the browser's bulleted list, given the design the rest
 * of the product has.
 *
 * Measured 2026-09-20 over 102 stored documents: 30 carry a list inside
 * `<nav>` and 17 of those (57%) render with a dot beside every item, no
 * spacing, no hover and no current-page state — 「ナビゲーションが箇条書きのまま
 * 表示されている…見栄えがかなり悪い」. Twelve of the seventeen put no class on the
 * list at all; the other five use one no stylesheet defines.
 *
 * The runtime audit reports this as `nav-unstyled` and asks a model to write
 * the rules. It is still 57%. See tools/nav-css.ts for what gets written and
 * why it descends from the nav rather than from the list.
 */
export function fixUnstyledNav(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))

  /*
   * Every rule the project has, wherever it keeps them — a Vue project puts
   * component CSS in the SFC, and a rule there styles the navigation just as
   * well as one in the stylesheet.
   */
  const allCss = [...files]
    .map(([path, body]) =>
      path.endsWith('.css')
        ? body
        : path.endsWith('.vue')
          ? [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
          : ''
    )
    .join('\n')
  const defined = definedClasses(allCss)

  const navs: NavRoot[] = []
  for (const [path, body] of files) {
    if (!/\.(tsx|jsx|vue)$/.test(path)) continue
    for (const found of body.matchAll(/<nav\b([^>]*)>([\s\S]{0,3000}?)<\/nav>/g)) {
      const list = /<(ul|ol)\b([^>]*)>/.exec(found[2])
      if (!list) continue
      const classesOf = (attrs: string): string[] => {
        const m = /\bclass(?:Name)?\s*=\s*["']([^"']*)["']/.exec(attrs)
        return m ? m[1].split(/\s+/).filter(Boolean) : []
      }
      const navClasses = classesOf(found[1])
      const listClasses = classesOf(list[2])
      const nav: NavRoot = {
        path,
        // A class no stylesheet defines is no better than none for hanging a
        // rule on, but it is still the honest selector to write.
        className: navClasses[0] ?? null,
        tag: list[1] as 'ul' | 'ol',
        listClasses,
        vertical: VERTICAL_NAV.test(
          `${navClasses.join(' ')} ${listClasses.join(' ')} ${path}`
        ),
      }
      /*
       * Anything that might already be reaching this list means this pass does
       * nothing. A class the project defines, a rule on the bare tag, a `*`
       * reset — see `listIsStyled`.
       */
      if (listClasses.some((c) => defined.has(c))) continue
      if (listIsStyled(allCss, nav)) continue
      navs.push(nav)
    }
  }
  if (navs.length === 0) return { files, fixed: [] }

  const written = navCss(navs, sheet[1])
  if (!written.css) return { files, fixed: [] }

  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${written.css}\n`)
  return {
    files: out,
    fixed: [
      `${sheet[0]}: ナビゲーションが箇条書きのままだったので CSS を書きました` +
        `（list-style の解除・並べ方・リンクの見た目・:hover・:focus-visible・現在地）: ${written.styled.join('、')}`,
    ],
  }
}

/**
 * Last resort: one component that will not build costs that component, not the
 * application.
 *
 * A project is compiled as a unit, so a single unparseable file has always meant
 * a blank page — every screen gone because one icon had a stray brace. Every
 * repair above exists because a specific idiom was measured doing exactly that,
 * and three sessions running, the next generation found a different one:
 *
 *     v145   a class-based router               (our bug — Sucrase lowering)
 *     v151   {width={size}} in one icon of nine
 *     v153   {#const …} in two screens
 *
 * Each was fixed, and each time the following run failed on something new. The
 * list of known mistakes is not converging fast enough to be the whole answer,
 * and the requirement it serves does not bend: a generated UI must never fail to
 * display.
 *
 * So this handles the class instead of the instance. When the project still will
 * not compile after every deterministic repair, the file the compiler blames is
 * replaced with a component that renders a labelled placeholder. The rest of the
 * application builds and runs: the navigation works, the other screens work, and
 * the one broken piece says so on the page.
 *
 * Deliberately narrow:
 *  - Components only. A `.svelte.ts` store or a `lib/` module is imported for the
 *    values it exports, and a stub of it breaks every file that reads it —
 *    trading one failure for several. Those keep the build error, which the
 *    preview shows as a readable message rather than a blank pane.
 *  - Never the entry or the shell. Stubbing `App` leaves an application with no
 *    navigation and nothing in it, which is not better than the error.
 *  - Never a file with named exports (React only in practice): something else
 *    imports those by name, and the stub would not have them.
 *  - It stops as soon as the project builds, so a sound document is untouched.
 *
 * The placeholder is visible on purpose. A silently missing card would leave the
 * user hunting for a screen that never rendered; a dashed box naming the file
 * says what happened and where.
 */
export function stubUnbuildableComponents(
  html: string,
  kind: OutputKind,
  compile: (html: string, kind: OutputKind) => { error?: string | null }
): { html: string; stubbed: string[]; reasons: { path: string; error: string }[] } {
  const fw = FRAMEWORKS[kind]
  const stubbed: string[] = []
  /*
   * Why each one was replaced, kept so the placeholder is not a diagnostic dead
   * end.
   *
   * Measured at v160: all three screens of a Svelte project were stubbed, the
   * application rendered its shell and navigation with a placeholder where every
   * screen should have been, and the only record was a list of three filenames.
   * Three failures with one probable cause, and nothing anywhere said what it
   * was — the stub had replaced the evidence along with the fault.
   */
  const reasons: { path: string; error: string }[] = []
  let out = html

  for (let guard = 0; guard < 8; guard++) {
    const error = compile(out, kind)?.error
    if (!error) break

    const named = new RegExp(`(src/[\\w./-]+\\${fw.componentExt})`).exec(error)?.[1]
    if (!named || stubbed.includes(named)) break

    // The entry and the shell are the application; a stub of either is not a
    // smaller failure than the error.
    if (named === fw.entry || new RegExp(`^src/App\\${fw.componentExt}$`).test(named)) break

    const files = readProjectFiles(out)
    const body = files.get(named)
    if (!body) break

    /*
     * Something may import a named export from this file, and the stub will not
     * have it.
     *
     * What counts as a named export differs by framework, and reading React's
     * rule into the others is wrong in a way that matters: inside a .svelte
     * file `export let variant = 'primary'` declares a PROP, not a module
     * export, and nothing imports it by name. Measured — a component whose only
     * "exports" were four Svelte 4 props was skipped, and its project stayed a
     * blank page for no reason.
     *
     * For Svelte a real named export lives in a module script; for Vue, in a
     * plain `<script>` beside the setup block. Both are rare in generated code.
     */
    const hasNamedExport =
      kind === 'react'
        ? /^\s*export\s+(?:const|function|class|let)\s+\w/m.test(body)
        : /<script\b[^>]*\b(?:module|context=["']module["'])[^>]*>/.test(body)
    if (hasNamedExport) break

    const written = writeProjectFile(out, named, componentStub(kind, named))
    if (written === null) break

    out = written
    stubbed.push(named)
    reasons.push({ path: named, error: error.split('\n')[0].slice(0, 300) })
  }

  return { html: out, stubbed, reasons }
}

/**
 * The files a build error names, whether or not a stub could replace them.
 *
 * `stubUnbuildableComponents` finds them too, and then declines on the entry,
 * the shell, a module, and anything with a named export — correctly, because a
 * placeholder for any of those is not a smaller failure than the error. It
 * reports nothing in those cases, which is right for stubbing and wrong for
 * everything else: repairing App.svelte is not only possible, it is the case
 * where repairing matters most, since nothing else can rescue it.
 *
 * Measured on v195. Svelte put an `{@const}` where Svelte does not allow one,
 * in App.svelte. Nothing could be stubbed, so the build-error repair — gated on
 * the stub having found something — never ran, and a project with five screens
 * and seventeen components rendered nothing at all and scored its floor.
 *
 * One name per compile, and the file is stubbed internally only to move past it
 * and see what the next error is. The stubbed document is thrown away; the
 * caller gets paths and messages.
 */
export function unbuildableFiles(
  html: string,
  kind: OutputKind,
  compile: (html: string, kind: OutputKind) => { error?: string | null }
): { path: string; error: string }[] {
  const fw = FRAMEWORKS[kind]
  const found: { path: string; error: string }[] = []
  let out = html

  for (let guard = 0; guard < 8; guard++) {
    const error = compile(out, kind)?.error
    if (!error) break
    /*
     * Longest extension first, and only at a boundary.
     *
     * Two ways to get the wrong path out of a right message. `.svelte` tried
     * before `.ts` truncates `src/lib/store.svelte.ts` to `src/lib/store.svelte`;
     * `ts` tried before `tsx` truncates `Card.tsx` to `Card.ts`. Either way a
     * repair is handed a file the project does not have and can only fail on it.
     */
    const named = new RegExp(
      `(src/[\\w./-]+\\.(?:tsx|jsx|ts|js)(?![\\w.])|src/[\\w./-]+\\${fw.componentExt}(?![\\w.]))`
    ).exec(error)?.[1]
    if (!named || found.some((f) => f.path === named)) break
    found.push({ path: named, error: error.split('\n')[0].slice(0, 300) })
    // Only to reach the next error. This document is never returned.
    const written = writeProjectFile(out, named, componentStub(kind, named))
    if (written === null) break
    out = written
  }
  return found
}

/** A component of this framework that renders a labelled placeholder. */
function componentStub(kind: OutputKind, path: string): string {
  const name = path.split('/').pop() ?? path
  const note = `${name} はビルドできなかったため、この部分だけ差し替えられています`
  // Inline styles rather than a class: the stylesheet may not define one, and
  // this has to be visible in a project it knows nothing about.
  const style =
    'padding:16px;border:1px dashed #b45309;border-radius:8px;' +
    'background:#fffbeb;color:#92400e;font-size:13px;line-height:1.6'

  if (kind === 'vue') {
    return `<template>\n  <div style="${style}">${note}</div>\n</template>\n`
  }
  return (
    `export default function BrokenComponent(_props: Record<string, unknown>) {\n` +
    `  return (\n` +
    `    <div style={{ padding: 16, border: '1px dashed #b45309', borderRadius: 8,\n` +
    `                  background: '#fffbeb', color: '#92400e', fontSize: 13, lineHeight: 1.6 }}>\n` +
    `      ${note}\n` +
    `    </div>\n` +
    `  );\n` +
    `}\n`
  )
}

/**
 * Last resort: a component's `<style>` block that will not parse loses the
 * block, rather than the application losing the page.
 *
 * Every targeted repair above exists because a specific idiom was measured
 * reaching a user as a blank page. Three consecutive Svelte runs failed to
 * build for three unrelated reasons, and only one of them was foreseen. The
 * targeted repairs are still worth having — they preserve the code the model
 * wrote — but a list of known mistakes cannot be complete, and the requirement
 * it serves is absolute: a generated UI must never fail to display.
 *
 * So this handles the class rather than the instance, for the one part of a
 * component that can be removed without changing what the component does.
 * `src/styles/globals.css` is the design by contract — it carries the tokens,
 * the shell, and every shape a screen uses — which makes a scoped block
 * supplementary. Dropping one costs some polish on one component. Keeping it
 * costs the entire interface.
 *
 * Deliberately conservative:
 *  - Only when the document does not compile at all.
 *  - Only when the compiler blames CSS. A block is never removed to work around
 *    an error in the script, because that would hide a real fault behind a
 *    cosmetic change and still not build.
 *  - Only the file the compiler names.
 *  - It stops as soon as the project builds, so a document that compiles is
 *    returned exactly as it came in.
 */
export function salvageUnparsableStyles(
  html: string,
  kind: OutputKind,
  compile: (html: string, kind: OutputKind) => { error?: string | null }
): { html: string; stripped: string[] } {
  const stripped: string[] = []
  let out = html

  for (let guard = 0; guard < 6; guard++) {
    const error = compile(out, kind).error
    if (!error) break
    // Svelte reports `css_expected_identifier` and friends, and links to
    // svelte.dev/e/css_*; Vue's SFC compiler names the block outright.
    if (!/\bcss[_\s-]|CSS|<style/i.test(error)) break

    const named = /(src\/[\w./-]+\.(?:vue))/.exec(error)?.[1]
    if (!named || stripped.includes(named)) break

    const files = readProjectFiles(out)
    const body = files.get(named)
    if (!body || !/<style[\s>]/.test(body)) break

    const next = body.replace(/\n?[ \t]*<style[^>]*>[\s\S]*?<\/style>[ \t]*\n?/g, '\n')
    if (next === body) break

    // Refuses the write if the body would break the transport. Nothing here can
    // produce that — removing a block cannot introduce a fence — but the whole
    // point of this function is to be the step that never makes things worse.
    const written = writeProjectFile(out, named, next)
    if (written === null) break

    out = written
    stripped.push(named)
  }

  return { html: out, stripped }
}

/**
 * A default export pulled in by name through `require`.
 *
 *     // src/components/icons/ClockIcon.tsx
 *     export default function ClockIcon({ size }) { … }
 *
 *     // src/screens/ApplicationsScreen.tsx
 *     const { ClockIcon } = require('../components/icons/ClockIcon');
 *     …
 *     return <ClockIcon size={12} />;
 *
 * The module has no named `ClockIcon`, so the binding is `undefined` and React
 * refuses to render it:
 *
 *     Minified React error #130  (element type is invalid: got undefined)
 *
 * Measured at v172, on a screen whose other seven imports were ordinary ESM at
 * the top of the file. Three icons were reached this way, mid-function.
 *
 * It survives the checks for the same reason the markdown fence did: nothing
 * here is malformed. The module resolves, the destructuring succeeds, and the
 * value is simply not there. `unresolvedComponentDefects` skips React on the
 * reasoning that an undefined JSX name is already a reference error — true of a
 * free identifier, and this is a declared `const` bound to undefined.
 *
 * Rewritten to read the default, which is the export that exists:
 *
 *     const ClockIcon = require('../components/icons/ClockIcon').default;
 *
 * Left in place rather than hoisted to an import — a `require` inside a
 * function runs when it is called, and moving it changes when the module is
 * evaluated. Only when the target actually has a default export and no named
 * export of that name: a module offering both is doing so deliberately.
 */
export function fixRequireNamedDefault(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const fixed: string[] = []
  const out = new Map(files)

  const resolve = (from: string, spec: string): string | undefined => {
    const dir = from.slice(0, from.lastIndexOf('/'))
    const parts = `${dir}/${spec}`.split('/')
    const stack: string[] = []
    for (const p of parts) {
      if (p === '.' || p === '') continue
      if (p === '..') stack.pop()
      else stack.push(p)
    }
    const base = stack.join('/')
    return [...files.keys()].find((k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue)$/, '') === base)
  }

  for (const [path, body] of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(path)) continue
    let next = out.get(path) ?? body
    let touched = false

    next = next.replace(
      /(?:const|let|var)\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
      (whole, name: string, spec: string) => {
        const target = resolve(path, spec)
        if (!target) return whole
        const t = files.get(target) ?? ''
        if (!/export\s+default\b/.test(t)) return whole
        // A module that exports both is offering the named one on purpose.
        if (new RegExp(`export\\s+(?:const|function|class)\\s+${name}\\b`).test(t)) return whole
        touched = true
        fixed.push(`${name} (${path})`)
        return `const ${name} = require('${spec}').default`
      }
    )

    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          `default export を名前で require していたため .default に変更（undefined が描画され React error #130 になります）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

/**
 * A local binding that turns a rune back into a store read.
 *
 *     const state = appStore;
 *     let currentScreen = $state('home');
 *
 * compiles to
 *
 *     const $state = () => $.store_get(state, '$state', $$stores);
 *     let currentScreen = $.mutable_source($state()('home'));
 *
 *     TypeError: e.subscribe is not a function
 *
 * `$name` is a store subscription whenever `name` is in scope, and that rule
 * outranks the rune. So naming a variable `state` silently disables `$state` for
 * the rest of the file — the component still compiles, and dies on mount.
 * Measured at v178.
 *
 * `fixSvelteRuneShadowing` already handles this for exported names, where the
 * rename has to reach every importer. A local binding is the easier half: the
 * shadow cannot leave the file, so neither does the fix.
 *
 * Only when the rune is actually used — an unrelated `state` variable in a file
 * with no `$state` shadows nothing — and never for a name that came out of
 * `$props()`, where the name is a contract with the parent.
 */

/**
 * An event handler missing its closing parenthesis.
 *
 *     @click="navigate('cart'"
 *
 *     src/App.vue: Error parsing JavaScript expression:
 *     Unexpected token, expected "," (1:17)
 *
 * The attribute value is a whole expression, so a count that comes up exactly
 * one short has exactly one repair. Measured at v178, where the same file had
 * three other handlers calling the same function correctly — the kind of slip
 * that survives because it looks like its neighbours.
 *
 * Only by one, and only when nothing else in the value is unbalanced: two
 * missing is a different mistake, and a value that is short a bracket or a brace
 * is not this one.
 */
export function fixVueUnclosedHandler(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(/(\s(?:@|v-on:)[\w.-]+=")([^"]*)"/g, (whole, head: string, expr: string) => {
    let round = 0
    let other = 0
    for (const ch of expr) {
      if (ch === '(') round++
      else if (ch === ')') round--
      else if (ch === '[' || ch === '{') other++
      else if (ch === ']' || ch === '}') other--
      if (round < 0 || other < 0) return whole
    }
    if (round !== 1 || other !== 0) return whole
    fixed.push(expr.trim().slice(0, 32))
    return `${head}${expr})"`
  })
  return {
    source: out,
    fixed: fixed.length
      ? [`閉じ括弧が足りないイベントハンドラを補完（テンプレート式のパースに失敗します）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

/**
 * A TypeScript assertion left in the markup.
 *
 *     onConfirm={() => deleteRequest(confirmDeleteId!)}
 *
 *     src/screens/RequestsListScreen.svelte: Unexpected token
 *
 * Only `<script>` blocks are handed to Sucrase, because only they are
 * JavaScript — the markup is Svelte's own language and its expressions are
 * parsed by Svelte. So a non-null assertion inside an event handler never meets
 * the TypeScript stripper, and Svelte's expression parser has no idea what the
 * `!` is doing there.
 *
 * Measured at v178. It is easy to write, because the same file's script block
 * is TypeScript and the assertion is correct there — the boundary is invisible
 * while you are typing.
 *
 * Postfix `!` is unambiguous: logical NOT is a prefix operator, and `!=` / `!==`
 * are excluded by requiring a closing token after it. Nothing else in the
 * expression is touched.
 */

/**
 * `defineProps` called and thrown away, while the code reads `props`.
 *
 *     <script setup lang="ts">
 *     defineProps<Props>()
 *     const points = computed(() => props.data.map(…))
 *
 *     ReferenceError: props is not defined
 *
 * The macro returns the props object and this call discards it, so `props` is
 * never bound. It compiles — `props` is just a free identifier as far as the
 * compiler is concerned — and throws on the first render that evaluates the
 * expression. Measured at v200: two of these in one Vue project, the chart
 * component threw, and the run scored its floor.
 *
 * `fixVueUncapturedProps` above does not reach it. That one rewrites bare uses
 * of declared prop NAMES into `props.name`, and it reads those names out of an
 * inline type or object literal — with `defineProps<Props>()` the names live in
 * a separate interface, so it finds none and returns. Here the uses are already
 * written `props.data`; the only thing missing is the binding.
 *
 * Which makes the repair the smallest possible one: give the call its variable.
 * Nothing else moves.
 */
export function fixVueUnboundProps(source: string): { source: string; fixed: string[] } {
  const block = /(<script[^>]*\bsetup\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(source)
  if (!block) return { source, fixed: [] }
  const [, open, body, close] = block

  // A call standing alone as a statement — not `const props = defineProps(…)`,
  // and not nested inside anything.
  const call = /(^|\n)([ \t]*)(defineProps\s*(?:<[\s\S]*?>)?\s*\([\s\S]*?\)\s*;?)[ \t]*(?=\n|$)/.exec(body)
  if (!call) return { source, fixed: [] }
  const preceding = body.slice(0, call.index + call[1].length + call[2].length).trimEnd()
  if (/[(=,[:]$/.test(preceding)) return { source, fixed: [] }

  // Already bound, by this call or any other.
  if (/(?:const|let|var)\s+props\b/.test(body)) return { source, fixed: [] }
  // And actually read. A component that calls defineProps for its template only
  // is correct as written, and binding it would leave an unused variable.
  if (!/(?<![\w$.])props\s*[.[]/.test(body)) return { source, fixed: [] }

  const fixedBody = body.replace(call[3], () => `const props = ${call[3]}`)
  return {
    source: source.replace(open + body + close, () => open + fixedBody + close),
    fixed: ['defineProps の戻り値を props に束縛（props is not defined になります）'],
  }
}
/**
 * An import written half as an import and half as a require.
 *
 *     import { route, navigate } = require('./lib/navigation.svelte');
 *
 *     Error transforming src/App.svelte: Unexpected token (6:30)
 *
 * Neither language has this form: `import { … }` wants `from`, and `= require()`
 * wants a `const`. Column 30 is the `=`. It sits among five correct `import …
 * from` lines in the same block, which is what makes it easy to write and easy
 * to miss.
 *
 * Measured at v179. The repair is the line the rest of the file is already
 * written in — the module specifier is right there, so nothing has to be
 * inferred.
 */
export function fixImportRequireHybrid(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(
    /import\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g,
    (_whole, binding: string, quote: string, spec: string) => {
      fixed.push(spec)
      return `import ${binding} from ${quote}${spec}${quote};`
    }
  )
  return {
    source: out,
    fixed: fixed.length
      ? [
          `import と require が混ざった行を import ... from に統一（どちらの構文でもないため構文エラーになります）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

/**
 * Props used in the script of a `<script setup>` that never captured them.
 *
 *     defineProps<{ data: MonthlySalesData[] }>()
 *
 *     const maxAmount = computed(() => Math.max(...data.map(d => d.amount)))
 *
 *     ReferenceError: data is not defined
 *
 * `defineProps` returns the props object; the template gets the names bound for
 * free, script code does not. So the same name works in the markup and throws
 * ten lines above it — `<g v-if="data.length > 0">` renders and
 * `data.map(...)` in a computed does not, in one file.
 *
 * Measured at v183 on a chart component, where every scale function reached for
 * `data` and the template used it correctly throughout.
 *
 * The repair is the line the docs give: capture the return and read through it.
 * Only names the props type actually declares, only in the script block, and
 * only where nothing local already binds the name — a shadowing declaration
 * means the reference resolves and this is not the defect.
 *
 * The type may be written inline or as a name. Reading only the inline form is
 * what let this ship again on 2026-09-18: `defineProps<Props>()` above
 * `interface Props { product: Product }` declared nothing this could see, so
 * every product card in a storefront threw on click and the page looked fine
 * until someone pressed one. See `namedTypeLiteral`.
 */
/**
 * A props shape with its nested levels removed, so only its own members read.
 *
 * `{ product: { id: string } }` declares ONE prop. Taking every `name:` in the
 * text declares two, and the second — `id` — is a name a script is very likely
 * to use for something else, which would rewrite a local variable into
 * `props.id`. The members sit at depth 1 by construction here; everything
 * deeper belongs to a member rather than being one.
 */
function outerMembers(shape: string): string {
  let depth = 0
  let out = ''
  for (const ch of shape) {
    if (ch === '{') { depth++; out += ch; continue }
    if (ch === '}') { depth--; out += ch; continue }
    if (depth <= 1) out += ch
  }
  return out
}

/**
 * The body of `interface Props { … }` or `type Props = { … }`, as a literal.
 *
 * The repair below read the names straight out of the type argument, which
 * works for `defineProps<{ product: Product }>()` and finds nothing at all for
 * `defineProps<Props>()` — a type REFERENCE has no members in it. That second
 * spelling is the one a model writes when it has already declared the interface
 * for readability, and it is the one that shipped the defect this repair exists
 * for: a storefront where every product card's click handler read a bare
 * `product` and threw `ReferenceError: product is not defined`, measured
 * 2026-09-18 on a Vue generation, with `interface Props { product: Product }`
 * eight lines above the call.
 *
 * Only a declaration in the same script block, and only when its brace follows
 * the name closely — a match far from its own `{` is a different declaration.
 */
function namedTypeLiteral(script: string, name: string): string | null {
  const at = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:interface\\s+${name}\\b|type\\s+${name}\\s*=)`).exec(script)
  if (!at) return null
  const from = at.index + at[0].length
  const open = script.indexOf('{', from)
  if (open === -1 || open - from > 40) return null
  let depth = 0
  for (let i = open; i < script.length; i++) {
    if (script[i] === '{') depth++
    else if (script[i] === '}' && --depth === 0) return script.slice(open, i + 1)
  }
  return null
}

export function fixVueUncapturedProps(source: string): { source: string; fixed: string[] } {
  const block = /(<script[^>]*\bsetup\b[^>]*>)([\s\S]*?)(<\/script>)/.exec(source)
  if (!block) return { source, fixed: [] }
  const [whole, open, body, close] = block

  // An unassigned defineProps — the assigned form is already correct.
  const call = /(^|\n)([ \t]*)defineProps\s*(<[\s\S]*?>)?\s*\(([\s\S]*?)\)\s*;?[ \t]*(?=\n|$)/.exec(body)
  if (!call) return { source, fixed: [] }
  /*
   * Starting a line is not the same as starting a statement. `withDefaults(`
   * puts `defineProps<{` on its own indented line and the props ARE captured
   * — by the call wrapped around it. Rewriting that produced
   * `const props = withDefaults(` followed by `const __props = defineProps<{`,
   * which does not parse. Measured: the repair broke two documents that were
   * already correct.
   */
  const preceding = body.slice(0, call.index ?? 0).replace(/\s+$/, '')
  if (/[(=,[:]$/.test(preceding)) return { source, fixed: [] }

  /*
   * The names it declares, from the type literal, a named type declared beside
   * it, or the object argument.
   */
  const declared = new Set<string>()
  const reference = /^<\s*([A-Za-z_$][\w$]*)\s*>$/.exec((call[3] ?? '').trim())
  const shape = outerMembers(
    (reference ? namedTypeLiteral(body, reference[1]) : null) ?? call[3] ?? call[4] ?? ''
  )
  for (const m of shape.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)) declared.add(m[1])
  for (const m of shape.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) declared.add(m[1])
  if (declared.size === 0) return { source, fixed: [] }

  const rest = body.slice(0, call.index) + body.slice((call.index ?? 0) + call[0].length)
  const used = [...declared].filter((name) => {
    if (new RegExp(`(?:const|let|var|function)\\s+${name}\\b`).test(rest)) return false
    if (new RegExp(`\\(\\s*(?:[^)]*,\\s*)?${name}\\s*[,)]`).test(rest)) return false
    return new RegExp(`(?<![\\w$'"])(?<!(?<!\\.)\\.)${name}(?![\\w$:])`).test(rest)
  })
  if (used.length === 0) return { source, fixed: [] }

  const holder = /(?<![\w$.])props(?![\w$])/.test(body) ? '__props' : 'props'
  let next = body.replace(call[0], () => `${call[1]}${call[2]}const ${holder} = defineProps${call[3] ?? ''}(${call[4]});\n`)

  for (const name of used) {
    next = next.replace(new RegExp(`(?<![\\w$'"])(?<!(?<!\\.)\\.)${name}(?![\\w$:])`, 'g'), `${holder}.${name}`)
  }
  // The declaration line must not have been rewritten along with the uses.
  next = next.replace(new RegExp(`const ${holder}\\.[\\w$]+ = defineProps`), `const ${holder} = defineProps`)

  return {
    source: source.replace(whole, () => `${open}${next}${close}`),
    fixed: [
      `defineProps の戻り値を受け取り、スクリプト内の参照を ${holder}. 経由に変更（テンプレートでは動くがスクリプトでは ReferenceError になります）: ${used.join(', ')}`,
    ],
  }
}

/**
 * A default import of a file that only has named exports.
 *
 *     // src/components/icons/TrendIcon.tsx
 *     export function TrendIcon({ direction, size = 16 }) { … }
 *
 *     // src/components/KPICards.tsx
 *     import TrendIcon from './icons/TrendIcon';
 *
 *     Minified React error #130  (element type is invalid: got undefined)
 *
 * The module has no default, so the binding is `undefined` and the element
 * refuses to render — the same silent shape as `fixRequireNamedDefault`, in the
 * spelling ESM uses. Both halves are ordinary: the component is exported, the
 * importer names it correctly, and only the form disagrees.
 *
 * Measured at v185, on the run where the icons and illustrations instructions
 * first took effect. Two of the three occurrences were in exactly those new
 * files — asking for more components produced more of them and a new way for
 * them to be wired up wrong, which is worth saying plainly.
 *
 * The importer is what changes, because the export is what other files may
 * already be reading correctly. When the local name differs from the export —
 * `import EmptyStateIllustration from './illustrations/EmptyState'` — the alias
 * form keeps every use in the file working untouched.
 *
 * Only when the target offers exactly one component-shaped export. Two would be
 * a guess about which was meant, and none means the file is broken in a way
 * this cannot repair.
 */
export function fixDefaultImportOfNamedExport(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const fixed: string[] = []
  const out = new Map(files)

  const resolve = (from: string, spec: string): string | undefined => {
    const dir = from.slice(0, from.lastIndexOf('/'))
    const stack: string[] = []
    for (const seg of `${dir}/${spec}`.split('/')) {
      if (seg === '.' || seg === '') continue
      if (seg === '..') stack.pop()
      else stack.push(seg)
    }
    const base = stack.join('/')
    return [...files.keys()].find(
      (k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue)$/, '') === base
    )
  }

  for (const [path, body] of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(path)) continue
    let next = out.get(path) ?? body
    let touched = false

    for (const m of body.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])(\.[^'"]+)\2\s*;?/g)) {
      const [whole, local, quote, spec] = m
      const target = resolve(path, spec)
      if (!target) continue
      const t = files.get(target) ?? ''
      if (/export\s+default\b/.test(t)) continue

      const named = [
        ...t.matchAll(/export\s+(?:const|let|var|function|class)\s+([A-Z][\w$]*)/g),
      ].map((x) => x[1])
      const unique = [...new Set(named)]
      /*
       * The importer's own name, when the target exports it, is not a guess.
       *
       * The one-export rule skipped the commonest shape a repair writes: a
       * shared layout file holding several components, imported by the one it
       * is named after —
       *
       *     // src/components/ui/Screen.tsx
       *     export function Screen …  export function PageTitle …  export function Button …
       *     // src/screens/SettingsScreen.tsx
       *     import Screen from '../components/ui/Screen';
       *
       * Measured 2026-09-14: 4 of the 5 repair candidates rejected for breaking
       * the app between the baseline and the comparison runs were exactly this
       * (`Screen` x3 across 13 screens, `Card` beside `CardHeader` and
       * `CardBody` once), each a React #130 on every screen importing it, and
       * each discarding the pass's decomposition, icons and imagery with it.
       */
      const exported = unique.includes(local) ? local : unique.length === 1 ? unique[0] : undefined
      if (!exported) continue
      const clause = exported === local ? `{ ${local} }` : `{ ${exported} as ${local} }`
      next = next.replace(whole, () => `import ${clause} from ${quote}${spec}${quote};`)
      touched = true
      fixed.push(`${local} ← ${target}`)
    }

    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          `default import を名前付き import に修正（対象に default export がなく undefined が描画されます）: ${[
            ...new Set(fixed),
          ]
            .slice(0, 5)
            .join(', ')}`,
        ]
      : [],
  }
}

/**
 * An arrow function cast without being wrapped first.
 *
 *     window.addEventListener('inquiry-confirmed', (e) => {
 *       …
 *     } as EventListener)
 *
 *     [vue/compiler-sfc] Unexpected token, expected "," (34:4)
 *
 * TypeScript will not take an arrow function as the left operand of `as` — the
 * parentheses have to be there:
 *
 *     }) as EventListener)
 *
 * Verified against the transformer rather than assumed: the bare form fails,
 * the parenthesised form and the ordinary `handler as EventListener` both pass.
 * Measured at v186, where one occurrence took a whole Vue project down.
 *
 * Only when the brace really closes an arrow's body. A `}` followed by `as` can
 * also end an object literal or a block, and neither wants parentheses.
 */
export function fixArrowFunctionCast(source: string): { source: string; fixed: string[] } {
  let out = source
  let count = 0

  for (let guard = 0; guard < 12; guard++) {
    let done = true
    for (const m of [...out.matchAll(/\}\s*as\s+[A-Za-z_$][\w$.<>[\]]*/g)]) {
      const closeAt = m.index ?? 0

      // The brace this one closes.
      let depth = 0
      let openAt = -1
      for (let i = closeAt; i >= 0; i--) {
        if (out[i] === '}') depth++
        else if (out[i] === '{') {
          depth--
          if (depth === 0) { openAt = i; break }
        }
      }
      if (openAt < 0) continue

      // An arrow's body, not an object literal or a plain block.
      const before = out.slice(0, openAt).replace(/\s+$/, '')
      if (!before.endsWith('=>')) continue

      // Back over the parameter list to where the arrow starts.
      let start = before.length - 2
      while (start > 0 && /\s/.test(out[start - 1])) start--
      if (out[start - 1] === ')') {
        let d = 0
        let i = start - 1
        for (; i >= 0; i--) {
          if (out[i] === ')') d++
          else if (out[i] === '(') {
            d--
            if (d === 0) break
          }
        }
        if (i < 0) continue
        start = i
      } else {
        let i = start - 1
        while (i >= 0 && /[\w$]/.test(out[i])) i--
        start = i + 1
      }
      const async = /\basync\s*$/.exec(out.slice(0, start))
      if (async) start -= async[0].length

      out = `${out.slice(0, start)}(${out.slice(start, closeAt + 1)})${out.slice(closeAt + 1)}`
      count++
      done = false
      break
    }
    if (done) break
  }

  return {
    source: out,
    fixed: count
      ? [`アロー関数の as キャストを括弧で囲みました（囲まないと TypeScript として構文エラーになります）: ${count}件`]
      : [],
  }
}
