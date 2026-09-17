import { readProjectFiles } from '../tools/project-transport.js'
import { PHOTO_SLOT } from '../tools/stock-images.js'
import type { InteractionDefect } from './interaction-audit.js'

/**
 * Whether the mock's data looks like data.
 *
 * Observed on a working, well-scoring generation — a warehouse dashboard whose
 * shelf table read:
 *
 *     A-01   1階 北側   8   ▓▓▓▓▓░░░░  55%
 *     A-02   1階 中央   8   ▓▓▓▓▓▓▓▓▓ 146%
 *     B-01   2階 南側   8   ▓▓▓▓▓▓▓▓▓ 137%
 *     C-01   3階 西側   8   ▓▓▓▓▓▓▓▓▓ 184%
 *
 * Every shelf holds exactly eight items, and a "stock rate" reaches 184% with a
 * progress bar pinned at full. Nothing in the pipeline could see either: the
 * layout is right, the components work, the controls are live, and the numbers
 * are the one thing no audit reads. It is also the first thing a person notices,
 * and it is what makes a mock read as a template with numbers dropped in rather
 * than a picture of a real system.
 *
 * Both checks are about the seed data rather than the rendering, because that is
 * where the fix belongs — a repair that adjusted the bar would leave the 184%
 * next to it.
 */

/** Records below this are too few for repetition to mean anything. */
const MIN_RECORDS = 5

/**
 * Fields whose repetition is normal and not a tell.
 *
 * A currency code, a unit, a tenant id — genuinely the same on every row in real
 * data. Everything else being identical across five or more records is flatness.
 */
const REPEATABLE = /^(currency|unit|locale|lang|language|tenant|org|type|kind|country|timezone|tz)$/i

interface Field {
  name: string
  values: string[]
}

/**
 * Object literals in an array, as field -> values.
 *
 * Deliberately a scanner rather than a parser. The alternative is running the
 * module, and these files import types from elsewhere in the project; the values
 * are literals written on their own lines, which is exactly what a scanner is
 * good at. A field it fails to see costs a missed finding, never a false one.
 */
