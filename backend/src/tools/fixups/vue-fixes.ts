/**
 * Deterministic repairs for Vue single-file components: a second defineProps,
 * an event handler left unclosed, props declared but never bound or captured,
 * and a router that watches location.hash, which Vue cannot watch.
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

