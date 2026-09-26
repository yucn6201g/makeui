/**
 * CSS for the utility classes a generated project uses but never defined.
 *
 * The build is told to put every style in `src/styles/globals.css` and to name
 * its classes after the components they belong to. Most of the time it does.
 * Then it writes `className="flex items-center gap-4 rounded-lg bg-white p-6
 * shadow-sm"` — the vocabulary of a framework this project does not carry — and
 * every one of those classes means nothing. Measured over the last 102 stored
 * documents: **23 of them (24%) ship with three or more dead utility classes**,
 * the worst carrying 95 of them, and what the reviewer sees is a page with no
 * padding, no card, no type scale. Reported as 「デザインが反映されておらず、
 * チープなデザインになってしまっている」.
 *
 * The audit has reported this for a while (`utility-classes` in
 * design-audit.ts) and a model is asked to rewrite the markup into component
 * classes. It is still 24%, which is the measurement that matters: reporting it
 * has not closed it.
 *
 * So the classes are made to work instead. This writes the CSS they were always
 * meant to have, for the classes the project actually uses and no others.
 *
 * ## What the values are, and why
 *
 * Layout, spacing, sizing and type follow the scale these names come from —
 * `p-4` is 1rem because the model wrote `p-4` meaning 1rem, and a project whose
 * `p-4` were something else would be a worse answer than one where it is what
 * it says.
 *
 * Colour, radius and shadow do NOT. Those are where a design system lives: a
 * `rounded-lg` under Carbon is Carbon's radius, which is zero, and a
 * `text-gray-900` should be the ink this product already uses rather than
 * Tailwind's #111827. They resolve through the project's own `:root` tokens,
 * and fall back to the literal value only when the project declares nothing
 * that fits. Measured across the same documents, the neutral families are all
 * that ever appear — `gray`, `white`, `black`, never `blue-600` — because the
 * model reaches for the preset's tokens for anything with colour in it and for
 * these only for chrome. That is what makes the mapping safe.
 *
 * ## What it does not do
 *
 * Anything it cannot map exactly comes back in `unhandled`, so the audit still
 * reports those and a repair can still be spent on them. Inventing a
 * declaration for a class this does not understand would be worse than a class
 * that does nothing, because it would look deliberate.
 */

/**
 * A Tailwind utility, recognised by its value as well as its prefix.
 *
 * Prefixes alone matched the project's own names: `my-reservations-screen` read as
 * a vertical margin. So spacing and sizing need a number or a keyword after the
 * dash, colours need a palette step, and the bare words (`flex`, `grid`, `fixed`)
 * only count because a project that defines them is excluded before this is asked.
 */
export const UTILITY_CLASS = new RegExp('^(?:' + [
  '-?[mp][trblxy]?-(?:\\d|px|auto)',
  '[wh]-(?:\\d|full|screen|auto|px|min|max|fit)',
  '(?:min|max)-[wh]-',
  'gap-(?:[xy]-)?\\d', 'space-[xy]-\\d',
  'flex(?:-(?:col|row|wrap|1|none|auto|grow|shrink))?$', 'grid(?:-(?:cols|rows)-\\d+)?$', 'col-span-\\d',
  'items-(?:center|start|end|stretch|baseline)$', 'justify-(?:center|start|end|between|around|evenly)$',
  'text-(?:xs|sm|base|lg|[2-9]?xl|center|left|right|white|black|(?:gray|slate|zinc|neutral|red|green|blue|indigo|yellow|orange|purple|pink)-\\d{2,3})$',
  'font-(?:thin|light|normal|medium|semibold|bold|extrabold|black)$',
  'bg-(?:white|black|transparent|gradient-to-\\w+|(?:gray|slate|zinc|neutral|red|green|blue|indigo|yellow|orange|purple|pink)-\\d{2,3})$',
  'border(?:-[trblxy])?(?:-\\d|-(?:gray|slate|zinc|neutral)-\\d{2,3})?$',
  'rounded(?:-(?:sm|md|lg|xl|2xl|3xl|full|none))?$', 'shadow(?:-(?:sm|md|lg|xl|2xl|none))?$',
  '(?:inset|top|left|right|bottom)-\\d', 'z-\\d+$', 'opacity-\\d+$',
  'leading-(?:none|tight|snug|normal|relaxed|loose|\\d)$', 'tracking-(?:tighter|tight|normal|wide|wider|widest)$',
  'mx-auto$', 'min-h-screen$', 'inline-(?:block|flex)$', '(?:fixed|absolute|relative|sticky)$', 'truncate$',
  'overflow-(?:hidden|auto|x-auto|y-auto)$', '(?:sm|md|lg|xl|hover|focus):', 'cursor-pointer$', 'duration-\\d+$', 'sr-only$',
].join('|') + ')')

