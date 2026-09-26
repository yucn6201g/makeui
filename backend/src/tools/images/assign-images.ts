import {
  loadStockIndex,
  stockUrl,
  usablePhotographs,
  PHOTO_SLOT,
  type StockImage,
} from './stock-images.js'
import { matchSubject, matchSubjects, matchCategories, SUBJECT_CATEGORY } from './subject-terms.js'
import { artworkFor, dominantHue } from './placeholder-art.js'
import type { SubjectResolver } from './subject-resolve.js'
import { logger } from '../../utils/logger.js'

/**
 * Gives every picture on the page a reason to be that picture.
 *
 * The failure this exists for, measured on a real generated storefront:
 *
 *   name: 'オーガニックコットンTシャツ'  image: .../stock/office/35f3fd7a….jpg
 *   name: 'ウールニットセーター'        image: .../stock/workspace/c327….webp
 *   name: 'デニムジーンズ'              image: .../stock/office/4a2a….jpg
 *
 * Three garments illustrated with two photographs of an office. Nothing there
 * was broken in the way the pipeline knows how to look for — the URLs resolved,
 * the layout was fine, the audit was clean. It was simply wrong, and only a
 * person looking at it could tell.
 *
 * The cause was the shape of the offer: the assembler is handed a short list of
 * URLs for the whole screen and writes them wherever an image goes. A model has
 * no way to do better than that, because at the moment it writes the catalogue
 * it does not know which photograph is of what. So the assignment is taken away
 * from it and done here, per item, against the thing the item is called.
 *
 * Deterministic, no model call, and it runs after assembly on the finished
 * document — which is also the only point at which every item and its label
 * exist to be read.
 */

/** How the picture ended up where it is. Logged, so a bad page can be explained. */
export interface Assignment {
  label: string
  subject: string | null
  /**
   * `subject` — a photograph of the thing itself.
   * `category` — a photograph of the right KIND of thing.
   * `context` — the page's own domain decided it, because the name said nothing.
   * `artwork` — a drawn panel: nothing in the library is of this, or it is not a
   *   thing that can be photographed at all (a headline, an article).
   * `kept` — a picture that was already there and has no item to be wrong about.
   */
  outcome: 'subject' | 'category' | 'context' | 'artwork' | 'kept'
}

/** What the page is about, and how to ask about names the term list cannot place. */
interface AssignContext {
  /**
   * The user's brief. Used only as the last resort before drawing: a bookshop's
   * items are books even when every name on the page is a title.
   */
  brief?: string
  /**
   * Reads unresolved item names once per run. Injected rather than imported so
   * the tests stay hermetic — without it, nothing here makes a model call.
   */
  resolveNames?: SubjectResolver
  /** The design's own hue, so drawn panels sit beside the palette rather than across it. */
  hue?: number
}

interface AssignResult {
  html: string
  assignments: Assignment[]
  /** Slots that got a picture of what they are actually about. */
  matched: number
  /** Slots left with no photograph because the library has nothing relevant. */
  cleared: number
}

/**
 * The neutral block, moved to `stock-images` and imported.
 *
 * Two passes now need it — this one, and the invented-URL repair, which used to
 * substitute an arbitrary photograph from the library instead. One definition,
 * because the whole point of it is that a page shows the *same* honest gap
 * wherever a picture could not be chosen.
 */
function placeholder(label: string, hue?: number): string {
  /**
   * Drawn rather than announced, since 2026-09-18.
   *
   * The neutral block was right while a gap was rare. It is not what a page of
   * twelve gaps needs, and half of all slots were gaps: a listing of grey boxes
   * saying 「画像なし」 twelve times is the complaint this changed for. The panel
   * is still not a picture of anything — see placeholder-art.ts — so the rule
   * that a T-shirt is never illustrated with an office desk is untouched.
   *
   * NO_IMAGE stays exported and is still what the invented-URL repair falls back
   * to before this pass has run.
   */
  return artworkFor(label, hue === undefined ? {} : { hue })
}

