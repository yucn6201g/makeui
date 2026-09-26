/**
 * Deterministic repairs for pictures of catalogue items: an image field misspelt
 * between the data and the screen, a grey box standing in for a photograph, and a
 * catalogue whose records have no photograph at all.
 */
import { PHOTO_SLOT } from '../images/stock-images.js'
import { PICTURE_FRAME, pictureFrames } from './picture-frames.js'

/**
 * A card that draws a grey box with the word 「商品画像」 in it, instead of the
 * picture the item carries.
 *
 * Measured on the same storefront: every product had an `image` field, the card
 * rendered `<div className="card-image"><span>商品画像</span></div>`, and the page
 * shipped with no photograph on it at all. The pipeline's own photograph pass
 * cannot help — it replaces image URLs and slots, and there was no image element
 * to replace.
 *
 * The box is turned into the `<img>` it was standing in for. Deliberately narrow:
 * the element has to be a picture frame by its own class name, hold nothing but a
 * placeholder word, and the component has to receive an object whose type really
 * does declare an image field — otherwise the repair would write a src that does
 * not exist, which is the one outcome worse than a grey box.
 */
const PLACEHOLDER_WORD = /^(?:商品画像|画像|イメージ|写真|画像なし|no\s*image|image|photo|placeholder)$/i
/*
 * A picture field, whatever the project decided to call it.
 *
 * The list of exact names missed `thumbnailUrl: string` on an article feed of
 * 2026-09-11 — three photographs sitting in the data and the word
 * `thumbnailUrl` appearing nowhere else in the project. A suffix is allowed
 * now, and only the suffixes that still mean "this IS the picture":
 * `imageSrc`, `coverImage`, `photoUrl`. Not any suffix — `imageAlt` and
 * `imageWidth` are about a picture without being one, and writing a URL into
 * either would be worse than leaving the field alone.
 */
const PICTURE_NAME = '(?:image|img|thumbnail|thumb|photo|picture|cover|avatar|banner|hero)(?:Url|URL|Src|Image|Path)?'

const IMAGE_FIELD = new RegExp(`\\b(${PICTURE_NAME})\\s*\\??\\s*:\\s*string`)
const NAME_FIELD = /\b(name|title|label|productName)\s*\??\s*:\s*string/

/** Every field name the project's own record types declare. */
function declaredFields(files: Map<string, string>): Set<string> {
  const names = new Set<string>()
  for (const [path, body] of files) {
    if (!/^src\/(data|store|lib|types)\//.test(path) && !/types?\.ts$/.test(path)) continue
    for (const decl of body.matchAll(/(?:interface|type)\s+[A-Z][\w$]*\s*=?\s*\{([\s\S]*?)\n\}/g)) {
      for (const m of decl[1].matchAll(/(?:^|\n)\s*([a-z][\w$]*)\s*\??\s*:/g)) names.add(m[1])
    }
  }
  return names
}

/**
 * A picture bound to a field the data does not have.
 *
 * Measured 2026-09-18, on the edit a user asked for after 「商品をクリックしても何も
 * 起きません」. The model rewrote the whole screen rather than patching it, and in
 * the rewrite it replaced `<ProductCard :product="product" />` with markup of
 * its own:
 *
 *     <img :src="product.imageUrl" :alt="product.name" />
 *
 * `Product` declares `image`, not `imageUrl`, and the file it deleted had read
 * it correctly. Nothing could see this: the SFC compiles, the template type is
 * never checked, and `undefined` in `src` renders as a broken picture rather
 * than as an error. The user reported it as 「画像が表示されなくなりました」.
 *
 * Deliberately only picture sources, and only when the name is declared NOWHERE
 * in the project and exactly one declared name is a prefix of it. The same rule
 * applied to expressions generally would rewrite `store.cartTotal` to
 * `store.cart` — a legitimate computed whose name happens to start with a field.
 * An image source has no such shape: it is a value read straight off a record.
 */
export function fixImageFieldMisspelt(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const out = new Map<string, string>()
  const fixed: string[] = []
  const declared = declaredFields(files)
  if (declared.size === 0) return { files: out, fixed }

  /*
   * `:src` in a Vue template, `src={…}` in JSX, and either spread over several
   * lines — a bound attribute is rarely on the same line as its tag once the
   * element has three of them. The bind prefix is why the word boundary goes
   * before `src` and not before the colon: ` :src` has no boundary at the colon.
   */
  const SRC = /<img\b[^>]*?(?::src|\bsrc)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g
  for (const [path, body] of files) {
    if (!/\.(vue|tsx|jsx)$/.test(path)) continue
    let next = body
    let touched = false
    for (const m of body.matchAll(SRC)) {
      const expr = m[1] ?? m[2] ?? m[3] ?? ''
      const read = /^\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*$/.exec(expr)
      if (!read) continue
      const [, item, field] = read
      if (declared.has(field)) continue
      const lower = field.toLowerCase()
      const candidates = [...declared].filter((d) => d.length >= 4 && lower.startsWith(d.toLowerCase()))
      if (candidates.length !== 1) continue
      next = next.split(`${item}.${field}`).join(`${item}.${candidates[0]}`)
      touched = true
      fixed.push(`${path}: ${item}.${field} -> ${item}.${candidates[0]}`)
    }
    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          '画像の src が、データに無いフィールドを読んでいたので宣言されている名前に修正' +
            `（undefined になり画像が出ません）: ${[...new Set(fixed)].join('、')}`,
        ]
      : [],
  }
}

