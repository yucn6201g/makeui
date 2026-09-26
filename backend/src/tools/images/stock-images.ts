import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { matchSubjects, matchCategories } from './subject-terms.js'
import { logger } from '../../utils/logger.js'

/**
 * Picks photographs for a generated screen out of the curated library.
 *
 * Deterministic and local: an index in S3, scored against the brief with string
 * matching. No model decides this and no request leaves the region, which is the
 * point — a stock-photo search API would send the user's brief abroad as a query
 * string, and for the customers this product is aimed at that is the one thing
 * that cannot happen.
 *
 * Everything in the library is CC0, so the generated project can embed, publish
 * and redistribute the images with no conditions attached. That is why the
 * collection step filters on CC0 specifically rather than on "free to use".
 */

const REGION = process.env.AWS_REGION || 'ap-northeast-1'
const BUCKET = process.env.OUTPUT_BUCKET_NAME || `makeui-outputs-${process.env.AWS_ACCOUNT_ID || ''}`
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || ''

export interface StockImage {
  id: string
  /**
   * What the photograph is of — `butter`, `tshirt`, `warehouse`.
   *
   * The unit the library is indexed by. `category` above it is only for the
   * restraint rules and the fallback tier; it is far too coarse to choose a
   * picture with, which is exactly how a storefront selling butter ended up
   * illustrating three garments with two photographs of an office.
   */
  subject: string
  category: string
  key: string
  width: number
  height: number
  aspect: number
  title: string
  tags: string[]
  query: string
  license: string
  licenseUrl: string
  creator: string
  source: string
  sourceUrl: string
  attribution: string
}

interface StockIndex {
  count: number
  images: StockImage[]
}

/**
 * Held for the life of the container.
 *
 * The library changes when someone re-curates it, which is a manual act; paying
 * an S3 read per generation to discover that it has not would be a poor trade.
 */
let cached: StockImage[] | null = null
let loadFailed = false

