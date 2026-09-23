/**
 * A show-or-hide by width that the cascade has already overruled.
 *
 * Reported on a Digital Agency storefront (2026-09-23): a 「絞り込み」 button
 * meant for phones only sat full-width across the middle of the desktop page.
 * It carried two classes — `.da-filter-toggle { display: none }`, shown again
 * in `@media (max-width: 767px)`, and `.da-btn { display: inline-flex }` — and
 * `.da-btn` came later in the sheet at the same specificity, so the hide never
 * applied. The same file had the mirror image: the filter panel collapsed by
 * `display: none` inside the phone media query, then `.da-filter-panel {
 * display: flex }` written after it, so on a phone the panel could not be
 * closed and the toggle did nothing.
 *
 * Both are one mistake — a width-dependent `display` written at the same
 * specificity as a rule that follows it — and both have one mechanical answer
 * that changes nothing but which rule wins: raise the width-dependent rules.
 *
 *   A — hidden everywhere, shown by a media query, and sharing its element
 *       with a later class that sets `display`: the hide becomes `.C.C`, the
 *       media query's show `.C.C.C`, so the other class loses to both.
 *   B — hidden inside a max-width query and overruled by a later top-level
 *       rule for the same class: the hide becomes `.C.C`, and the rules in the
 *       same query that show it again (an `--open` state) become `.X.X.X`,
 *       so opening still works.
 *
 * Only single-class selectors are touched and only where the conflict is found:
 * over the 88 stored documents this fires on exactly the one reported.
 */

interface CssRule {
  sel: string
  selStart: number
  selEnd: number
  body: string
  media: string | null
  /** Which media block, so rules can be grouped with their siblings. */
  block: number
  pos: number
}

/** Top-level and one-deep @media rules, with the offsets of their selectors. */
function cssRules(css: string): CssRule[] {
  const out: CssRule[] = []
  let pos = 0
  let block = 0
  const scan = (from: number, to: number, media: string | null, blockId: number): void => {
    let k = from
    while (k < to) {
      const open = css.indexOf('{', k)
      if (open < 0 || open >= to) return
      const rawHead = css.slice(k, open)
      const head = rawHead.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      // The matching close, counting nesting.
      let depth = 1
      let j = open + 1
      while (j < to && depth) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      if (head.startsWith('@media')) {
        scan(open + 1, j - 1, head, ++block)
      } else if (!head.startsWith('@')) {
        // The selector starts after any comment written above the rule —
        // 「/* Buttons */」 sits in the same stretch of text as `.da-btn`.
        const afterComment = rawHead.lastIndexOf('*/') + 1 ? rawHead.lastIndexOf('*/') + 2 : 0
        const selText = rawHead.slice(afterComment)
        const lead = selText.length - selText.trimStart().length
        const selStart = k + afterComment + lead
        const selEnd = selStart + selText.trim().length
        out.push({ sel: selText.trim(), selStart, selEnd, body: css.slice(open + 1, j - 1), media, block: blockId, pos: pos++ })
      }
      k = j
    }
  }
  scan(0, css.length, null, 0)
  return out
}

const displayOf = (body: string): string | undefined => /(?:^|[;{\s])display\s*:\s*([\w-]+)/.exec(body)?.[1]
const singleClass = (sel: string): string | null => (/^\.[\w-]+$/.test(sel) ? sel.slice(1) : null)
const shows = (body: string): boolean => {
  const d = displayOf(body)
  return Boolean(d && d !== 'none')
}

/** Every class list written in the project's markup, as arrays of class names. */
function classLists(files: Map<string, string>): string[][] {
  const lists: string[][] = []
  for (const [path, body] of files) {
    if (!/\.(tsx|jsx|vue)$/.test(path)) continue
    for (const m of body.matchAll(/\bclass(?:Name)?\s*=\s*(?:\{\s*)?["'`]([^"'`]+)["'`]/g)) {
      lists.push(m[1].split(/\s+/).map((c) => c.replace(/\$\{[^}]*\}/g, '')).filter(Boolean))
    }
  }
  return lists
}

export function fixResponsiveDisplay(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const lists = classLists(files)
  const out = new Map(files)
  const fixed: string[] = []
  for (const [path, css] of files) {
    if (!path.endsWith('.css')) continue
    const rules = cssRules(css)
    const edits = new Map<number, { end: number; to: string }>()
    const raise = (r: CssRule, times: number): void => {
      const c = singleClass(r.sel)
      if (!c || edits.has(r.selStart)) return
      edits.set(r.selStart, { end: r.selEnd, to: `.${c}`.repeat(times) })
    }
    const notes: string[] = []

    // A — hidden at the top level, shown by a media query, overruled by a co-class.
    for (const r of rules) {
      const c = singleClass(r.sel)
      if (!c || r.media || displayOf(r.body) !== 'none') continue
      const shownBy = rules.filter((m) => m.media && singleClass(m.sel) === c && shows(m.body))
      if (shownBy.length === 0) continue
      const rival = lists
        .filter((l) => l.includes(c))
        .flatMap((l) => l.filter((d) => d !== c))
        .find((d) => rules.some((x) => !x.media && singleClass(x.sel) === d && shows(x.body) && x.pos > r.pos))
      if (!rival) continue
      raise(r, 2)
      for (const m of shownBy) raise(m, 3)
      notes.push(`.${c}（.${rival} に上書きされ、隠れていなかった）`)
    }

    // B — hidden inside a max-width query, overruled by a later top-level rule.
    for (const r of rules) {
      const c = singleClass(r.sel)
      if (!c || !r.media || !/max-width/.test(r.media) || displayOf(r.body) !== 'none') continue
      const later = rules.find((x) => !x.media && singleClass(x.sel) === c && shows(x.body) && x.pos > r.pos)
      if (!later) continue
      raise(r, 2)
      for (const s of rules) if (s.block === r.block && s !== r && shows(s.body)) raise(s, 3)
      notes.push(`.${c}（狭い画面での非表示が、後ろの .${c} に上書きされていた）`)
    }

    if (edits.size === 0) continue
    let next = css
    for (const [start, { end, to }] of [...edits].sort((a, b) => b[0] - a[0])) {
      next = next.slice(0, start) + to + next.slice(end)
    }
    out.set(path, next)
    fixed.push(`画面幅で出し分ける表示が、後ろの規則に負けて効いていなかったため、優先度を上げました: ${[...new Set(notes)].join('、')}`)
  }
  return fixed.length ? { files: out, fixed } : { files, fixed: [] }
}
