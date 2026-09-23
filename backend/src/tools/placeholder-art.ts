/**
 * A drawing for a slot no photograph can fill.
 *
 * Half of every photograph slot in production ended as the neutral 「画像なし」
 * block — 42 of 84 over three weeks — and a catalogue of grey boxes is the
 * complaint this exists for. Some of those slots never had a photograph to find:
 * a news headline, a blog post, a product the CC0 library does not contain. A
 * page of those is not improved by saying "no image" twelve times.
 *
 * So the gap is drawn rather than announced: a quiet abstract panel derived from
 * the item's own name, with its first character set into it. It is deliberately
 * NOT a picture of anything — inventing a photograph of a product nobody
 * photographed is the failure this pipeline already fixed once, when three
 * garments were illustrated with two photographs of an office desk. An abstract
 * panel claims nothing while still reading as a designed surface.
 *
 * Deterministic: the same name always draws the same panel, so the catalogue is
 * stable across regenerations and every item on a page differs from its
 * neighbours. No model call, no network, no bytes to host — it is an inline data
 * URI like the block it replaces.
 *
 * Restrained on purpose. Saturation stays low and the shapes are pale, because
 * this lands inside somebody else's design system: a vivid panel would fight the
 * preset's palette, and twelve vivid panels would be the loudest thing on the
 * screen. The one thing it must never look like is a photograph.
 */

/** Same box as the neutral block it replaces, so a card's layout is unchanged. */
const WIDTH = 400
const HEIGHT = 300

/** FNV-1a: small, stable across processes, and good enough to spread hues. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The first character of the name, which in Japanese is already a word's worth
 * of meaning — 「騎士団長殺し」 shows 騎, 「カプチーノ」 shows カ. Latin names take
 * two letters, because a single Latin letter carries much less.
 *
 * Surrogate-aware: a name starting with an emoji or a rare kanji outside the
 * BMP would otherwise be cut in half and render as a replacement glyph.
 */
export function monogram(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) return ''
  const chars = [...trimmed]
  const first = chars[0]
  if (!/[A-Za-z0-9]/.test(first)) return first
  return chars.slice(0, 2).join('').toUpperCase()
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string
  )
}

/**
 * One of four compositions, chosen by the name.
 *
 * Four rather than one because a listing shows these side by side: a single
 * layout repeated twelve times reads as a rendering fault, which is the same
 * reason the photograph picker rotates through a subject's images.
 */
function shapes(seed: number, ink: string): string {
  const variant = seed % 4
  const o = (n: number) => (0.1 + ((seed >> (n * 3)) % 7) * 0.018).toFixed(3)
  if (variant === 0) {
    // Diagonal bands.
    return (
      `<path d="M-40 ${120 + (seed % 40)} L${WIDTH} ${-20 + (seed % 30)} L${WIDTH} ${60 + (seed % 30)} L-40 ${210 + (seed % 40)} Z" fill="${ink}" opacity="${o(0)}"/>` +
      `<path d="M-40 ${250 + (seed % 30)} L${WIDTH} ${110 + (seed % 30)} L${WIDTH} ${190 + (seed % 20)} L-40 ${HEIGHT + 40} Z" fill="${ink}" opacity="${o(1)}"/>`
    )
  }
  if (variant === 1) {
    // Concentric arcs from a corner.
    const cx = seed % 2 ? WIDTH - 40 : 40
    return [0, 1, 2, 3]
      .map((n) => `<circle cx="${cx}" cy="${HEIGHT - 30}" r="${70 + n * 55}" fill="none" stroke="${ink}" stroke-width="${14 - n * 2}" opacity="${o(n)}"/>`)
      .join('')
  }
  if (variant === 2) {
    // A field of dots, thinning towards one side.
    let out = ''
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 7; col++) {
        const r = 4 + ((seed >> (row + col)) % 9)
        out += `<circle cx="${30 + col * 57}" cy="${34 + row * 60}" r="${r}" fill="${ink}" opacity="${(0.08 + col * 0.018).toFixed(3)}"/>`
      }
    }
    return out
  }
  // Overlapping rounded panels.
  return (
    `<rect x="${30 + (seed % 40)}" y="40" width="200" height="200" rx="28" fill="${ink}" opacity="${o(0)}"/>` +
    `<rect x="${150 + (seed % 60)}" y="${90 + (seed % 30)}" width="220" height="170" rx="28" fill="${ink}" opacity="${o(1)}"/>`
  )
}

