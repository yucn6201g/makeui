/**
 * A glyph on the button whose label already says what the glyph would say.
 *
 * `icons` is the second largest source-visible finding: 22 of 76 stored
 * documents render nothing from `src/components/icons/`. Its own instruction
 * names four places a glyph could go — 「ナビ・ボタン・空状態・ステータス表示」 —
 * and two of the four are now known to be wrong. A user reported both on one
 * storefront: a magnifier centred on a product photograph, and another one in an
 * empty cart. A project holding ONE icon reaches for it wherever it wants a
 * graphic, because the contract requires every glyph it draws to be rendered.
 *
 * So only buttons, and only where the pairing is not a judgement: the button's
 * whole content is one run of plain text, that text is an action this file has
 * a word for, and the glyph is the one that action is universally drawn with.
 *
 * ## Measured, and then measured again
 *
 * A first table reached 4 of 12 documents and paired 戻る with `CloseIcon` —
 * 戻る is "back", not "close". Separating them and reading every proposed
 * pairing rather than counting them gives 5 of 22 documents and 9 pairings,
 * every one of them right.
 *
 * 5 of 22 is not worth a pass. The reason it is so low is not the labels: 13 of
 * the 22 have no icon FILES at all, so there is nothing to pair with. Writing
 * the glyph the pairing needs — four or five universal shapes, drawn to the
 * contract the instruction already states — takes it to 17 of 22 (77%) and 53
 * pairings, and reading all 53: 保存→Check, キャンセル→Close, 閉じる→Close,
 * 次へ→ChevronRight, 戻る→ChevronLeft, 削除→Trash, 編集→Edit, 登録する→Plus,
 * カートに追加→Cart. None of them is wrong.
 *
 * The five that stay unpaired have buttons this file has no word for, and that
 * is the honest answer for them: a glyph chosen for a label nobody can map is
 * the magnifier on the photograph again.
 */

import { FRAMEWORKS, type OutputKind } from '../config/frameworks.js'

export const ICON_DIR = 'src/components/icons/'

/**
 * What a button's label means, and the glyph it is drawn with.
 *
 * `name` is the component written when the project has nothing suitable;
 * `words` are what a project's OWN icon file would be called, so its glyph is
 * preferred over a new one. Anchored at the start of the label: 「削除しますか」
 * in a dialog's body is not a delete button, and a label is only matched when
 * it is the whole of the button.
 */
export interface ActionGlyph {
  label: RegExp
  name: string
  words: string[]
  /**
   * After the words rather than before them.
   *
   * Only for a glyph that points the way the button goes: 「次へ →」 reads and
   * 「→ 次へ」 does not, while 「← 戻る」 reads and 「戻る ←」 does not. Everything
   * else is a symbol for the action and sits in front of its name.
   */
  trailing?: boolean
}

export const ACTION_GLYPHS: ActionGlyph[] = [
  { label: /^検索(?:する)?$/, name: 'SearchIcon', words: ['search', 'magnif', 'lens'] },
  { label: /^(?:絞り込|フィルタ)/, name: 'FilterIcon', words: ['filter', 'funnel', 'slider', 'adjust'] },
  { label: /カートに(?:追加|入れる)/, name: 'CartIcon', words: ['cart', 'basket', 'bag'] },
  { label: /^(?:追加|新規|作成|登録)/, name: 'PlusIcon', words: ['plus', 'add', 'new'] },
  { label: /^(?:閉じる|とじる)$/, name: 'CloseIcon', words: ['close', 'xmark', 'cross', 'dismiss'] },
  { label: /^(?:キャンセル|取消|取り消し)/, name: 'CloseIcon', words: ['close', 'xmark', 'cross', 'cancel'] },
  // Back is not close. The first table said it was.
  { label: /^(?:戻る|前へ)$|に戻る$/, name: 'ChevronLeftIcon', words: ['arrowleft', 'chevronleft', 'caretleft', 'back'] },
  { label: /^(?:次へ|進む)$/, name: 'ChevronRightIcon', words: ['arrowright', 'chevronright', 'caretright', 'next'], trailing: true },
  { label: /^(?:保存|確定|完了|適用|決定)/, name: 'CheckIcon', words: ['check', 'save', 'done', 'tick', 'floppy'] },
  { label: /^削除/, name: 'TrashIcon', words: ['trash', 'delete', 'bin', 'remove'] },
  { label: /^編集/, name: 'EditIcon', words: ['edit', 'pencil', 'pen'] },
  { label: /^設定/, name: 'SettingsIcon', words: ['setting', 'gear', 'cog'] },
  { label: /^(?:ダウンロード|出力|エクスポート)/, name: 'DownloadIcon', words: ['download', 'export'] },
]

/**
 * The shapes, to the contract the repair instruction already states: a 24x24
 * viewBox, `fill="none"`, `stroke="currentColor"`, stroke-width 1.5, and
 * `aria-hidden` because the label beside it says the same thing out loud.
 *
 * Sized in `em` rather than pixels so a glyph matches whatever the button's
 * text is set at; the projects here run from 13px to 16px on their buttons.
 */