function fieldsOf(source: string): Map<string, Field> {
  const fields = new Map<string, Field>()
  // `name: 'A-01',` / `quantity: 8,` — a literal value, not an expression.
  for (const m of source.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`|true|false)\s*,?\s*$/gm)) {
    const name = m[1]
    const value = m[2]
    const field = fields.get(name) ?? { name, values: [] }
    field.values.push(value)
    fields.set(name, field)
  }
  return fields
}

export function auditSeedData(html: string): InteractionDefect[] {
  const files = readProjectFiles(html)
  if (files.size === 0) return []

  const data = [...files.entries()].filter(([p]) => /^src\/(data|mocks?|fixtures)\//.test(p))
  // NOT an early return for the whole audit. It was, and that quietly disabled
  // the ratio check below on any project that keeps its seed records somewhere
  // other than src/data — which is where the 184% bar was actually measured.

  const flat: string[] = []
  for (const [path, body] of data) {
    for (const field of fieldsOf(body).values()) {
      if (field.values.length < MIN_RECORDS) continue
      if (REPEATABLE.test(field.name)) continue
      if (new Set(field.values).size > 1) continue
      /*
       * The photo slot is supposed to be the same on every record.
       *
       * `__PHOTO__` is this pipeline's own marker: the image assignment replaces
       * it with a real photograph per record at the end of the run, and the
       * instruction two hundred lines below this one tells the model to write
       * it. Reporting it as flat data contradicts that instruction in the same
       * audit — and the repair a model makes when told to "vary this field" is
       * to invent image URLs, which removes the slot and ships broken images.
       *
       * Measured on the v199 Svelte run: `imageUrl（20件すべて '__PHOTO__'）`.
       */
      if (String(field.values[0]).includes(PHOTO_SLOT)) continue
      /*
       * A `data:` URI is a payload, not a reference.
       *
       * v199 Svelte carried `url（5件すべて 'data:text/csv;base64,'）` — the
       * prefix of the CSV export link every row hands to the same download.
       * That is the same string on purpose, and telling a model to vary it
       * produces five differently-broken data URIs.
       *
       * Narrower than it looks: five records sharing one `imageUrl` pointing at
       * a real file is still flat data and still reported. Only a literal
       * payload is exempt, because a payload cannot be a reference to different
       * things.
       */
      if (/^['"]?data:/.test(String(field.values[0]).trim())) continue
      flat.push(`${path} の ${field.name}（${field.values.length}件すべて ${field.values[0]}）`)
    }
  }

  const defects: InteractionDefect[] = []
  if (flat.length > 0) {
    defects.push({
      id: 'seed-data-flat',
      instruction:
        'モックデータの次の項目が全レコードで同じ値です。実在するデータには見えないため、' +
        'それぞれ現実的にばらつく値に書き換えてください（件数・数量・日付・担当者・状態を' +
        'レコードごとに変える）:\n' +
        flat.slice(0, 8).map((f) => `  - ${f}`).join('\n'),
    })
  }

  /*
   * A second check lived here and has been removed.
   *
   * The motivating observation is real: the same dashboard showed a stock-rate
   * bar at 184%, pinned at full, because `(currentStock / minStock) * 100` is
   * not a percentage of anything bounded. The rule was going to be "an unclamped
   * ratio somewhere in the project, plus a percentage-driven width somewhere in
   * the project".
   *
   * It would not fire on the document it was written from, and I could not
   * establish why — the two halves each test true when evaluated by hand against
   * the same file list. A detector that cannot be shown working on the case that
   * motivated it is worse than no detector: it reports clean, and the next person
   * reads that as evidence.
   *
   * If it is picked up again, the thing to check first is whether the ratio and
   * the width are being looked for across the whole project rather than within
   * one file — in the measured case the division was in src/lib/ and the width in
   * src/screens/, which is the seam per-file assembly creates.
   */


  /**
   * An image source that can be the empty string.
   *
   * `<img src="">` is not a missing picture, it is a request for the CURRENT
   * PAGE — the browser resolves the empty URL against the document, fetches the
   * document again as an image, and logs a failure. Measured on a real Vue
   * generation:
   *
   *     function getProductImage(id: number): string {
   *       return getProduct(id)?.image || ''
   *     }
   *
   * with no `image` on any product record. Two console errors, an empty box
   * where the product photograph goes, and nothing else wrong with the page —
   * every file compiled, every screen rendered, every control worked.
   *
   * The fix is never "hide the image". It is to give the record a picture, or to
   * render the empty state instead of an `<img>`.
   */
  const emptySrc: string[] = []
  for (const [path, body] of files) {
    if (!/^src\//.test(path)) continue
    // `|| ''` or `?? ''` feeding something the markup uses as a source, and the
    // literal empty attribute.
    const fallsBackToEmpty = /\b(image|img|src|photo|thumbnail|avatar|cover)\w*\s*(\?\.\w+\s*)?(\|\||\?\?)\s*['"]{2}/i.test(body)
    const literalEmpty = /<img[^>]*\ssrc\s*=\s*(""|'')/.test(body) || /:src\s*=\s*(""|'')/.test(body)
    if (fallsBackToEmpty || literalEmpty) emptySrc.push(path)
  }
  if (emptySrc.length > 0) {
    defects.push({
      id: 'empty-image-src',
      instruction:
        '画像の src が空文字になりうる箇所があります' +
        `（${emptySrc.slice(0, 4).join('、')}）。` +
        '`<img src="">` は「画像なし」ではなく**現在のページ自身をもう一度取得する**指示になり、' +
        'コンソールに読み込み失敗が出たうえで、枠だけが空で残ります。' +
        '対処は次のどちらかです: (1) データの各レコードに画像を持たせる' +
        '（商品写真が要る一覧なら __PHOTO__ を書けば生成の最後に実物へ差し替わります）、' +
        '(2) 画像が無いレコードでは <img> を描画せず、空状態のプレースホルダを出す。' +
        '空文字を src に渡すことだけは避けてください。',
    })
  }

  return defects
}