/**
 * The hue the document itself is built on.
 *
 * Read from the finished source rather than passed down from the preset, for two
 * reasons: it is the colour actually on the screen — a preset can be absent, and
 * a build can lean on one accent from within a palette — and it needs no
 * argument threaded through three call sites to get here.
 *
 * Near-neutrals are excluded (greys, near-white, near-black): every page is
 * mostly those, and the hue of a border is not the hue of the design. Undefined
 * when the document has no colour of its own, and the panel then takes a hue
 * from the item's name as before.
 */
export function dominantHue(source: string): number | undefined {
  const counts = new Map<number, number>()
  for (const m of source.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
    const r = parseInt(hex.slice(0, 2), 16) / 255
    const g = parseInt(hex.slice(2, 4), 16) / 255
    const b = parseInt(hex.slice(4, 6), 16) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    if (d < 0.12 || l > 0.93 || l < 0.07) continue
    let h = 0
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = Math.round(h * 60)
    if (h < 0) h += 360
    // Bucketed: a palette's ramp is one hue at several lightnesses, and counting
    // #1f6feb and #216fe0 as different colours would split its own vote.
    const bucket = Math.round(h / 15) * 15
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  let best: number | undefined
  let bestN = 0
  for (const [hue, n] of counts) if (n > bestN) { best = hue; bestN = n }
  return best
}

export interface ArtworkOptions {
  /**
   * The hue the surrounding design uses, 0-359, when it is known. Panels are
   * drawn next to it, one step off it, rather than at a hue of their own.
   */
  hue?: number
}

/**
 * A panel for this label, as a data URI.
 *
 * `role="img"` with the label as its accessible name: the element it lands in
 * usually has its own `alt`, but a background or a bare `src` does not, and a
 * decorative panel with no name is a screen reader reading out a data URI.
 */
export function artworkFor(label: string, options: ArtworkOptions = {}): string {
  const seed = hash(label || 'makeui')
  /**
   * One hue for the page, nudged per item — not a hue per item.
   *
   * Drawn from the name alone, a catalogue came out pink, green and purple down
   * one row, which reads as a fault rather than as a design (seen on the first
   * sheet of these). The caller passes the document's own hue, and each panel
   * sits a few degrees off it, so a listing looks like one set of things.
   */
  const given = options.hue !== undefined
  const base = given ? ((options.hue! % 360) + 360) % 360 : seed % 360
  const hueA = given ? (base + ((seed % 3) - 1) * 9 + 360) % 360 : base
  // A second hue close to the first: a two-stop ground reads as depth, while a
  // complementary pair reads as a gradient someone chose, which this is not.
  const hueB = (hueA + (given ? 12 : 24) + (seed % 10)) % 360
  const ground = `hsl(${hueA} 26% 93%)`
  const groundB = `hsl(${hueB} 24% 87%)`
  const ink = `hsl(${hueA} 38% 38%)`
  const id = `g${(seed % 100000).toString(36)}`
  const text = monogram(label)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" ` +
    `role="img" aria-label="${escapeXml(label || '画像')}">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${ground}"/><stop offset="1" stop-color="${groundB}"/>` +
    `</linearGradient></defs>` +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#${id})"/>` +
    shapes(seed, ink) +
    (text
      ? `<text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" dominant-baseline="central" ` +
        `font-family="sans-serif" font-size="96" font-weight="700" fill="${ink}" opacity="0.24">${escapeXml(text)}</text>`
      : '') +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
