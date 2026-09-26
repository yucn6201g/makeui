import { paletteOf, type Palette } from './utility-css.js'

/**
 * CSS for a navigation that shipped in browser bullets.
 *
 * Measured 2026-09-20 over 102 stored documents: 30 carry a list inside
 * `<nav>`, and **17 of those 30 (57%) render as a bulleted list** — the
 * browser's default, with a dot beside every item and no spacing, padding,
 * hover or current-page state. Reported as 「ナビゲーションが箇条書きのまま表示され
 * ている…見栄えがかなり悪い」.
 *
 * Two shapes, and neither can be reached by any rule the project wrote:
 *
 *   12 documents   <nav className="app-nav"><ul><li><button>…   no class on the
 *                  list, the item or the control at all
 *    5 documents   <ul className="app-nav-list">                a class no
 *                  stylesheet defines
 *
 * The runtime audit has reported this as `nav-unstyled` since the browser walk
 * could see it, and its own note says what the cause is — 「every one used nav
 * classes that no stylesheet defines」. A model is then asked to write them. It
 * is still 57%, so the rules are written here instead.
 *
 * ## Written from the element, not from the class
 *
 * The list usually has no class to hang a rule on, so the selectors descend
 * from whatever the NAV has — `.app-nav ul`, `.app-nav a` — and from the bare
 * element when even that is missing. That is what makes this work for both
 * shapes with one generator, and it is also why it is safe: a rule under
 * `.app-nav` cannot reach anything that is not in the navigation.
 *
 * ## The values are the project's
 *
 * Colour, radius and the current-page state read this project's own tokens
 * through the same `paletteOf` the utility CSS uses, so the navigation looks
 * like the rest of the product rather than like a default. Spacing is literal,
 * for the reason stated there: it is a measurement, not a design decision.
 */

/** A navigation found in the markup, and what it has to hang rules on. */
export interface NavRoot {
  /** The file it is in — for the report, not for the CSS. */
  path: string
  /** The nav's own first class, or null when it has none. */
  className: string | null
  /** `ul` or `ol`. */
  tag: 'ul' | 'ol'
  /** Classes on the list itself, which may be none and may be undefined. */
  listClasses: string[]
  /** Whether it reads as a sidebar rather than a bar across the top. */
  vertical: boolean
}

/**
 * Names that mean the navigation runs down the side rather than across.
 *
 * Exported so the pass that finds the navigations and the generator that
 * writes their rules cannot disagree about which way a rail runs.
 */
export const VERTICAL_NAV = /sidebar|side-nav|sidenav|rail|drawer|vertical|aside/i

/**
 * Whether any rule in the stylesheet could reach this list.
 *
 * Conservative on purpose: if anything might already be styling it, this pass
 * does nothing. A selector ending in the tag, in `*`, or in one of the list's
 * own classes counts — and so does a rule on the nav's class that sets a
 * display, because `display: flex` on a `<ul>` blockifies its items and the
 * markers stop rendering without `list-style` being mentioned anywhere.
 */
export function listIsStyled(css: string, nav: NavRoot): boolean {
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = rule[2]
    const touchesList = /list-style|display\s*:\s*(?:flex|grid|inline-flex)/.test(body)
    if (!touchesList) continue
    for (const one of rule[1].split(',')) {
      const s = one.trim()
      if (!s) continue
      if (new RegExp(`(?:^|[\\s>+~])${nav.tag}(?:[:.\\[][^\\s>+~]*)?$`).test(s)) return true
      if (/(?:^|[\s>+~])\*$/.test(s)) return true
      for (const c of nav.listClasses) {
        if (new RegExp(`\\.${c.replace(/([.:])/g, '\\$1')}(?:[:.\\[][^\\s>+~]*)?$`).test(s)) return true
      }
    }
  }
  return false
}

/** `var(--token)` when the project has one, the literal otherwise. */
const token = (name: string | undefined, fallback: string): string =>
  name ? `var(${name})` : fallback

