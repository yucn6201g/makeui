import { FRAMEWORKS, type OutputKind } from '../config/frameworks.js'
import { readProjectFiles, writeProjectFile } from './project-transport.js'
import { fixNamedImportOfDefault } from './react-bundle.js'
import { replaceEmoji } from './emoji-icons.js'

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
 * Svelte 5 reads `$name` as a store subscription, and rune modules are not stores.
 *
 * Reported by a user as a blank page with:
 *
 *     TypeError: e.subscribe is not a function
 *
 * The `$` prefix is Svelte's store contract from 3/4 — it compiles to
 * `store_get(name)`, which calls `name.subscribe(…)`. A `.svelte.ts` module
 * exporting rune state exports a plain object, so the call throws and nothing
 * renders. It is not a compile error: both halves are legal, and the two idioms
 * simply cannot be mixed.
 *
 * Only rewritten for names the file actually imports from a `.svelte` module,
 * because `$state`, `$derived`, `$props` and `$effect` are runes and a genuine
 * store elsewhere in the project must keep working.
 */
function fixSvelteStorePrefix(source: string): { source: string; fixed: string[] } {
  const RUNES = new Set(['$state', '$derived', '$props', '$effect', '$inspect', '$bindable', '$host'])
  const runeModuleNames = new Set<string>()

  for (const m of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!/\.svelte(?:\.[jt]s)?$/.test(m[2]) && !/\/(store|state)(\.svelte)?$/.test(m[2])) continue
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop()?.trim()
      if (name) runeModuleNames.add(name)
    }
  }
  if (runeModuleNames.size === 0) return { source, fixed: [] }

  const fixed: string[] = []
  const out = source.replace(/\$([A-Za-z_$][\w$]*)/g, (whole, name: string) => {
    if (RUNES.has(whole)) return whole
    if (!runeModuleNames.has(name)) return whole
    fixed.push(`${whole} → ${name}`)
    return name
  })
  return { source: out, fixed: fixed.length ? [`ストア構文をルーンの読み取りに置換: ${[...new Set(fixed)].join(', ')}`] : [] }
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
 * How many unclosed braces stand before `index`.
 *
 * Zero means module top level, which is the only place a binding can collide
 * with a top-level function declaration. Strings, template literals and
 * comments are skipped, because a brace inside any of them is not structure —
 * `` `${a}` `` and `// } ` would otherwise both throw the count off, and a
 * count that is wrong in the low direction is worse than no count at all: it
 * puts a nested declaration back in scope for renaming.
 *
 * Regular-expression literals are not tracked. Distinguishing `/` as division
 * from `/` as a literal needs the parser this file deliberately does without,
 * and a brace inside a character class is rare enough that the honest note is
 * better than a guess that fails silently. The failure direction is safe: an
 * unbalanced count reads as nested and the repair declines.
 */
function braceDepthAt(source: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index && i < source.length; i++) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i < 0) return depth
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) return depth
      i = end + 1
    } else if (c === '"' || c === "'" || c === '`') {
      for (i++; i < index && source[i] !== c; i++) if (source[i] === '\\') i++
    } else if (c === '{') depth++
    else if (c === '}') depth--
  }
  return depth
}

/**
 * A private binding and its accessor sharing one name.
 *
 *     let appState = $state<AppState>({ cart: [], … });
 *
 *     export function appState() {
 *       return appState;
 *     }
 *
 *     SyntaxError: Identifier 'appState' has already been declared
 *
 * Measured at v168, and the shape is not an accident. Svelte's own message for
 * exported rune state says to "export a function returning its value", and this
 * is that advice carried out with the name reused — the accessor and the thing
 * it accesses cannot both be `appState`, and the module does not compile.
 *
 * It is also exactly the shape `fixSvelteDerivedExport` above produces when it
 * rescues an exported rune, which gets it right by giving the binding a private
 * name. So the repair is to arrive at the same place: rename the binding, leave
 * the exported name alone. Every reader keeps calling `appState()` and no import
 * has to change.
 *
 * The function's own declaration is the one occurrence left as it was; the
 * `return` inside it follows the binding, since that is what it returns.
 *
 * Two things this must not do, both measured on a v191 Svelte result that
 * scored 50 with a clean console.
 *
 * It must not fire on a declaration inside a function. `navigation.svelte.ts`
 * exported `route()` and, inside `parseHash`, declared a local `const route:
 * Route`. Those do not collide — the local shadows the export, legally, and the
 * module compiled — but the scan matched at any indentation and "repaired" a
 * conflict that did not exist.
 *
 * And it must not rename a call. Having decided to rename, it rewrote `route()`
 * in the module's own hashchange handler to `__makeui_route()`, which is not a
 * function and not a binding in that scope. That throws on every hash change —
 * which is to say on every navigation — while loading cleanly, so the page
 * reported zero console errors and two dead nav items. The genuine clash is a
 * value that is read and never called, so excluding calls costs the repair
 * nothing and would alone have prevented this.
 */
