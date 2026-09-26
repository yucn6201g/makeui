/**
 * The element a photograph goes in, found by matching tags.
 *
 * Split out of framework-fixups.ts, which is held under a line ceiling that
 * exists to catch a retired framework's repairs coming back in bulk; this is
 * the scanner for one repair and it reads on its own.
 *
 * Why a scanner and not a regular expression: the pattern this replaced read a
 * frame's child as the SIBLING that followed it, because a lazy `[\s\S]*?`
 * between an opening and a closing tag happily crosses whatever lies between.
 *
 *     <div className="product-image" />
 *     <div className="product-info"> … </div>
 *
 * matched as ONE frame whose child was the info block, and the repair swallowed
 * the product name and price into a ternary. It broke two documents that the
 * narrower pattern had correctly left alone.
 */

/**
 * An icon standing on top of a photograph, and where to cut it out.
 *
 * Reported by a user on a generated storefront: 「商品をクリックすると画像が表示
 * されるが、中心に検索マークが表示されている」. The detail screen drew
 *
 *     <div style={{ backgroundImage: 'url(…)', backgroundSize: 'cover',
 *                   display: 'flex', alignItems: 'center',
 *                   justifyContent: 'center' }}>
 *       <SearchIcon />
 *     </div>
 *
 * — a magnifier centred on the garment, with no handler behind it. It is the
 * `icons` incentive backfiring: the contract requires every glyph a project
 * draws to be rendered somewhere, the audit reports a project that renders
 * none, and a project holding one icon reaches for it wherever it wants a
 * graphic. A magnifier centred on a photograph means nothing and hides part of
 * the picture.
 *
 * Narrow on purpose: the element must carry the picture in its own style, the
 * icon must be its only child, and nothing may be listening for a click — a
 * zoom control that works is a control, not decoration. One document of 76.
 */
export function iconsOnPhotographs(source: string): Array<{ at: number; end: number }> {
  const out: Array<{ at: number; end: number }> = []
  for (const m of source.matchAll(/<(div|figure|span|a|button)\b((?:[^<>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)>/g)) {
    const [whole, tag, attrs] = m
    const at = m.index ?? 0
    if (!/background(?:Image)?\s*:\s*['"`]?url\(/i.test(attrs)) continue
    // A control is a control. Only decoration is removed.
    if (/\bon[A-Z]\w*\s*=|@click|v-on:click|href\s*=/.test(attrs)) continue
    if (tag === 'a' || tag === 'button') continue
    const close = matchingClose(source, at + whole.length, tag)
    if (close === -1) continue
    const child = source.slice(at + whole.length, close)
    if (!isSingleElement(child)) continue
    const name = /^\s*<([A-Za-z][\w.-]*)/.exec(child)?.[1] ?? ''
    const isIcon = /Icon$/.test(name) || (/^svg$/i.test(name) && /\bicon\b|[-_]icon/i.test(child.slice(0, 200)))
    if (!isIcon) continue
    out.push({ at: at + whole.length, end: close })
  }
  return out
}

/** An element whose class says a picture goes in it. */
export const PICTURE_FRAME = /class(?:Name)?\s*=\s*["'{][^"'}]*(?:image|photo|thumb|picture|visual)/i

/**
 * Every element whose class says a picture goes in it, holding nothing or one
 * thing.
 *
 * Tags are matched by depth counting rather than by a regular expression. The
 * regular expression this replaced could read a frame's child as the SIBLING
 * that followed it, because a lazy `[\s\S]*?` between an opening and a closing
 * tag happily crosses whatever lies between — see the note at the call site.
 *
 * `child` is the frame's entire content, and the caller is given it only when
 * it is one element and no text, or nothing at all.
 */
export function pictureFrames(source: string): Array<{
  at: number
  end: number
  tag: string
  attrs: string
  child: string
}> {
  const out: Array<{ at: number; end: number; tag: string; attrs: string; child: string }> = []
  for (const m of source.matchAll(/<(div|figure|span)\b([^>]*)>/g)) {
    const [whole, tag, attrs] = m
    const at = m.index ?? 0
    if (!PICTURE_FRAME.test(attrs)) continue
    // Skeletons are a loading state, and a loading state has no picture yet.
    if (/skeleton|loading|shimmer/i.test(attrs)) continue
    if (/\/\s*$/.test(attrs)) {
      // `<div className="product-image" />` — a frame with nothing in it, and
      // the shape the old pattern read as an opening tag with a stray slash.
      out.push({ at, end: at + whole.length, tag, attrs, child: '' })
      continue
    }
    const contentStart = at + whole.length
    const close = matchingClose(source, contentStart, tag)
    if (close === -1) continue
    const child = source.slice(contentStart, close)
    if (child.trim() && !isSingleElement(child)) continue
    out.push({ at, end: close + `</${tag}>`.length, tag, attrs, child })
  }
  /*
   * The OUTER of a nested pair, and only it.
   *
   * A detail screen writes `<div className="cds-detail-image">` around
   * `<div className="cds-image-placeholder" />` and both names say picture, so
   * both matched and their edits overlapped — applying them left the second
   * rewrite spliced into the middle of the first. The outer one is the frame
   * and the inner one is the stand-in it holds, which is exactly the shape the
   * fallback branch below is written for.
   */
  return out.filter((f, i) => !out.some((o, j) => j !== i && o.at <= f.at && f.end <= o.end && (o.at !== f.at || o.end !== f.end || j < i)))
}

/** Where `</tag>` closes the element whose content starts at `from`. */
function matchingClose(source: string, from: number, tag: string): number {
  const open = new RegExp(`<${tag}(?![\\w-])([^>]*)>`, 'g')
  const close = new RegExp(`</${tag}\\s*>`, 'g')
  let depth = 1
  let i = from
  for (let guard = 0; guard < 2000; guard++) {
    close.lastIndex = i
    const c = close.exec(source)
    if (!c) return -1
    open.lastIndex = i
    let o = open.exec(source)
    while (o && o.index < c.index) {
      // A self-closing one opens nothing.
      if (!/\/\s*$/.test(o[1])) depth++
      open.lastIndex = o.index + 1
      o = open.exec(source)
    }
    depth--
    if (depth === 0) return c.index
    i = c.index + c[0].length
  }
  return -1
}

/** Whether this content is exactly one element, with no text beside it. */
function isSingleElement(child: string): boolean {
  const body = child.trim()
  const head = /^<([A-Za-z]\w*)([^>]*)>/.exec(body)
  if (!head) return false
  if (/\/\s*$/.test(head[2])) return body.length === head[0].length
  const close = matchingClose(body, head[0].length, head[1])
  if (close === -1) return false
  return body.slice(close).trim() === `</${head[1]}>`
}