/**
 * The corner this product actually uses, for a project with no radius token.
 *
 * A literal default was wrong in the one direction that shows: the first
 * document this ran on was Carbon, which is square and declares no radius
 * scale, so a 6px fallback rounded the navigation in a design system whose
 * whole character is that nothing is rounded.
 *
 * Read from the stylesheet instead — the most common `border-radius` the
 * project already writes. Pills and circles are left out: `9999px` and `50%`
 * are shapes, not the product's corner.
 */
export function commonRadius(css: string, fallback = '6px'): string {
  const counts = new Map<string, number>()
  for (const m of css.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    const value = m[1].trim()
    if (!value || /9999|50%|100%|9rem|var\(/.test(value) || value.includes(' ')) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  if (counts.size === 0) return fallback
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * The rules for one navigation.
 *
 * Every selector is scoped to the navigation, so nothing here can reach a list
 * anywhere else in the product.
 */
function rulesFor(nav: NavRoot, palette: Palette, radius: string): string[] {
  const root = nav.className ? `.${nav.className}` : 'nav'
  const list = nav.listClasses.length > 0 ? `${root} .${nav.listClasses[0]}` : `${root} ${nav.tag}`
  const item = `${root} li`
  const control = `${root} a, ${root} button`
  const ink = token(palette.ink, '#1f2937')
  const inkMuted = token(palette.inkMuted, '#4b5563')
  const wash = token(palette.surfaceMuted, 'rgba(0, 0, 0, 0.05)')
  const corner = token(palette.radiusMd ?? palette.radiusSm, radius)

  return [
    `${list} {`,
    '  list-style: none;',
    '  margin: 0;',
    '  padding: 0;',
    '  display: flex;',
    `  flex-direction: ${nav.vertical ? 'column' : 'row'};`,
    `  align-items: ${nav.vertical ? 'stretch' : 'center'};`,
    `  gap: ${nav.vertical ? '2px' : '4px'};`,
    '}',
    `${item} { display: flex; }`,
    `${control} {`,
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 8px;',
    `  ${nav.vertical ? 'width: 100%;' : ''}`.trim(),
    '  padding: 8px 12px;',
    `  border-radius: ${corner};`,
    '  border: 0;',
    '  background: none;',
    `  color: ${inkMuted};`,
    '  font: inherit;',
    '  text-decoration: none;',
    '  cursor: pointer;',
    '  white-space: nowrap;',
    '  transition: background-color 120ms ease, color 120ms ease;',
    '}',
    /*
     * The three states a navigation needs and a default list has none of. The
     * current page is read from `aria-current`, which the build contract
     * already requires — so this styles what is there rather than asking for a
     * class that would have to be added.
     */
    `${root} a:hover, ${root} button:hover { background-color: ${wash}; color: ${ink}; }`,
    `${root} a:focus-visible, ${root} button:focus-visible {`,
    `  outline: 2px solid ${token(palette.ink, '#1f2937')};`,
    '  outline-offset: 2px;',
    '}',
    `${root} [aria-current="page"], ${root} .is-active, ${root} .active {`,
    `  color: ${ink};`,
    '  font-weight: 600;',
    `  background-color: ${wash};`,
    '}',
  ].filter(Boolean)
}

/** Where this pass's rules begin, so an audit can tell them from the design. */
const NAV_BLOCK_MARKER = '/* makeui:navigation */'

interface NavCss {
  css: string
  styled: string[]
}

/** CSS for the navigations given, or an empty result when there are none. */
export function navCss(navs: NavRoot[], stylesheet = ''): NavCss {
  if (navs.length === 0) return { css: '', styled: [] }
  const palette = paletteOf(stylesheet)
  const radius = commonRadius(stylesheet)
  const sections: string[] = [
    NAV_BLOCK_MARKER,
    '/* ------------------------------------------------------------------',
    '   Navigation.',
    '',
    '   The list, its items and its links, so the navigation reads as part of',
    '   this product rather than as the browser\'s default bulleted list. The',
    '   colours and the corner come from the tokens above.',
    '   ------------------------------------------------------------------ */',
  ]
  const styled: string[] = []
  for (const nav of navs) {
    sections.push(...rulesFor(nav, palette, radius), '')
    styled.push(nav.className ? `.${nav.className}` : `${nav.path.split('/').pop()} の <nav>`)
  }
  return { css: sections.join('\n').replace(/\n+$/, ''), styled }
}
