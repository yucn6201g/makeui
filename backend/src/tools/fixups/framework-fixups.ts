import { type OutputKind } from '../../config/frameworks.js'
import { readProjectFiles, writeProjectFile } from '../project/project-transport.js'
import { dropSuppliedFiles } from './supplied-files.js'
import { fixCountBadges, fixFlowScreensInNav, fixIconBaseline } from './shell-fixes.js'
import { fixResponsiveDisplay } from './responsive-display.js'
import { fixSourceConsistency } from './source-consistency.js'
import { fixNamedImportOfDefault } from '../project/react-bundle.js'
import { replaceEmoji } from './emoji-icons.js'
import { fixRenderNavigation } from './render-navigation.js'
import { raiseControlFonts } from './form-controls.js'
import {
  fixVueMacros,
  fixVueNonReactiveHash,
  fixVueUnclosedHandler,
  fixVueUnboundProps,
  fixVueUncapturedProps,
} from './vue-fixes.js'
import {
  fixRequireNamedDefault,
  fixImportRequireHybrid,
  fixDefaultImportOfNamedExport,
  fixArrowFunctionCast,
} from './module-fixes.js'
import { fixReactMissingProvider, fixDetailIdNotPassed, fixPathAsScreenId } from './state-fixes.js'
import { fixImageFieldMisspelt, fixPlaceholderImageBoxes, fixCatalogueWithoutPhotos } from './picture-fixes.js'
import {
  fixDeadUtilityClasses,
  fixIconsNotDrawn,
  fixIconOnPhotograph,
  fixUndefinedTokens,
  fixArtworkNotDrawn,
  fixKeyboardUnreachable,
  fixUnstyledNav,
} from './presentation-fixes.js'

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
 *
 * This file applies them in order (fixupFile per file, fixupProject across the
 * project). The repairs themselves are in the modules beside it, grouped by what
 * they are about: vue-fixes, module-fixes, state-fixes, picture-fixes and
 * presentation-fixes.
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
    // See tools/fixups/render-navigation.ts.
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

  // Four that compile and render and are wrong — see tools/fixups/source-consistency.ts.
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