export function fixPlaceholderImageBoxes(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const code = [...files].filter(([p]) => /\.(tsx?|jsx?|vue)$/.test(p))
  if (code.length === 0) return { files, fixed: [] }

  // Types that carry a picture, so a component holding one can be given an <img>.
  const withImage = new Map<string, { image: string; name: string | null }>()
  for (const [, body] of code) {
    for (const m of body.matchAll(/(?:interface|type)\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
      const image = IMAGE_FIELD.exec(m[2])
      if (!image) continue
      const name = NAME_FIELD.exec(m[2])
      withImage.set(m[1], { image: image[1], name: name ? name[1] : null })
    }
  }
  if (withImage.size === 0) return { files, fixed: [] }

  const out = new Map(files)
  const fixed: string[] = []
  for (const [path, body] of code) {
    // The object this file renders: a prop whose declared type carries a picture.
    let holder: { object: string; image: string; name: string | null } | null = null
    for (const m of body.matchAll(/(\w+)\s*\??\s*:\s*(\w+)\s*[;,\n]/g)) {
      const type = withImage.get(m[2])
      if (!type) continue
      if (!new RegExp(`\\b${m[1]}\\.`).test(body)) continue
      holder = { object: m[1], image: type.image, name: type.name }
      break
    }
    if (!holder) continue

    let changed = 0
    const next = body.replace(
      /<(div|span|figure|p)\b([^>]*)>\s*(?:<(?:span|p|div)\b[^>]*>\s*)?([^<>{}\n]{1,12}?)\s*(?:<\/(?:span|p|div)>\s*)?<\/\1>/g,
      (whole, tag: string, attrs: string, text: string) => {
        if (!PLACEHOLDER_WORD.test(text.trim())) return whole
        // It has to be the picture's own frame. A caption that happens to read
        // 「画像」 is not a frame, and replacing it would delete the caption.
        if (!/class(?:Name)?\s*=\s*["'{][^"'}]*(image|photo|thumb|picture|visual)/i.test(attrs)) return whole
        changed++
        const src = `${holder!.object}.${holder!.image}`
        const alt = holder!.name ? `${holder!.object}.${holder!.name}` : "''"
        const isTemplate = path.endsWith('.vue')
        const img = isTemplate
          ? `<img :src="${src}" :alt="${alt}" style="width:100%;height:100%;object-fit:cover" />`
          : `<img src={${src}} alt={${alt}} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />`
        const inner = img
        return `<${tag}${attrs}>${inner}</${tag}>`
      }
    )
    if (changed === 0) continue
    out.set(path, next)
    fixed.push(`${path}: 「${'商品画像'}」と書いた枠を、品目が持つ画像の <img> に置き換え（写真が1枚も出ない状態の修正・${changed}箇所）`)
  }
  return fixed.length ? { files: out, fixed } : { files, fixed: [] }
}

/**
 * A span of source with the strings taken out of consideration.
 *
 * The scanners below count braces, and a brace inside a Japanese product
 * description is not a brace they are counting. Cheap and sufficient: quotes do
 * not nest, and an escaped quote keeps its backslash.
 */
function skipString(src: string, at: number): number {
  const quote = src[at]
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue }
    if (src[i] === quote) return i
  }
  return src.length - 1
}

/** The index of the bracket closing the one at `at`, or -1. */
function closingBracket(src: string, at: number): number {
  const open = src[at]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  for (let i = at; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue }
    if (c === open) depth++
    else if (c === close && --depth === 0) return i
  }
  return -1
}