/**
 * The class names a stylesheet defines, escapes included.
 *
 * A utility class is not a plain identifier: `hover:bg-gray-50` has to be
 * written `.hover\:bg-gray-50:hover` and `px-2.5` as `.px-2\.5`. Reading
 * selectors with `/\.([A-Za-z_][\w-]*)/` stops at the backslash and returns
 * `hover`, so a class this file had just defined still read as undefined — the
 * audit would report it, and a repair would be spent rewriting markup that
 * already worked.
 *
 * One reader, used by the pass that writes the CSS and by the audit that
 * reports what is left, so the two cannot disagree about what "defined" means.
 */
export function definedClasses(css: string): Set<string> {
  const out = new Set<string>()
  for (const m of css.matchAll(/\.(-?(?:[_a-zA-Z]|\\.)(?:[\w-]|\\.)*)/g)) {
    out.add(m[1].replace(/\\(.)/g, '$1'))
  }
  return out
}

/** Tailwind's spacing step. `p-4` is four of them. */
const STEP_REM = 0.25

/** The named type scale, as size/line-height pairs. */
const TEXT_SIZE: Record<string, [string, string]> = {
  xs: ['0.75rem', '1rem'],
  sm: ['0.875rem', '1.25rem'],
  base: ['1rem', '1.5rem'],
  lg: ['1.125rem', '1.75rem'],
  xl: ['1.25rem', '1.75rem'],
  '2xl': ['1.5rem', '2rem'],
  '3xl': ['1.875rem', '2.25rem'],
  '4xl': ['2.25rem', '2.5rem'],
  '5xl': ['3rem', '1'],
  '6xl': ['3.75rem', '1'],
  '7xl': ['4.5rem', '1'],
}

const FONT_WEIGHT: Record<string, string> = {
  thin: '100', extralight: '200', light: '300', normal: '400',
  medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900',
}

const LEADING: Record<string, string> = {
  none: '1', tight: '1.25', snug: '1.375', normal: '1.5', relaxed: '1.625', loose: '2',
}

const TRACKING: Record<string, string> = {
  tighter: '-0.05em', tight: '-0.025em', normal: '0', wide: '0.025em', wider: '0.05em', widest: '0.1em',
}

const MAX_WIDTH: Record<string, string> = {
  xs: '20rem', sm: '24rem', md: '28rem', lg: '32rem', xl: '36rem',
  '2xl': '42rem', '3xl': '48rem', '4xl': '56rem', '5xl': '64rem', '6xl': '72rem', '7xl': '80rem',
  full: '100%', none: 'none', prose: '65ch', screen: '100vw',
}

const SHADOW: Record<string, string> = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
  none: 'none',
}

const RADIUS: Record<string, string> = {
  none: '0', sm: '0.125rem', DEFAULT: '0.25rem', md: '0.375rem',
  lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', full: '9999px',
}

/** The neutral ramp, for a project that declares nothing of its own. */
const GRAY: Record<string, string> = {
  '50': '#f9fafb', '100': '#f3f4f6', '200': '#e5e7eb', '300': '#d1d5db', '400': '#9ca3af',
  '500': '#6b7280', '600': '#4b5563', '700': '#374151', '800': '#1f2937', '900': '#111827', '950': '#030712',
}

const NEUTRAL_FAMILY = /^(?:gray|grey|slate|zinc|neutral|stone)$/

/**
 * The families that carry meaning, and the meaning they carry.
 *
 * The census said the neutrals were all that ever appeared. That was the top of
 * the list rather than the whole of it: further down sit `text-red-500` on a
 * delete, `bg-red-50` behind an error, `text-blue-600` on a link. Those are not
 * decoration — they are the states this product already has tokens for, so the
 * solid steps resolve to them and only the tints fall back to a literal.
 *
 * 500-700 is where a family is the colour itself; 50-200 is where it is a wash
 * behind text. A design system has an opinion about the first and rarely about
 * the second.
 */
