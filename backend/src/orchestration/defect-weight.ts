/**
 * How much a finding counts when two documents are compared.
 *
 * The repair judge compared how MANY findings each document had, and a count
 * treats an unreachable screen and an emoji as the same size. Measured on the
 * live generation of 2026-09-13 (an inventory app): a pass took two screens from
 * 18% of the viewport to 100%, made both reachable and put the navigation the
 * shell had been missing on screen — and in the same rewrite added one emoji and
 * a low-contrast label. Three findings before, three after; rejected as "no
 * improvement", and the half-empty version shipped at 56.
 *
 * A finding here is weighted by what it does to someone using the app. The
 * heavy ones are the app not being usable: a screen that renders nothing or
 * next to nothing, a screen or control that cannot be reached or does nothing,
 * code that throws or cannot load. Everything else — a colour, a glyph, a
 * missing icon, a density complaint — is real and counted, and one of them does
 * not outweigh a screen nobody can open.
 *
 * The weight is 3, not larger: three cosmetic regressions still cancel one
 * functional fix, so a pass cannot trade a working screen for a stream of small
 * damage and be accepted for it. The breaking regressions (`render-lost`,
 * `unreachable-introduced`, `console-error-introduced`) are not weighted here at
 * all — the judge rejects on them outright, before any count.
 */
export const SEVERE_WEIGHT = 3

const SEVERE = new Set([
  // Nothing, or almost nothing, on screen.
  'blank-render',
  'layout-broken',
  'screen-thin',
  'screen-hidden',
  'screen-thinned',
  'empty-container',
  'route-unrendered',
  'app-fallback',
  // Cannot be reached, or does nothing when used.
  'screen-unreachable',
  'shell-without-nav',
  'routes-missing',
  'nav-dead-runtime',
  'action-dead-runtime',
  'action-throws',
  'form-inert',
  // Throws, or cannot load.
  'console-error',
  'syntax-error',
  'import-missing',
  'export-missing',
  'component-unresolved',
  'conditional-hook',
])

export function defectWeight(id: string): number {
  return SEVERE.has(id) ? SEVERE_WEIGHT : 1
}

export function weightedCount(defects: readonly { id: string }[]): number {
  return defects.reduce((sum, d) => sum + defectWeight(d.id), 0)
}