/** The object literals directly inside an array literal, as [start, end] pairs. */
function recordsIn(src: string, arrayOpen: number): Array<[number, number]> {
  const arrayClose = closingBracket(src, arrayOpen)
  if (arrayClose === -1) return []
  const out: Array<[number, number]> = []
  for (let i = arrayOpen + 1; i < arrayClose; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue }
    if (c !== '{') continue
    const end = closingBracket(src, i)
    if (end === -1) break
    out.push([i, end])
    i = end
  }
  return out
}

/**
 * A catalogue whose records carry no picture, given one.
 *
 * Measured 2026-09-19, comparing React and Vue on the same storefront brief,
 * because the pictures 「Vueに比べてReactで生成したときに画像が出る枚数が少ない」.
 * On the catalogue-shaped documents in the corpus the difference is not in the
 * photograph pass at all — it is in what the build handed it:
 *
 *   vue    13 records, 13 image fields, 13 photographs
 *   react  12 records, `image?: string` declared and set by NOT ONE of them,
 *          and the card drawing `<div className="product-card__image">
 *          <ContentFrame /></div>` — a stand-in where the photograph goes
 *
 * `assignItemImages` replaces picture URLs and slots. With no URL and no slot
 * there is nothing for it to replace, so it correctly does nothing, and the
 * storefront ships with drawn panels where twelve garments should be. The type
 * says the picture was intended; the records simply never got one.
 *
 * So the slot is written where the model said it would be. `__PHOTO__` is the
 * token the assembler is already told to write for exactly this, and the pass
 * that resolves it reads the record's own `name` to decide what to photograph —
 * so a record that says 「ニットセーター」 gets knitwear, which is the whole point
 * of doing this here rather than picking a URL at random.
 *
 * Deliberately narrow, in three ways. The type must already DECLARE a picture —
 * adding a field nobody asked for is a claim about the design, not a repair.
 * Not one record may carry one — a catalogue where some items have photographs
 * and others do not is a decision, not an omission. And the frame keeps
 * whatever it was drawing as the fallback branch, so a project whose
 * illustrations are only rendered here does not lose them.
 *
 * ## The card can ask too (2026-09-20)
 *
 * The first of those three was too narrow, and a user's storefront is the
 * argument. 「商品一覧画面では商品の画像が表示されていない」 on a document where
 * `Product` declares id, name, price, category, colors, sizes, material and
 * dimensions — and no picture — while the card draws
 *
 *     <div className="da-card-image" aria-label={`${product.name}の画像`}>
 *       <svg …> … a gradient, a dot pattern, a circle and a rectangle
 *
 * an invented abstract composition, which the IMAGERY contract names as the
 * wrong answer for a catalogue in those words. The type never asked for a
 * picture; the CARD asked, by its class and by the label it reads out. So
 * "nobody asked for it" was not true of this shape, and the rule excluded a
 * storefront that shipped twelve garments as gradients.
 *
 * Measured over 76 stored documents: 9 have a catalogue and a picture frame at
 * all, 5 of those have a frame with no picture in it, and 2 of the 5 are this
 * shape. So it is 2 in 76 of everything and 2 in 5 of the population this pass
 * exists for.
 *
 * A frame declares a picture only with all of: a data array of at least three
 * records of one type, that type having a name field, a component drawing an
 * element whose class names it a picture BOUND to an item of that type, and no
 * `<img>` already in it. Then the field is written onto the interface as well
 * as into the records.
 */
const CATALOGUE_IMAGE = new RegExp(`\\b(${PICTURE_NAME})(\\s*\\?)?\\s*:\\s*string`)