const ACCENT: Record<string, { role: RegExp; ramp: Record<string, string> }> = {
  red: { role: /danger|error|critical|destructive|negative/, ramp: { '50': '#fef2f2', '100': '#fee2e2', '200': '#fecaca', '300': '#fca5a5', '400': '#f87171', '500': '#ef4444', '600': '#dc2626', '700': '#b91c1c', '800': '#991b1b', '900': '#7f1d1d' } },
  rose: { role: /danger|error|critical/, ramp: { '50': '#fff1f2', '100': '#ffe4e6', '200': '#fecdd3', '300': '#fda4af', '400': '#fb7185', '500': '#f43f5e', '600': '#e11d48', '700': '#be123c', '800': '#9f1239', '900': '#881337' } },
  green: { role: /success|positive|ok|safe/, ramp: { '50': '#f0fdf4', '100': '#dcfce7', '200': '#bbf7d0', '300': '#86efac', '400': '#4ade80', '500': '#22c55e', '600': '#16a34a', '700': '#15803d', '800': '#166534', '900': '#14532d' } },
  emerald: { role: /success|positive/, ramp: { '50': '#ecfdf5', '100': '#d1fae5', '200': '#a7f3d0', '300': '#6ee7b7', '400': '#34d399', '500': '#10b981', '600': '#059669', '700': '#047857', '800': '#065f46', '900': '#064e3b' } },
  amber: { role: /warning|caution|attention/, ramp: { '50': '#fffbeb', '100': '#fef3c7', '200': '#fde68a', '300': '#fcd34d', '400': '#fbbf24', '500': '#f59e0b', '600': '#d97706', '700': '#b45309', '800': '#92400e', '900': '#78350f' } },
  yellow: { role: /warning|caution/, ramp: { '50': '#fefce8', '100': '#fef9c3', '200': '#fef08a', '300': '#fde047', '400': '#facc15', '500': '#eab308', '600': '#ca8a04', '700': '#a16207', '800': '#854d0e', '900': '#713f12' } },
  orange: { role: /warning|caution/, ramp: { '50': '#fff7ed', '100': '#ffedd5', '200': '#fed7aa', '300': '#fdba74', '400': '#fb923c', '500': '#f97316', '600': '#ea580c', '700': '#c2410c', '800': '#9a3412', '900': '#7c2d12' } },
  blue: { role: /primary|accent|brand|link|info/, ramp: { '50': '#eff6ff', '100': '#dbeafe', '200': '#bfdbfe', '300': '#93c5fd', '400': '#60a5fa', '500': '#3b82f6', '600': '#2563eb', '700': '#1d4ed8', '800': '#1e40af', '900': '#1e3a8a' } },
  indigo: { role: /primary|accent|brand/, ramp: { '50': '#eef2ff', '100': '#e0e7ff', '200': '#c7d2fe', '300': '#a5b4fc', '400': '#818cf8', '500': '#6366f1', '600': '#4f46e5', '700': '#4338ca', '800': '#3730a3', '900': '#312e81' } },
  sky: { role: /primary|accent|info/, ramp: { '50': '#f0f9ff', '100': '#e0f2fe', '200': '#bae6fd', '300': '#7dd3fc', '400': '#38bdf8', '500': '#0ea5e9', '600': '#0284c7', '700': '#0369a1', '800': '#075985', '900': '#0c4a6e' } },
  violet: { role: /primary|accent|brand/, ramp: { '50': '#f5f3ff', '100': '#ede9fe', '200': '#ddd6fe', '300': '#c4b5fd', '400': '#a78bfa', '500': '#8b5cf6', '600': '#7c3aed', '700': '#6d28d9', '800': '#5b21b6', '900': '#4c1d95' } },
  purple: { role: /primary|accent|brand/, ramp: { '50': '#faf5ff', '100': '#f3e8ff', '200': '#e9d5ff', '300': '#d8b4fe', '400': '#c084fc', '500': '#a855f7', '600': '#9333ea', '700': '#7e22ce', '800': '#6b21a8', '900': '#581c87' } },
  teal: { role: /primary|accent|info/, ramp: { '50': '#f0fdfa', '100': '#ccfbf1', '200': '#99f6e4', '300': '#5eead4', '400': '#2dd4bf', '500': '#14b8a6', '600': '#0d9488', '700': '#0f766e', '800': '#115e59', '900': '#134e4a' } },
  cyan: { role: /primary|accent|info/, ramp: { '50': '#ecfeff', '100': '#cffafe', '200': '#a5f3fc', '300': '#67e8f9', '400': '#22d3ee', '500': '#06b6d4', '600': '#0891b2', '700': '#0e7490', '800': '#155e75', '900': '#164e63' } },
  pink: { role: /accent|brand/, ramp: { '50': '#fdf2f8', '100': '#fce7f3', '200': '#fbcfe8', '300': '#f9a8d4', '400': '#f472b6', '500': '#ec4899', '600': '#db2777', '700': '#be185d', '800': '#9d174d', '900': '#831843' } },
}

