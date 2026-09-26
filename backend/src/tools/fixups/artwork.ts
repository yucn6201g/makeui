/**
 * The drawing an empty screen was supposed to have, actually drawn.
 *
 * `imagery-missing` is the largest source-visible finding there is: measured
 * 2026-09-20 over the 34 stored project documents, 15 of them (44%) reach the
 * user with it open. The audit's own note says why it survives — it and `icons`
 * are "the only two defects in the set that cannot be satisfied by editing a
 * file that already exists", and the repair pass is told elsewhere to keep the
 * component structure as it is. It is fixed 41% of the time and survives half of
 * the runs it appears in.
 *
 * The finding has two halves, and the corpus splits them almost evenly:
 *
 *   9 of 34  no `src/components/illustrations/` at all
 *   6 of 34  the folder is there, three or four drawings in it, and NOTHING
 *            renders any of them
 *
 * The second half is the one worth pausing on. The build does the expensive
 * part — `EmptyCartIllustration`, `EmptySearchIllustration`, `Wordmark`, real
 * line art drawn in the project's own tokens — and then never imports it. The
 * reviewer sees a bare 「該当する商品がありません」 and the artwork sits in the
 * file list. Nothing about that needs a model: the drawing exists, the empty
 * state exists, and joining them is bookkeeping.
 *
 * WHERE IT GOES. Measured across the 17 documents that report either finding:
 * all 17 have somewhere to put a drawing — 15 have an element whose class says
 * it is an empty state, 10 have a component file named for one, and every one
 * has at least one of the two. A component is preferred when both exist,
 * because one edit there reaches every screen that uses it.
 *
 * WHAT IS CREATED when the folder is absent: one drawing, not the three the
 * repair instruction asks for. The check is `used.length === 0`, and three files
 * with one of them drawn is the same shape the audit was written to stop — the
 * cheap half of the requirement paid and the expensive half skipped.
 */

import { FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'

export const ART_DIR = 'src/components/illustrations/'

/** The component written when the project drew nothing to use. */
export const CREATED_ART = 'EmptyStateArt'

/**
 * A generic empty state: a tray with two sheets settling into it.
 *
 * Stroke only, 160px, and coloured from `--border` and `--text-muted` — the
 * contract the repair instruction states, so a drawing written here and a
 * drawing written by a repair look like the same product. Not an enlarged icon:
 * the shapes are at a size that only works at this size.
 */
const EMPTY_STATE_SVG = `<svg
    viewBox="0 0 160 160"
    width="160"
    height="160"
    fill="none"
    role="presentation"
    aria-hidden="true"
  >
    <path
      d="M30 98 L46 46 h68 l16 52"
      stroke="var(--border)"
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <path
      d="M30 98 v22 a10 10 0 0 0 10 10 h80 a10 10 0 0 0 10-10 V98 Z"
      stroke="var(--border)"
      stroke-width="2"
      stroke-linejoin="round"
    />
    <path
      d="M30 98 h28 l8 13 h28 l8-13 h28"
      stroke="var(--text-muted)"
      stroke-width="2"
      stroke-linejoin="round"
    />
    <path d="M56 34 h48" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" />
    <path d="M66 20 h28" stroke="var(--border)" stroke-width="2" stroke-linecap="round" />
  </svg>`

/** The created drawing, as a file this framework can compile. */
export function emptyStateArt(kind: OutputKind): string {
  if (kind === 'vue') {
    return `<template>\n  ${EMPTY_STATE_SVG}\n</template>\n`
  }
  return (
    `export default function ${CREATED_ART}() {\n` +
    `  return (\n    ${EMPTY_STATE_SVG.replace(/stroke-(width|linejoin|linecap)=/g, (_m, p) => `stroke${p[0].toUpperCase()}${p.slice(1)}=`)}\n  );\n}\n`
  )
}

/** The component name a file under `illustrations/` declares. */
export function artName(path: string): string {
  return path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
}

/**
 * Whether the file exports its component as the default or by name.
 *
 * Both are written by real builds, and an import of the wrong one is a compile
 * error rather than a missing picture — which would turn a cosmetic finding into
 * a blank screen.
 */
export function isDefaultExport(source: string): boolean {
  return /\bexport\s+default\b/.test(source)
}

/** `../components/illustrations/X`, from the file doing the importing. */
export function importPath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1)
  const toParts = to.replace(/\.[^./]+$/, '').split('/')
  let shared = 0
  while (shared < fromParts.length && shared < toParts.length - 1 && fromParts[shared] === toParts[shared]) shared++
  const up = fromParts.length - shared
  const rel = [...(up > 0 ? Array(up).fill('..') : ['.']), ...toParts.slice(shared)].join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

