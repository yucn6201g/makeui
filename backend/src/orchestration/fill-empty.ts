import type { EmptyBox, RuntimeFacts } from '../tools/browser-verify.js'
import { logger } from '../utils/logger.js'

/**
 * Writes real content into containers that rendered empty.
 *
 * The generic repair pass cannot do this, and measurement showed exactly why: it
 * is told "keep the existing markup, copy and visual design exactly as they are,
 * do not restyle", which is the opposite of "draw a real chart into this empty
 * box". Handed both, it did the conservative thing — on a measured run it fixed
 * a preset drift, left the empty Gantt chart untouched, and was accepted for the
 * improvement it did make. The defect was detected, reported, repaired around,
 * and shipped.
 *
 * So this is a separate pass with the opposite instruction: it is allowed, and
 * required, to author substantial new content — but only inside one named
 * element. Everything outside that element is spliced back byte-for-byte, so
 * the permission to write cannot become permission to damage.
 */

/** Enough of the document around the hole for the model to match its style and data. */
const CONTEXT_CHARS = 4000

/** Two per run. A document with more holes than that needs regenerating, not patching. */
const MAX_FILLS = 2

export interface FillTarget {
  box: EmptyBox
  screen: string
  /** Index in the source where the element's opening tag starts. */
  start: number
  /** Index just past the element's closing tag. */
  end: number
  /** The element's current inner content (empty or whitespace, by definition). */
  openTag: string
  closeTag: string
}

/** The tag name out of an opening tag, e.g. `<div class="x">` -> `div`. */
function tagNameOf(openTag: string): string | null {
  const m = /^<([a-zA-Z][\w-]*)/.exec(openTag)
  return m ? m[1].toLowerCase() : null
}

/**
 * Elements whose emptiness is correct, and which must never be written into.
 *
 * The probe already skips these, but the guard lives here too: this module is
 * the one that writes, and a target list is an input it does not control. The
 * failure it prevents was real — 586 characters of help text written into a
 * <textarea> that had a perfectly good placeholder.
 */
const NEVER_FILL = /^(textarea|input|select|canvas|iframe|svg|img|video|audio|object|embed|script|style)$/

/**
 * Finds the element in the source and returns its exact bounds.
 *
 * Located by id when there is one, otherwise by the opening tag verbatim — and
 * only when that tag appears exactly once. A second occurrence means we cannot
 * tell which box the browser measured, and writing into the wrong one is worse
 * than leaving the right one empty.
 */