/**
 * The project's own tokens, by what they are for rather than by name.
 *
 * Every preset names them differently — `--color-text-high-emphasis`,
 * `--color-text`, `--text-primary` — so the match is on what the name contains.
 * Ordered: the first pattern that hits wins, so the more specific ones come
 * first.
 */
export interface Palette {
  ink?: string
  inkMuted?: string
  surface?: string
  surfaceMuted?: string
  border?: string
  radiusSm?: string
  radiusMd?: string
  radiusLg?: string
  /** Every token this project declares, for an accent to look itself up in. */
  names: string[]
}

const ROLE: Array<[Exclude<keyof Palette, 'names'>, RegExp[]]> = [
  ['inkMuted', [/text.*(?:secondary|muted|subtle|tertiary|low|weak)/, /(?:secondary|muted|subtle)[-_]?text/]],
  ['ink', [/text.*(?:high|primary|strong|default|emphasis)/, /^--(?:color-)?text$/, /(?:^|-)ink(?:-|$)/]],
  ['surfaceMuted', [/surface.*(?:secondary|subtle|muted|alt)/, /bg.*(?:secondary|subtle|muted)/, /background.*(?:secondary|subtle|muted)/]],
  ['surface', [/surface.*(?:primary|default)/, /^--(?:color-)?surface$/, /^--(?:color-)?background$/, /^--(?:color-)?bg$/]],
  ['border', [/border|divider|outline/]],
  /*
   * A radius SCALE, not any token with "radius" in its name. A catch-all
   * matched `--radius-snackbar` on a real document and every `rounded-lg` in
   * the project became a snackbar's corner — a component's measurement
   * standing in for a scale it was never part of. When the project has no
   * scale, the literal is the honest answer.
   */
  ['radiusSm', [/radius[-_](?:sm|small|xs|1)$/]],
  ['radiusLg', [/radius[-_](?:lg|large|xl|2xl|3|4)$/]],
  ['radiusMd', [/radius[-_](?:md|medium|base|default|2)$/, /^--(?:border-)?radius$/]],
]

/**
 * What a token NAME is for, by the same patterns the palette is filed under.
 *
 * Used to read a name the project does not define — `var(--text-muted)` in a
 * drawing, in a project whose muted ink is `--color-text-secondary` — and say
 * which of its own tokens was meant.
 */
export function roleOf(name: string): Exclude<keyof Palette, 'names'> | null {
  for (const [role, patterns] of ROLE) {
    if (patterns.some((p) => p.test(name))) return role
  }
  return null
}

/** Reads `:root` declarations and files them by the job each one does. */
export function paletteOf(css: string): Palette {
  const names: string[] = []
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) names.push(m[1])
  const out: Palette = { names }
  for (const [role, patterns] of ROLE) {
    if (out[role]) continue
    for (const pattern of patterns) {
      const hit = names.find((n) => pattern.test(n))
      if (hit) { out[role] = hit; break }
    }
  }
  return out
}

/**
 * `var(--token)` when the project has one, the literal otherwise.
 *
 * No fallback inside the `var()`. The token exists by construction — it was
 * read out of this project's own `:root` a moment ago — and a fallback would
 * put a colour into the stylesheet that the design system never chose. Two
 * audits count exactly that: `palette-size` counts distinct colours and
 * `preset-drift` counts values outside the bound system, so a fallback here
 * would manufacture findings for a repair to spend a call on.
 */
const token = (name: string | undefined, fallback: string): string =>
  name ? `var(${name})` : fallback