/** The item label nearest to an offset: the `name`/`title` of the object it sits in. */
function labelForDataField(source: string, at: number): string {
  // Walk back to the opening brace of the enclosing object literal, so a field
  // in one product cannot read the name of the previous one.
  let depth = 0
  let start = -1
  for (let i = at; i >= 0 && at - i < 4000; i--) {
    const c = source[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) { start = i; break }
      depth--
    }
  }
  if (start === -1) return ''
  let end = source.indexOf('}', at)
  if (end === -1) end = Math.min(source.length, at + 2000)
  const block = source.slice(start, end)
  const m = block.match(/\b(?:name|title|label|productName|itemName|品名|名称)\s*:\s*(['"`])([^'"`]{1,80})\1/)
  return m ? m[2] : ''
}

/** The label nearest to an `<img>`: its own alt, else the closest preceding heading. */
function labelForImgTag(source: string, tagStart: number, tag: string): string {
  const alt = tag.match(/\balt\s*=\s*(['"])([^'"]{1,120})\1/)
  if (alt && alt[2].trim()) return alt[2]
  const before = source.slice(Math.max(0, tagStart - 1200), tagStart)
  const heads = [...before.matchAll(/<(h[1-6]|figcaption)[^>]*>([^<]{1,80})</g)]
  return heads.length ? heads[heads.length - 1][2].trim() : ''
}

/**
 * Rotates through a subject's photographs.
 *
 * Six products all matching `tshirt` must not all show the same shirt: an
 * identical thumbnail repeated down a catalogue reads as a rendering bug, and
 * it is the second most recognisable tell of a generated page after the
 * lavender gradient.
 */
function picker(rawLibrary: StockImage[]) {
  /**
   * Artwork out, best first. A catalogue handed out in collection order gave a
   * product card a clip-art illustration as readily as a photograph — and to
   * every check in the pipeline that is a URL that resolves.
   */
  const library = usablePhotographs(rawLibrary)
  const bySubject = new Map<string, StockImage[]>()
  const byCategory = new Map<string, StockImage[]>()
  for (const img of library) {
    if (!img.subject) continue
    const s = bySubject.get(img.subject) ?? []
    s.push(img)
    bySubject.set(img.subject, s)
    const c = byCategory.get(img.category) ?? []
    c.push(img)
    byCategory.set(img.category, c)
  }
  const used = new Map<string, number>()
  const take = (pool: StockImage[] | undefined, key: string): string | null => {
    if (!pool || pool.length === 0) return null
    const n = used.get(key) ?? 0
    used.set(key, n + 1)
    return stockUrl(pool[n % pool.length])
  }
  return {
    /**
     * A photograph of the subject, or of something else in its category, or
     * nothing.
     *
     * The category tier is not a loosening of the rule. If the label matched
     * `butter` we know for certain the item is food, so a photograph of cheese
     * is a picture of the right kind of thing — visibly better than a concrete
     * wall and honest about what it is. Only when nothing matched at all, and
     * we therefore know nothing, does it give up.
     */
    forSubject(subject: string): { url: string; tier: 'subject' | 'category' } | null {
      const exact = take(bySubject.get(subject), `s:${subject}`)
      if (exact) return { url: exact, tier: 'subject' }
      /**
       * Read from the table rather than from the library, because we are here
       * precisely because the library holds no image of this subject — there is
       * nothing to read the category off.
       */
      const category = SUBJECT_CATEGORY[subject]
      if (!category) return null
      const near = take(byCategory.get(category), `c:${category}`)
      return near ? { url: near, tier: 'category' } : null
    },
    /**
     * Any photograph of this kind of thing.
     *
     * For the case where the item's own name settles nothing and the page's
     * domain is all there is: 「アパレルのECサイト」 names `apparel`, so a garment
     * is the right kind of picture even though which garment is unknown.
     */
    forCategory(category: string): string | null {
      return take(byCategory.get(category), `c:${category}`)
    },
  }
}

const HOST = process.env.CLOUDFRONT_DOMAIN || ''

/**
 * Categories whose photographs are of a THING somebody lists, sells or books.
 *
 * Only these may be inferred from the brief. The others — `scene`, `place`,
 * `people`, `abstract` — are pictures of a setting, and a setting is never what
 * an item on a list IS: 「社内の承認ワークフローを管理する画面」 mentions an office,
 * and the first version of this fallback put a photograph of an office desk on a
 * card called 「商品A」. That is the exact failure the per-item assignment was
 * built to end, arriving through a new door. A drawn panel is the better answer
 * whenever all we know is the room the product is in.
 */
const GOODS = new Set(['food', 'drink', 'apparel', 'electronics', 'home', 'beauty', 'leisure', 'stationery'])

/**
 * The hue drawn panels take when the document declares no colour of its own.
 *
 * Something rather than nothing, because "nothing" means each panel derives its
 * own hue from its own name, and a catalogue of those came out pink, then green,
 * then purple down a single row. A slate blue is the least opinionated thing to
 * put next to a palette nobody described.
 */
const NEUTRAL_HUE = 215

/**
 * Reassigns every stock photograph in the document to match what it illustrates.
 *
 * Only touches URLs under our own stock path. A data URI the pipeline drew, an
 * SVG illustration, a user's uploaded image — none of those are ours to move,
 * and rewriting them would be this pass exceeding its remit.
 */

/**
 * Image hosts a generated project reaches for when left to itself.
 *
 * Measured across five real generations: 12 to 18 URLs each, every one of them
 * invented — `https://images.unsplash.com/photo-1521572163474-…?w=500&h=500`
 * with a photo id the model made up, `https://via.placeholder.com/…`,
 * `https://picsum.photos/…`.
 *
 * This is why the `__PHOTO__` slot was never used, and the diagnosis was not
 * "the model ignores the instruction". The model reliably writes something
 * image-shaped; it just writes a URL instead of the slot. So the slot count was
 * zero on every run while the pages were full of image sources.
 *
 * Three separate problems, and the licence one is the serious one:
 *
 *   - Unsplash's licence forbids redistribution, and redistribution is exactly
 *     what this product does: the image is embedded in a generated page,
 *     published on a URL and handed over inside a downloadable project. The
 *     library is CC0 precisely so that is allowed. `scripts/curate-images.mjs`
 *     says so at the top and names Unsplash as a source it will not use.
 *   - The URLs are invented, so they 404 or hotlink-block, which surfaces as a
 *     console error and an empty box.
 *   - `repairStockUrls` cannot help: it only rewrites URLs under our own CDN.
 *
 * Rewriting them to the slot turns the failure into the mechanism that was
 * built for it — `assignItemImages` then picks a real photograph per item from
 * the item's own name.
 */
const FOREIGN_IMAGE_HOSTS =
  /https?:\/\/(?:[\w-]+\.)*(?:unsplash\.com|picsum\.photos|placeholder\.com|placehold\.co|loremflickr\.com|dummyimage\.com|pexels\.com|pixabay\.com|cloudinary\.com|imgur\.com|gravatar\.com)[^"'`\s)]*/gi

/**
 * Replaces invented external image URLs with the slot token.
 *
 * Runs before the assignment pass, so everything downstream sees one kind of
 * "a picture goes here" rather than two.
 */
/**
 * A raster photograph on ANY host — the allow-list half.
 *
 * The list above names the hosts a model reaches for, and a licence guarantee
 * cannot rest on a list of offenders: `m.media-amazon.com`, `cdn.shopify.com`,
 * `upload.wikimedia.org` (whose licences vary picture by picture) and every
 * host nobody has thought of would ship untouched. Measured 2026-09-23 over 131
 * stored documents the only image host in any of them was our own CDN, so this
 * changes nothing that has happened — it makes 「必ず商用利用可能な画像」 a rule
 * rather than an observation.
 *
 * Raster only. An external .svg is an icon or a logo far more often than a
 * photograph, and a photo slot in its place would put a picture where a glyph
 * was. Our own CDN and data: URIs (which is what a user's own upload becomes)
 * never match.
 */
const ANY_RASTER = /https?:\/\/([\w.-]+)\/[^"'`\s)]*?\.(?:jpe?g|png|webp|gif|avif)(?:\?[^"'`\s)]*)?(?=["'`\s)])/gi

export function slotForeignImages(
  html: string,
  /**
   * The user's own words. A URL the user typed into the request is a picture
   * they chose and are answerable for, and replacing it would be overruling
   * them — so it is left exactly where it is.
   */
  userText = ''
): { html: string; replaced: number } {
  let replaced = 0
  const keep = (url: string) => userText.includes(url)
  let out = html.replace(FOREIGN_IMAGE_HOSTS, (url) => {
    if (keep(url)) return url
    replaced++
    return PHOTO_SLOT
  })
  out = out.replace(ANY_RASTER, (url, host: string) => {
    if (HOST && host.toLowerCase() === HOST.toLowerCase()) return url
    if (keep(url)) return url
    replaced++
    return PHOTO_SLOT
  })
  if (replaced > 0) {
    logger.info('Replaced invented external image URLs with photo slots', {
      replaced,
      why: 'not CC0, frequently invented, and this product redistributes what it embeds',
    })
  }
  return { html: out, replaced }
}

/**
 * Every label a picture in this document hangs off, in the order the passes
 * below will meet them.
 *
 * Collected before anything is rewritten, because the names have to be resolved
 * TOGETHER: asking a model once per item would be twelve calls on a catalogue
 * page, and asking it after the first rewrite would be asking about a document
 * that had already given up on half of them.
 */
function labelsInDocument(html: string, urlPattern: RegExp): string[] {
  const labels: string[] = []
  const add = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label)
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!m[0].match(urlPattern)) continue
    add(labelForImgTag(html, m.index ?? 0, m[0]))
  }
  for (const m of html.matchAll(urlPattern)) add(labelForDataField(html, m.index ?? 0))
  return labels
}

/**
 * An item's picture written as a name somebody made up.
 *
 * Measured on a real apparel storefront (2026-09-18): every product carried
 * `image: 'women-clothes-1'`, `image: 'wool-sweater'` — twelve of them, none a
 * URL, none the slot, none a file in the project. The model was told to write
 * `__PHOTO__` and wrote a plausible-looking identifier instead, which is the
 * same reflex that made it invent Unsplash URLs before `slotForeignImages`.
 *
 * To every check in the pipeline these are just strings; to a browser they are a
 * broken image, and in that storefront they were not even rendered — so the page
 * shipped with no photographs and nothing reported anything.
 *
 * Turning them into the slot puts them back on the path that was built for them:
 * the item's own name then chooses the photograph. Deliberately narrow — an
 * image-shaped FIELD whose value is a bare identifier. A path, a URL, a data
 * URI, an import or anything with spaces or punctuation is somebody's real
 * intention and is left exactly as it is.
 */
const INVENTED_IMAGE_VALUE = /\b(image|imageUrl|imageSrc|thumbnail|thumb|photo|picture|img)\s*:\s*(['"])([A-Za-z0-9][\w-]{2,60})\2/g

function slotInventedImageValues(html: string): { html: string; replaced: number } {
  let replaced = 0
  const out = html.replace(INVENTED_IMAGE_VALUE, (whole, key: string, quote: string, value: string) => {
    // A file in the project (`hero.png`) or a known token is a real reference.
    if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(value)) return whole
    if (value === PHOTO_SLOT) return whole
    replaced++
    return `${key}: ${quote}${PHOTO_SLOT}${quote}`
  })
  if (replaced > 0) {
    logger.info('Replaced invented image identifiers with photo slots', {
      replaced,
      why: 'a name nobody can resolve is a broken image; the slot lets the item name choose the photograph',
    })
  }
  return { html: out, replaced }
}

export async function assignItemImages(html: string, context: AssignContext = {}): Promise<AssignResult> {
  // Invented external URLs become slots first, so everything below sees one
  // kind of "a picture goes here".
  const foreign = slotForeignImages(html, context.brief ?? '')
  html = foreign.html
  const invented = slotInventedImageValues(html)
  html = invented.html
  const hasSlot = html.includes(PHOTO_SLOT)
  const hasStock = Boolean(HOST) && html.includes(`${HOST}/stock/`)
  if (!hasSlot && !hasStock) return { html, assignments: [], matched: 0, cleared: 0 }

  const library = await loadStockIndex()
  /**
   * With no library there is still work to do, and it is the important kind.
   *
   * A slot token is not a URL — it is a string the assembler was told to write
   * and that only this pass knows how to remove. Returning early on an empty
   * library would ship `src="__PHOTO__"` to the user as a broken image on every
   * product card, which is a far worse outcome than the missing photograph it
   * stands for.
   */
  if (library.length === 0) {
    if (!hasSlot) return { html, assignments: [], matched: 0, cleared: 0 }
    let n = 0
    const stripped = html.replace(new RegExp(PHOTO_SLOT, 'g'), (_m, offset: number) => {
      n++
      return placeholder(labelForDataField(html, offset), context.hue)
    })
    logger.info('No photograph library available; slots left as placeholders', { slots: n })
    return { html: stripped, assignments: [], matched: 0, cleared: n }
  }

  const pick = picker(library)
  // The document's own accent, so a drawn panel belongs to this design rather
  // than to a hue of its own. Computed once; the source does not change under us.
  const hue = context.hue ?? dominantHue(html) ?? NEUTRAL_HUE
  const assignments: Assignment[] = []
  let matched = 0
  let cleared = 0

  /**
   * Both things a picture can currently be: a real URL the assembler chose, and
   * a slot it was told to leave. They are handled identically from here — the
   * question in each case is what the thing next to it is called.
   */
  const urlPattern = new RegExp(
    `https://${HOST.replace(/\./g, '\\.')}/stock/[^"'\\s)\`]+|${PHOTO_SLOT}`,
    'g'
  )

  /**
   * What each name is a picture of.
   *
   * Three sources, cheapest first, and each only asked what the one before it
   * could not answer:
   *
   *   1. the term list, which is a substring test and free;
   *   2. a model, once, for the names left over — 「カプチーノ」 is coffee and
   *      「騎士団長殺し」 is a book, and no list of terms was ever going to say so;
   *   3. the page's own domain, for names that settle nothing either way.
   *
   * Whatever remains is drawn rather than photographed.
   */
  const subjects = new Map<string, string | null>()
  const unresolved: string[] = []
  for (const label of labelsInDocument(html, urlPattern)) {
    const direct = matchSubject(label)
    subjects.set(label, direct)
    if (!direct) unresolved.push(label)
  }
  if (unresolved.length > 0 && context.resolveNames) {
    const named = await context.resolveNames(unresolved, context.brief)
    for (const [label, subject] of named) if (subject) subjects.set(label, subject)
  }

  /**
   * The page's domain, as a subject and as a category.
   *
   * Used only when a name resolved to nothing at all, and only when the brief
   * names ONE thing — a brief mentioning three subjects tells us nothing about
   * which of them a particular card is, and guessing there is how a page gets an
   * illustration that contradicts its own label.
   */
  const briefSubjects = matchSubjects(context.brief ?? '').filter((s) => GOODS.has(SUBJECT_CATEGORY[s]))
  const briefCategory = matchCategories(context.brief ?? '').find((c) => GOODS.has(c))
    ?? (briefSubjects.length === 1 ? SUBJECT_CATEGORY[briefSubjects[0]] : undefined)
  const contextSubject = briefSubjects.length === 1 ? briefSubjects[0] : undefined

  /**
   * A picture for this name, and how it was arrived at. Returns null when the
   * answer is a drawn panel.
   */
  const choose = (label: string): { url: string; subject: string | null; tier: 'subject' | 'category' | 'context' } | null => {
    const subject = subjects.get(label) ?? matchSubject(label)
    if (subject) {
      const chosen = pick.forSubject(subject)
      if (chosen) return { url: chosen.url, subject, tier: chosen.tier }
      return null
    }
    if (!label) return null
    if (contextSubject) {
      const chosen = pick.forSubject(contextSubject)
      if (chosen) return { url: chosen.url, subject: contextSubject, tier: 'context' }
    }
    if (briefCategory) {
      const url = pick.forCategory(briefCategory)
      if (url) return { url, subject: null, tier: 'context' }
    }
    return null
  }

  // Pass 1: <img> tags, where the label is the alt text or the heading above it.
  let out = html.replace(/<img\b[^>]*>/gi, (tag, offset: number) => {
    const url = tag.match(urlPattern)
    if (!url) return tag
    const label = labelForImgTag(html, offset, tag)
    const chosen = choose(label)
    if (!chosen) {
      assignments.push({ label, subject: subjects.get(label) ?? null, outcome: 'artwork' })
      cleared++
      return tag.replace(urlPattern, placeholder(label, hue))
    }
    assignments.push({ label, subject: chosen.subject, outcome: chosen.tier })
    matched++
    return tag.replace(urlPattern, chosen.url)
  })

  // Pass 2: data fields, where the label is the name in the same object literal.
  // Run second and over the already-rewritten document so an <img> whose src is
  // a literal URL is not reconsidered here.
  out = out.replace(urlPattern, (url, offset: number) => {
    const label = labelForDataField(out, offset)
    const chosen = choose(label)
    if (!chosen) {
      /**
       * No label to go on is a different case from a label that matched
       * nothing: a hero band or a background has no item name and never had
       * one, and blanking it would remove a picture that was fine.
       *
       * A slot token is the exception, and must never be kept — it is not a
       * picture, it is an instruction to this pass, and leaving it in place
       * ships the literal string `__PHOTO__` as an image source.
       */
      if (!label && url !== PHOTO_SLOT) {
        assignments.push({ label: '', subject: null, outcome: 'kept' })
        return url
      }
      assignments.push({ label, subject: subjects.get(label) ?? null, outcome: 'artwork' })
      cleared++
      return placeholder(label, hue)
    }
    assignments.push({ label, subject: chosen.subject, outcome: chosen.tier })
    matched++
    return chosen.url
  })

  /**
   * Nothing may leave here still holding the token.
   *
   * Both passes above resolve it, but a slot written somewhere neither of them
   * walks — a CSS `background-image`, a string built by concatenation — would
   * survive and ship as a broken image. This is the backstop, and it firing is
   * worth knowing about.
   */
  if (out.includes(PHOTO_SLOT)) {
    let n = 0
    out = out.replace(new RegExp(PHOTO_SLOT, 'g'), () => { n++; return placeholder('', hue) })
    cleared += n
    logger.warn('Photo slots survived both passes and were blanked', { count: n })
  }

  if (assignments.length > 0) {
    logger.info('Assigned photographs to what they illustrate', {
      slots: assignments.length,
      matched,
      cleared,
      sample: assignments.slice(0, 8).map((a) => `${a.label || '(no label)'}→${a.subject ?? '-'}:${a.outcome}`),
    })
  }
  return { html: out, assignments, matched, cleared }
}
