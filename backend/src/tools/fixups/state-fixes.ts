/**
 * Deterministic repairs for screens that render but lose their data: a store
 * used without its provider, a detail screen never given its id, and a path
 * passed where a screen id was expected.
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