export function fixSvelteDuplicateAccessor(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (let guard = 0; guard < 8; guard++) {
    let name = ''
    for (const m of out.matchAll(/(?:^|\n)\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=/g)) {
      const candidate = m[1]
      if (!new RegExp(`export\\s+function\\s+${candidate}\\s*\\(`).test(out)) continue
      // Only a top-level binding can clash with a top-level function. One
      // declared inside a function shadows the export, which is legal and none
      // of this repair's business.
      if (braceDepthAt(out, m.index ?? 0) !== 0) continue
      name = candidate
      break
    }
    if (!name) break

    const inner = `__makeui_${name}`
    // Everything but the function's own name, which is the export the readers
    // hold, and but a call, which can only mean that function. A declaration is
    // matched first so it is not renamed twice.
    out = out.replace(
      new RegExp(`(export\\s+function\\s+)${name}(\\s*\\()|(^|[^\\w$.])${name}\\b(?!\\s*\\()`, 'gm'),
      (_whole, kw: string, open: string, before: string) =>
        kw ? `${kw}${name}${open}` : `${before}${inner}`
    )
    fixed.push(`${name} → ${inner}`)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [`同名の内部変数と export 関数が衝突していたため内部側を改名（Identifier has already been declared）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

export function fixSvelteRuneImports(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(
    /import\s*\{([^}]*)\}\s*from\s*(['"])svelte\2\s*;?/g,
    (whole, names: string, quote: string) => {
      const parts = names.split(',').map((p) => p.trim()).filter(Boolean)
      const kept = parts.filter((p) => !p.startsWith('$'))
      const dropped = parts.filter((p) => p.startsWith('$'))
      if (dropped.length === 0) return whole
      fixed.push(...dropped)
      // Dropping every name leaves `import {} from 'svelte'`, which compiles but
      // reads as a mistake; remove the statement instead.
      return kept.length === 0 ? '' : `import { ${kept.join(', ')} } from ${quote}svelte${quote};`
    }
  )
  return {
    source: out,
    fixed: fixed.length
      ? [`ルーンの import を削除（構文であって値ではない）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

/**
 * `$state(…)` created lazily inside a function.
 *
 *     let store: AppState | null = null;
 *     export function getStore(): AppState {
 *       if (!store) { store = $state({ cart: [], … }); }
 *       return store;
 *     }
 *
 * Svelte rejects this outright:
 *
 *     `$state(...)` can only be used as a variable declaration initializer, a
 *     class field declaration, or the first assignment to a class field at the
 *     top level of the constructor.        (svelte.dev/e/state_invalid_placement)
 *
 * Measured on a real run at v138, in `src/lib/store.svelte.ts`. One file that
 * will not compile takes the whole project with it: blank page, score 30.
 *
 * The shape is not a careless mistake — it is the ordinary way to write a
 * singleton in every other language, and "create the store once" invites it.
 * Which is why telling the model not to do it has a failure rate, and why this
 * hoists it instead: a module-level `const` initialised by the rune is exactly
 * what the code was trying to express, and it is what Svelte allows.
 */
export function fixSvelteLazyRuneState(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (let guard = 0; guard < 8; guard++) {
    // An assignment (not a declaration) whose right-hand side is the rune.
    const m = /(^|[^\w.$])([A-Za-z_$][\w$]*)\s*=\s*\$state\s*\(/.exec(out)
    if (!m) break
    const nameAt = m.index + m[1].length
    const name = m[2]
    // A declaration is legal already; only a bare assignment is the bug.
    if (/\b(let|const|var)\s*$/.test(out.slice(Math.max(0, nameAt - 8), nameAt))) break

    const assign = statementRange(out, nameAt)
    if (!assign) break
    const initialiser = out.slice(out.indexOf('$state', nameAt), assign.end).replace(/;\s*$/, '')

    // The module-level `let name … = null` this was deferring.
    const declRe = new RegExp(`(^|\\n)([ \\t]*)(?:let|var)\\s+${name}\\b[^\\n=]*=\\s*null\\s*;?`)
    const decl = declRe.exec(out)
    if (!decl) break

    // Drop the assignment, and the `if (!name) { … }` wrapper around it if that
    // is all the wrapper held.
    let before = out.slice(0, assign.start)
    let after = out.slice(assign.end)
    const wrapper = new RegExp(`if\\s*\\(\\s*!\\s*${name}\\s*\\)\\s*\\{\\s*$`)
    const openedWrapper = wrapper.test(before)
    if (openedWrapper) {
      before = before.replace(wrapper, '')
      after = after.replace(/^\s*\}/, '')
    }
    out = before + after
    out = out.replace(declRe, `$1$2const ${name} = ${initialiser};`)
    fixed.push(name)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [`$state をモジュール直下の宣言に巻き上げ（関数内での代入は不可）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

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
/**
 * A rune returned from a getter or a method.
 *
 *     get route() { return $derived(() => this.currentRouteState); }
 *
 * Svelte rejects it — a rune initialises a variable declaration or a class
 * field, and is not an expression you can return — so the file does not compile
 * and the project is a blank page. Measured on a real run at v145, in a
 * class-based router in src/lib/navigation.svelte.ts.
 *
 * The wrapper is not merely misplaced, it is unnecessary: the getter reads a
 * field that is already `$state`, and reading `$state` inside a getter is
 * reactive on its own. So the fix is to return what was being wrapped. A thunk
 * is unwrapped with it — `$derived(() => x)` is a second mistake in the same
 * expression, since the callback form is `$derived.by`.
 *
 * Deliberately narrow: only a `return` whose entire expression is the rune.
 * A rune used correctly elsewhere in the same class is untouched.
 */
export function fixSvelteRuneInGetter(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(
    /return\s+\$(derived|state)\s*\(\s*(?:\(\s*\)\s*=>\s*)?([\s\S]*?)\s*\)\s*;?/g,
    (whole, rune: string, inner: string) => {
      // Balanced only: an inner expression carrying its own parentheses would
      // need real parsing, and a half-applied rewrite is worse than none.
      let depth = 0
      for (const ch of inner) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (depth < 0) return whole
      }
      if (depth !== 0 || !inner.trim()) return whole
      fixed.push(`$${rune}`)
      return `return ${inner.trim()};`
    }
  )
  return {
    source: out,
    fixed: fixed.length
      ? [`getter/メソッドから返されていたルーンを解除（ルーンは宣言の初期化子であって式ではない）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

export function fixSvelteGlobalAtRule(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (let guard = 0; guard < 32; guard++) {
    const at = out.search(/:global\(\s*@/)
    if (at < 0) break
    // Balanced match, because the prelude carries its own parens:
    // `(prefers-reduced-motion: reduce)`.
    const open = out.indexOf('(', at)
    let depth = 0
    let close = -1
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++
      else if (out[i] === ')') {
        depth--
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) break
    const inner = out.slice(open + 1, close).trim()
    fixed.push(inner.split(/\s|\(/)[0])
    out = out.slice(0, at) + inner + out.slice(close + 1)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [`:global() の中の at-rule を展開（セレクタではないため CSS パースに失敗する）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

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
  if (kind === 'svelte') {
    const fixed: string[] = [...hybridFixed]
    let next = body
    /**
     * The entry file is a `.ts`, not a `.svelte`, so the legacy-mount rewrite
     * cannot sit behind the component test below it — which is where it was
     * first put, and why it did nothing.
     */
    const mounted = fixSvelteLegacyMount(next)
    next = mounted.source
    fixed.push(...mounted.fixed)

    // Applies to every Svelte file, not just components: the run this was
    // written for put the import in a `.svelte.ts` store module.
    const runes = fixSvelteRuneImports(next)
    next = runes.source
    fixed.push(...runes.fixed)

    // Before the rune repairs below: a module that will not parse at all cannot
    // be reasoned about by any of them.
    const dupAccessor = fixSvelteDuplicateAccessor(next)
    next = dupAccessor.source
    fixed.push(...dupAccessor.fixed)

    const runeCall = fixSvelteRuneCalledAsFunction(next)
    next = runeCall.source
    fixed.push(...runeCall.fixed)

    // Straight after the call fix, which rewrites the initializer of the very
    // line this deletes. Both spellings are matched there, so the order is a
    // preference rather than a requirement.
    const redeclared = fixSvelteRedeclaredImport(next)
    next = redeclared.source
    fixed.push(...redeclared.fixed)

    // Modules only: a component owns its own effects.
    const orphan = /\.svelte\.[jt]s$/.test(path)
      ? fixSvelteOrphanEffect(next)
      : { source: next, fixed: [] as string[] }
    next = orphan.source
    fixed.push(...orphan.fixed)

    /*
     * Components only, and before anything that needs the file to parse.
     *
     * This repair's whole premise is that markup is not type-stripped. A
     * `.svelte.ts` module has no markup — it is TypeScript from the first
     * character — so running it there strips assertions that are correct and
     * required. Measured: `PRODUCTS[categoryId as keyof typeof PRODUCTS]` in a
     * store module became `PRODUCTS[categoryId typeof PRODUCTS]`, and a project
     * that compiled stopped compiling. The repair broke what it was repairing,
     * one file away from where it was looking.
     */
    const markupTs = path.endsWith('.svelte')
      ? fixSvelteMarkupTypeAssertion(next)
      : { source: next, fixed: [] as string[] }
    next = markupTs.source
    fixed.push(...markupTs.fixed)

    const shadowLocal = fixSvelteRuneShadowLocal(next)
    next = shadowLocal.source
    fixed.push(...shadowLocal.fixed)

    const runeInObject = fixSvelteRuneInObjectLiteral(next)
    next = runeInObject.source
    fixed.push(...runeInObject.fixed)

    const reactiveStmt = fixSvelteReactiveStatement(next)
    next = reactiveStmt.source
    fixed.push(...reactiveStmt.fixed)

    const classDir = fixSvelteClassDirectiveExpression(next)
    next = classDir.source
    fixed.push(...classDir.fixed)

    const inPlaceSort = fixSvelteInPlaceSort(next)
    next = inPlaceSort.source
    fixed.push(...inPlaceSort.fixed)

    const lazy = fixSvelteLazyRuneState(next)
    next = lazy.source
    fixed.push(...lazy.fixed)

    const inGetter = fixSvelteRuneInGetter(next)
    next = inGetter.source
    fixed.push(...inGetter.fixed)

    /*
     * After the getter rewrite, not before.
     *
     * `return $derived(() => x)` is both mistakes in one expression. Running
     * this first turns it into `return $derived.by(() => x)`, which the getter
     * rewrite above no longer recognises — it matches `$derived(`, not
     * `$derived.by(` — so the file goes back to not compiling. Measured: it
     * regressed a document that had been passing.
     */
    const thunk = fixSvelteDerivedThunk(next)
    next = thunk.source
    fixed.push(...thunk.fixed)

    if (path.endsWith('.svelte')) {
      const reserved = fixSvelteReservedProp(next)
      next = reserved.source
      fixed.push(...reserved.fixed)

      /*
       * After the reserved-word rewrite, which normalises `export let class:
       * additionalClass` into the `export { local as class }` form. This then
       * carries that across as a destructuring alias, so the two arrive at the
       * same answer instead of fighting over the same line.
       */
      const legacyProps = fixSvelteLegacyProps(next)
      next = legacyProps.source
      fixed.push(...legacyProps.fixed)

      // Before everything else that reads the script block: with two of them,
      // every later repair is looking at whichever one its regex found first.
      const dupScript = fixSvelteDuplicateScript(next)
      next = dupScript.source
      fixed.push(...dupScript.fixed)

      const constBlock = fixSvelteConstBlock(next)
      next = constBlock.source
      fixed.push(...constBlock.fixed)

      // After the spelling fix, so a `{#const}` corrected into a `{@const}` is
      // then checked for being in a place Svelte accepts.
      const constPlace = fixSvelteConstPlacement(next)
      next = constPlace.source
      fixed.push(...constPlace.fixed)

      const dupProps = fixSvelteDuplicateProps(next)
      next = dupProps.source
      fixed.push(...dupProps.fixed)

      // Before the shorthand repair, which would otherwise see
      // `onsubmit|preventDefault={handleSubmit}` as an attribute it should
      // rewrite rather than a Svelte 4 idiom to translate.
      const modifiers = fixSvelteEventModifiers(next)
      next = modifiers.source
      fixed.push(...modifiers.fixed)

      const propsArg = fixSveltePropsArgument(next)
      next = propsArg.source
      fixed.push(...propsArg.fixed)

      const shorthand = fixSvelteAttributeShorthand(next)
      next = shorthand.source
      fixed.push(...shorthand.fixed)

      // After the shorthand repair, which turns `{width={size}}` into
      // `width={size}` — a form this must not then treat as a bare shorthand.
      const undefShorthand = fixSvelteUndefinedShorthand(next)
      next = undefShorthand.source
      fixed.push(...undefShorthand.fixed)

      const nested = fixSvelteNestedButton(next)
      next = nested.source
      fixed.push(...nested.fixed)
    }

    const atRule = fixSvelteGlobalAtRule(next)
    next = atRule.source
    fixed.push(...atRule.fixed)

    if (path.endsWith('.svelte') || /\.svelte\.[jt]s$/.test(path)) {
      const store = fixSvelteStorePrefix(next)
      next = store.source
      fixed.push(...store.fixed)
    }
    return { body: next, fixed }
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
  let files = readProjectFiles(html)
  if (files.size === 0) return { html, fixed: [] }

  let out = html
  const fixed: string[] = []

  /**
   * Project-wide first, because renaming an export means rewriting its importers
   * and the two have to move together.
   */
  // Every framework: a `require` of a default export by name is the same
  // mistake whatever the component language is.
  const namedDefault = fixDefaultImportOfNamedExport(files)
  if (namedDefault.fixed.length > 0) {
    for (const [path, body] of namedDefault.files) {
      const next = writeProjectFile(out, path, body)
      if (next) out = next
    }
    files = readProjectFiles(out)
    fixed.push(...namedDefault.fixed)
  }

  // And the reverse direction — see `fixNamedImportOfDefault`.
  const defaultNamed = fixNamedImportOfDefault(out)
  if (defaultNamed.fixed.length > 0) {
    out = defaultNamed.html
    files = readProjectFiles(out)
    fixed.push(...defaultNamed.fixed)
  }

  const reqDefault = fixRequireNamedDefault(files)
  if (reqDefault.fixed.length > 0) {
    for (const [path, body] of reqDefault.files) {
      const next = writeProjectFile(out, path, body)
      if (next) out = next
    }
    files = readProjectFiles(out)
    fixed.push(...reqDefault.fixed)
  }

  if (kind === 'react') {
    const provider = fixReactMissingProvider(files)
    if (provider.fixed.length > 0) {
      for (const [path, body] of provider.files) {
        const next = writeProjectFile(out, path, body)
        if (next) out = next
      }
      files = readProjectFiles(out)
      fixed.push(...provider.fixed)
    }
  }

  if (kind === 'svelte') {
    // Before the rest, because it changes the shape of an export that the
    // other svelte passes read.
    const runeStore = fixSvelteRuneStoreSubscribe(files)
    if (runeStore.fixed.length > 0) {
      for (const [path, body] of runeStore.files) {
        const next = writeProjectFile(out, path, body)
        if (next) out = next
      }
      files = readProjectFiles(out)
      fixed.push(...runeStore.fixed)
    }
    const kit = fixSvelteKitImports(files)
    if (kit.fixed.length > 0) {
      for (const [path, body] of kit.files) {
        const next = writeProjectFile(out, path, body)
        if (next) out = next
      }
      files = readProjectFiles(out)
      fixed.push(...kit.fixed)
    }
    const shadow = fixSvelteRuneShadowing(files)
    if (shadow.fixed.length > 0) {
      for (const [path, body] of shadow.files) {
        const next = writeProjectFile(out, path, body)
        if (next) out = next
      }
      files = readProjectFiles(out)
      fixed.push(...shadow.fixed)
    }
    // After the rename, so a store named `state` is already `appState` by the
    // time its readers are rewritten into calls.
    const derived = fixSvelteDerivedExport(files)
    if (derived.fixed.length > 0) {
      for (const [path, body] of derived.files) {
        const next = writeProjectFile(out, path, body)
        if (next) out = next
      }
      files = readProjectFiles(out)
      fixed.push(...derived.fixed)
    }
  }

  if (kind === 'vue') {
    const hash = fixVueNonReactiveHash(files)
    if (hash.fixed.length > 0) {
      for (const [path, body] of hash.files) {
        const next = writeProjectFile(out, path, body)
        if (next) out = next
      }
      files = readProjectFiles(out)
      fixed.push(...hash.fixed)
    }
  }

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
 * Names a Svelte project may not export, because `$` + the name is a rune.
 *
 * The one that actually happened is `state`, and the mechanism is worth writing
 * down because nothing about it is obvious. A component wrote
 *
 *     import { state } from '../lib/store.svelte';
 *     let toastVisible = $state(false);
 *
 * and Svelte compiled the SECOND line to
 *
 *     const $state = () => $.store_get(_storesvelte.state, '$state', $$stores);
 *     let toastVisible = $state()(false);
 *
 * With a binding called `state` in scope, `$state` is read as a store
 * subscription on it rather than as the rune — the store-prefix rule wins, and
 * it wins silently. The module is a rune module, not a store, so `subscribe` is
 * not a function and the page throws on first render:
 *
 *     TypeError: e.subscribe is not a function
 *
 * Nothing fails at build time. Both files compile. Measured on a real Svelte
 * generation: eight components and screens, every one of them poisoned by the
 * same import, and a blank page.
 */
const RUNE_SHADOWS = ['state', 'props', 'derived', 'effect', 'inspect', 'bindable', 'host']

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
 * `$derived` handed a function where `$derived.by` was meant.
 *
 *     let filtered = $derived(() => {
 *       …
 *       return results;
 *     })();
 *
 * Svelte has two forms: `$derived(expr)` for an expression, and `$derived.by(fn)`
 * for a callback. Reaching for a callback and then invoking it — because the
 * value plainly should not be a function — produces `$derived(...)()`, which is
 * a call rather than a declaration initialiser, and Svelte refuses it:
 *
 *     `$derived(...)` can only be used as a variable declaration initializer …
 *
 * Measured in a real Svelte run, in a screen computing a filtered list. The
 * error message is unhelpful here — it names a rule the line appears to follow,
 * because `let x = $derived(…)` really is a declaration initialiser; what it
 * objects to is the `()` after it.
 *
 * Both shapes are rewritten to `$derived.by`. The invoked one is unambiguous.
 * The bare `$derived(() => …)` is left ambiguous only in theory: it would mean a
 * derived value that IS a function, which no generated screen has ever wanted,
 * and which would make every template reading it render "function () { … }".
 */
export function fixSvelteDerivedThunk(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (let guard = 0; guard < 32; guard++) {
    const at = out.search(/\$derived\s*\(\s*(?:\(|async\b|function\b)/)
    if (at < 0) break

    const open = out.indexOf('(', at)
    // The argument has to look like a function, not a parenthesised expression:
    // `$derived((a + b) * c)` is correct as written and must be left alone.
    const head = out.slice(open + 1, open + 200)
    if (!/^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(head)) break

    let depth = 0
    let close = -1
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++
      else if (out[i] === ')') {
        depth--
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) break

    // Drop an immediate invocation if there is one — that is the whole mistake.
    const after = out.slice(close + 1)
    const invoked = /^\s*\(\s*\)/.exec(after)
    const tail = invoked ? after.slice(invoked[0].length) : after

    out = `${out.slice(0, at)}$derived.by${out.slice(open, close + 1)}${tail}`
    fixed.push(invoked ? '$derived(fn)() → $derived.by(fn)' : '$derived(fn) → $derived.by(fn)')
  }

  return {
    source: out,
    fixed: fixed.length
      ? [`コールバック形のルーンを修正（式は $derived、コールバックは $derived.by）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

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
 * `$props()` called more than once in a component.
 *
 *     let { params = {} } = $props();
 *     let { onSelect } = $props();
 *
 * Svelte refuses it — "Cannot use `$props()` more than once"
 * (svelte.dev/e/props_duplicate) — so the component, and therefore the whole
 * project, does not build.
 *
 * This is the Svelte spelling of a fault a user already reported in Vue:
 * `duplicate defineProps() call`, which `fixVueMacros` above exists for. The
 * cause is the same in both — a component acquires a second prop while being
 * written, and declaring it looks exactly like declaring the first — so it is
 * worth repairing the same way rather than waiting to be told about it again in
 * a different framework.
 *
 * The destructuring patterns are merged into the first call and the rest are
 * deleted. That is what was meant: two `$props()` calls naming different props
 * are one component wanting all of them.
 *
 * The pattern is found by counting braces rather than by a regex, because a
 * default value is itself a brace — `{ params = {} }` — and `[^}]*` stops at the
 * wrong one. That mistake made the first version of this match nothing at all,
 * which is the failure mode worth being careful about: it looks like success.
 *
 * A call that is not destructured (`const p = $props()`) is left alone, and the
 * file goes to the repair loop. A merge that guesses is worse than an error.
 */
export function fixSvelteDuplicateProps(source: string): { source: string; fixed: string[] } {
  interface Call { start: number; end: number; inner: string }
  const calls: Call[] = []

  for (const m of source.matchAll(/=\s*\$props\s*\(\s*\)\s*;?/g)) {
    const eq = m.index ?? 0
    /*
     * Back to the destructuring pattern, over an optional type annotation.
     *
     * `let { a }: { a: string } = $props()` puts a second brace group between
     * the pattern and the `=`, and taking the first `}` found gives the TYPE.
     * The two are told apart by what precedes the group: a `:` means it was the
     * annotation, so keep going.
     */
    const matchingOpen = (from: number): number => {
      let depth = 0
      for (let j = from; j >= 0; j--) {
        if (source[j] === '}') depth++
        else if (source[j] === '{') {
          depth--
          if (depth === 0) return j
        }
      }
      return -1
    }

    let i = eq - 1
    while (i >= 0 && /\s/.test(source[i])) i--
    if (source[i] !== '}') continue

    let open = matchingOpen(i)
    if (open < 0) continue

    let before = open - 1
    while (before >= 0 && /\s/.test(source[before])) before--
    if (source[before] === ':') {
      // That was the annotation. The pattern is the group before it.
      i = before - 1
      while (i >= 0 && /\s/.test(source[i])) i--
      if (source[i] !== '}') continue
      open = matchingOpen(i)
      if (open < 0) continue
    }

    // And back over the declaration keyword.
    let k = open - 1
    while (k >= 0 && /\s/.test(source[k])) k--
    const kw = /(let|const|var)$/.exec(source.slice(Math.max(0, k - 5), k + 1))
    if (!kw) continue

    calls.push({
      start: k + 1 - kw[1].length,
      end: eq + m[0].length,
      inner: source.slice(open + 1, i),
    })
  }
  if (calls.length < 2) return { source, fixed: [] }

  // Every name, in the order first written, without repeats: a name appearing in
  // two calls is one prop, not two.
  const seen = new Set<string>()
  const names: string[] = []
  for (const call of calls) {
    let depth = 0
    let part = ''
    // Split on top-level commas only — a default can contain its own.
    for (const ch of `${call.inner},`) {
      if (ch === '{' || ch === '[' || ch === '(') depth++
      else if (ch === '}' || ch === ']' || ch === ')') depth--
      if (ch === ',' && depth === 0) {
        const name = part.trim()
        part = ''
        if (!name) continue
        const key = name.split(/[:=]/)[0].trim()
        if (seen.has(key)) continue
        seen.add(key)
        names.push(name)
        continue
      }
      part += ch
    }
  }
  if (names.length === 0) return { source, fixed: [] }

  let out = ''
  let at = 0
  for (const [i, call] of calls.entries()) {
    out += source.slice(at, call.start)
    if (i === 0) out += `let { ${names.join(', ')} } = $props();`
    at = call.end
  }
  out += source.slice(at)

  return {
    source: out,
    fixed: [`$props() の重複呼び出し ${calls.length} 件を1つにまとめました: ${[...seen].join(', ')}`],
  }
}


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
 * A prop named after a reserved word, declared as if it could be a binding.
 *
 *     export let class: additionalClass = '';
 *
 * `class` cannot be a variable, so this is a syntax error — "Unexpected token" —
 * and the component does not build. Measured across a whole generated project:
 * nine components had this same line, so nine of them failed and the application
 * showed nothing.
 *
 * The intent is legible, and it is a real Svelte idiom written from memory.
 * Passing an attribute whose name is a keyword needs the export renamed:
 *
 *     let additionalClass = '';
 *     export { additionalClass as class };
 *
 * That is what this produces, keeping the default. Both halves of the mangled
 * line are already there — the outward name before the colon, the local name
 * after it — which is why the rewrite is a rearrangement rather than a guess.
 *
 * Only reserved words. `export let size: number = 24` is ordinary TypeScript and
 * must survive untouched; the distinction is safe because a reserved word can
 * never be a `let` binding, so a line matching this pattern cannot be valid code
 * under any reading.
 */
const RESERVED_PROPS = ['class', 'for', 'default', 'case', 'new', 'this', 'in', 'of', 'function']

/**
 * Svelte 4 props in a file that also uses runes.
 *
 *     <script>
 *       export let variant = 'primary';
 *       export let disabled = false;
 *       let additionalClass = '';
 *       export { additionalClass as class };
 *
 *       let isLoading = $state(loading);   // ← this puts the file in runes mode
 *       $effect(() => { isLoading = loading });
 *     </script>
 *
 * One rune anywhere in the file switches it to runes mode, and there `export let`
 * is not a prop declaration any more:
 *
 *     Cannot use `export let` in runes mode — use `$props()` instead
 *
 * Measured across one generated project: five components written this way, all
 * five refused, and the application showed nothing. The mixture is not careless
 * — Svelte 4 is most of what has been written about Svelte, and `$state` is the
 * thing a model reaches for when it wants reactivity, so the two arrive in the
 * same file from different memories.
 *
 * Every prop becomes one destructuring of `$props()`, which is what the compiler
 * asks for. The renamed form carries across as a destructuring alias:
 * `export { additionalClass as class }` is `class: additionalClass`, which is
 * also how a reserved word is spelled in runes mode — so the two problems have
 * the same answer.
 *
 * A file with NO rune is a legitimate Svelte 4 component and is left alone. The
 * point is the contradiction, not the syntax.
 */
export function fixSvelteLegacyProps(source: string): { source: string; fixed: string[] } {
  // Runes mode is decided by the file, not by the framework version: any one of
  // these makes `export let` an error in the same file.
  if (!/\$(?:state|derived|props|effect|bindable)\b/.test(source)) return { source, fixed: [] }
  if (!/export\s+(?:let\b|\{)/.test(source)) return { source, fixed: [] }

  interface Cut { start: number; end: number }
  const cuts: Cut[] = []
  const entries: string[] = []
  const names: string[] = []

  // 1. `export let name [: type] [= default];`
  for (const m of source.matchAll(
    /export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?\s*(=\s*[^;\n]+)?;?/g
  )) {
    const [whole, name, init] = m
    cuts.push({ start: m.index ?? 0, end: (m.index ?? 0) + whole.length })
    entries.push(init ? `${name} ${init.trim()}` : name)
    names.push(name)
  }

  // 2. `export { local as outward };` — how Svelte 4 spells a prop whose name is
  //    a reserved word. The local declaration above it carries the default.
  for (const m of source.matchAll(/export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*\}\s*;?/g)) {
    const [whole, local, outward] = m

    /*
     * The same syntax spells a second, unrelated thing: a component method.
     *
     *     function openModal() { isOpen = true }
     *     export { openModal as open };
     *
     * That is not a prop and Svelte 5 accepts it as written — the file compiles
     * before this function touches it. Rewritten as a prop it becomes
     * `open: openModal` in the destructuring while `function openModal` stays
     * where it was, and the component dies on `Identifier 'openModal' has
     * already been declared`. Measured on one corpus document: valid Svelte in,
     * blank page out.
     *
     * `let` is the discriminator the compiler itself uses. A `let` export is a
     * prop; a `function`/`const`/`class` export is a static binding, and those
     * are left exactly as they are.
     */
    if (new RegExp(`(?:^|\\n)[ \\t]*(?:function|const|class|var)\\s+${local}\\b`).test(source)) continue

    cuts.push({ start: m.index ?? 0, end: (m.index ?? 0) + whole.length })

    const declaration = new RegExp(`(?:^|\\n)[ \\t]*let\\s+${local}\\s*(?::\\s*[^=;\\n]+)?\\s*(=\\s*[^;\\n]+)?;?`)
    const decl = declaration.exec(source)
    if (decl) {
      cuts.push({ start: decl.index + (decl[0].startsWith('\n') ? 1 : 0), end: decl.index + decl[0].length })
      entries.push(decl[1] ? `${outward}: ${local} ${decl[1].trim()}` : `${outward}: ${local}`)
    } else {
      entries.push(`${outward}: ${local}`)
    }
    names.push(outward)
  }

  if (entries.length === 0) return { source, fixed: [] }

  // Rebuild without the removed declarations, putting the destructuring where
  // the first one was so the props still read before the code that uses them.
  cuts.sort((a, b) => a.start - b.start)
  const insertAt = cuts[0].start
  let out = ''
  let at = 0
  for (const cut of cuts) {
    if (cut.start < at) continue // overlapping match; already consumed
    out += source.slice(at, cut.start)
    if (cut.start === insertAt) out += `let { ${entries.join(', ')} } = $props();`
    at = cut.end
  }
  out += source.slice(at)

  return {
    // Removing six declarations leaves six blank lines where they were. The
    // generated project is something a developer opens and continues from, so
    // the debris matters: collapse a run of them back to one.
    // Anchored so it consumes only the blank lines themselves: a pattern ending
    // in `[ \t]*` also swallows the NEXT line's indentation, which un-indents
    // the statement after the props and looks worse than the gap did.
    source: out.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n'),
    fixed: [`Svelte 4 の export let を $props() に変換（ルーンと混在するとコンパイルエラー）: ${names.join(', ')}`],
  }
}

function fixSvelteReservedProp(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (const word of RESERVED_PROPS) {
    const pattern = new RegExp(
      // export let <reserved> : <localName> [= <default>] ;
      `export\\s+let\\s+${word}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*(=\\s*[^;\\n]+)?;?`,
      'g'
    )
    out = out.replace(pattern, (_whole, local: string, init: string | undefined) => {
      fixed.push(`${word} → ${local}`)
      const declaration = init ? `let ${local} ${init.trim()};` : `let ${local};`
      return `${declaration}\n  export { ${local} as ${word} };`
    })
  }

  return {
    source: out,
    fixed: fixed.length
      ? [`予約語のプロパティ宣言を Svelte の形式に修正（export { local as name }）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

/**
 * A `{@const}` where Svelte does not allow one.
 *
 *     <main class="content">
 *       {@const Screen = renderScreen()}
 *       <Screen />
 *     </main>
 *
 *     `{@const}` must be the immediate child of `{#snippet}`, `{#if}`,
 *     `{:else if}`, `{:else}`, `{#each}`, `{:then}`, `{:catch}`,
 *     `<svelte:fragment>`, `<svelte:boundary>` or `<Component>`
 *
 * The tag is spelled correctly and the expression is valid; only the position is
 * wrong, and the whole project fails to build. Measured at v195 in App.svelte —
 * five screens, seventeen components, and a page that rendered nothing. The
 * shell cannot be stubbed, so nothing rescued it.
 *
 * This is the fourth spelling of the same reach, after `{width={size}}`,
 * `{#const …}` and `{width}`. Here the fix is to put the binding where it was
 * always going to work: the script, as `$derived`, which is what a value
 * computed from state is.
 *
 * Deliberately narrow. Only a `{@const}` with no block open above it anywhere in
 * the markup is touched, because that is the case where the expression provably
 * cannot reference a loop variable, an awaited value or a snippet parameter —
 * there is no block to have introduced one. A `{@const}` inside `{#each}` may be
 * misplaced too, and hoisting it would silently change what it computes, so it
 * is left for the build repair to read with the compiler's message in hand.
 */
export function fixSvelteConstPlacement(source: string): { source: string; fixed: string[] } {
  const script = /<script(?![^>]*\bmodule\b)[^>]*>([\s\S]*?)<\/script>/.exec(source)
  if (!script) return { source, fixed: [] }

  const fixed: string[] = []
  const hoisted: string[] = []
  let out = source
  // Only the markup, so a `{@const` written inside a string in the script is not
  // counted and the offsets are the ones the compiler complains about.
  const markupFrom = script.index + script[0].length

  for (let guard = 0; guard < 12; guard++) {
    const markup = out.slice(markupFrom)
    let depth = 0
    let target = -1
    for (const m of markup.matchAll(/\{#[a-z]+|\{\/[a-z]+\}|\{@const\s/g)) {
      if (m[0].startsWith('{#')) depth++
      else if (m[0].startsWith('{/')) depth--
      else if (depth === 0) { target = m.index ?? -1; break }
    }
    if (target < 0) break

    // Balance from the tag's own brace so a nested object or a call with braces
    // cannot end it early.
    const open = markupFrom + target
    let braces = 0
    let close = -1
    for (let i = open; i < out.length; i++) {
      if (out[i] === '{') braces++
      else if (out[i] === '}') {
        braces--
        if (braces === 0) { close = i; break }
      }
    }
    if (close < 0) break

    const body = out.slice(open + '{@const'.length, close).trim()
    const eq = body.indexOf('=')
    if (eq < 0) break
    const name = body.slice(0, eq).trim()
    const expr = body.slice(eq + 1).trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || !expr) break

    out = out.slice(0, open) + out.slice(close + 1)
    hoisted.push(`  const ${name} = $derived(${expr});`)
    fixed.push(name)
  }

  if (fixed.length === 0) return { source, fixed: [] }

  // Appended to the end of the instance script, after everything it may read.
  const reopened = /<script(?![^>]*\bmodule\b)[^>]*>([\s\S]*?)<\/script>/.exec(out)!
  const at = reopened.index + reopened[0].lastIndexOf('</script>')
  out = `${out.slice(0, at)}\n${hoisted.join('\n')}\n${out.slice(at)}`

  return {
    source: out,
    fixed: [
      `ブロックの外にある {@const} を script の $derived に移動（{@const} は {#if} や {#each} の直下にしか置けません）: ${fixed.join(', ')}`,
    ],
  }
}

/**
 * A second `<script>` block, usually appended after the markup.
 *
 *     <script>
 *       let period = $state('month');
 *     </script>
 *
 *     <div id="app"> … </div>
 *
 *     <script>
 *       let errorMessage = '';
 *       function handleApplyPeriod() { … }
 *     </script>
 *
 *     A component can have a single top-level <script> element and/or a single
 *     top-level <script module> element
 *     https://svelte.dev/e/script_duplicate
 *
 * Fatal, and in the shell, which is where it costs everything: App.svelte
 * cannot be stubbed, so the whole application renders nothing. Measured at
 * v203 — four screens, four components, zero rendered, score 30 with a 45-point
 * reach deduction on top.
 *
 * The correct form is unambiguous. Svelte allows one instance script and one
 * module script; every declaration in the instance script is in scope for the
 * markup wherever it sits, so the fix is to move the later bodies into the
 * first block and delete the empty tags. Nothing is reordered relative to
 * itself and nothing is dropped.
 *
 * `<script module>` — and its Svelte 4 spelling `context="module"` — is the
 * legal second block and is left exactly where it is.
 */
export function fixSvelteDuplicateScript(source: string): { source: string; fixed: string[] } {
  const blocks = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
  const instance = blocks.filter((b) => !/\b(?:module\b|context\s*=\s*["']module["'])/.test(b[1]))
  if (instance.length < 2) return { source, fixed: [] }

  const [first, ...rest] = instance
  // Removed from the end so the earlier offsets stay valid.
  let out = source
  for (const b of [...rest].reverse()) {
    const at = b.index ?? 0
    out = out.slice(0, at) + out.slice(at + b[0].length)
  }
  const merged = [first[2].replace(/\s+$/, ''), ...rest.map((b) => b[2].trim())].join('\n\n  ')
  out = out.replace(first[0], `<script${first[1]}>${merged}\n</script>`)

  return {
    source: out,
    fixed: [
      `2つ目以降の <script> を1つ目に統合（Svelte のコンポーネントは instance script を1つしか持てません）: ${rest.length}箇所`,
    ],
  }
}
export function fixSvelteConstBlock(source: string): { source: string; fixed: string[] } {
  let count = 0
  const out = source.replace(/\{#const\b/g, () => {
    count++
    return '{@const'
  })
  return {
    source: out,
    fixed: count > 0 ? [`{#const} を {@const} に修正（const はブロックではなくタグ）: ${count}箇所`] : [],
  }
}

/**
 * A shorthand attribute naming something that does not exist.
 *
 *     <script>
 *       let { size = 24 } = $props();
 *     </script>
 *     <svg {width} {height} viewBox="0 0 24 24">
 *
 * `{width}` is Svelte's shorthand for `width={width}` — it passes a variable of
 * that name, and there is no such variable. The component COMPILES, because
 * Svelte does not resolve the identifier at build time, and then throws the
 * first time it renders:
 *
 *     ReferenceError: width is not defined
 *       at CartIcon  at Header  at App
 *
 * Measured at v165. One icon, and the entire application rendered nothing —
 * caught only by running the document in a real browser, because every static
 * check and the compile gate pass.
 *
 * This is the third spelling of one mistake. The component wants its icon sized
 * by a prop, and reaches for the shorthand:
 *
 *     v151   {width={size}}   the shorthand with a value inside it — a parse error
 *     v153   {#const …}       a tag written as a block — a parse error
 *     v165   {width}          the shorthand with nothing behind it — a ReferenceError
 *
 * The first two fail loudly at build. This one waits.
 *
 * Two repairs, in order of how much they preserve:
 *
 *   - the component declares exactly one prop and the attribute is a dimension:
 *     bind it. `{width}` beside `let { size } = $props()` means `width={size}`,
 *     which is what an icon component is for.
 *   - otherwise: drop the attribute. An SVG without width renders at its CSS or
 *     default size, which is a smaller wrong than a blank page.
 */
export function fixSvelteUndefinedShorthand(source: string): { source: string; fixed: string[] } {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/g
  let declared = new Set<string>()
  let props: string[] = []

  for (const block of source.matchAll(script)) {
    const code = block[1]
    // Destructured props: `let { size = 24, variant } = $props()`.
    for (const m of code.matchAll(/(?:let|const|var)\s*\{([^}]*)\}\s*(?::[^=]+)?=\s*\$props\s*\(\s*\)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split(/[:=]/)[0].trim()
        if (name) { declared.add(name); props.push(name) }
      }
    }
    // Everything else a name can come from.
    for (const m of code.matchAll(/(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
    for (const m of code.matchAll(/import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/g)) {
      if (m[2]) declared.add(m[2])
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.split(/\s+as\s+/).pop()?.trim()
        if (name) declared.add(name)
      }
    }
  }

  /*
   * Names the MARKUP binds, which the script never mentions.
   *
   * `{#each filteredItems as product}` then `<ProductCard {product} />` is the
   * idiomatic way to pass a row to a component, and the first version of this
   * deleted it — the scan looked only at <script>, so `product` was undeclared
   * as far as it could see. Measured on a real grid before it shipped: the
   * repair for a blank page would have emptied the product list instead.
   */
  for (const m of source.matchAll(/\{#each\s+[^}]*?\bas\s+([^}()]+?)\s*(?:\(|\}|,)/g)) {
    for (const part of m[1].replace(/[{}[\]]/g, ',').split(',')) {
      const name = part.split(':').pop()?.trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }
  // `{#each xs as x, i}` — the index, and `{#await p then v}` / `catch e`.
  for (const m of source.matchAll(/\{#each\s+[^}]*?,\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of source.matchAll(/\{[#:]await\s+[^}]*?\b(?:then|catch)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of source.matchAll(/\{@const\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of source.matchAll(/\{#snippet\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    declared.add(m[1])
    for (const part of m[2].split(',')) {
      const name = part.split(/[:=]/)[0].trim()
      if (name) declared.add(name)
    }
  }
  // `let:item` on a component binds `item` for its children.
  for (const m of source.matchAll(/\blet:([A-Za-z_$][\w$]*)/g)) declared.add(m[1])

  const DIMENSION = new Set(['width', 'height'])
  const sizeProp = props.length === 1 ? props[0] : null
  const fixed: string[] = []

  // Only inside a tag: `{count}` in text content is an expression, not an
  // attribute, and removing it would delete what the screen is there to show.
  const out = source.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    if (tag.startsWith('</')) return tag
    return tag.replace(/\s\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (whole, name: string) => {
      if (declared.has(name)) return whole
      if (sizeProp && DIMENSION.has(name)) {
        fixed.push(`{${name}} → ${name}={${sizeProp}}`)
        return ` ${name}={${sizeProp}}`
      }
      fixed.push(`{${name}} を削除`)
      return ''
    })
  })

  return {
    source: out,
    fixed: fixed.length
      ? [`未定義の変数を指す短縮記法を修正（コンパイルは通り、描画時に ReferenceError になる）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

/**
 * Svelte 4 event modifiers, which Svelte 5 removed.
 *
 *     <form onsubmit|preventDefault={handleSubmit}>
 *
 *     'onsubmit|preventDefault' is not a valid attribute name
 *
 * The whole component refuses, so the page is blank. Measured on the corpus:
 * one project, two forms, both written this way — which is the shape of this
 * mistake, since a model that reaches for the Svelte 4 idiom reaches for it
 * everywhere it submits something.
 *
 * `preventDefault`, `stopPropagation` and `self` have exact expressions, so they
 * are written out. Anything else — `once`, `capture`, `passive` — is dropped
 * with the modifier removed: that changes behaviour, and it is still the better
 * of the two outcomes available, because the alternative is a component that
 * does not compile and a screen with nothing on it.
 */
export function fixSvelteEventModifiers(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const BODY: Record<string, string> = {
    preventDefault: 'e.preventDefault();',
    stopPropagation: 'e.stopPropagation();',
    self: 'if (e.target !== e.currentTarget) return;',
  }

  const out = source.replace(
    /\bon([a-z]+)((?:\|[a-zA-Z]+)+)=\{([^{}]+)\}/g,
    (_whole, event: string, mods: string, handler: string) => {
      const names = mods.split('|').filter(Boolean)
      const known = names.filter((n) => n in BODY)
      const dropped = names.filter((n) => !(n in BODY))
      fixed.push(
        `on${event}|${names.join('|')} → on${event}（Svelte 5 で修飾子は廃止）` +
          (dropped.length ? `。${dropped.join(', ')} は再現できないため除去` : '')
      )
      const prelude = known.map((n) => BODY[n]).join(' ')
      return `on${event}={(e) => { ${prelude}${prelude ? ' ' : ''}(${handler.trim()})(e); }}`
    }
  )
  return { source: out, fixed }
}

/**
 * `$props()` called with an argument.
 *
 *     let { navigate } = $props(useNavigation());
 *
 *     `$props` cannot be called with arguments
 *
 * The rune takes none, so anything inside the parentheses is a mistake — but
 * which mistake decides the repair, and the two readings give opposite results.
 *
 * A CALL is where the values actually come from. Measured on the corpus
 * document this was found in: `useNavigation` is a real export, and `<Header />`
 * is rendered in six places with no props at all. Dropping the argument would
 * compile and leave `navigate` undefined — a dead navigation, silent, on every
 * screen. Unwrapping it gives `let { navigate } = useNavigation()`, which is
 * what the line plainly means.
 *
 * An OBJECT LITERAL reads as defaults rather than a source, and there the safe
 * repair is the other one: keep `$props()` and let the parent supply them.
 */
export function fixSveltePropsArgument(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(/\$props\(\s*([^)]*?)\s*\)/g, (whole, arg: string) => {
    const inner = arg.trim()
    if (!inner) return whole
    if (inner.startsWith('{')) {
      fixed.push('$props() の引数（オブジェクト）を除去（ルーンは引数を取りません）')
      return '$props()'
    }
    fixed.push(`$props(${inner}) → ${inner}（ルーンは引数を取らないため、値の出所をそのまま使用）`)
    return inner
  })
  return { source: out, fixed }
}

export function fixSvelteAttributeShorthand(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []

  /*
   * Markup only. `<script>` is JavaScript, where the same shape is ordinary and
   * correct:
   *
   *     let { params = {} } = $props();
   *
   * is a destructuring pattern with a default, and rewriting it to
   * `params={}` destroys the declaration. Measured as a regression on a document
   * that had been compiling — caught by re-running every stored Svelte project
   * rather than only the one being fixed, which is the argument for doing that.
   */
  const rewrite = (markup: string): string =>
    markup.replace(
      // `{name={expr}}` and `{name="literal"}`. The name has to look like an
      // attribute, so `{#if a === b}` is not touched.
      /\{\s*([A-Za-z_:][\w:.-]*)\s*=\s*(\{[^{}]*\}|"[^"]*"|'[^']*')\s*\}/g,
      (_whole, name: string, value: string) => {
        fixed.push(name)
        return `${name}=${value}`
      }
    )

  // Split on script and style blocks, rewrite only what falls between them.
  const out = source
    .split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/i)
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part)))
    .join('')

  return {
    source: out,
    fixed: fixed.length
      ? [`属性の短縮記法に値が入っていたのを修正（{name} か name={expr} のどちらか）: ${[...new Set(fixed)].join(', ')}`]
      : [],
  }
}

export function fixSvelteNestedButton(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (let guard = 0; guard < 16; guard++) {
    const rewritten = rewriteOuterButton(out)
    if (!rewritten) break
    out = rewritten
    fixed.push('button')
  }

  return {
    source: out,
    fixed: fixed.length
      ? [`入れ子の <button> を解消（外側を div[role=button] に。HTML として不正で、Svelte はビルドを止めます）: ${fixed.length}箇所`]
      : [],
  }
}

/** One outer button that contains another, rewritten. Null when there is none. */
function rewriteOuterButton(source: string): string | null {
  const OPEN = /<button\b([^>]*)>/g
  for (const open of [...source.matchAll(OPEN)]) {
    const bodyStart = (open.index ?? 0) + open[0].length

    // The matching close, counting nested opens.
    let depth = 1
    let i = bodyStart
    let closeStart = -1
    while (i < source.length && depth > 0) {
      const nextOpen = source.indexOf('<button', i)
      const nextClose = source.indexOf('</button>', i)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++
        i = nextOpen + 7
      } else {
        depth--
        if (depth === 0) closeStart = nextClose
        i = nextClose + 9
      }
    }
    if (closeStart === -1) continue

    const inner = source.slice(bodyStart, closeStart)
    if (!/<button\b/.test(inner)) continue

    // Keep every attribute; add the two that make a div behave like a control,
    // unless the markup already carries them.
    let attrs = open[1]
    if (!/\brole=/.test(attrs)) attrs += ' role="button"'
    if (!/\btabindex=/.test(attrs)) attrs += ' tabindex="0"'
    // `disabled` means nothing on a div and would read as a stray attribute.
    attrs = attrs.replace(/\s+disabled(=(\{[^}]*\}|"[^"]*"|'[^']*'))?/g, '')

    return (
      source.slice(0, open.index) +
      `<div${attrs}>` +
      inner +
      '</div>' +
      source.slice(closeStart + '</button>'.length)
    )
  }
  return null
}

export function fixSvelteDerivedExport(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const out = new Map(files)
  const fixed: string[] = []

  for (const [path, body] of files) {
    if (!/\.svelte\.[jt]s$/.test(path)) continue

    /*
     * Two rules with one shape, which Svelte states separately.
     *
     *   export const d = $derived(x)     always refused
     *   export let  s = $state(x)        refused ONLY if s is reassigned
     *
     * The second cost a blank page at v167:
     *
     *     export let currentRoute = $state<Route>(parseHash(location.hash));
     *     …
     *     currentRoute = parseHash(location.hash);   // ← makes the export illegal
     *
     *     Cannot export state from a module if it is reassigned.
     *
     * Mutating an exported `$state` object — `appState.cart.push(x)` — stays
     * legal and must stay untouched, so the test is for reassignment of the
     * binding, not for the export.
     *
     * Neither shape can be rescued by the component stub: a module is imported
     * for the values it exports, so replacing it breaks every reader. That is
     * the right refusal, and it is why this repair has to work.
     */
    const reassigned = (name: string, after: string): boolean =>
      new RegExp(`(?:^|[^\\w$.])${name}\\s*=(?!=)`, 'm').test(after)

    const candidates = [
      ...body.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\$derived\b/g),
      ...[...body.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\$state\b/g)]
        .filter((m) => reassigned(m[1], body.slice((m.index ?? 0) + m[0].length))),
    ]

    for (const m of candidates) {
      const name = m[1]
      // Doubled escapes: inside a template literal a single \s is an unknown
      // escape and JavaScript drops it. The same slip has cost this codebase
      // four defects — see test/source-hygiene.test.mjs.
      const importsIt = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`)
      const importers = [...files.entries()].filter(([other, text]) => other !== path && importsIt.test(text))

      if (importers.length === 0) {
        // Private after all: dropping the keyword is the whole fix.
        out.set(
          path,
          (out.get(path) ?? body).replace(
            new RegExp(`export\\s+((?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\\$(?:derived|state)\\b)`),
            '$1'
          )
        )
        fixed.push(`${name}: export を削除（他ファイルから参照されていません）`)
        continue
      }

      const inner = `__makeui_${name}`
      const rewritten = (out.get(path) ?? body)
        .replace(
          new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(\\$(?:derived|state))`),
          `let ${inner} = $1`
        )
        // Reassignments inside the module follow the rename, or it goes on
        // writing to a binding that no longer exists.
        .replace(new RegExp(`(^|[^\\w$.])${name}(\\s*=(?!=))`, 'gm'), `$1${inner}$2`)
      out.set(path, `${rewritten}\n\nexport function ${name}() { return ${inner}; }\n`)

      for (const [other] of importers) {
        const text = out.get(other) ?? ''
        // Every read that is not a property access and not already a call. The
        // import statement itself is left alone — the name it binds is unchanged.
        const read = new RegExp(`(^|[^\\w$.])${name}\\b(?!\\s*\\()`, 'g')
        out.set(
          other,
          text
            .split('\n')
            .map((line) => (/^\s*import\b/.test(line) ? line : line.replace(read, `$1${name}()`)))
            .join('\n')
        )
      }
      fixed.push(`${name}: 関数化し、参照する ${importers.length} ファイルを呼び出しに変更`)
    }
  }

  return {
    files: out,
    // Names the rune rather than assuming $derived: this also handles an
    // exported $state that the module reassigns, and a log line that says the
    // wrong one sends the next reader to the wrong rule.
    fixed: fixed.length ? [`モジュールから export されたルーン状態を修正: ${fixed.join(' / ')}`] : [],
  }
}

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
  let next = entry.replace(root[0], wrapped)
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

export function fixSvelteRuneShadowing(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const renames = new Map<string, string>()
  for (const [path, body] of files) {
    if (!/\.svelte\.[jt]s$/.test(path)) continue
    for (const name of RUNE_SHADOWS) {
      // Double backslashes: inside a template literal a single \s is an unknown
      // escape and JavaScript drops it, so the pattern would compile to "exports+".
      // The same slip once made the fenced-transport detector match nothing at all.
      const exported =
        new RegExp(`export\\s+(?:const|let|var|function|class)\\s+${name}\\b`).test(body) ||
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(body)
      if (exported) renames.set(name, `app${name.charAt(0).toUpperCase()}${name.slice(1)}`)
    }
  }
  if (renames.size === 0) return { files, fixed: [] }

  const out = new Map<string, string>()
  const fixed: string[] = []
  for (const [path, body] of files) {
    let next = body
    for (const [from, to] of renames) {
      // Not after a dot (a property), not after a dollar (a rune), not a key.
      const use = new RegExp(`(?<![.$\\w])${from}(?![\\w:])`, 'g')
      const before = next
      next = next.replace(use, to)
      if (next !== before) fixed.push(`${path}: ${from} → ${to}`)
    }
    out.set(path, next)
  }
  return { files: out, fixed: [...new Set(fixed.map((f) => f.split(': ')[1]))].map((r) => `ルーン名と衝突する export を改名: ${r}`) }
}

/**
 * SvelteKit imports in a project that is not a SvelteKit project.
 *
 * Measured: `import { goto } from '$app/navigation'` inside the project's OWN
 * `src/lib/navigation.svelte.ts`. It compiles — a bare specifier is assumed to
 * be a package — and throws `Module not found: $app/navigation` at first
 * require, so the page is blank. The contract already forbids it in so many
 * words; the model reached for what it knows anyway, which is what a rewrite is
 * for rather than another sentence in a prompt.
 *
 * Only applied when the project has its own navigation to redirect to. Without
 * that, removing the import would trade a clear error for an undefined function,
 * and the build gate should decline instead.
 */
function fixSvelteKitImports(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const navModule = [...files.entries()].find(
    ([p, b]) => /navigation\.svelte\.[jt]s$/.test(p) && /export\s+function\s+navigate\b/.test(b)
  )
  const hasKitImport = [...files.values()].some((b) => /['"]\$app\/[\w/]+['"]/.test(b))
  if (!hasKitImport) return { files, fixed: [] }
  if (!navModule) return { files, fixed: [] }

  const out = new Map<string, string>()
  const fixed: string[] = []
  for (const [path, body] of files) {
    let next = body
    if (/['"]\$app\/[\w/]+['"]/.test(next)) {
      // The import statement goes entirely; `goto` becomes the project's own
      // `navigate`, which takes the same first argument.
      next = next.replace(/^\s*import\s+\{[^}]*\}\s+from\s+['"]\$app\/[\w/]+['"];?\s*$/gm, '')
      next = next.replace(/\bgoto\s*\(/g, 'navigate(')
      if (path !== navModule[0] && !/from\s+['"][^'"]*navigation/.test(next)) {
        // The file now calls navigate() and has to import it.
        const depth = path.split('/').length - 2
        const prefix = depth <= 1 ? './' : '../'.repeat(depth - 1)
        next = `import { navigate } from '${prefix}lib/navigation.svelte';
${next}`
      }
      fixed.push(`${path}: SvelteKit の $app import を除去し navigate() に置換`)
    }
    out.set(path, next)
  }
  return { files: out, fixed }
}

/**
 * Svelte 5 mounts a component with `mount()`, not with `new`.
 *
 * Measured, and it is the third distinct way a Svelte generation has arrived
 * blank. The entry file came back as
 *
 *     import App from './App.svelte';
 *     const app = new App({ target: document.getElementById('app')! });
 *
 * which is the Svelte 3/4 class API. In Svelte 5 a compiled component is a
 * function, so `new App(...)` throws
 *
 *     TypeError: Cannot read properties of undefined (reading 'call')
 *
 * from inside the runtime, with nothing failing at compile time and nothing in
 * the project looking wrong. The contract already asks for `mount(App, {…})`;
 * this is the rewrite for when the model reaches for what it knows instead.
 *
 * `mount()` takes the same options object, so the arguments move across
 * unchanged — only the call shape and the import differ.
 */
export function fixSvelteLegacyMount(source: string): { source: string; fixed: string[] } {
  // Default imports from a component file: those are the only things that can
  // legitimately be mounted, and the only ones this may rewrite.
  const components = new Set<string>()
  for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+\.svelte['"]/g)) {
    components.add(m[1])
  }
  if (components.size === 0) return { source, fixed: [] }

  const fixed: string[] = []
  let out = source
  for (const name of components) {
    const call = new RegExp(`new\\s+${name}\\s*\\(`, 'g')
    if (!call.test(out)) continue
    out = out.replace(new RegExp(`new\\s+${name}\\s*\\(`, 'g'), `mount(${name}, `)
    fixed.push(`new ${name}(…) → mount(${name}, …)`)
  }
  if (fixed.length === 0) return { source, fixed: [] }

  if (!/import\s*\{[^}]*\bmount\b[^}]*\}\s*from\s*['"]svelte['"]/.test(out)) {
    out = `import { mount } from 'svelte';\n${out}`
  }
  return { source: out, fixed: [`Svelte 5 のマウント形式に修正: ${fixed.join(', ')}`] }
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
  if (kind === 'svelte') {
    // `$props()` is called and discarded so a parent passing props is not an
    // error, and so the component reads as deliberate rather than truncated.
    return `<script lang="ts">\n  const _props = $props();\n</script>\n\n<div style="${style}">${note}</div>\n`
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

    const named = /(src\/[\w./-]+\.(?:svelte|vue))/.exec(error)?.[1]
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
 * A rune store the rest of the project subscribes to.
 *
 *     // src/lib/store.svelte.ts
 *     function createStore() {
 *       let state = $state<AppState>(initialState);
 *       return {
 *         get currentState() { return state; },
 *         addExpense(e) { state.expenses = [e, ...state.expenses]; },
 *       };
 *     }
 *     export const appState = createStore();
 *
 *     // five screens, all of them
 *     appState.subscribe((s) => { … });
 *
 * Measured at v171. The producer is written in the rune idiom and every consumer
 * in the store idiom, and each half is idiomatic on its own — the module is a
 * textbook Svelte 5 rune store, and `subscribe` is how the rest of Svelte has
 * always read shared state. They just never meet, so the page is blank with
 * `appState.subscribe is not a function`.
 *
 * The two idioms are bridgeable and Svelte 5 supplies the exact piece: an
 * `$effect` re-runs when the state it read changes, and `$effect.root` returns
 * its own teardown — which is the unsubscribe contract, handed back by the
 * function that has to return it. So the object gains a real `subscribe` rather
 * than a snapshot: consumers get the value now AND on every later change, which
 * is what they were written expecting.
 *
 * A snapshot would have been three lines and would have rendered — once. Every
 * button in the app would then have looked dead, which is the worse failure:
 * a blank page is at least obviously broken.
 *
 * Only when the consumers say so. A rune module nobody subscribes to is correct
 * as written and is left alone — adding a subscribe there would be inventing an
 * API for a project that never asked for one.
 */
export function fixSvelteRuneStoreSubscribe(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const fixed: string[] = []
  const out = new Map(files)
  const RUNE = /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\$state\b/
  const SUBSCRIBE = /\bsubscribe\s*[(:]/

  for (const [path, body] of files) {
    if (!/\.svelte\.(ts|js)$/.test(path)) continue
    if (!/\$state\b/.test(body)) continue

    const exported = [...body.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\)/g)]

    for (const [, name, factory] of exported) {
      const consumers = [...files].filter(
        ([p, b]) => p !== path && new RegExp(`\\b${name}\\s*\\.\\s*subscribe\\s*\\(`).test(b)
      )
      if (consumers.length === 0) continue

      // Read from what the file holds now — an earlier export in the same
      // module may already have shifted every offset in it.
      const src = out.get(path) ?? body
      const fnAt = src.search(new RegExp(`function\\s+${factory}\\s*\\(`))
      if (fnAt < 0) continue

      const tail = src.slice(fnAt)
      const stateName = RUNE.exec(tail)?.[1]
      if (!stateName) continue

      const returnAt = tail.search(/return\s*\{/)
      if (returnAt < 0) continue
      // Already a store — nothing to bridge.
      if (SUBSCRIBE.test(tail.slice(returnAt, returnAt + 2000))) continue

      const insertAt = fnAt + returnAt + tail.slice(returnAt).indexOf('{') + 1
      const method = [
        '',
        '    subscribe(run) {',
        // Synchronously first. A store's subscribe hands over the current
        // value before it returns — consumers assign it and clear their own
        // loading flag on that call — while `$effect` is scheduled, not
        // immediate. With only the effect, the first screen rendered its
        // 「読み込み中...」 placeholder and stayed there: no error, no content.
        `      run(${stateName});`,
        '      return $effect.root(() => {',
        `        $effect(() => { run(${stateName}); });`,
        '      });',
        '    },',
      ].join('\n')

      out.set(path, src.slice(0, insertAt) + method + src.slice(insertAt))
      fixed.push(
        `${path} の ${name} に subscribe を追加（ルーン製のストアを .subscribe() で読む利用側が ${consumers.length} ファイル）`
      )
    }
  }

  return { files: out, fixed }
}

/**
 * An array sorted where it stands, on the way to being rendered.
 *
 *     function getFilteredExpenses() {
 *       let filtered = state.expenses;          // the $state proxy itself
 *       if (filter) filtered = filtered.filter(…);
 *       filtered.sort((a, b) => …);             // sorts state, in place
 *       return filtered;
 *     }
 *
 *     {#if getFilteredExpenses().length === 0}  ← called from the template
 *
 * `sort` mutates. When the filter is empty, `filtered` is still the very array
 * the rune holds, so the sort writes to state — from inside a template
 * expression, which Svelte 5 stops outright:
 *
 *     https://svelte.dev/e/state_unsafe_mutation
 *
 * Measured at v171, and it had been sitting there unreached: the screen's store
 * was broken, `state` stayed null, and the function returned `[]` from its guard
 * before it ever got to the sort. Fixing the store is what surfaced this —
 * the second defect was always the one that would blank the screen.
 *
 * The rewrite is the copy the code should have taken:
 *
 *     filtered = [...filtered].sort((a, b) => …);
 *
 * Only a bare `x.sort(…);` statement, whose result is thrown away — that is the
 * form that exists purely for the mutation, and copying it is what the author
 * meant. A `return x.sort(…)` or `const y = x.sort(…)` is left alone: the value
 * is being used, and changing those would be rewriting working code on
 * suspicion. And only when `x` is a `let`, since the rewrite assigns to it.
 */
export function fixSvelteInPlaceSort(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []

  // (1) The statement form, whose result is thrown away — it exists purely for
  // the mutation, so the copy has to be assigned back.
  let out = source.replace(
    /^([ \t]*)([A-Za-z_$][\w$]*)\.sort\(/gm,
    (whole, indent: string, name: string, at: number) => {
      if (!new RegExp(`\\blet\\s+${name}\\b`).test(source)) return whole
      const before = source.slice(0, at).replace(/\s+$/, '')
      if (before !== '' && !/[;{}]$/.test(before)) return whole
      fixed.push(name)
      return `${indent}${name} = [...${name}].sort(`
    }
  )

  /*
   * (2) The chained form, whose result IS used:
   *
   *     return appState.expenses
   *       .sort((a, b) => …)
   *       .slice(0, 5)
   *
   * Reads as a query and is a mutation — `sort` reorders the array it is given,
   * and that array is the rune's own. Called from a $derived, which is where
   * Svelte stops it: https://svelte.dev/e/state_unsafe_mutation. Measured at
   * v180, and it had been hiding behind an effect_orphan that threw first.
   *
   * Only a plain member chain. A receiver that ends in a call — `.filter(…)`,
   * `.slice()` — is already a fresh array, and copying it again would be noise
   * rather than a repair.
   */
  out = out.replace(
    /(^|[^\w$.\]])((?:[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)+)(\s*)\.sort\(/gm,
    (whole, before: string, chain: string, gap: string) => {
      if (/=\s*$/.test(before)) return whole
      fixed.push(chain)
      return `${before}[...${chain}]${gap}.sort(`
    }
  )

  return {
    source: out,
    fixed: fixed.length
      ? [
          `配列を書き換える sort をコピーに変更（$state を描画中に破壊すると state_unsafe_mutation になります）: ${[
            ...new Set(fixed),
          ]
            .slice(0, 5)
            .join(', ')}`,
        ]
      : [],
  }
}

/**
 * A rune value called as though it were a function.
 *
 *     const recentApplications = $derived.by(() => { … });
 *
 *     {#each recentApplications() as app}
 *
 * `$derived` produces a value, not a getter, so the markup calls the array —
 * `$.get(recentApplications)()` in the compiled output — and the page throws
 * `TypeError: $.get(...) is not a function`.
 *
 * Measured at v172. The mistake is easy to see how it happens: the accessor
 * shape (`route()`, `appState()`) is everywhere in Svelte 5 code because it is
 * how you export rune state across a module boundary, and inside the file that
 * declares it the rune needs no call at all. Both forms are correct Svelte, one
 * line apart, and only one is correct here.
 *
 * Only an empty call on a name this same file declares as a rune. Arguments
 * mean it was never this rune being called — a shadowed helper, an import of
 * the same name — and dropping them would change what the code does rather
 * than repair it.
 */
export function fixSvelteRuneCalledAsFunction(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (const m of source.matchAll(
    /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\$(?:state|derived)\b/g
  )) {
    const name = m[1]
    const call = new RegExp(`(^|[^\\w$.])${name}\\s*\\(\\s*\\)(\\s*)`, 'g')
    let hit = false
    out = out.replace(call, (whole, before: string, after: string, at: number) => {
      // `function appState() {` and the method shorthand `appState() {` are
      // declarations, not calls. Stripping their parens produces
      // `function appState {`, which does not parse — measured as six corpus
      // documents failing where four had before.
      const preceding = out.slice(Math.max(0, at - 12), at + before.length)
      if (/\b(?:function|get|set)\s*$/.test(preceding)) return whole
      if (after.startsWith('{')) return whole
      hit = true
      return `${before}${name}${after}`
    })
    if (hit) fixed.push(name)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [
          `ルーンの値を関数として呼んでいたため () を削除（$derived / $state は値です）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
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
    return [...files.keys()].find((k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue|svelte)$/, '') === base)
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
 * A class directive whose name was written as an expression.
 *
 *     <div class="toast"
 *          class:{'toast--success'}={appState.toast.type === 'success'}
 *          class:{'toast--error'}={appState.toast.type === 'error'}>
 *
 *     src/App.svelte: Expected token =
 *
 * `class:` takes a literal name — `class:toast--success={cond}` — and the parser
 * wants the `=` straight after it. Wrapping the name in braces is how you would
 * write a dynamic key everywhere else in the language, which is presumably why
 * it gets written here; it is a parse error, so the file never compiles and the
 * whole project goes with it.
 *
 * Measured at v177. The quoted name is already a literal, so unwrapping it is
 * not a guess — it is the same directive with the braces removed.
 *
 * Only when the quoted string is a usable class-directive name. A name with a
 * space in it is two classes and cannot be one directive, and interpolation
 * means it really is dynamic; both are left for the repair pass, which can
 * rewrite them as a `class={...}` expression.
 */
export function fixSvelteClassDirectiveExpression(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(
    /class:\{\s*(['"])([^'"]+)\1\s*\}\s*=/g,
    (whole, _q: string, name: string) => {
      if (!/^[A-Za-z_-][\w-]*$/.test(name)) return whole
      fixed.push(name)
      return `class:${name}=`
    }
  )
  return {
    source: out,
    fixed: fixed.length
      ? [
          `class: ディレクティブ名の {} を削除（名前はリテラルで書きます。式にすると Expected token = になります）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

/**
 * A Svelte 4 reactive statement in a runes file.
 *
 *     $: filteredExpenses = getFilteredExpenses();
 *
 *     src/screens/DetailScreen.svelte: `$:` is not allowed in runes mode,
 *     use `$derived` or `$effect` instead
 *
 * The moment any rune appears in a component, the whole file is in runes mode
 * and the old reactive label is a compile error — so one leftover line takes the
 * project down. Measured at v177, three of them across two screens in a project
 * that was otherwise written in runes throughout.
 *
 * Only the assignment form, and only when the name belongs to this statement
 * alone: nothing else declares it and nothing else assigns to it. That is the
 * case where `$: x = expr` and `const x = $derived(expr)` mean the same thing.
 *
 * A bare `$: doSomething()` or a `$: { … }` block is an effect, not a value, and
 * turning one into `$effect` changes WHEN it runs relative to the rest of the
 * component. Those are left for the repair pass, which can read the intent.
 */
export function fixSvelteReactiveStatement(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(
    /^([ \t]*)\$:\s*([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+);?[ \t]*$/gm,
    (whole, indent: string, name: string, expr: string) => {
      // Declared elsewhere, so this is a reassignment and `const` would not do.
      if (new RegExp(`(?:let|const|var)\\s+${name}\\b`).test(source)) return whole
      // Assigned elsewhere, same reason.
      const others = [...source.matchAll(new RegExp(`(?:^|[^\\w$.])${name}\\s*=(?!=)`, 'gm'))]
      if (others.length > 1) return whole
      fixed.push(name)
      return `${indent}const ${name} = $derived(${expr.trim()});`
    }
  )

  /*
   * And the block form, which is a side effect rather than a value.
   *
   *     $: {
   *       document.title = formatPageTitle();
   *     }
   *
   * `$derived` is wrong here — there is nothing to derive — so it becomes
   * `$effect`, which is what a Svelte 4 reactive block always meant.
   *
   * Measured at v203, in App.svelte, behind a duplicate `<script>` that had to
   * be merged before anything could see it. Across the whole corpus these are
   * the only two forms that have ever appeared: three assignments and this one
   * block. No `$: if`, no bare statement — so the narrow pair is the complete
   * set rather than a first instalment.
   */
  let withBlocks = out
  for (let guard = 0; guard < 8; guard++) {
    const at = /^([ \t]*)\$:\s*\{/m.exec(withBlocks)
    if (!at) break
    const open = withBlocks.indexOf('{', at.index)
    let depth = 0
    let close = -1
    for (let i = open; i < withBlocks.length; i++) {
      if (withBlocks[i] === '{') depth++
      else if (withBlocks[i] === '}') {
        depth--
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) break
    const indent = at[1]
    const inner = withBlocks.slice(open + 1, close).replace(/\s+$/, '')
    withBlocks =
      withBlocks.slice(0, at.index) +
      `${indent}$effect(() => {${inner}\n${indent}});` +
      withBlocks.slice(close + 1)
    fixed.push('$: { … }')
  }
  return {
    source: withBlocks,
    fixed: fixed.length
      ? [
          `$: の反応文を $derived / $effect に変換（ルーンを使うファイルでは $: はコンパイルエラーになります）: ${[
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
 * An imported value re-declared as a rune, in the same file.
 *
 *     import { setCategory, addToCart, appState } from '../lib/store.svelte';
 *     …
 *     const appState = $derived(appState());
 *
 *     Identifier 'appState' has already been declared
 *
 * A Svelte 4 habit with no Svelte 5 meaning. In runes mode a `$state` exported
 * from a `.svelte.ts` module is already reactive at every import site, so there
 * is nothing to wrap — and the wrapper collides with the import it wraps, which
 * is fatal for the whole component.
 *
 * `fixSvelteRuneCalledAsFunction` reaches this line first and turns
 * `$derived(appState())` into `$derived(appState)`, which is correct about the
 * call and leaves the declaration both duplicated and self-referential. So both
 * spellings are matched here and the order of the two repairs does not matter.
 *
 * Only when the initializer's sole reference is the name being declared. A
 * `const total = $derived(cart.items.length)` shadowing an imported `total` is a
 * different mistake with a different answer, and deleting it would silently drop
 * a computation.
 *
 * Measured on the corpus: two components in one project, both screens of it,
 * neither rendering.
 */
export function fixSvelteRedeclaredImport(source: string): { source: string; fixed: string[] } {
  const imported = new Set<string>()
  for (const m of source.matchAll(/import\s*{([^}]*)}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) imported.add(name)
    }
  }
  if (imported.size === 0) return { source, fixed: [] }

  const fixed: string[] = []
  let out = source
  for (const name of imported) {
    // `$derived(name)`, `$derived(name())`, `$state(name)` — the whole statement,
    // including its own line, so no blank declaration is left behind.
    const re = new RegExp(
      `^[ \\t]*(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*` +
        `\\$(?:derived|state)(?:\\.by)?\\s*\\(\\s*${name}\\s*(?:\\(\\))?\\s*\\)\\s*;?[ \\t]*\\n?`,
      'm'
    )
    if (!re.test(out)) continue
    out = out.replace(re, '')
    fixed.push(name)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [
          `import した値を同じ名前でルーンに包み直していた宣言を削除（Identifier has already been declared）: ${fixed.join(', ')}`,
        ]
      : [],
  }
}

export function fixSvelteRuneShadowLocal(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (const name of RUNE_SHADOWS) {
    if (!new RegExp(`\\$${name}\\s*[(<]`).test(out)) continue
    const declared = new RegExp(`(?<!export\\s)(?:const|let|var)\\s+${name}\\b\\s*(?::[^=]+)?=`).test(out)
    if (!declared) continue
    // A prop of that name is the parent's word, not ours to change.
    if (new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*\\$props\\s*\\(`).test(out)) continue

    /*
     * The new name has to be free in this file. `app${Name}` is the same shape
     * the exported-rename uses, and on the run this was written for the module
     * ALREADY had an `appState` — renaming into it produced two bindings of one
     * name and a file that no longer parsed. Measured: the fix broke what it
     * was repairing.
     */
    const taken = (n: string) => new RegExp(`(?<![.$\\w])${n}(?![\\w:])`).test(out)
    const capital = `${name.charAt(0).toUpperCase()}${name.slice(1)}`
    const to = [`app${capital}`, `local${capital}`, `${name}Value`, `${name}Ref`].find((n) => !taken(n))
    if (!to) continue

    out = out.replace(new RegExp(`(?<![.$\\w])${name}(?![\\w:])`, 'g'), to)
    fixed.push(`${name} → ${to}`)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [
          `ルーン名を覆い隠すローカル変数を改名（$state などがストア購読として解釈され e.subscribe is not a function になります）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

export function fixSvelteRuneInObjectLiteral(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  let out = source

  for (let guard = 0; guard < 8; guard++) {
    // The capture ends ON the rune's own opening paren, which is the one to
    // balance from. Searching backwards for it instead found the `(` of the
    // `()` in `() =>` and closed the expression in the wrong place, leaving
    // `return ;` and the arrow body stranded outside the object.
    const m = /(^[ \t]*)([A-Za-z_$][\w$]*)\s*:\s*\$derived(?:\.by)?\s*\(/m.exec(out)
    if (!m) break
    const indent = m[1]
    const name = m[2]
    const openParen = m.index + m[0].length - 1

    let depth = 0
    let end = -1
    for (let i = openParen; i < out.length; i++) {
      if (out[i] === '(') depth++
      else if (out[i] === ')') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) break

    let inner = out.slice(openParen + 1, end).trim()
    inner = inner.replace(/^\(\s*\)\s*=>\s*/, '')

    let body: string
    if (inner.startsWith('{') && inner.endsWith('}')) {
      body = inner.slice(1, -1).replace(/^\r?\n/, '').replace(/\s+$/, '')
    } else {
      body = `${indent}  return ${inner};`
    }

    let after = end + 1
    if (out[after] === ',') after++

    out = `${out.slice(0, m.index)}${indent}get ${name}() {\n${body}\n${indent}},${out.slice(after)}`
    fixed.push(name)
  }

  return {
    source: out,
    fixed: fixed.length
      ? [
          `オブジェクトのプロパティに置かれたルーンを getter に変換（ルーンは宣言の初期化子であって値ではありません）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

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
 * Apply an edit to the `{ … }` expressions of a piece of markup, and to nothing
 * else.
 *
 * Svelte's markup is two languages sharing a file: everything inside braces is
 * an expression, everything outside is text the page shows. A repair that reads
 * one as the other edits what the user sees — `<p>(known as HTML)</p>` is prose,
 * and a pattern looking for a type cast finds a cast in it.
 *
 * Braces are counted rather than matched by pattern, because an event handler is
 * full of them, and quoted strings are stepped over on both levels: `{'{'}` is a
 * legal expression and would otherwise end the span at the wrong place.
 */
function editMarkupExpressions(markup: string, edit: (expr: string) => string): string {
  let out = ''
  let i = 0
  while (i < markup.length) {
    if (markup[i] !== '{') {
      out += markup[i++]
      continue
    }
    const start = i
    let depth = 0
    let quote = ''
    for (; i < markup.length; i++) {
      const c = markup[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { i++; break }
      }
    }
    // An unbalanced brace is not an expression; leave the rest of the file alone.
    if (depth !== 0) return out + markup.slice(start)
    const span = markup.slice(start, i)
    /*
     * A block tag is Svelte syntax, not an expression.
     *
     * `{#each rows as row (row.id)}` carries the keyword `as` as part of the
     * language, and the first version of the cast repair below stripped it —
     * turning three corpus projects that compiled into three that did not,
     * with `An {#each ...} block without an as clause cannot have a key`. The
     * repair broke what it was repairing, which is the failure this file has
     * the most history with.
     *
     * `{@const}` / `{@html}` / `{@render}` are expression tags and stay in.
     */
    if (/^[{][ ]*[#:/]/.test(span)) {
      out += span
      continue
    }
    out += edit(span)
  }
  return out
}

/**
 * Run a replacement over an expression without reaching inside its strings.
 *
 * `{`known as ${x}`}` contains the word this is looking for, in the one place it
 * must not touch.
 */
function outsideStrings(expr: string, apply: (chunk: string) => string): string {
  const parts: string[] = []
  let out = ''
  let buf = ''
  let quote = ''
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (quote) {
      buf += c
      if (c === '\\') { buf += expr[++i] ?? '' }
      else if (c === quote) { parts.push(buf); out += `\u0000STR${parts.length - 1}\u0000STR`; buf = ''; quote = '' }
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; buf = c; continue }
    out += c
  }
  out += buf
  return apply(out).replace(/\u0000STR(\d+)\u0000STR/g, (_m, n: string) => parts[Number(n)])
}

export function fixSvelteMarkupTypeAssertion(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []

  // Markup is what is left once the blocks are set aside; their contents are
  // JavaScript and CSS and this must not reach into them.
  const blocks: string[] = []
  const masked = source.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, (m) => {
    blocks.push(m)
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })

  let out = masked.replace(/([A-Za-z_$\w\]\)])!(?=\s*[),\]};])/g, (whole, before: string) => {
    fixed.push(whole)
    return before
  })


  /*
   * `(e.target as HTMLInputElement).value`
   *
   * The same boundary, the other TypeScript form, and the one that lasts
   * longer: a `!` is one character someone might notice, while a cast reads
   * like careful code. Measured on the corpus — two of the four Svelte
   * projects still failing after every other repair, in different files, both
   * inside an `onchange`.
   *
   * Only inside `{ … }`, because outside one ` as ` is an ordinary English
   * word and the pattern would edit the page's own text, and only outside
   * strings for the same reason one level down. `as const` goes with them: it
   * is equally illegal here and equally meaningless.
   */
  const casts: string[] = []
  out = editMarkupExpressions(out, (expr) =>
    outsideStrings(expr, (chunk) =>
      chunk.replace(
        /\s+as\s+(?:const|[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])*)/g,
        (m) => {
          casts.push(m.trim())
          return ''
        }
      )
    )
  )

  const report: string[] = []
  if (fixed.length) {
    report.push(
      `マークアップ式から TypeScript の非nullアサーション(!)を削除（マークアップは型を剥がされないため構文エラーになります）: ${[
        ...new Set(fixed),
      ]
        .slice(0, 5)
        .join(', ')}`
    )
  }
  if (casts.length) {
    report.push(
      `マークアップ式から TypeScript の型アサーション(as)を削除（同上。! より長く生き残ります）: ${[
        ...new Set(casts),
      ]
        .slice(0, 5)
        .join(', ')}`
    )
  }

  return {
    source: out.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]),
    fixed: report,
  }
}

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

  const fixedBody = body.replace(call[3], `const props = ${call[3]}`)
  return {
    source: source.replace(open + body + close, open + fixedBody + close),
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
 * An effect at the top level of a module.
 *
 *     // src/lib/navigation.svelte.ts
 *     $effect(() => {
 *       window.addEventListener('hashchange', handleHashChange)
 *       return () => window.removeEventListener('hashchange', handleHashChange)
 *     })
 *
 *     https://svelte.dev/e/effect_orphan
 *
 * `$effect` needs an owner — a component, or an explicit root — and a module has
 * neither. It throws while the module is being required, which is before any
 * component renders, so the whole app is blank rather than one screen.
 *
 * Wrapping it in `$effect.root` was the obvious repair and it does not work:
 * the body calls its own handler synchronously to set the initial route, so
 * the effect writes state during its own run and Svelte stops it with
 * `state_unsafe_mutation` instead. Measured — the fix moved the failure
 * rather than removing it.
 *
 * At module scope this body is initialisation, not reaction: register a
 * listener, set the starting value. So it is lifted out of the effect and
 * runs when the module loads, which is what it was always doing.
 *
 * Measured at v180, in a router that registered its own hashchange listener.
 *
 * Only at depth zero. An effect inside a function is already owned by whatever
 * calls it, and wrapping that would change when it runs.
 */
export function fixSvelteOrphanEffect(source: string): { source: string; fixed: string[] } {
  let out = source
  let count = 0

  for (let guard = 0; guard < 8; guard++) {
    // Depth-zero occurrences only, and never $effect.root / $effect.pre.
    let depth = 0
    let at = -1
    for (let i = 0; i < out.length; i++) {
      const ch = out[i]
      if (ch === '{' || ch === '(' || ch === '[') depth++
      else if (ch === '}' || ch === ')' || ch === ']') depth--
      else if (depth === 0 && ch === '$' && out.startsWith('$effect', i)) {
        if (/^\s*\(\s*\(\s*\)\s*=>\s*\{/.test(out.slice(i + 7))) { at = i; break }
      }
    }
    if (at < 0) break

    const open = out.indexOf('(', at)
    let d = 0
    let end = -1
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') d++
      else if (out[i] === ')') {
        d--
        if (d === 0) { end = i; break }
      }
    }
    if (end < 0) break

    // The arrow's own braces, so the body can be lifted out of them.
    const bodyOpen = out.indexOf('{', open)
    if (bodyOpen < 0 || bodyOpen > end) break
    let bd = 0
    let bodyClose = -1
    for (let i = bodyOpen; i < end; i++) {
      if (out[i] === '{') bd++
      else if (out[i] === '}') {
        bd--
        if (bd === 0) { bodyClose = i; break }
      }
    }
    if (bodyClose < 0) break

    let body = out.slice(bodyOpen + 1, bodyClose)
    /*
     * The teardown an effect returns has no owner once the effect is gone, and
     * a bare `return` at module scope is a syntax error. The listener is meant
     * to live as long as the module anyway.
     */
    body = body.replace(/\n\s*return\s*\(\s*\)\s*=>\s*\{[\s\S]*?\n\s*\}\s*;?/g, '')
    body = body.replace(/\n\s*return\s+[^\n;]+;?/g, '')
    body = body.replace(/^\n+/, '').replace(/\s+$/, '')
    // One level of indentation comes off with the arrow that held it.
    body = body.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n')

    let stop = end + 1
    if (out[stop] === ';') stop++
    out = `${out.slice(0, at)}${body}\n${out.slice(stop)}`
    count++
  }

  return {
    source: out,
    fixed: count
      ? [`モジュール直下の $effect を展開（所有者がないと effect_orphan で読み込み時に落ちます）: ${count}件`]
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
 * Only names the type literal actually declares, only in the script block, and
 * only where nothing local already binds the name — a shadowing declaration
 * means the reference resolves and this is not the defect.
 */
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

  // The names it declares, from either the type literal or the object argument.
  const declared = new Set<string>()
  const shape = call[3] ?? call[4] ?? ''
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
  let next = body.replace(call[0], `${call[1]}${call[2]}const ${holder} = defineProps${call[3] ?? ''}(${call[4]});\n`)

  for (const name of used) {
    next = next.replace(new RegExp(`(?<![\\w$'"])(?<!(?<!\\.)\\.)${name}(?![\\w$:])`, 'g'), `${holder}.${name}`)
  }
  // The declaration line must not have been rewritten along with the uses.
  next = next.replace(new RegExp(`const ${holder}\\.[\\w$]+ = defineProps`), `const ${holder} = defineProps`)

  return {
    source: source.replace(whole, `${open}${next}${close}`),
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
      (k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue|svelte)$/, '') === base
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
      next = next.replace(whole, `import ${clause} from ${quote}${spec}${quote};`)
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