/** Whether the project holds an array of at least three records of this type. */
function hasCatalogueOf(code: Array<[string, string]>, type: string): boolean {
  for (const [path, body] of code) {
    if (!/^src\/data\//.test(path)) continue
    for (const m of body.matchAll(new RegExp(`export\\s+const\\s+\\w+\\s*:\\s*${type}\\[\\]\\s*=\\s*\\[`, 'g'))) {
      if (recordsIn(body, (m.index ?? 0) + m[0].length - 1).length >= 3) return true
    }
  }
  return false
}

/**
 * Whether some component draws a picture frame for an item of this catalogue.
 *
 * Bound to the item, not merely present: a frame in a hero banner says nothing
 * about the records. The binding is the same one the markup step uses, so a
 * frame that argues for the field here is a frame that gets an `<img>` there.
 */
function frameAsksFor(code: Array<[string, string]>, nameField: string): boolean {
  for (const [path, body] of code) {
    if (/^src\/data\//.test(path)) continue
    for (const m of body.matchAll(/<(?:div|figure|span)\b([^>]*)>/g)) {
      if (!PICTURE_FRAME.test(m[1])) continue
      if (/skeleton|loading|shimmer/i.test(m[1])) continue
      const at = m.index ?? 0
      // Already drawing one, so nothing is missing here.
      if (/<img[\s>]/.test(body.slice(at, at + 400))) continue
      const item = itemBindingNear(body, at, nameField)
      if (item && new RegExp(`\\b${item}\\.${nameField}\\b`).test(body)) return true
    }
  }
  return false
}

export function fixCatalogueWithoutPhotos(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const code = [...files].filter(([p]) => /\.(tsx?|jsx?|vue)$/.test(p))
  if (code.length === 0) return { files, fixed: [] }

  /** Types that say they carry a picture, and where they say it. */
  const carriers = new Map<string, { field: string; optional: boolean; declaredIn: string; nameField: string }>()
  /** Record types with a name and no picture — candidates for the card to ask. */
  const nameOnly = new Map<string, { declaredIn: string; nameField: string; at: number; body: string }>()
  for (const [path, body] of code) {
    for (const m of body.matchAll(/(?:interface|type)\s+(\w+)[^{]*\{([\s\S]*?)\n\}/g)) {
      const img = CATALOGUE_IMAGE.exec(m[2])
      const name = NAME_FIELD.exec(m[2])
      if (!name) continue
      if (!img) {
        nameOnly.set(m[1], { declaredIn: path, nameField: name[1], at: m.index ?? 0, body: m[0] })
        continue
      }
      carriers.set(m[1], { field: img[1], optional: Boolean(img[2]), declaredIn: path, nameField: name[1] })
    }
  }

  /*
   * And the types whose CARD asks, where the type did not. See the note above:
   * a frame classed for a picture and bound to an item of the type is the build
   * saying a photograph goes there, whatever the interface left out.
   */
  const declaredByFrame = new Set<string>()
  for (const [type, info] of nameOnly) {
    if (carriers.has(type)) continue
    if (!hasCatalogueOf(code, type)) continue
    if (!frameAsksFor(code, info.nameField)) continue
    carriers.set(type, { field: 'image', optional: false, declaredIn: info.declaredIn, nameField: info.nameField })
    declaredByFrame.add(type)
  }

  if (carriers.size === 0) return { files, fixed: [] }

  const out = new Map(files)
  const fixed: string[] = []
  /** Types whose records this pass filled, so the markup below knows to draw them. */
  const slotted = new Map<string, { field: string; nameField: string }>()

  for (const [path, body] of code) {
    if (!/^src\/data\//.test(path)) continue
    let next = out.get(path) ?? body
    for (const m of body.matchAll(/export\s+const\s+\w+\s*:\s*(\w+)\[\]\s*=\s*\[/g)) {
      const carrier = carriers.get(m[1])
      if (!carrier) continue
      const arrayOpen = (m.index ?? 0) + m[0].length - 1
      const records = recordsIn(body, arrayOpen)
      // Two records are a pair of examples; a catalogue is what this is for.
      if (records.length < 3) continue
      /*
       * The ones without a picture, which is usually not the whole catalogue.
       *
       * This began as "not one record may carry one", on the reasoning that a
       * catalogue where some items have photographs and others do not is a
       * decision rather than an omission. Measured against the storefront that
       * prompted this, that reasoning was wrong and it cost the repair: ONE of
       * the twelve garments carried a photograph and eleven did not, which is
       * not a decision — it is the shape the difference actually takes, and the
       * rule excluded exactly the document it was written for.
       *
       * Records that already have one keep it. Only the gaps are filled.
       */
      const held = new RegExp(`\\b${carrier.field}\\s*:`)
      const missing = records.filter(([a, b]) => !held.test(body.slice(a, b)))
      /*
       * A catalogue whose records ALREADY carry their pictures still reaches
       * the markup step below, and that is the whole of the 2026-09-20 report:
       * 「画像が一枚も挿入されていません」 on a document holding eleven real
       * photographs in `src/data/products.ts` and not one `<img>` anywhere —
       * the card drew `<div className="cds-product-image"><ContentFrame /></div>`.
       *
       * The data was complete, so this pass had nothing to slot, and gating the
       * markup on having slotted something meant the one thing that was wrong
       * went untouched. The two halves are independent: fill what is missing,
       * and draw what is there.
       */
      slotted.set(m[1], { field: carrier.field, nameField: carrier.nameField })
      if (missing.length === 0) continue

      /*
       * Written from the END of the file backwards, so an insertion does not
       * move the offsets of the records still to be edited.
       */
      for (const [start] of [...missing].reverse()) {
        const lineEnd = next.indexOf('\n', start)
        if (lineEnd === -1) continue
        const indent = /^[ \t]*/.exec(next.slice(lineEnd + 1))?.[0] ?? '    '
        next = `${next.slice(0, lineEnd + 1)}${indent}${carrier.field}: '${PHOTO_SLOT}',\n${next.slice(lineEnd + 1)}`
      }
      fixed.push(`${path}: ${records.length}件中${missing.length}件に ${carrier.field} を追加`)
    }
    if (next !== (out.get(path) ?? body)) out.set(path, next)
  }
  if (slotted.size === 0) return { files, fixed: [] }

  /*
   * Now every record has one, so the declaration is no longer optional. Left
   * optional, `src={item.image}` is `string | undefined` and `tsc` rejects the
   * project this system exists to hand someone.
   */
  for (const [type, { field }] of slotted) {
    const carrier = carriers.get(type)!
    const body = out.get(carrier.declaredIn) ?? files.get(carrier.declaredIn) ?? ''
    /*
     * A type the CARD asked for has no line to un-optional — it has no line at
     * all. Written beside the name field, because that is the field this pass
     * already read the type for and it puts the picture with what it pictures.
     */
    if (declaredByFrame.has(type)) {
      const decl = new RegExp(`(\\n([ \\t]*)${carrier.nameField}\\s*\\??\\s*:\\s*string;?)`)
      const withField = body.replace(decl, `$1\n$2${field}: string;`)
      if (withField !== body) {
        out.set(carrier.declaredIn, withField)
        fixed.push(`${carrier.declaredIn}: ${type} に ${field} を宣言（カードに写真枠があるのに型が写真を持っていませんでした）`)
      }
      continue
    }
    if (!carrier.optional) continue
    const fixedDecl = body.replace(new RegExp(`(\\b${field})\\s*\\?\\s*:(\\s*string)`), '$1:$2')
    if (fixedDecl !== body) out.set(carrier.declaredIn, fixedDecl)
  }

  /*
   * And the frame gets the picture it was holding a place for.
   *
   * The element has to be a picture frame by its own class name, and hold
   * nothing but a drawn stand-in — an empty box, or a single component. A frame
   * with real content in it is not a frame with a missing picture.
   */
  /*
   * A frame holding nothing, or holding one stand-in and nothing else.
   *
   * The stand-in was read as a capitalised self-closing component, which is
   * `<ContentFrame />` on the list screen and missed the detail screen's
   * `<div className="cds-image-placeholder" />` on the same document. Any
   * single childless element counts now; a frame with real content in it still
   * does not match, because the pattern allows exactly one and no text.
   */
  /*
   * `<svg>…</svg>` is a stand-in too, and it is the one the storefront of
   * 2026-09-20 used: sixty lines of gradient, dot pattern, circle and rectangle
   * inside `<div className="da-card-image">`. The frames are found by matching
   * tags rather than by a pattern — see tools/fixups/picture-frames.ts for the two
   * documents a pattern broke.
   */
  for (const [path, body] of code) {
    if (/^src\/data\//.test(path)) continue
    const source = out.get(path) ?? body
    const edits: Array<{ at: number; end: number; text: string }> = []
    for (const frame of pictureFrames(source)) {
      const { at, end, tag, attrs, child } = frame
      /*
       * A frame already drawing a picture is not a frame with a missing one.
       * Widening the child to any childless element once let this match an
       * `<img>`, so the repair replaced a working picture with its own.
       */
      if (/^<(?:img|picture|image)\b/i.test(child.trim())) continue
      const type = [...slotted].find(([, info]) => {
        const item = itemBindingNear(source, at, info.nameField)
        return item !== null && new RegExp(`\\b${item}\\.${info.nameField}\\b`).test(source)
      })
      if (!type) continue
      const item = itemBindingNear(source, at, type[1].nameField)
      if (!item) continue
      const { field, nameField } = type[1]
      const vue = path.endsWith('.vue')
      const img = vue
        ? `<img :src="${item}.${field}" :alt="${item}.${nameField}" style="width:100%;height:100%;object-fit:cover" />`
        : `<img src={${item}.${field}} alt={${item}.${nameField}} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />`
      const open = `<${tag}${attrs.replace(/\s*\/$/, '')}>`
      let inner: string
      if (!child.trim()) {
        inner = img
      } else if (/^<svg[\s>]/i.test(child.trim())) {
        /*
         * An inline `<svg>` stand-in is replaced outright. The other branch
         * exists so that a COMPONENT drawing the stand-in is still rendered
         * somewhere and does not become an unused file; drawn inline there is
         * no file, and sixty lines of invented gradient hanging off a ternary
         * whose condition is a slot we just wrote is dead weight.
         */
        inner = img
      } else {
        // Trimmed: the child carries the frame's indentation, and a newline
        // between `:` and the fallback makes the branch read as two statements.
        const standIn = child.trim()
        inner = vue
          ? `${img.replace('<img ', `<img v-if="${item}.${field}" `)}${standIn.replace('/>', 'v-else />')}`
          : `{${item}.${field} ? ${img} : ${standIn}}`
      }
      edits.push({ at, end, text: `${open}${inner}</${tag}>` })
    }
    if (edits.length === 0) continue
    let next = source
    // From the end, so an earlier rewrite does not move the offsets after it.
    for (const e of [...edits].reverse()) next = next.slice(0, e.at) + e.text + next.slice(e.end)
    out.set(path, next)
    fixed.push(`${path}: 品目の写真枠に <img> を入れた（${edits.length}箇所）`)
  }

  /*
   * A slot nothing draws is worse than no slot: `__PHOTO__` would ship as a
   * broken `src`, or as a string in a record the screens never read. So the
   * data change stands only when something renders the field — the frame this
   * pass just gave an `<img>`, or an `<img>` the build already wrote elsewhere
   * (a detail screen usually has one even when the cards do not).
   */
  /*
   * Nothing was written, so nothing is reported. With the two halves
   * independent this is reachable in a way it was not before: a catalogue that
   * already carries its pictures AND already draws them leaves both halves
   * with nothing to do, and the report below would otherwise announce a repair
   * with an empty list of what it repaired.
   */
  if (fixed.length === 0) return { files, fixed: [] }
  const drawnHere = fixed.some((f) => f.includes('<img>'))
  const slottedHere = fixed.some((f) => f.includes('を追加'))
  const drawnAlready = [...slotted].some(([, { field }]) =>
    code.some(([p, b]) => !/^src\/data\//.test(p) && new RegExp(`<img[^>]*\\.${field}\\b`).test(b))
  )
  if (!drawnHere && !drawnAlready) return { files, fixed: [] }
  /*
   * Said as what happened, because the two halves are independent now and the
   * commonest case is only the second: a catalogue whose records already carry
   * their photographs, drawn by nothing.
   */
  const what = slottedHere && drawnHere
    ? 'データに写真の枠を作り、カードに <img> を入れました（この後の工程が品名から実際の写真を割り当てます）'
    : slottedHere
      ? 'データに写真の枠を作りました（この後の工程が品名から実際の写真を割り当てます）'
      : '品目が持っている写真がどこにも描画されていなかったので、写真枠に <img> を入れました'
  return { files: out, fixed: [`${what}: ${fixed.join('、')}`] }
}

/**
 * The record a frame is being rendered for, or null.
 *
 * A list says so in its `.map()` or its `v-for`. A DETAIL screen does not —
 * it holds one record in a local, and the 2026-09-20 document's detail screen
 * was missed for exactly that reason. So the last resort is the name the
 * markup around the frame is already reading: whatever `X` is in `X.name`
 * beside it is the record this frame belongs to.
 */
function itemBindingNear(source: string, at: number, nameField = 'name'): string | null {
  const before = source.slice(Math.max(0, at - 1200), at)
  const mapped = [...before.matchAll(/\.map\(\s*\(?\s*([A-Za-z_$][\w$]*)/g)].pop()
  if (mapped) return mapped[1]
  const each = [...before.matchAll(/v-for\s*=\s*["'][({]?\s*([A-Za-z_$][\w$]*)/g)].pop()
  if (each) return each[1]
  const window = source.slice(Math.max(0, at - 800), at + 600)
  const named = [...window.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\.${nameField}\\b`, 'g'))]
    .map((m) => m[1])
    .filter((name) => name !== 'props')
  return named[0] ?? null
}