/** A spacing step as a length. */
function length(value: string): string | null {
  if (value === 'auto') return 'auto'
  if (value === 'px') return '1px'
  if (value === 'full') return '100%'
  if (value === 'screen') return '100vh'
  if (value === 'fit') return 'fit-content'
  if (value === 'min') return 'min-content'
  if (value === 'max') return 'max-content'
  const fraction = /^(\d+)\/(\d+)$/.exec(value)
  if (fraction) return `${((Number(fraction[1]) / Number(fraction[2])) * 100).toFixed(4).replace(/\.?0+$/, '')}%`
  if (!/^\d+(?:\.5)?$/.test(value)) return null
  const n = Number(value)
  return n === 0 ? '0' : `${+(n * STEP_REM).toFixed(4)}rem`
}

const SIDES: Record<string, string[]> = {
  '': [''], t: ['-top'], r: ['-right'], b: ['-bottom'], l: ['-left'],
  x: ['-left', '-right'], y: ['-top', '-bottom'],
}

/** A colour class's value, resolved through the project's tokens. */
function colour(kind: 'text' | 'bg' | 'border', rest: string, palette: Palette): string | null {
  if (rest === 'white') return token(palette.surface, '#ffffff')
  if (rest === 'black') return kind === 'text' ? token(palette.ink, '#000000') : '#000000'
  if (rest === 'transparent') return 'transparent'
  if (rest === 'current') return 'currentColor'
  const step = /^([a-z]+)-(\d{2,3})$/.exec(rest)
  if (!step) return null
  const n = Number(step[2])
  if (!NEUTRAL_FAMILY.test(step[1])) {
    /*
     * A family that means something. The solid steps take the token this
     * product already has for that meaning — a delete is this design's danger
     * colour, not Tailwind's red — and the washes behind them keep the literal,
     * because a design system rarely declares a tint.
     */
    const accent = ACCENT[step[1]]
    const shade = accent?.ramp[step[2]]
    if (!accent || !shade) return null
    if (n < 500 || n > 700) return shade
    /*
     * The token named for the MEANING, not one named for a slot that happens
     * to contain the word. `--color-surface-primary` matched `primary` and
     * sorted before `--color-primary`, so a link's blue became the page's
     * background — caught by the test below before it could ship.
     *
     * Slot words out, then the shortest name wins: `--color-primary` is the
     * colour, `--color-primary-hover` is a state of it.
     */
    const named = palette.names
      .filter((name) => accent.role.test(name))
      .filter((name) => !/surface|background|bg|border|divider|outline|text|ink|hover|active|focus|disabled|light|dark|subtle|weak|\d/.test(name))
      .sort((a, b) => a.length - b.length)[0]
    return token(named, shade)
  }
  const literal = GRAY[step[2]] ?? null
  if (literal === null) return null
  /*
   * The ramp read as roles rather than as numbers. 900 and 800 are the ink this
   * product writes in; 400–600 is the quieter ink beside it; 200 and 300 are
   * the line between things; 50 and 100 are the ground behind them. Anything
   * else keeps the literal step, which is the honest answer for a value the
   * design system has no opinion about.
   */
  if (kind === 'text') {
    if (n >= 700) return token(palette.ink, literal)
    if (n >= 400) return token(palette.inkMuted, literal)
    return literal
  }
  if (kind === 'border') return n <= 400 ? token(palette.border, literal) : literal
  return n <= 100 ? token(palette.surfaceMuted, literal) : literal
}