/**
 * A drawing that reads as an empty state, preferred over one that does not.
 *
 * A project with `EmptyCartIllustration` and `Wordmark` should put the cart in
 * the empty state and not the logo; with nothing named for the job, the first is
 * as good an answer as any and better than none.
 */
export function pickArtwork(
  paths: string[],
  place: 'empty' | 'header' = 'empty',
  /** The file the drawing is going into, which is a hint about which one fits. */
  host = ''
): string | undefined {
  const wordmark = paths.find((p) => /wordmark|logo|brand/i.test(artName(p)))
  if (place === 'header') return wordmark
  const others = paths.filter((p) => p !== wordmark)
  /*
   * A project with `EmptyCartIllustration` and `EmptySearchIllustration` should
   * put the cart one on the cart screen. Matched on the words the two names
   * share, after dropping the words every one of them contains — without that,
   * `EmptyCartIllustration` matches `EmptyRoomScreen` on the word "empty" and
   * the choice is whichever came first.
   */
  const words = (name: string) =>
    name
      .replace(/(?:Empty|No|Illustration|Screen|Page|View|Art|State)/g, ' ')
      .split(/(?=[A-Z])|[^A-Za-z]+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 3)
  const hostWords = new Set(words(artName(host)))
  const matched = hostWords.size > 0
    ? others.find((p) => words(artName(p)).some((w) => hostWords.has(w)))
    : undefined
  return matched
    ?? others.find((p) => /empty|nodata|none|placeholder/i.test(artName(p)))
    ?? others[0]
    ?? paths[0]
}

export interface ArtHost {
  path: string
  /** Where the drawing is inserted: just past the host element's opening tag. */
  at: number
  /** The indentation of the element it goes inside. */
  indent: string
  /** What kind of place it is, which decides which drawing belongs in it. */
  place: 'empty' | 'header'
  /**
   * An icon standing in for the drawing, to be replaced rather than joined.
   *
   * Measured 2026-09-20 over the 28 documents this pass edits: 8 of them
   * already draw something as the first child of the empty state, and every one
   * of the 8 is an ICON doing an illustration's job — `<EmptyIcon />`,
   * `<EmptyReservationIcon />`, `<DeckIcon size={40} />`,
   * `<svg className="cds-empty-state-icon">`. A user saw the result of joining
   * them: 「カートが空のときのカード画面の妙な位置に検索マークが表示されている」,
   * which is `<EmptyStateArt />` inserted above the `<SearchIcon />` the build
   * had already put there.
   *
   * Replacing is also what the contract asks for in its own words — 「アイコンを
   * 拡大したものにしない」 — so an enlarged icon there is the defect, not a
   * second picture's excuse to stand beside it.
   */
  replaces?: { at: number; end: number }
}

/** The opening tag starting at `at`, skipping any `>` inside a value or expression. */
function openingTagEnd(source: string, at: number): number | null {
  let depth = 0
  let quote = ''
  for (let i = at; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') { depth++; continue }
    if (c === '}') { depth--; continue }
    if (c === '>' && depth === 0) return source[i - 1] === '/' ? null : i + 1
  }
  return null
}

