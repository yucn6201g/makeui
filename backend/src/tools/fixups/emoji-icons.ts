import type { OutputKind } from '../../config/frameworks.js'

/**
 * Emoji out of a generated UI, without asking a model.
 *
 * This is the one rewrite in the fixups that is not about a fatal failure, and
 * the exception is measured rather than argued. The build prompt bans emoji in
 * capitals, `auditAiTells` reports them, and the repair loop hands them back —
 * and a model fixed `emoji` 6 times in 40 (FIX_RATE) while 26 of 30 were still
 * there at the end of the run (SURVIVAL). Of the 80 most recent documents in S3,
 * 15 shipped with emoji in their source, 38 occurrences between them.
 *
 * The occurrences have two shapes, and both are mechanical:
 *
 *   <div className="empty-icon">📋</div>          an icon slot holding a glyph
 *   <button>📥 CSVエクスポート</button>            a glyph in front of a label
 *
 * An element whose whole text is emoji becomes an inline line icon — the drawing
 * the prompt asked for in the first place, chosen by what the glyph depicts, a
 * plain circle when nothing matches. Everywhere else the glyph and the space
 * after it are removed, which is what the audit's own instruction says to do
 * with a decorative one: 「装飾目的の絵文字は置き換えではなく削除してください」.
 *
 * The icons are drawn here, not taken from a set, and carry `aria-hidden` —
 * the label beside them or the element's `aria-label` already says what they
 * mean, and in the 38 measured occurrences one always did.
 */

/** The ranges `design-audit.ts` counts, plus the joiner that glues a sequence into one glyph. */
const EMOJI_CLASS =
  '\\u{1F300}-\\u{1F5FF}\\u{1F600}-\\u{1F64F}\\u{1F680}-\\u{1F6FF}\\u{1F900}-\\u{1F9FF}\\u{1FA70}-\\u{1FAFF}' +
  '\\u{1F1E6}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2705}\\u{2728}\\u{274C}\\u{2764}\\u{2B50}\\u{1F004}\\u{2B07}\\u{2B06}\\u{2934}\\u{2935}\\u{2714}\\u{2716}'

/**
 * Marks a product legitimately typesets, kept exactly as the audit keeps them.
 * Duplicated rather than imported: this module sits below the orchestration
 * layer and must not pull the audits into every fixup bundle.
 */
const TYPOGRAPHIC_MARKS = new Set(['★', '☆', '☐', '☑', '☒', '⚠', '♠', '♣', '♥', '♦'])

/** One glyph: a base, any variation selectors and joined parts. */
const GLYPH = new RegExp(`[${EMOJI_CLASS}](?:\\u{FE0F}|\\u{200D}[${EMOJI_CLASS}])*\\u{FE0F}?`, 'gu')

/** Element text that is nothing but glyphs. */
const GLYPH_ONLY_CONTENT = new RegExp(`>(\\s*)((?:[${EMOJI_CLASS}](?:\\u{FE0F}|\\u{200D}[${EMOJI_CLASS}])*\\u{FE0F}?\\s*)+)(<)`, 'gu')

/** Paths drawn on a 24-unit grid with a 1.5 stroke, to match the prompt's icon rule. */
const ICONS: { glyphs: string; d: string }[] = [
  { glyphs: '📭📬📥📤📦🗃🗄', d: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6l2-8z' },
  { glyphs: '📊📈📉💹', d: 'M4 20V11M10 20V5M16 20v-6M3 20h18' },
  { glyphs: '📅📆🗓⏰⏱🕐', d: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4' },
  { glyphs: '📋📄📝🗒📃📑📰', d: 'M6 3h9l3 3v15H6V3zM9 11h6M9 15h6' },
  { glyphs: '🔍🔎', d: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4' },
  { glyphs: '👤👥🧑👨👩🙋', d: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' },
  { glyphs: '🗑', d: 'M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3' },
  { glyphs: '⚙🔧🛠', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1' },
  { glyphs: '✅✔☑', d: 'M5 12l5 5L20 7' },
  { glyphs: '❌✖⛔🚫', d: 'M6 6l12 12M18 6L6 18' },
  { glyphs: '⬇⤵💾', d: 'M12 4v12M6 10l6 6 6-6M4 20h16' },
  { glyphs: '⬆⤴', d: 'M12 20V8M6 14l6-6 6 6M4 4h16' },
  { glyphs: '🔔', d: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 21h4' },
  { glyphs: '🏠🏢🏬', d: 'M3 11l9-7 9 7M5 10v10h14V10' },
  { glyphs: '💰💴💵💳🪙', d: 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  { glyphs: '🛒🛍', d: 'M3 4h2l2 12h11l2-8H6M9 20h.01M17 20h.01' },
  { glyphs: '✉📧📨📩', d: 'M3 6h18v12H3zM3 7l9 6 9-6' },
  { glyphs: '📷📸🖼', d: 'M4 7h4l2-2h4l2 2h4v12H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z' },
  { glyphs: '📚📖📕📗📘📙', d: 'M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5zM6 19h12' },
  { glyphs: '⭐🌟✨', d: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z' },
  { glyphs: '🔒🔐🔑', d: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4' },
  { glyphs: '📍🗺📌', d: 'M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z' },
  { glyphs: '💡', d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z' },
  { glyphs: '📞☎📱', d: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z' },
]
const FALLBACK = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'

function iconFor(glyphs: string): string {
  const first = [...glyphs.replace(/[\u{FE0F}\u{200D}\s]/gu, '')][0] ?? ''
  return ICONS.find((i) => i.glyphs.includes(first))?.d ?? FALLBACK
}

function svg(d: string, kind: OutputKind): string {
  // JSX spells SVG attributes in camelCase; a kebab-case one there is a React warning, which is a console error.
  const jsx = kind === 'react'
  const stroke = jsx
    ? 'strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"'
    : 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  return `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" ${stroke} aria-hidden="true"><path d="${d}" /></svg>`
}

const hasKeptMarksOnly = (glyphs: string): boolean =>
  [...glyphs.replace(/[\u{FE0F}\u{200D}\s]/gu, '')].every((c) => TYPOGRAPHIC_MARKS.has(c))

/** Files a glyph can be shown from. Stylesheets and prose are not the UI. */
const UI_FILE = /\.(tsx|jsx|vue|ts|js)$/

export function replaceEmoji(path: string, body: string, kind: OutputKind): { body: string; replaced: number; removed: number } {
  if (!UI_FILE.test(path)) return { body, replaced: 0, removed: 0 }
  let replaced = 0
  let removed = 0
  let out = body
  // Markup can only be in a component file; a `.ts` module's `>…<` is a comparison.
  if (/\.(tsx|jsx|vue)$/.test(path)) {
    out = out.replace(GLYPH_ONLY_CONTENT, (whole, _lead: string, glyphs: string) => {
      if (hasKeptMarksOnly(glyphs)) return whole
      replaced += 1
      return `>${svg(iconFor(glyphs), kind)}<`
    })
  }
  out = out.replace(new RegExp(`${GLYPH.source}[ \\u3000]?`, 'gu'), (whole) => {
    if (hasKeptMarksOnly(whole)) return whole
    removed += 1
    return ''
  })
  return { body: out, replaced, removed }
}