export function locate(html: string, box: EmptyBox, screen: string): FillTarget | null {
  const tag = tagNameOf(box.openTag)
  if (!tag) return null
  if (NEVER_FILL.test(tag)) {
    logger.info('Empty box skipped — this element is meant to be empty', { screen, tag, label: box.label })
    return null
  }

  let start = -1
  if (box.id) {
    // `id` is unique by definition, so an id-bearing box is the easy case.
    const idPattern = new RegExp(`<${tag}\\b[^>]*\\bid=["']${box.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i')
    const m = idPattern.exec(html)
    if (m) start = m.index
  }
  if (start < 0) {
    const first = html.indexOf(box.openTag)
    if (first < 0) return null
    if (html.indexOf(box.openTag, first + 1) >= 0) {
      logger.info('Empty box skipped — its opening tag is not unique in the source', {
        screen,
        label: box.label,
      })
      return null
    }
    start = first
  }

  const openEnd = html.indexOf('>', start)
  if (openEnd < 0) return null
  const openTag = html.slice(start, openEnd + 1)

  // Self-closing or void elements have no inside to fill.
  if (/\/>\s*$/.test(openTag)) return null

  // Walk to the matching close, counting nesting of the same tag.
  const open = new RegExp(`<${tag}\\b`, 'gi')
  const close = new RegExp(`</${tag}\\s*>`, 'gi')
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0) {
    open.lastIndex = cursor
    close.lastIndex = cursor
    const o = open.exec(html)
    const c = close.exec(html)
    if (!c) return null
    if (o && o.index < c.index) {
      depth++
      cursor = o.index + 1
    } else {
      depth--
      cursor = c.index + c[0].length
      if (depth === 0) {
        return { box, screen, start, end: cursor, openTag, closeTag: c[0] }
      }
    }
  }
  return null
}

const SYSTEM = `あなたはUIエンジニアです。既存のページの中で、**枠だけあって中身が空**になっている
要素を1つ渡します。その中身だけを書いてください。

出力するのは、その要素の**内側に入るHTMLだけ**です。要素そのもののタグは書かないでください。
説明も、マークダウンのコードフェンスも書かないでください。

守ること:
- 周囲のコードから、この画面が扱っているデータと使われているクラス名・CSS変数を読み取り、
  **同じ流儀で**書いてください。新しい色やフォントを持ち込まないでください。
- グラフなら、周囲にある実際のデータを使ってインラインSVGで描いてください。
  固定値のダミーではなく、その画面が持っているレコードを反映させてください。
- リストや表なら、実在しそうなレコードを十分な行数で入れてください。
- 与えられた寸法（幅・高さ）の中に収まるように作ってください。
- **同じ要素の繰り返しで埋めないでください。** 観測した実例では、ガントチャートの1本の
  バーを月セルごとに分割し、同じ案件名を6回書いて埋めていました。1つの連続した期間は
  1本のバーで表し、ラベルは1回だけ書いてください。空間を埋めることが目的ではなく、
  その要素が本来示すはずの情報を示すことが目的です。
- 文言は日本語で書いてください。
- 画像ファイルは参照できません。図はすべてインラインSVGで描いてください。`

export interface FillOutcome {
  html: string
  filled: string[]
}

/**
 * @param invoke The pipeline's model caller, injected so this module carries no
 *   Bedrock wiring and can be exercised with a stub.
 */
export async function fillEmptyContainers(
  html: string,
  facts: RuntimeFacts,
  presetSpec: string,
  invoke: (system: string, user: string) => Promise<string>
): Promise<FillOutcome> {
  const targets: FillTarget[] = []
  for (const screen of facts.screens) {
    for (const box of screen.emptyBoxes) {
      if (targets.length >= MAX_FILLS) break
      const t = locate(html, box, screen.id)
      if (t) targets.push(t)
    }
  }
  if (targets.length === 0) return { html, filled: [] }

  const filled: string[] = []
  let out = html
  /**
   * Applied last-first so that each splice leaves every earlier target's offsets
   * untouched. Filling in document order would shift everything after the first
   * write and quietly corrupt the second.
   */
  for (const t of [...targets].sort((a, b) => b.start - a.start)) {
    const before = out.slice(Math.max(0, t.start - CONTEXT_CHARS), t.start)
    const after = out.slice(t.end, t.end + CONTEXT_CHARS)
    try {
      const inner = await invoke(
        SYSTEM,
        `${presetSpec ? `デザインシステム（この値だけを使う）:\n${presetSpec}\n\n` : ''}` +
          `画面: ${t.screen}\n` +
          `空になっている要素: ${t.openTag}\n` +
          `その要素の実寸: ${t.box.width}px × ${t.box.height}px\n\n` +
          `直前のコード:\n${before}\n\n` +
          `直後のコード:\n${after}\n\n` +
          `この要素の中身だけを出力してください。`
      )
      const body = inner
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim()
      // A few characters back is the model declining, not a fill.
      if (body.length < 40) {
        logger.info('Empty box fill produced nothing usable', { screen: t.screen, label: t.box.label, chars: body.length })
        continue
      }
      out = out.slice(0, t.start) + t.openTag + '\n' + body + '\n' + t.closeTag + out.slice(t.end)
      filled.push(`${t.screen}/${t.box.label}`)
    } catch (e) {
      logger.warn('Empty box fill failed', { screen: t.screen, error: String(e) })
    }
  }

  if (filled.length > 0) {
    logger.info('Empty containers filled', { filled, beforeChars: html.length, afterChars: out.length })
  }
  return { html: out, filled }
}
