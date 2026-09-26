/**
 * Navigation called while a component renders, moved to after the render.
 *
 * Found on a user's 在庫管理 run of 2026-09-20, where clicking ANY item row froze
 * the preview outright. The detail screen guarded itself the way generated
 * screens often do —
 *
 *     if (!selectedItemId) {
 *       onNavigateItems();
 *       return null;
 *     }
 *
 * — and read `selectedItemId` from the top of the store while the reducer wrote
 * it under `state.ui`, so the guard was true on every visit. `navigate()` sets
 * the router's state while a CHILD renders; the router renders again before the
 * hash has changed, so the child renders again, and calls navigate again. The
 * page never returns to the event loop: not the reviewer's clicks, not the
 * browser walk, not even a timer the walk sets for itself can run.
 *
 * Measured over the 75 stored React documents: 3 (4%) navigate during render.
 * In two of them the guard is only true when a screen is opened directly — an
 * empty cart at #/confirm, no session at #/study — so they freeze on a reload
 * rather than on a click. It is a latent freeze in every one of them.
 *
 * THE REWRITE is the smallest one that breaks the loop: the call moves into a
 * `setTimeout(…, 0)`, so it runs after React has finished the render and the
 * guard still returns null in the meantime. Nothing else in the component
 * changes. A `useEffect` would be the idiomatic answer and is deliberately not
 * what this writes: the guard is often the SECOND early return in a component
 * (the detail screen had two in a row), and a hook inserted after an early
 * return is a hook called conditionally — which React rejects at run time.
 * Deferring by a tick is correct wherever the pattern appears, including inside
 * a handler, where it changes nothing a user could notice.
 *
 * It does not fix what made the guard true; it makes that a bug the page can
 * survive — clicking the row now bounces back to the list instead of locking
 * the tab — and so one the walk can reach, measure and hand to the repair loop.
 */

/**
 * What a navigation call looks like, and only that.
 *
 * Tight on purpose. `push` alone is an array, `go…` is `goods()`; a bare
 * identifier or a router's own method, nothing reached through an arbitrary
 * object.
 */
const NAV_CALL =
  /^(?:navigate|onNavigate\w*|goTo\w*|goBack|redirect\w*|setScreen|setRoute|setPage|setView|router\.(?:push|replace)|history\.(?:push|replace))\s*\(/

/**
 * `if (COND) { NAV(...); return null; }` — one call, then the empty render.
 *
 * The condition is bounded so a regex cannot run across half a file; the body
 * is exactly one statement and the return.
 */
const GUARD = /(if\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*\{\s*)([^;{}]+?\([^;{}]*\)\s*;)(\s*return\s+null\s*;?\s*\})/g
// The condition balances parentheses three deep — `!items.some((i) => i.ok)` —
// with alternatives that cannot both match one character, so it cannot
// backtrack its way across a file.

interface RenderNavigation {
  /** The call as written, for the report. */
  call: string
}

/** The guards in one file that navigate during render, rewritten. */
export function deferRenderNavigation(source: string): { source: string; found: RenderNavigation[] } {
  const found: RenderNavigation[] = []
  const next = source.replace(GUARD, (whole, head: string, call: string, tail: string, at: number) => {
    const statement = call.trim().replace(/;$/, '')
    if (!NAV_CALL.test(statement)) return whole
    // Already deferred, or already inside an effect: correct code is left alone.
    if (/^setTimeout\s*\(/.test(statement)) return whole
    const before = source.slice(Math.max(0, at - 300), at)
    if (/use(?:Layout)?Effect\(\s*\(\)\s*=>\s*\{[^{}]*$/.test(before)) return whole
    found.push({ call: statement })
    return `${head}setTimeout(() => ${statement}, 0);${tail}`
  })
  return { source: found.length > 0 ? next : source, found }
}

/** Every React source file, rewritten where it navigates during render. */
export function fixRenderNavigation(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const out = new Map(files)
  const touched: string[] = []
  let total = 0
  for (const [path, body] of files) {
    if (!/\.(tsx|jsx)$/.test(path)) continue
    const r = deferRenderNavigation(body)
    if (r.found.length === 0) continue
    out.set(path, r.source)
    touched.push(path)
    total += r.found.length
  }
  if (total === 0) return { files, fixed: [] }
  return {
    files: out,
    fixed: [
      `描画中に画面遷移していた箇所${total}件を描画後に遅らせました（${touched.join('、')}）` +
        '。描画中の遷移は画面を再描画させ続け、ページ全体が応答しなくなります',
    ],
  }
}