/**
 * The element a drawing belongs inside, in one file.
 *
 * An element whose class names it an empty state; failing that, the brand
 * corner of the shell, which is where a wordmark goes. Self-closing elements are
 * refused — there is nothing to put a child inside of.
 */
function hostElements(source: string, pattern: RegExp, place: 'empty' | 'header'): ArtHost[] {
  const out: ArtHost[] = []
  // A fresh regex each time: `matchAll` on a shared /g literal would resume
  // from wherever the previous file left it.
  for (const m of source.matchAll(new RegExp(pattern.source, pattern.flags))) {
    // Only the container pattern is filtered: the art-slot pattern matches
    // `empty-state__art` on purpose, and the `__` rule threw it away.
    if (pattern === EMPTY_ELEMENT && EMPTY_PART.test(m[2] ?? '')) continue
    const end = openingTagEnd(source, m.index ?? 0)
    if (end === null) continue
    /*
     * Nothing goes into an art SLOT that is already occupied.
     *
     * cf5b4848's `empty-state__art` holds `<CalendarXIcon />` — an icon rather
     * than an illustration, so the audit still reports the document, and a
     * second graphic on top of the first would be worse than the finding.
     *
     * Only the slot, and only its first line. Run over a CONTAINER this is
     * wrong: an empty state whose action button carries an icon three elements
     * down has nothing drawn where the illustration goes, and reading 400
     * characters forward from a container took imagery-missing from 0 back to
     * 2 of 34 and from 1 back to 5 of 41.
     */
    if (pattern === EMPTY_ART_SLOT && ALREADY_DRAWN.test(source.slice(end, end + 120))) continue
    /*
     * And what is already the first thing inside decides the rest. An icon
     * standing in for the drawing is replaced; any other graphic means the
     * place is taken and this is not a host. See `replaces`.
     */
    const standing = firstGraphic(source, end)
    if (standing && !standing.isIcon) continue
    const lineStart = source.lastIndexOf('\n', m.index ?? 0) + 1
    out.push({
      path: '',
      at: end,
      indent: /^\s*/.exec(source.slice(lineStart))?.[0] ?? '',
      place,
      ...(standing ? { replaces: { at: standing.at, end: standing.end } } : {}),
    })
  }
  return out
}