const PATHS: Record<string, string> = {
  SearchIcon: '<circle cx="11" cy="11" r="7" /><path d="M16.5 16.5 L21 21" />',
  FilterIcon: '<path d="M3 5h18l-7 8v6l-4 2v-8Z" />',
  CartIcon: '<circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M2 3h3l2.7 11.4a1.5 1.5 0 0 0 1.5 1.1h8.6a1.5 1.5 0 0 0 1.5-1.2L21.5 7H6" />',
  PlusIcon: '<path d="M12 5v14M5 12h14" />',
  CloseIcon: '<path d="M6 6l12 12M18 6L6 18" />',
  ChevronLeftIcon: '<path d="M15 5l-7 7 7 7" />',
  ChevronRightIcon: '<path d="M9 5l7 7-7 7" />',
  CheckIcon: '<path d="M4 12.5l5.5 5.5L20 7" />',
  TrashIcon: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />',
  EditIcon: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" /><path d="M14.5 6.5l3 3" />',
  SettingsIcon: '<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />',
  DownloadIcon: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16" />',
}

/** One glyph, as a file this framework can compile. */
export function glyphSource(name: string, kind: OutputKind): string {
  const svg =
    `<svg\n` +
    `    viewBox="0 0 24 24"\n` +
    `    width="1.15em"\n` +
    `    height="1.15em"\n` +
    `    fill="none"\n` +
    `    stroke="currentColor"\n` +
    `    stroke-width="1.5"\n` +
    `    stroke-linecap="round"\n` +
    `    stroke-linejoin="round"\n` +
    `    aria-hidden="true"\n` +
    `  >${PATHS[name]}</svg>`
  if (kind === 'vue') return `<template>\n  ${svg}\n</template>\n`
  const jsx = svg.replace(/stroke-(width|linecap|linejoin)=/g, (_m, p: string) => `stroke${p[0].toUpperCase()}${p.slice(1)}=`)
  return `export default function ${name}() {\n  return (\n    ${jsx}\n  );\n}\n`
}

export interface IconPlacement {
  path: string
  /** Where the label's text begins, inside the button. */
  at: number
  /** The glyph's component name, as this file will render it. */
  render: string
  /** The file it comes from, or '' when it has to be written. */
  from: string
  /** Whether it goes after the label rather than before it. */
  trailing: boolean
}

/**
 * A button whose content is exactly one run of plain text.
 *
 * Anything else is a button that already has structure in it — a span, a count,
 * an interpolated name — and a glyph pushed into that is a guess about a layout
 * this cannot see.
 */
const PLAIN_BUTTON = /<(button|Button)\b[^>]*>(\s*)([^<>{}\n]{1,18}?)(\s*)<\/\1>/g

/** Every button that should be given a glyph, and which glyph. */
export function iconPlacements(
  files: Map<string, string>,
  kind: OutputKind,
  /** The project's own glyphs, as [component name, path]. */
  own: Array<[string, string]>
): IconPlacement[] {
  const ext = FRAMEWORKS[kind].componentExt
  const out: IconPlacement[] = []
  /** One decision per label, so every 保存 button in the project matches. */
  const decided = new Map<string, { render: string; from: string; trailing: boolean } | null>()

  for (const [path, body] of files) {
    if (!path.endsWith(ext) || path.startsWith(ICON_DIR)) continue
    const markup = kind === 'vue' ? /<template>([\s\S]*)<\/template>/.exec(body) : null
    const offset = kind === 'vue' ? (markup?.index ?? -1) + 10 : 0
    const source = kind === 'vue' ? (markup?.[1] ?? '') : body
    if (!source) continue

    for (const m of source.matchAll(PLAIN_BUTTON)) {
      const label = m[3].trim()
      if (!decided.has(label)) {
        const glyph = ACTION_GLYPHS.find((g) => g.label.test(label))
        if (!glyph) {
          decided.set(label, null)
        } else {
          // The project's own glyph for this action, when it drew one.
          const mine = own.find(([name]) => glyph.words.some((w) => name.toLowerCase().includes(w)))
          decided.set(label, {
            render: mine ? mine[0] : glyph.name,
            from: mine ? mine[1] : '',
            trailing: Boolean(glyph.trailing),
          })
        }
      }
      const choice = decided.get(label)
      if (!choice) continue
      const labelAt = m[0].indexOf(m[3], m[1].length + 1)
      out.push({
        path,
        at: offset + (m.index ?? 0) + (choice.trailing ? labelAt + m[3].length : labelAt),
        render: choice.render,
        from: choice.from,
        trailing: choice.trailing,
      })
    }
  }
  return out
}

/**
 * The stylesheet rule that makes a button with a glyph in it line up.
 *
 * One rule rather than an inline style on each button: the class names differ
 * per project and per preset, and `:has()` asks the question this needs —
 * "a button that now contains a drawing" — without naming any of them. A button
 * that already held one is unaffected; `gap` does nothing with a single child.
 */
export const ICON_BUTTON_MARKER = '/* makeui:icon-buttons */'

export const ICON_BUTTON_CSS = `${ICON_BUTTON_MARKER}
button:has(> svg),
a:has(> svg),
[class*="btn"]:has(> svg),
[class*="button"]:has(> svg) {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
}`