export async function loadStockIndex(): Promise<StockImage[]> {
  if (cached) return cached
  // One failure is enough. A bucket without a library is a configuration state,
  // not a transient error, and retrying it on every generation adds latency to
  // every generation.
  if (loadFailed) return []
  try {
    const s3 = new S3Client({ region: REGION })
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'stock/index.json' }))
    const body = await res.Body?.transformToString()
    const parsed = JSON.parse(body ?? '{}') as StockIndex
    /**
     * Titles come from the photographers and some of them carry markup.
     *
     * Measured in the real index: a butter photograph is titled
     * `<div class='fn'> Butter dish</div>`, which Wikimedia stores verbatim.
     * That string is handed to a model as the description of the picture and is
     * the obvious thing for it to copy into an `alt` attribute — so a tag ends
     * up in the accessible name of an image, where a screen reader reads it out.
     * Cleaned once at the boundary rather than at each of the four places the
     * title is used.
     */
    cached = (Array.isArray(parsed.images) ? parsed.images : []).map((i) => ({
      ...i,
      title: String(i.title ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
    logger.info('Stock image library loaded', { count: cached.length })
    return cached
  } catch (e) {
    loadFailed = true
    logger.info('No stock image library available; continuing without photographs', { error: String(e) })
    return []
  }
}

/**
 * What the assembler writes where a catalogue item's photograph goes.
 *
 * The division of labour this token creates is the point. Measured on a real
 * dairy shop: the assembler was handed five URLs including two of butter, wrote
 * a complete eight-product catalogue with names, prices, specs and options —
 * and gave none of them an image at all. It had been told to use photographs
 * sparingly, which is right for a dashboard and wrong for a shop, and it has no
 * way to know which of the five URLs is the butter one anyway.
 *
 * So it is asked for the one thing it can do reliably: leave a slot, and name
 * the item well. Choosing the picture is done afterwards, per item, by
 * something that knows what every photograph is of.
 */
export const PHOTO_SLOT = '__PHOTO__'

/** Public URL for an image. Empty when the CDN is not configured. */
export function stockUrl(image: StockImage): string {
  return CLOUDFRONT_DOMAIN ? `https://${CLOUDFRONT_DOMAIN}/${image.key}` : ''
}

/**
 * Tags that mean the file is not a photograph.
 *
 * Measured in the real index: 189 of 3,239 images carry one of these, and the
 * titles say exactly what they are — "Cheese wheel clipart, illustration
 * vector", "Milk carton clipart, dairy illustration". A clip-art milk carton
 * dropped into a product card beside four photographs does not read as a
 * stylistic choice; it reads as a broken image that happened to load. Nothing
 * downstream can tell the difference, because to every check in the pipeline it
 * is a URL that resolves.
 *
 * Excluded rather than penalised, because there is no brief for which the
 * answer is "an illustration of a thing, where a photograph of that thing also
 * exists". No subject loses more than half its images to this and none is
 * emptied.
 */
const NOT_A_PHOTOGRAPH = [
  'clip art', 'clipart', 'vector', 'drawing', 'painting', 'illustration',
  'cartoon', 'sketch', 'engraving', 'manuscript', 'diagram', 'icon', 'logo',
  'art print', 'poster', 'png sticker', 'sticker',
  // Cutouts and renders. A transparent-background PNG dropped into a card with
  // `object-fit: cover` shows the page behind it; a wireframe render of a
  // "data warehouse" is a diagram of a metaphor.
  'png', 'transparent', 'wireframe', 'render', '3d render',
]

/**
 * Tags that make a picture the wrong register for a product mock.
 *
 * Penalised, not excluded. A "vintage" tag is sometimes a colour treatment and
 * sometimes a photograph of an actual antique, and 109 images carry it — enough
 * that dropping them all would thin subjects that are already thin. Ranking them
 * last means they appear only when the alternative is no photograph, which is
 * the trade the rest of this module already makes everywhere else.
 *
 * The register failures are the ones a user notices and no audit can: a dental
 * clinic booking site illustrated with a photograph from a refugee medical
 * centre, a café reservation screen given a historical shot of men smoking
 * pipes. Both were real picks, from correctly matched subjects.
 */
const OFF_REGISTER = [
  'vintage', 'antique', 'retro', 'black and white', 'monochrome', 'sepia',
  'history', 'historical', 'archive', 'museum', 'church', 'army', 'military',
  'war', 'grunge', 'ruins', 'abandoned',
]

/** True when the file is a photograph rather than artwork. */
function isPhotograph(image: StockImage): boolean {
  const tags = image.tags ?? []
  if (tags.some((t) => NOT_A_PHOTOGRAPH.includes(t))) return false
  // The tags are not exhaustive; the title usually says so outright.
  return !/\b(clipart|clip art|illustration|vector|drawing|painting|cartoon|sticker)\b/i.test(image.title)
}

/**
 * Whether the title says what the picture is of.
 *
 * `HC05891`, `2013_09_25_Hawa_Abdi_Center_S.jpg` and `DSC_4471` are all real
 * titles in the library, and the title is the only description the assembler
 * gets — so a picture with one of these is one nobody, model or human, can place
 * deliberately. It goes to the back rather than out, because a picture that is
 * unidentifiable from its metadata may still be a perfectly good photograph of
 * the subject folder it sits in.
 */
function namesItsSubject(title: string): boolean {
  const t = title.trim()
  if (t.length < 4) return false
  if (/^(dsc|dscn|img|imgp|cimg|pict|sam_|p\d|hc\d|_mg|\d{3}_)/i.test(t)) return false
  if (/^\d{4}[-_. ]\d{2}[-_. ]\d{2}/.test(t)) return false
  // At least two real words, so "IMG 4471 2" and bare catalogue numbers fail.
  return (t.match(/[a-z]{3,}|[ぁ-んァ-ヶ一-龠]{2,}/gi) ?? []).length >= 2
}

/**
 * How usable this photograph is in a product mock, independent of any brief.
 *
 * Computed here rather than at curation time because it is a judgement about
 * how the library is *used*, and changing it should not mean re-downloading
 * three thousand images. The same reason the Japanese synonyms live on this
 * side of the wire.
 */
/**
 * Whether the picture's own words say it is of the thing its folder claims.
 *
 * The strongest signal available, and it was going unused: every image carries
 * the `query` that found it, and the subject it was filed under. Measured on
 * the `warehouse` subject, where the top two picks were titled "Joseph
 * McReynolds, Nat. Pub. Co" and "Food is prepared for distribution" — both
 * genuinely returned by a warehouse search, both photographs of something else
 * that happened to be near one. A title that does not contain the word is not
 * proof the picture is wrong, but it is the difference between "we know" and
 * "we assume", and there are usually thirty of the same subject that do say so.
 */
function subjectWords(image: StockImage): string[] {
  return [image.subject, ...String(image.query ?? '').split(/\s+/)]
    .map((w) => w.toLowerCase().trim())
    .filter((w) => w.length >= 4)
}

/** Whether a piece of text names the subject. Plural counts. */
function echoes(text: string, words: string[]): boolean {
  const t = text.toLowerCase()
  return words.some((w) => t.includes(w) || t.includes(`${w}s`))
}

/**
 * How usable this photograph is in a product mock, independent of any brief.
 *
 * Computed here rather than at curation time because it is a judgement about
 * how the library is *used*, and changing it should not mean re-downloading
 * three thousand images. Same reason the Japanese synonyms live on this side of
 * the wire.
 *
 * The title and the tags are scored SEPARATELY, and the split is the point.
 * Measured on the `warehouse` subject: the picture whose tags read "cargo,
 * conveyor, crane warehouse, logistics warehouse" has no title at all, and the
 * one titled "Joseph McReynolds, Nat. Pub. Co" is a photograph of a man. A
 * single "does it describe itself" term ranked the man first, because he has a
 * title and the warehouse does not. A title that names something *other* than
 * the subject is evidence against the picture, not merely an absence of
 * evidence for it — which is exactly what a missing title is.
 */
function quality(image: StockImage): number {
  const words = subjectWords(image)
  const title = image.title.trim()
  const tags = image.tags ?? []

  let q = 0
  if (words.length && echoes(title, words)) q += 3
  if (words.length && echoes(tags.join(' '), words)) q += 3
  // A title that names something else, on a picture whose tags are on-subject:
  // usually a photograph of a person or a company that happens to be there.
  if (title && words.length && !echoes(title, words) && echoes(tags.join(' '), words)) q -= 2
  if (namesItsSubject(title)) q += 2
  if (tags.length >= 3) q += 2
  // Landscape crops into a hero band or a card; a tall strip does not.
  if (image.aspect >= 1.2 && image.aspect <= 2.0) q += 1
  if (image.width >= 1600) q += 1

  if (tags.some((t) => OFF_REGISTER.includes(t))) q -= 8
  if (/\b(vintage|antique|historic|1[89]\d\d)\b/i.test(title)) q -= 4
  /**
   * Keyword spam, which scores well on every other term precisely because it
   * is spam. Measured: a Flickr upload titled "Pentagon wireframe, dodecahedron
   * storage, literal, subject, data warehouse, product management, private
   * cloud, monitoring, content, collaboration, …" carrying twenty tags ranked
   * top for `warehouse`. It echoes the subject in both title and tags, has
   * plenty of tags, is large and is landscape — it wins on every signal this
   * function has, and it is a diagram of a metaphor.
   */
  if ((title.match(/,/g) ?? []).length >= 4) q -= 10
  return q
}

/**
 * Scores one image against the brief, given that its subject was already
 * matched.
 *
 * The subject decides *whether* an image is eligible; this only decides which
 * of that subject's photographs to prefer. Tag and title overlap sharpen it —
 * a brief mentioning 「倉庫の棚」 should get the shelves rather than the forklift.
 *
 * What this deliberately no longer does is score across the whole library. The
 * previous version gave six points for a coarse category match and let anything
 * with a plausible tag through, which is how "product" came to mean "any
 * photograph at all".
 */
function score(image: StockImage, haystack: string): number {
  let s = 0
  for (const tag of image.tags) {
    if (tag.length >= 4 && haystack.includes(tag)) s += 3
  }
  for (const word of image.title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 5 && haystack.includes(word)) s += 1
  }
  return s
}

/**
 * A key for "this is the same picture again".
 *
 * Measured: a brief for an apparel shop came back with "Stack of folded
 * t-shirts" twice and "Woman clothes in the store. Fashion store. Shopping
 * mall." twice — four offers, two pictures. They are different files with
 * different ids, so nothing deduplicated them, and a catalogue with the same
 * thumbnail repeated down it is the second most recognisable tell of a
 * generated page.
 */
function pictureKey(image: StockImage): string {
  return image.title.toLowerCase().replace(/[^a-z0-9]+/g, '') || image.id
}

interface PickedImage {
  url: string
  /** What the picture shows, for the alt text and for the model's own choice. */
  description: string
  width: number
  height: number
  aspect: number
  attribution: string
}

/**
 * A handful of photographs the brief actually suggests, or none.
 *
 * Capped low on purpose. A generated screen with a photograph in every panel is
 * the single most recognisable tell of machine-made design, and most business
 * software has very few photographs in it: a hero, an empty state, a row of
 * faces. Offering forty would produce forty.
 */
export async function pickStockImages(
  brief: string,
  limit = 5,
  options: {
    /**
     * Offer photographs even when the brief names no subject the library covers.
     *
     * Off by default, and it must stay that way for generation: the restraint is
     * the feature there. It exists for the one case where returning nothing is
     * plainly wrong — the user has asked for a photograph in so many words.
     * "写真を追加して" names no subject at all, so the conservative path answers a
     * direct request with nothing and the model fills the gap by inventing a URL
     * that 404s.
     */
    anyCategory?: boolean
  } = {}
): Promise<PickedImage[]> {
  const library = await loadStockIndex()
  if (library.length === 0 || !CLOUDFRONT_DOMAIN) return []

  const haystack = brief.toLowerCase()
  /**
   * Subjects the brief actually names, most specific first.
   *
   * This is the whole change. Matching used to be against seven categories, one
   * of which was "product" — a word that describes nothing photographable and
   * matched every storefront ever generated, which is why a page of T-shirts
   * came back illustrated with office desks. A subject is a thing someone can
   * photograph, and if the brief names none, none is offered.
   */
  const subjects = matchSubjects(brief)
  /**
   * A named category, when the brief names no subject at all.
   *
   * 「アパレルのECサイト」 is the common shape and it matched nothing: `apparel`
   * is a category, and the subjects under it are `tshirt`, `knitwear`, `jeans`.
   * Measured on a real run — 37 files, 155 CSS rules, and not one photograph on
   * a clothing shop.
   *
   * Consulted only after subjects, so a brief that does name a garment still
   * gets that garment rather than a spread across the whole category.
   */
  const categories = subjects.length === 0 ? matchCategories(brief) : []
  const eligible = (
    subjects.length
      ? library.filter((i) => subjects.includes(i.subject))
      : categories.length
        ? library.filter((i) => categories.includes(i.category))
        : options.anyCategory
          ? library
          : []
  ).filter(isPhotograph)
  if (eligible.length === 0) return []

  /**
   * Three terms, in the order they matter.
   *
   * `rank` — how specific the subject match was — dominates, as before. What is
   * new is `quality`, and it is the term that was missing rather than wrong:
   * the tags are English and every brief is Japanese, so `score` is zero for
   * almost every image and the previous ordering inside a subject was, in
   * practice, the order the images happened to be collected in. That is how a
   * correctly matched `portrait` produced "Moody Expressions. A Crossdresser
   * Portrait" for a project-management tool, and a correctly matched `hospital`
   * produced a photograph from a Somali refugee medical centre for a dental
   * clinic. Neither was a matching failure. Both were an ordering failure over
   * a set with no order.
   */
  const rank = new Map(subjects.map((s, i) => [s, subjects.length - i]))
  const ranked = eligible
    .map((image) => ({
      image,
      s: (rank.get(image.subject) ?? 0) * 100 + quality(image) * 10 + score(image, haystack),
    }))
    .sort((a, b) => b.s - a.s)

  /**
   * A floor, so "the best of a bad set" is not a thing this returns.
   *
   * Everything below it is off-register, or unidentifiable from its own
   * metadata, or both. Offering none is a supported outcome everywhere
   * downstream — the assembler is told photographs are optional and most screens
   * are better without one — so a weak offer is strictly worse than no offer.
   */
  const FLOOR = 0
  // At most two from any one subject, so a brief mentioning 「オフィス」 does not
  // come back with five near-identical desks.
  const perSubject = new Map<string, number>()
  const seen = new Set<string>()
  const picked: PickedImage[] = []
  for (const { image, s } of ranked) {
    if (quality(image) < FLOOR) continue
    const used = perSubject.get(image.subject) ?? 0
    if (used >= 2) continue
    const key = pictureKey(image)
    if (seen.has(key)) continue
    seen.add(key)
    void s
    perSubject.set(image.subject, used + 1)
    picked.push({
      url: stockUrl(image),
      description: image.title || image.query,
      width: image.width,
      height: image.height,
      aspect: image.aspect,
      attribution: image.attribution,
    })
    if (picked.length >= limit) break
  }
  return picked
}

/**
 * The block handed to the design phase.
 *
 * Different from the assembler's block in what it asks for, and that difference
 * is the whole point of sending it this early. The assembler is told how to
 * write an <img>; the designer is asked to decide, screen by screen, whether a
 * photograph belongs there at all — and to say so in the specification, so the
 * layout is drawn around the picture instead of having one dropped into a
 * layout that was composed without it. A hero band designed for text and then
 * given a photograph is the shape this fixes.
 *
 * No URLs here. A specification is not the place to write one, and a designer
 * that quotes a URL invites the assembler to copy it from prose rather than
 * from the list it is given verbatim.
 */
export function stockImageBrief(
  images: Pick<PickedImage, 'description' | 'width' | 'height' | 'aspect'>[]
): string {
  if (images.length === 0) return ''
  return `
利用可能な写真素材（CC0・実在します）:
${images.map((i, n) => `${n + 1}. ${i.description}（${i.width}×${i.height}、横縦比 ${i.aspect}）`).join('\n')}

設計時に、この中のどれをどの画面のどこに置くかを決めてください。決めたものは
仕様に「写真: <上の番号または内容> を <配置場所> に、<寸法や比率>で」と明記します。
写真を前提にした構図（ヒーロー帯の高さ、カードの画像比率、テキストの回り込み）を
設計の側で決めてください。後から画像を差し込むと、必ず窮屈な見た目になります。

ただし写真が要らない画面のほうが多数派です。数値パネル、表、フォーム、設定画面には
置かないでください。1枚も使わない設計も正解です。`
}

/**
 * The block handed to the code assembler.
 *
 * States the URLs as facts and the restraint as a rule. Without the second half
 * the model uses every image it is given, in every slot that will take one.
 */
/**
 * True when there is a library to draw from at all.
 *
 * Cheap after the first call — the index is held for the life of the container —
 * and it is the fact the instructions below actually depend on. They used to
 * depend on whether any photograph had been *pre-matched*, which is a different
 * and much narrower question.
 */
export async function hasStockLibrary(): Promise<boolean> {
  if (!CLOUDFRONT_DOMAIN) return false
  return (await loadStockIndex()).length > 0
}

/**
 * The block handed to the code assembler.
 *
 * The slot half is emitted whenever a library exists, not only when the brief
 * happened to pre-match something. That gate was the bug, and it is the reason
 * an apparel storefront came back with no clothes on it.
 *
 * The chain: `matchSubjects` reads the brief for a subject it can photograph,
 * and 「アパレルのECサイト」 names none — `apparel` is a category, and the
 * subjects under it are `tshirt`, `knitwear`, `jeans`. So no image was matched,
 * so this returned the empty string, so the assembler was never told that
 * `__PHOTO__` exists — and `assignItemImages`, which matches the library against
 * each item's own name and would have found the T-shirt photographs perfectly
 * well, had no slots to fill. Measured: 37 files, 155 CSS rules, 16 inline SVGs,
 * and zero photographs on a clothing shop.
 *
 * The slot was designed precisely so the assembler need not know which URL is
 * which. Making it conditional on the assembler having URLs inverted that.
 */
export function stockImageInstructions(images: PickedImage[], libraryAvailable = images.length > 0): string {
  if (images.length === 0 && !libraryAvailable) return ''
  if (images.length === 0) return `
══════════════════════════════════════════════
商品写真 — 実物を並べる画面では ${PHOTO_SLOT} を書いてください
══════════════════════════════════════════════
CC0の写真ライブラリがあります。商品・物件・設備など「実物」を並べる場合は、
画像のURLを自分で書かず、**${PHOTO_SLOT}** と書いてください。

  { id: 'p1', name: 'オーガニックコットン Tシャツ', price: 4800, image: '${PHOTO_SLOT}', … }
  <img src="${PHOTO_SLOT}" alt="オーガニックコットン Tシャツ">

生成の最後に、**その品目の名前に合った写真**へ機械的に差し替えます。Tシャツには
Tシャツの写真が入ります。一覧に並ぶ品目には**1件残らず** image を付けてください。
写真の無い商品カードは未完成に見えます。名前は具体的に書いてください
（「商品A」ではなく「オーガニックコットン Tシャツ」）— 差し替えはその名前だけを手がかりにします。

**外部の画像URLを書いてはいけません。** images.unsplash.com / via.placeholder.com /
picsum.photos などは、実在しないIDを書いてしまううえ、ライセンス上この製品では使えません
（生成物はページに埋め込まれ、URLで公開され、プロジェクトとして配布されます。
そのため写真は CC0 のものだけを自前で用意しています）。
ヒーロー帯など品目でない箇所に写真が要る場合は、インラインSVGで図版を描いてください。

使ってはいけない場所: ダッシュボードの数値パネル、表、フォーム、設定画面、アイコンの代わり。
必ず alt を書き、object-fit: cover と明示的な高さを指定してください。

**画像の枠を文字で代用してはいけません。** 「商品画像」と書いた灰色の箱は画像ではありません。
品目のカードには必ず <img> を書き、src にはその品目の image フィールドを渡してください
（実測: 商品12件すべてが image フィールドを持ちながら、カードは文字の箱を描き、
写真が1枚も出ませんでした）。`
  return `
══════════════════════════════════════════════
USABLE PHOTOGRAPHS — 実在するURLです
══════════════════════════════════════════════
次の画像はすべてCC0で、このまま <img src="..."> に書けます。URLは一字一句そのまま使ってください。
一覧にないURLを書いてはいけません（存在しない画像になります）。

${images.map((i) => `- ${i.url}\n  内容: ${i.description} / ${i.width}×${i.height}（横縦比 ${i.aspect}）`).join('\n')}

━━ 商品・物件・設備など「実物」を並べる場合 ━━
上のURLを選ばず、**${PHOTO_SLOT}** と書いてください。

  { id: 'p1', name: '北海道産 無塩バター 200g', price: 1280, image: '${PHOTO_SLOT}', … }
  <img src="${PHOTO_SLOT}" alt="北海道産 無塩バター 200g">

生成の最後に、**その品目の名前に合った写真**へ機械的に差し替えます。バターにはバターの
写真が入ります。あなたがどのURLがどの被写体かを知らないまま選ぶ必要はありません。
一覧に並ぶ品目には**1件残らず** image を付けてください。写真の無い商品カードは
未完成に見えます。名前は具体的に書いてください（「商品A」ではなく「北海道産 無塩バター 200g」）
— 差し替えはその名前だけを手がかりにします。

━━ それ以外（ヒーロー帯・空状態の背景など）━━
上のURLをそのまま使ってください。一覧にないURLを書いてはいけません。

使ってはいけない場所:
- ダッシュボードの数値パネル、表、フォーム、設定画面
- アイコンの代わり（アイコンはインラインSVGで描く）
- 意味のない装飾

必ず alt を書き、object-fit: cover と明示的な高さを指定して、レイアウトが崩れないようにしてください。`
}

/**
 * Shown when nothing in the library is about this item.
 *
 * A neutral block rather than the nearest photograph, because the nearest
 * photograph is how a T-shirt ends up illustrated with a desk. Every catalogue
 * in the world has a "no image" state and none of them fills it with an
 * unrelated stock photo. Inline so it costs no request and cannot 404.
 */
/**
 * The library with the artwork removed and the best pictures first.
 *
 * Shared with the per-item assignment pass, which walks a subject's photographs
 * in order and hands them out one at a time. That pass read the library exactly
 * as collected, so a clip-art milk carton went onto a product card as readily as
 * a photograph of milk, and within a subject the order was whatever the
 * collection happened to produce. Both are the same defect the picker had; both
 * are fixed by asking the same question in one place.
 */
export function usablePhotographs(library: StockImage[]): StockImage[] {
  return library
    .filter(isPhotograph)
    .map((image) => ({ image, q: quality(image) }))
    .sort((a, b) => b.q - a.q)
    .map((x) => x.image)
}

export const NO_IMAGE: string = (() => {
  /**
   * It says 「画像なし」, in words.
   *
   * The first version drew a small picture-frame outline, and the outline was
   * the problem: a tidy line drawing in the middle of a card does not read as
   * "this is missing", it reads as a deliberate icon — so a catalogue of them
   * looks like a design choice rather than a gap. Text cannot be misread that
   * way.
   *
   * Width and height as well as the viewBox: an SVG carrying only a viewBox has
   * no intrinsic size, and a card that sizes its image from the file gets the
   * browser's default instead of the 4:3 box the layout expects. Measured — it
   * reported 200x150 for the viewBox-only version.
   *
   * `sans-serif` rather than a named face: the string is Japanese and the file
   * is rendered on whatever machine opens the mock, so naming a font is a way
   * to get a fallback nobody chose.
   */
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300" role="img" aria-label="画像なし">` +
    `<rect width="400" height="300" fill="#f1f2f4"/>` +
    `<rect x="0.5" y="0.5" width="399" height="299" fill="none" stroke="#e0e3e8"/>` +
    `<text x="200" y="150" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="sans-serif" font-size="26" fill="#9aa1ab">画像なし</text>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
})()


/**
 * Replaces any URL under our own image path that is not in the library.
 *
 * A model handed a list of URLs will occasionally write a plausible-looking one
 * that does not exist, and a broken image in a delivered mock is worse than no
 * image. Checked rather than trusted, and repaired in place: the alternative is
 * a defect the audits cannot see, because a 404 is invisible to a regex over
 * the source.
 *
 * What it is replaced WITH is the part that was wrong. This walked the whole
 * library in index order — `byIndex[n++ % byIndex.length]` — so an invented URL
 * became an arbitrary photograph out of three thousand, with no relationship to
 * the page it landed on. `assignItemImages` runs afterwards and rescues any of
 * these that sits next to an item name, but a hero band or a section background
 * has no label by design, so exactly the pictures that are largest on the screen
 * were the ones left holding a random photograph. That is the most visible half
 * of 「関連性の低い画像が挿入されている」.
 *
 * Now the substitute comes from the photographs actually chosen for this run,
 * which are the ones matched against this brief. With none to draw on it becomes
 * the same neutral placeholder an unmatched item gets — saying "no picture" is
 * always better than saying something untrue.
 */
export async function repairStockUrls(
  html: string,
  offered: PickedImage[] = []
): Promise<{ html: string; fixed: number }> {
  if (!CLOUDFRONT_DOMAIN || !html.includes(`${CLOUDFRONT_DOMAIN}/stock/`)) return { html, fixed: 0 }
  const library = await loadStockIndex()
  if (library.length === 0) return { html, fixed: 0 }

  const valid = new Set(library.map((i) => stockUrl(i)))
  const substitutes = offered.map((o) => o.url).filter(Boolean)
  let fixed = 0
  let n = 0
  const out = html.replace(
    /**
     * Both escapes doubled, because this is a template literal.
     *
     * It read [^"'\s)]+ and JavaScript dropped the backslash, so the class
     * excluded the LETTER s rather than whitespace. A stock URL contains s in
     * /stock/ itself, so every match stopped a character or two in, and that
     * fragment was never in the valid set — so every good URL was counted as
     * invented and replaced, and the replacement covered only the fragment,
     * leaving the rest of the old URL glued to the end of the new one.
     * The domain's dots were unescaped for the same reason.
     */
    new RegExp(`https://${CLOUDFRONT_DOMAIN.replace(/\./g, '\\.')}/stock/[^"'\\s)]+`, 'g'),
    (url) => {
      if (valid.has(url)) return url
      fixed++
      return substitutes.length ? substitutes[n++ % substitutes.length] : NO_IMAGE
    }
  )
  if (fixed > 0) {
    logger.info('Replaced invented stock image URLs', {
      fixed,
      substitutedFrom: substitutes.length ? 'this run\'s photographs' : 'placeholder',
    })
  }
  return { html: out, fixed }
}