/** The declarations one class stands for, or null when this does not know. */
function declarations(name: string, palette: Palette): string | null {
  const keyword: Record<string, string> = {
    flex: 'display: flex;',
    'inline-flex': 'display: inline-flex;',
    grid: 'display: grid;',
    block: 'display: block;',
    'inline-block': 'display: inline-block;',
    inline: 'display: inline;',
    hidden: 'display: none;',
    'flex-col': 'flex-direction: column;',
    'flex-row': 'flex-direction: row;',
    'flex-wrap': 'flex-wrap: wrap;',
    'flex-nowrap': 'flex-wrap: nowrap;',
    'flex-1': 'flex: 1 1 0%;',
    'flex-auto': 'flex: 1 1 auto;',
    'flex-none': 'flex: none;',
    'flex-grow': 'flex-grow: 1;',
    'flex-shrink': 'flex-shrink: 1;',
    'flex-shrink-0': 'flex-shrink: 0;',
    relative: 'position: relative;',
    absolute: 'position: absolute;',
    fixed: 'position: fixed;',
    sticky: 'position: sticky;',
    static: 'position: static;',
    'inset-0': 'inset: 0;',
    'mx-auto': 'margin-left: auto; margin-right: auto;',
    'cursor-pointer': 'cursor: pointer;',
    'cursor-default': 'cursor: default;',
    'text-left': 'text-align: left;',
    'text-center': 'text-align: center;',
    'text-right': 'text-align: right;',
    'overflow-hidden': 'overflow: hidden;',
    'overflow-auto': 'overflow: auto;',
    'overflow-x-auto': 'overflow-x: auto;',
    'overflow-y-auto': 'overflow-y: auto;',
    'object-cover': 'object-fit: cover;',
    'object-contain': 'object-fit: contain;',
    'min-h-screen': 'min-height: 100vh;',
    'min-w-0': 'min-width: 0;',
    'w-full': 'width: 100%;',
    'h-full': 'height: 100%;',
    'whitespace-nowrap': 'white-space: nowrap;',
    truncate: 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
    'sr-only': 'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0;',
    'outline-none': 'outline: 2px solid transparent; outline-offset: 2px;',
    'transition': 'transition-property: color, background-color, border-color, opacity, box-shadow, transform; transition-duration: 150ms; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);',
    'transition-colors': 'transition-property: color, background-color, border-color; transition-duration: 150ms;',
    'pointer-events-none': 'pointer-events: none;',
    'select-none': 'user-select: none;',
    'list-none': 'list-style: none;',
    'appearance-none': 'appearance: none;',
    'items-center': 'align-items: center;',
    'items-start': 'align-items: flex-start;',
    'items-end': 'align-items: flex-end;',
    'items-stretch': 'align-items: stretch;',
    'items-baseline': 'align-items: baseline;',
    'justify-center': 'justify-content: center;',
    'justify-start': 'justify-content: flex-start;',
    'justify-end': 'justify-content: flex-end;',
    'justify-between': 'justify-content: space-between;',
    'justify-around': 'justify-content: space-around;',
    'justify-evenly': 'justify-content: space-evenly;',
    'self-center': 'align-self: center;',
    'self-start': 'align-self: flex-start;',
    'self-end': 'align-self: flex-end;',
    'text-nowrap': 'white-space: nowrap;',
    uppercase: 'text-transform: uppercase;',
    lowercase: 'text-transform: lowercase;',
    capitalize: 'text-transform: capitalize;',
    italic: 'font-style: italic;',
    underline: 'text-decoration-line: underline;',
    'border-collapse': 'border-collapse: collapse;',
  }
  if (keyword[name]) return keyword[name]

  // --- spacing ------------------------------------------------------------
  const space = /^(-)?([mp])([trblxy]?)-(.+)$/.exec(name)
  if (space) {
    const [, negative, kind, side, raw] = space
    const value = length(raw)
    if (value === null) return null
    if (negative && (value === 'auto' || kind === 'p')) return null
    const property = kind === 'm' ? 'margin' : 'padding'
    return SIDES[side].map((s) => `${property}${s}: ${negative ? `-${value}` : value};`).join(' ')
  }

  // --- gap and the space-between idiom ------------------------------------
  const gap = /^gap(?:-([xy]))?-(.+)$/.exec(name)
  if (gap) {
    const value = length(gap[2])
    if (value === null) return null
    if (!gap[1]) return `gap: ${value};`
    return `${gap[1] === 'x' ? 'column' : 'row'}-gap: ${value};`
  }

  // --- rings, which are a shadow rather than a border ----------------------
  const ring = /^ring(?:-(\d+))?$/.exec(name)
  if (ring) return `box-shadow: 0 0 0 ${ring[1] ?? '3'}px var(--ring-color, ${token(palette.border, GRAY['300'])});`
  const ringColour = /^ring-(.+)$/.exec(name)
  if (ringColour && !/^offset/.test(ringColour[1])) {
    const value = colour('border', ringColour[1], palette)
    return value === null ? null : `--ring-color: ${value};`
  }
  const ringOffset = /^ring-offset-(\d+)$/.exec(name)
  if (ringOffset) return `outline-offset: ${ringOffset[1]}px;`

  // --- sizing --------------------------------------------------------------
  const size = /^([wh])-(.+)$/.exec(name)
  if (size) {
    const value = length(size[2])
    if (value === null) return null
    const property = size[1] === 'w' ? 'width' : 'height'
    if (size[1] === 'h' && size[2] === 'screen') return 'height: 100vh;'
    if (size[1] === 'w' && size[2] === 'screen') return 'width: 100vw;'
    return `${property}: ${value};`
  }
  const bound = /^(min|max)-([wh])-(.+)$/.exec(name)
  if (bound) {
    const property = `${bound[1]}-${bound[2] === 'w' ? 'width' : 'height'}`
    const value = bound[2] === 'w' && MAX_WIDTH[bound[3]] ? MAX_WIDTH[bound[3]] : length(bound[3])
    if (!value) return null
    return `${property}: ${value};`
  }

  // --- grid ----------------------------------------------------------------
  const cols = /^grid-cols-(\d+)$/.exec(name)
  if (cols) return `grid-template-columns: repeat(${cols[1]}, minmax(0, 1fr));`
  const rows = /^grid-rows-(\d+)$/.exec(name)
  if (rows) return `grid-template-rows: repeat(${rows[1]}, minmax(0, 1fr));`
  const span = /^(col|row)-span-(\d+)$/.exec(name)
  if (span) return `grid-${span[1] === 'col' ? 'column' : 'row'}: span ${span[2]} / span ${span[2]};`

  // --- type ----------------------------------------------------------------
  const text = /^text-(.+)$/.exec(name)
  if (text && TEXT_SIZE[text[1]]) {
    const [size_, leading] = TEXT_SIZE[text[1]]
    return `font-size: ${size_}; line-height: ${leading};`
  }
  const weight = /^font-(.+)$/.exec(name)
  if (weight && FONT_WEIGHT[weight[1]]) return `font-weight: ${FONT_WEIGHT[weight[1]]};`
  const leading = /^leading-(.+)$/.exec(name)
  if (leading) {
    const value = LEADING[leading[1]] ?? (/^\d+$/.test(leading[1]) ? `${Number(leading[1]) * STEP_REM}rem` : null)
    return value ? `line-height: ${value};` : null
  }
  const tracking = /^tracking-(.+)$/.exec(name)
  if (tracking && TRACKING[tracking[1]]) return `letter-spacing: ${TRACKING[tracking[1]]};`

  // --- the design system's own: radius, shadow, colour ---------------------
  const rounded = /^rounded(?:-(.+))?$/.exec(name)
  if (rounded) {
    const key = rounded[1] ?? 'DEFAULT'
    if (!RADIUS[key]) return null
    if (key === 'full' || key === 'none') return `border-radius: ${RADIUS[key]};`
    const named = key === 'sm' ? palette.radiusSm
      : key === 'DEFAULT' || key === 'md' ? palette.radiusMd ?? palette.radiusSm
        : palette.radiusLg ?? palette.radiusMd
    return `border-radius: ${token(named, RADIUS[key])};`
  }
  const shadow = /^shadow(?:-(.+))?$/.exec(name)
  if (shadow) {
    const key = shadow[1] ?? 'DEFAULT'
    return SHADOW[key] ? `box-shadow: ${SHADOW[key]};` : null
  }
  /*
   * Borders before colour, because `border-b` is a side and `border-blue-500`
   * is a colour and the colour pattern matches both. Reading it as a colour
   * first returned null for every `border-b` in the corpus — 12 documents —
   * and the side never got its width.
   */
  const border = /^border(?:-([trblxy]))?(?:-(\d+))?$/.exec(name)
  if (border) {
    const width = border[2] ? `${border[2]}px` : '1px'
    const sides = border[1] ? SIDES[border[1]] : ['']
    return sides
      .map((s) => `border${s}-width: ${width}; border${s}-style: solid;`)
      .join(' ') + ` border-color: ${token(palette.border, GRAY['200'])};`
  }

  const paint = /^(text|bg|border)-(.+)$/.exec(name)
  if (paint) {
    const value = colour(paint[1] as 'text' | 'bg' | 'border', paint[2], palette)
    if (value === null) return null
    if (paint[1] === 'text') return `color: ${value};`
    if (paint[1] === 'bg') return `background-color: ${value};`
    return `border-color: ${value};`
  }

  // --- placement ------------------------------------------------------------
  const edge = /^(top|right|bottom|left)-(.+)$/.exec(name)
  if (edge) {
    const value = length(edge[2])
    return value === null ? null : `${edge[1]}: ${value};`
  }
  const z = /^z-(\d+)$/.exec(name)
  if (z) return `z-index: ${z[1]};`
  const opacity = /^opacity-(\d+)$/.exec(name)
  if (opacity) return `opacity: ${Number(opacity[1]) / 100};`
  const duration = /^duration-(\d+)$/.exec(name)
  if (duration) return `transition-duration: ${duration[1]}ms;`

  return null
}