const EMPTY_ELEMENT = /<([a-z][\w-]*)\s[^<]{0,400}?\b(?:class|className)\s*=\s*["'{`][^"'`}]*\b([\w-]*empty[\w-]*)\b/gi

/**
 * The container, not the words inside it.
 *
 * `[\w-]*empty[\w-]*` also matches `empty-state__title` and
 * `empty-state__message`, so the first version of this pass put a 160px drawing
 * inside the `<h2>` and again inside the `<p>` — four "hosts" in one screen that
 * has one empty state. A BEM element is never the container, and neither is a
 * class that names a part of one.
 */
const EMPTY_PART = /__|-(?:title|heading|subtitle|message|text|description|hint|label|action|actions|button|btn|icon|image|img)$/i

/**
 * Except the one BEM child that IS the place a drawing goes.
 *
 * `<div className="empty-state__art">` is a slot the build cut for artwork and
 * then left empty — the rule above threw it out with the titles and the
 * messages, and one document of 41 kept the finding because of it. Preferred
 * over the container when a file has both, or the drawing would land twice.
 *
 * `__icon` and `__image` are deliberately NOT here: both routinely already hold
 * something, and this pass does not look at what is inside its host.
 */
const EMPTY_ART_SLOT = /<([a-z][\w-]*)\s[^<]{0,400}?\b(?:class|className)\s*=\s*["'{`][^"'`}]*\b([\w-]*empty[\w-]*(?:art|illustration|figure|graphic|visual)[\w-]*)\b/gi
/**
 * The shell's brand corner.
 *
 * Only ever given a wordmark — see `pickArtwork`. One document in the corpus
 * (doc29) carries four drawings, renders none of them, and has no empty state
 * anywhere to put one in; a `Wordmark` in the header is the placement its own
 * repair instruction names, and a tray illustration there would be worse than
 * the finding.
 */
const HEADER_ELEMENT = /<(?:header\s[^<]{0,400}?|[a-z][\w-]*\s[^<]{0,400}?\b(?:class|className)\s*=\s*["'{`][^"'`}]*\b[\w-]*(?:brand|logo|wordmark)[\w-]*\b)/gi

/**
 * Whether anything puts this file on screen.
 *
 * The first version of this pass preferred a component file named for an empty
 * state, on the reasoning that one edit there reaches every screen using it.
 * Measured on doc25, which is exactly why the reasoning has to be checked: the
 * project has `src/components/ui/EmptyState.tsx`, four screens that each write
 * their own `.empty-state` markup, and NOTHING that imports the component. The
 * drawing went into the dead component, `renderedFrom` then saw the illustration
 * named somewhere and the finding closed with the screen still bare — which is
 * the exact failure the audit's own note describes: 「ファイルを作るだけでは
 * 不十分です」 satisfied on paper.
 *
 * A screen counts on its own: it is routed by the router, which reaches it by a
 * name this cannot follow through a lookup table. Anything else has to be
 * rendered by name somewhere.
 */
function isReachable(files: Map<string, string>, path: string): boolean {
  if (/^src\/(?:App|main)\.[^./]+$/.test(path)) return true
  if (/(?:^|\/)screens?\//i.test(path)) return true
  const name = artName(path)
  for (const [other, body] of files) {
    if (other === path) continue
    for (const local of localNamesFor(body, name)) {
      if (new RegExp(`<${local}(?![\\w$])`).test(body)) return true
    }
  }
  return false
}

/** A graphic already standing where one would be put. */
const ALREADY_DRAWN = /<svg[\s>]|<[A-Z][A-Za-z0-9]*(?:Icon|Illustration|Art|Figure|Graphic|Logo|Wordmark|Image)(?![\w$])|<img[\s>]/

/**
 * The graphic that is the first thing inside a host, if there is one.
 *
 * Only the FIRST element counts: a graphic further down is an icon on an action
 * button, not the picture of the empty state. Its extent is returned so a
 * caller can take it out, which is why a self-closing element and a paired one
 * are measured rather than just matched.
 */
function firstGraphic(
  source: string,
  from: number
): { at: number; end: number; isIcon: boolean } | null {
  const rest = source.slice(from)
  const lead = /^\s*/.exec(rest)?.[0].length ?? 0
  const tag = /^<([A-Za-z][\w.-]*)((?:[^<>"'{]|"[^"]*"|'[^']*'|\{[^{}]*\})*?)(\/?)>/.exec(rest.slice(lead))
  if (!tag) return null
  const [whole, name, attrs, selfClosing] = tag
  const at = from + lead
  const isGraphic =
    /^(?:svg|img|picture)$/i.test(name) ||
    /^[A-Z][A-Za-z0-9]*(?:Icon|Illustration|Art|Figure|Graphic|Logo|Wordmark|Image)$/.test(name)
  if (!isGraphic) return null
  // An icon is doing an illustration's job here; anything else is the drawing.
  const isIcon = /Icon$/.test(name) || (/^svg$/i.test(name) && /\bicon\b|[-_]icon/i.test(attrs))
  if (selfClosing) return { at, end: at + whole.length, isIcon }
  const close = source.indexOf(`</${name}>`, at + whole.length)
  if (close === -1) return { at, end: at + whole.length, isIcon }
  return { at, end: close + `</${name}>`.length, isIcon }
}

/**
 * Whether the project would still draw this graphic after it is taken out here.
 *
 * An inline `<svg>` is nobody's file, so removing it orphans nothing. A
 * component is counted across the whole project, minus this one use.
 */
function stillUsedElsewhere(
  files: Map<string, string>,
  path: string,
  source: string,
  range: { at: number; end: number }
): boolean {
  const name = /^<([A-Za-z][\w.-]*)/.exec(source.slice(range.at, range.end))?.[1]
  if (!name || !/^[A-Z]/.test(name)) return true
  const tag = new RegExp(`<${name}(?![\\w$])`, 'g')
  let uses = 0
  for (const [other, body] of files) {
    const text = other === path ? source.slice(0, range.at) + source.slice(range.end) : body
    uses += (text.match(tag) ?? []).length
  }
  return uses > 0
}

/** The same host, placed in the FILE rather than in the markup slice. */
function shift(host: ArtHost, path: string, offset: number): ArtHost {
  return {
    ...host,
    path,
    at: host.at + offset,
    ...(host.replaces
      ? { replaces: { at: host.replaces.at + offset, end: host.replaces.end + offset } }
      : {}),
  }
}

/** The markup half of a file, and how far into the file it starts. */
function markupOf(body: string, kind: OutputKind): { source: string; offset: number } {
  if (kind !== 'vue') return { source: body, offset: 0 }
  const m = /<template>([\s\S]*)<\/template>/.exec(body)
  return m ? { source: m[1], offset: (m.index ?? 0) + 10 } : { source: '', offset: 0 }
}

/**
 * Every empty state in the project that a reviewer can actually reach.
 *
 * All of them, not the first: a storefront with four bare empty states is four
 * bare screens, and the finding closing after one of them is the paper version
 * of the fix. Capped, because one screen can hold a list, a filtered list and a
 * search result, and six drawings is already more than anybody will page
 * through.
 *
 * Failing all of them, the shell's brand corner — which only ever receives a
 * wordmark the project already drew. See `pickArtwork`.
 */
export function findArtHosts(files: Map<string, string>, kind: OutputKind): ArtHost[] {
  const ext = FRAMEWORKS[kind].componentExt
  const candidates = [...files.keys()].filter(
    (p) => p.endsWith(ext) && !p.startsWith(ART_DIR) && isReachable(files, p)
  )

  const empties: ArtHost[] = []
  for (const path of candidates) {
    const { source, offset } = markupOf(files.get(path) ?? '', kind)
    if (!source) continue
    // The slot the build cut for artwork, when it cut one; the container
    // otherwise. Per file, so a file with both is not drawn into twice.
    const slots = hostElements(source, EMPTY_ART_SLOT, 'empty')
    for (const found of slots.length > 0 ? slots : hostElements(source, EMPTY_ELEMENT, 'empty')) {
      /*
       * An icon may only be replaced while the project still draws it
       * elsewhere. Taking out its last use orphans the file, and `icons` — the
       * finding that reports a project rendering none of its glyphs — goes from
       * 12 to 13 of 34 and 10 to 11 of 41. Trading one finding for another is
       * not a repair.
       */
      if (found.replaces && !stillUsedElsewhere(files, path, source, found.replaces)) continue
      empties.push(shift(found, path, offset))
      if (empties.length >= MAX_HOSTS) return empties
    }
  }
  if (empties.length > 0) return empties

  for (const path of candidates) {
    const { source, offset } = markupOf(files.get(path) ?? '', kind)
    if (!source) continue
    const [header] = hostElements(source, HEADER_ELEMENT, 'header')
    if (header) return [shift(header, path, offset)]
  }
  return []
}

const MAX_HOSTS = 6

/**
 * Components in `dir`, and the ones something else actually puts on screen.
 *
 * `icons` and `imagery-missing` asked whether the folder existed. Their own
 * instructions say 「ファイルを作るだけでは不十分です」 and then nothing checked
 * it, so a repair could create three files, satisfy the finding, and leave the
 * reviewer looking at a screen with no artwork on it. Measured across the
 * corpus: 127 documents have an illustrations/ folder and render none of it,
 * 106 the same for icons/, and 1,356 art files in total that nothing uses.
 *
 * Used means rendered as a tag, or named on a line that is not an import — an
 * icon can legitimately be handed around as a value:
 *
 *     icon: item.id === 'cart' ? CartIcon : undefined
 *
 * A bare `import CartIcon from …` with no other mention is not use; that is
 * exactly the shape 76 of these files have.
 */
/**
 * Which components in a directory something else actually renders.
 *
 * Exported because the SCORE has to ask the same question. It awarded up to 6
 * points for three files existing under `src/components/illustrations/`, and the
 * audit then reported those same files for not being drawn anywhere — measured
 * on 75 stored documents, 47 of the 56 that had the directory rendered none of
 * it, and all 47 had an empty state elsewhere that drew something else instead.
 * The cheap half of the requirement paid, the expensive half did not, and a
 * repair call was spent afterwards closing the gap at a 41% success rate.
 *
 * One definition, so the two cannot drift into rewarding what the other reports.
 */
export function renderedFrom(
  files: Map<string, string>,
  dir: string,
  ext: string
): { all: string[]; used: string[] } {
  const all = [...files.keys()].filter((p) => p.startsWith(dir) && p.endsWith(ext))
  const used = all.filter((path) => {
    const name = artName(path)
    if (!name) return false
    for (const [other, body] of files) {
      if (other === path) continue
      for (const local of localNamesFor(body, name)) {
        if (new RegExp(`<${local}(?![\\w$])`).test(body)) return true
        const word = new RegExp(`(?<![\\w$])${local}(?![\\w$])`)
        for (const line of body.split('\n')) {
          if (/^\s*(?:import|export)\b/.test(line)) continue
          if (word.test(line)) return true
        }
      }
    }
    return false
  })
  return { all, used }
}

/**
 * Every name one file could be rendering another file's component under.
 *
 * This used to be the component's own name and nothing else, and that read a
 * drawn illustration as an undrawn one:
 *
 *     import { EmptyState as EmptyStateIllustration } from '../illustrations/EmptyState';
 *     …
 *     <EmptyStateIllustration />
 *
 * `<EmptyState` does not match `<EmptyStateIllustration` — the lookahead is
 * there so that `CartIcon` is not found inside `CartIconButton` — and the import
 * line where the alias is declared is skipped, because an import is not a use.
 * So the document was told 「空状態などの図版を4個描いてありますが、どの画面にも
 * 表示されていません」 about a drawing that was on screen. Aliasing is the
 * OBVIOUS thing to do here: a project whose empty-state component is called
 * `EmptyState` has to rename the illustration of the same name to import it, and
 * this is the shape a build reaches for when it does.
 *
 * Imports are matched by the specifier's last segment rather than by resolving
 * the path. `../illustrations/EmptyState` and `./EmptyState` both name the same
 * file when only one file in the project has that name, and every one of these
 * directories holds names that are unique across the project.
 */
function localNamesFor(body: string, name: string): string[] {
  const locals = new Set([name])
  for (const m of body.matchAll(/import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const last = m[2].split('/').pop()?.replace(/\.[^.]+$/, '')
    if (last !== name) continue
    const clause = m[1]
    // `import X from …` and `import X, { … } from …`
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause)
    if (def) locals.add(def[1])
    // `import * as NS from …`
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (ns) locals.add(ns[1])
    /*
     * Only the binding for THIS component. Taking every identifier in the
     * clause would let `import { Other } from './EmptyState'` make `Other`'s
     * use count as `EmptyState` being drawn.
     */
    const braces = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? ''
    for (const named of braces.split(',')) {
      const pair = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(named)
      if (pair && pair[1] === name && pair[2]) locals.add(pair[2])
    }
  }
  return [...locals]
}