/**
 * `space-x-4` and `space-y-4`, which are a rule about the gaps BETWEEN
 * children rather than about the element — so they cannot be a declaration and
 * are written as their own rule.
 */
function spacedChildren(name: string): string | null {
  const m = /^space-([xy])-(.+)$/.exec(name)
  if (!m) return null
  const value = length(m[2])
  if (value === null) return null
  return m[1] === 'x'
    ? `> * + * { margin-left: ${value}; }`
    : `> * + * { margin-top: ${value}; }`
}

/** A class name as it has to be written in a selector. */
const escape = (name: string): string => `.${name.replace(/([.:/[\]])/g, '\\$1')}`

const BREAKPOINT: Record<string, string> = { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' }

/**
 * Where this pass's rules begin, so an audit can stop counting there.
 *
 * `thin-stylesheet` asks whether the project has a design of its own, by
 * counting class rules. Seventy utility rules appended here would answer yes
 * for a project whose styling is entirely `flex` and `p-4` — which is the
 * project that audit exists to find. So the block is marked and the count
 * stops at the marker: the classes work, and the stylesheet is still judged on
 * what the build actually wrote.
 */
export const UTILITY_BLOCK_MARKER = '/* makeui:utility-classes */'

interface UtilityCss {
  /** The stylesheet block, or '' when nothing could be written. */
  css: string
  /** Classes this wrote a rule for. */
  handled: string[]
  /** Classes it did not understand, which the audit should still report. */
  unhandled: string[]
}

/**
 * CSS for the classes given, using the project's tokens where the class is a
 * design decision rather than a measurement.
 */
export function utilityCss(classes: Iterable<string>, stylesheet = ''): UtilityCss {
  const palette = paletteOf(stylesheet)
  const handled: string[] = []
  const unhandled: string[] = []
  const plain: string[] = []
  const states: string[] = []
  const media = new Map<string, string[]>()

  for (const name of [...new Set(classes)].sort()) {
    /*
     * A variant is the same rule under a condition, so it is written by
     * resolving what follows the colon and wrapping it. Only one deep: `md:
     * hover:` is rare, and a rule this cannot write is better left to the audit
     * than guessed at.
     */
    const variant = /^([a-z0-9]+):(.+)$/.exec(name)
    if (variant) {
      const inner = declarations(variant[2], palette)
      if (!inner) { unhandled.push(name); continue }
      if (variant[1] === 'hover' || variant[1] === 'focus' || variant[1] === 'active' || variant[1] === 'disabled') {
        const pseudo = variant[1] === 'focus' ? ':focus-visible' : `:${variant[1]}`
        states.push(`${escape(name)}${pseudo} { ${inner} }`)
        handled.push(name)
        continue
      }
      if (BREAKPOINT[variant[1]]) {
        const at = BREAKPOINT[variant[1]]
        media.set(at, [...(media.get(at) ?? []), `  ${escape(name)} { ${inner} }`])
        handled.push(name)
        continue
      }
      unhandled.push(name)
      continue
    }
    const children = spacedChildren(name)
    if (children) {
      plain.push(`${escape(name)} ${children}`)
      handled.push(name)
      continue
    }
    const body = declarations(name, palette)
    if (!body) { unhandled.push(name); continue }
    plain.push(`${escape(name)} { ${body} }`)
    handled.push(name)
  }

  if (handled.length === 0) return { css: '', handled, unhandled }

  const sections = [
    UTILITY_BLOCK_MARKER,
    '/* ------------------------------------------------------------------',
    '   Utility classes used by this project.',
    '',
    '   The components above were written with these names on them. Sizes and',
    '   spacing follow the scale the names come from; colours, corners and',
    '   shadows read this project\'s own tokens, so they stay part of the design',
    '   system rather than beside it.',
    '   ------------------------------------------------------------------ */',
    ...plain,
  ]
  if (states.length > 0) sections.push('', ...states)
  for (const [at, rules] of [...media].sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    sections.push('', `@media (min-width: ${at}) {`, ...rules, '}')
  }
  return { css: sections.join('\n'), handled, unhandled }
}
