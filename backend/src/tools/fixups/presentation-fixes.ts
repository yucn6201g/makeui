/**
 * Deterministic repairs for what a screen shows and how it is reached: utility
 * classes and tokens used but never defined, a navigation left unstyled, icons
 * and artwork that were never drawn, and controls the keyboard cannot reach.
 */
import { FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import { UTILITY_CLASS, definedClasses, paletteOf, roleOf, utilityCss } from './utility-css.js'
import { listIsStyled, navCss, VERTICAL_NAV, type NavRoot } from './nav-css.js'
import { reachByKeyboard } from './keyboard-reach.js'
import { iconsOnPhotographs } from './picture-frames.js'
import {
  ICON_BUTTON_CSS,
  ICON_BUTTON_MARKER,
  ICON_DIR,
  glyphSource,
  iconPlacements,
  type IconPlacement,
} from './action-icons.js'
import {
  ART_DIR,
  CREATED_ART,
  artName,
  emptyStateArt,
  findArtHosts,
  type ArtHost,
  importPath,
  isDefaultExport,
  pickArtwork,
  renderedFrom,
} from './artwork.js'
import { declares, withImport } from './source-text.js'

/**
 * Utility classes that were written and never defined, given their CSS.
 *
 * `className="flex items-center gap-4 rounded-lg bg-white p-6 shadow-sm"` is
 * the vocabulary of a framework these projects do not carry, and every one of
 * those classes is inert. Measured over the last 102 stored documents, 23 (24%)
 * ship with three or more of them and the worst carries 95 — a page with no
 * padding, no card and no type scale, which is 「デザインが反映されておらず、
 * チープなデザインになってしまっている」.
 *
 * The audit has reported this as `utility-classes` for weeks and a model is
 * asked to rewrite the markup. It is still 24%. So the classes are made to work
 * instead, which is both the thing the user asked for — 「確実に効くように」 — and
 * the cheaper answer: a repair call not spent.
 *
 * See tools/fixups/utility-css.ts for what each class becomes and why colour, corners
 * and shadow go through the project's own tokens while spacing does not.
 * Classes it cannot map exactly are left alone and still reported.
 */
export function fixDeadUtilityClasses(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  // The largest stylesheet is the one carrying the tokens — the same choice
  // `stylesheetOf` makes, and for the same reason.
  const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))

  const defined = new Set<string>()
  for (const [, body] of sheets) {
    for (const c of definedClasses(body)) defined.add(c)
  }
  // A Vue project keeps its component CSS in the SFC, and a class defined there
  // is defined.
  for (const [path, body] of files) {
    if (!path.endsWith('.vue')) continue
    for (const style of body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      for (const c of definedClasses(style[1])) defined.add(c)
    }
  }

  const dead = new Set<string>()
  for (const [path, body] of files) {
    if (!/\.(tsx|jsx|vue)$/.test(path)) continue
    const values = [
      ...[...body.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]),
      ...[...body.matchAll(/\bclass(?:Name)?\s*=\s*\{\s*`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ' ')),
    ]
    for (const v of values) {
      for (const c of v.split(/\s+/)) {
        if (c && !defined.has(c) && UTILITY_CLASS.test(c)) dead.add(c)
      }
    }
  }
  /*
   * Three, the same floor the audit uses. One or two stray classes on a page
   * whose styling is otherwise its own is not the failure this is for, and
   * appending a stylesheet section for them would be louder than the problem.
   */
  if (dead.size < 3) return { files, fixed: [] }

  const written = utilityCss(dead, sheet[1])
  if (written.handled.length === 0) return { files, fixed: [] }

  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${written.css}\n`)
  return {
    files: out,
    fixed: [
      `${sheet[0]}: 定義の無いユーティリティクラス${written.handled.length}種類に CSS を書きました` +
        `（余白・寸法・文字はその名前の尺度どおり、色・角丸・影はこのプロジェクトのトークン経由）` +
        `${written.unhandled.length > 0 ? `。${written.unhandled.length}種類は対応表に無いのでそのままです` : ''}`,
    ],
  }
}

/**
 * A glyph on the button whose label already says what the glyph would say.
 *
 * `icons` on 22 of 76 stored documents. `tools/fixups/action-icons.ts` holds the
 * vocabulary, the shapes, and why this only touches buttons — two of the four
 * places the finding's own instruction names turned out to be wrong, and a user
 * reported both of them on one storefront.
 *
 * Reach: 17 of the 22 (77%), 53 pairings, every one read rather than counted.
 */
export function fixIconsNotDrawn(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const icons = renderedFrom(files, ICON_DIR, ext)
  if (icons.used.length > 0) return { files, fixed: [] }

  const own = icons.all.map((p): [string, string] => [artName(p), p])
  const places = iconPlacements(files, kind, own)
  if (places.length === 0) return { files, fixed: [] }

  const out = new Map(files)
  const created = new Set<string>()
  // Written from the end of each file, so an insertion does not move the
  // offsets of the buttons still to come.
  const byFile = new Map<string, IconPlacement[]>()
  for (const p of places) byFile.set(p.path, [...(byFile.get(p.path) ?? []), p])

  for (const [path, inFile] of byFile) {
    let body = out.get(path)
    if (body === undefined) continue
    const imports: string[] = []
    for (const p of [...inFile].sort((a, b) => b.at - a.at)) {
      let from = p.from
      if (!from) {
        from = `${ICON_DIR}${p.render}${ext}`
        if (!out.has(from)) { out.set(from, glyphSource(p.render, kind)); created.add(p.render) }
      }
      const source = out.get(from) ?? ''
      const clause = isDefaultExport(source) || created.has(p.render) ? p.render : `{ ${p.render} }`
      const statement = `import ${clause} from '${importPath(path, from)}'`
      if (!imports.includes(statement)) imports.push(statement)
      body = `${body.slice(0, p.at)}<${p.render} />${body.slice(p.at)}`
    }
    for (const statement of imports) body = withImport(body, statement, kind)
    out.set(path, body)
  }

  /*
   * And the rule that lines the glyph up with the words beside it. Without it
   * an inline `<svg>` sits on the text's baseline rather than beside it, which
   * is worse than the finding.
   */
  const sheets = [...out].filter(([p]) => p.endsWith('.css'))
  if (sheets.length > 0 && !sheets.some(([, b]) => b.includes(ICON_BUTTON_MARKER))) {
    const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))
    out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${ICON_BUTTON_CSS}\n`)
  }

  const labels = [...new Set(places.map((p) => p.render))]
  return {
    files: out,
    fixed: [
      `ラベルが動作を表しているボタン${places.length}個にアイコンを付けました（${labels.join('、')}` +
        `${created.size > 0 ? `。うち${[...created].join('、')}は新規作成` : ''}）`,
    ],
  }
}

/**
 * Takes the magnifier off the photograph — 「商品をクリックすると画像が表示される
 * が、中心に検索マークが表示されている」. What counts, and why it is narrow, is in
 * tools/fixups/picture-frames.ts.
 */
export function fixIconOnPhotograph(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const out = new Map(files)
  let removed = 0
  for (const [path, body] of files) {
    if (!path.endsWith(ext)) continue
    const found = iconsOnPhotographs(body)
    if (found.length === 0) continue
    let next = body
    for (const r of [...found].reverse()) next = next.slice(0, r.at) + next.slice(r.end)
    out.set(path, next)
    removed += found.length
  }
  if (removed === 0) return { files, fixed: [] }
  return {
    files: out,
    fixed: [`写真の上に重ねて描かれていた装飾アイコンを${removed}個取り除きました（写真が隠れます）`],
  }
}

const TOKEN_ALIAS_MARKER = '/* makeui:token-aliases */'

/**
 * Custom properties the project reads everywhere and defines nowhere.
 *
 * Found by looking at a drawing that was not there. doc25's empty cart renders
 * `EmptyCartIllustration` at 160x160, in the DOM, and invisible: every stroke is
 * `var(--border)`, the stylesheet defines no `--border`, and an undefined
 * custom property on `stroke` computes to `none`.
 *
 * It is not one document. Measured 2026-09-20 over the 34 stored projects, 22
 * (65%) read a custom property nothing defines, and in all 22 it happens inside
 * `illustrations/` or `icons/`. Two names account for 304 of the roughly 360
 * uses: `--text-muted` (208) and `--border` (96).
 *
 * Those two names are not the model's invention. They are the ones the repair
 * instruction for this very finding dictates — 「空状態の線画は…var(--border) と
 * var(--text-muted) を使い」 — while the presets name the same colours
 * `--color-border-subtle` and `--color-text-secondary`. So the pipeline asks for
 * a drawing in tokens the stylesheet does not have, the model complies, and the
 * result is an invisible picture that the audit then reports as a missing one.
 * That is a decent part of why `imagery-missing` survives half the runs it
 * appears in: the repair does the work and nothing appears on screen.
 *
 * The fix ALIASES rather than invents. `--border: var(--color-border-subtle)`
 * introduces no colour the design system did not already choose, so
 * `palette-size` and `preset-drift` — which count distinct colours and values
 * outside the bound system — do not move. A name whose role cannot be read from
 * it (`--color-neutral-9`, `--color-semantic-error`) is left undefined, for the
 * same reason: guessing at it would put a colour in the stylesheet that nothing
 * chose.
 *
 * `var(--x, fallback)` is not touched. It already renders.
 */
export function fixUndefinedTokens(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))

  const defined = new Set<string>()
  for (const [path, body] of files) {
    if (/\.(md|markdown|txt)$/i.test(path)) continue
    for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
  }

  const missing = new Set<string>()
  for (const [path, body] of files) {
    if (/\.(md|markdown|txt)$/i.test(path)) continue
    for (const m of body.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.add(m[1])
    }
  }
  if (missing.size === 0) return { files, fixed: [] }

  const palette = paletteOf(sheet[1])
  const lines: string[] = []
  for (const name of [...missing].sort()) {
    const role = roleOf(name)
    if (!role) continue
    const their = palette[role]
    if (!their || their === name) continue
    lines.push(`  ${name}: var(${their});`)
  }
  if (lines.length === 0) return { files, fixed: [] }

  const block = `${TOKEN_ALIAS_MARKER}\n:root {\n${lines.join('\n')}\n}`
  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${block}\n`)
  return {
    files: out,
    fixed: [
      `${sheet[0]}: 定義の無いカスタムプロパティ${lines.length}件を、このプロジェクトの` +
        `同じ役割のトークンに結びつけました（${lines.map((l) => l.trim().split(':')[0]).join('、')}）` +
        '。未定義の var() は stroke なら none になるため、図版が描画されていても見えません',
    ],
  }
}

/**
 * The drawing an empty screen was supposed to have, actually drawn.
 *
 * `imagery-missing` on 15 of the 34 stored documents (44%), the largest
 * source-visible finding there is. `tools/fixups/artwork.ts` holds the measurement, the
 * two halves it splits into, where a drawing is put and why only one file is
 * created when none exists.
 */
export function fixArtworkNotDrawn(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const art = renderedFrom(files, ART_DIR, ext)
  if (art.used.length > 0) return { files, fixed: [] }

  const hosts = findArtHosts(files, kind)
  if (hosts.length === 0) return { files, fixed: [] }

  const out = new Map(files)
  let created = ''

  /*
   * Nothing to draw, so one is drawn. ONE file, and it is rendered: three files
   * with none of them on screen is the shape this finding exists to report.
   *
   * Not into a header, though. The drawing made here is a tray for an empty
   * list, and the header fallback exists for a wordmark the project already has
   * — inventing one and putting a tray in the brand corner would be worse than
   * the finding.
   */
  if (art.all.length === 0) {
    if (hosts[0].place !== 'empty') return { files, fixed: [] }
    created = `${ART_DIR}${CREATED_ART}${ext}`
    out.set(created, emptyStateArt(kind))
  }
  const available = created ? [created] : art.all

  // Grouped by file and applied from the end of each, so an earlier insertion
  // does not move the offsets of the hosts still to come.
  const byFile = new Map<string, ArtHost[]>()
  for (const h of hosts) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h])

  const drawn: string[] = []
  for (const [path, inFile] of byFile) {
    let body = out.get(path)
    if (body === undefined) continue
    const source = pickArtwork(available, inFile[0].place, path)
    if (!source) continue
    const exported = artName(source)
    /*
     * The name it is rendered under, which is not always its own.
     *
     * A project's empty-state COMPONENT and its empty-state DRAWING are both
     * called `EmptyState` often enough that this was the first case the corpus
     * produced: importing `EmptyState` into a file that declares one puts an
     * import binding beside a function declaration of the same name. Sucrase
     * compiles that; a real module loader does not.
     */
    const name = declares(body, exported) ? `${exported}Illustration` : exported
    const clause = isDefaultExport(out.get(source) ?? '') || source === created
      ? name
      : name === exported ? `{ ${exported} }` : `{ ${exported} as ${name} }`
    const statement = `import ${clause} from '${importPath(path, source)}'`

    for (const h of [...inFile].sort((a, b) => b.at - a.at)) {
      /*
       * An icon already standing in for the drawing is REPLACED, not joined.
       * 「カートが空のときの…妙な位置に検索マークが表示されている」 was
       * `<EmptyStateArt />` inserted above the `<SearchIcon />` the build had
       * already put in that empty state. See `ArtHost.replaces`.
       */
      body = h.replaces
        ? body.slice(0, h.replaces.at) + `<${name} />` + body.slice(h.replaces.end)
        : body.slice(0, h.at) + `\n${h.indent}  <${name} />` + body.slice(h.at)
    }
    out.set(path, withImport(body, statement, kind))
    drawn.push(`${path}${inFile.length > 1 ? ` (${inFile.length})` : ''}`)
  }
  if (drawn.length === 0) return { files, fixed: [] }

  const where = hosts[0].place === 'empty' ? '空状態' : 'ヘッダー'
  return {
    files: out,
    fixed: [
      `${where}に図版を描画しました（${drawn.join('、')}）` +
        `${created ? `。${created} を作成` : `。${art.all.length}個あって1つも描画されていませんでした`}`,
    ],
  }
}

/**
 * Cards and rows that open something when clicked, and nothing when tabbed to.
 *
 * Reported by a user as 「依頼された要件が反映されていません: 商品カードはTabキーで
 * 辿れる」 on a storefront whose product cards were `<div … onClick={…}>`. The
 * requirement was real and the finding was right; what neither the check nor the
 * repair instruction said is that Tab reachability is not something a Tab key
 * handler provides. See `requirements.ts` for that half.
 *
 * Measured over the 34 stored project documents: 21 (62%) have at least one
 * such element. `tools/fixups/keyboard-reach.ts` holds the scan, what it refuses to
 * touch, and why the key handler re-dispatches a click rather than copying the
 * click expression.
 *
 * Vue is edited inside `<template>` only: the `<script>` block of an SFC is full
 * of `<` that opens nothing.
 */
export function fixKeyboardUnreachable(
  files: Map<string, string>,
  kind: OutputKind
): { files: Map<string, string>; fixed: string[] } {
  const ext = FRAMEWORKS[kind].componentExt
  const out = new Map(files)
  let total = 0
  const touched: string[] = []
  for (const [path, body] of files) {
    if (!path.endsWith(ext)) continue
    if (kind === 'vue') {
      const template = /<template>([\s\S]*)<\/template>/.exec(body)
      if (!template) continue
      const { source, count } = reachByKeyboard(template[1], kind)
      if (count === 0) continue
      out.set(path, body.slice(0, template.index + 10) + source + body.slice(template.index + 10 + template[1].length))
      total += count
      touched.push(path)
      continue
    }
    const { source, count } = reachByKeyboard(body, kind)
    if (count === 0) continue
    out.set(path, source)
    total += count
    touched.push(path)
  }
  if (total === 0) return { files, fixed: [] }
  return {
    files: out,
    fixed: [
      `クリックできるがキーボードで辿れない要素${total}個に tabindex と Enter/Space の処理を付けました` +
        `（${touched.slice(0, 3).join('、')}${touched.length > 3 ? ` ほか${touched.length - 3}件` : ''}）`,
    ],
  }
}

/**
 * A navigation left in the browser's bulleted list, given the design the rest
 * of the product has.
 *
 * Measured 2026-09-20 over 102 stored documents: 30 carry a list inside
 * `<nav>` and 17 of those (57%) render with a dot beside every item, no
 * spacing, no hover and no current-page state — 「ナビゲーションが箇条書きのまま
 * 表示されている…見栄えがかなり悪い」. Twelve of the seventeen put no class on the
 * list at all; the other five use one no stylesheet defines.
 *
 * The runtime audit reports this as `nav-unstyled` and asks a model to write
 * the rules. It is still 57%. See tools/fixups/nav-css.ts for what gets written and
 * why it descends from the nav rather than from the list.
 */
export function fixUnstyledNav(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  const sheet = sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))

  /*
   * Every rule the project has, wherever it keeps them — a Vue project puts
   * component CSS in the SFC, and a rule there styles the navigation just as
   * well as one in the stylesheet.
   */
  const allCss = [...files]
    .map(([path, body]) =>
      path.endsWith('.css')
        ? body
        : path.endsWith('.vue')
          ? [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
          : ''
    )
    .join('\n')
  const defined = definedClasses(allCss)

  const navs: NavRoot[] = []
  for (const [path, body] of files) {
    if (!/\.(tsx|jsx|vue)$/.test(path)) continue
    for (const found of body.matchAll(/<nav\b([^>]*)>([\s\S]{0,3000}?)<\/nav>/g)) {
      const list = /<(ul|ol)\b([^>]*)>/.exec(found[2])
      if (!list) continue
      const classesOf = (attrs: string): string[] => {
        const m = /\bclass(?:Name)?\s*=\s*["']([^"']*)["']/.exec(attrs)
        return m ? m[1].split(/\s+/).filter(Boolean) : []
      }
      const navClasses = classesOf(found[1])
      const listClasses = classesOf(list[2])
      const nav: NavRoot = {
        path,
        // A class no stylesheet defines is no better than none for hanging a
        // rule on, but it is still the honest selector to write.
        className: navClasses[0] ?? null,
        tag: list[1] as 'ul' | 'ol',
        listClasses,
        vertical: VERTICAL_NAV.test(
          `${navClasses.join(' ')} ${listClasses.join(' ')} ${path}`
        ),
      }
      /*
       * Anything that might already be reaching this list means this pass does
       * nothing. A class the project defines, a rule on the bare tag, a `*`
       * reset — see `listIsStyled`.
       */
      if (listClasses.some((c) => defined.has(c))) continue
      if (listIsStyled(allCss, nav)) continue
      navs.push(nav)
    }
  }
  if (navs.length === 0) return { files, fixed: [] }

  const written = navCss(navs, sheet[1])
  if (!written.css) return { files, fixed: [] }

  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${written.css}\n`)
  return {
    files: out,
    fixed: [
      `${sheet[0]}: ナビゲーションが箇条書きのままだったので CSS を書きました` +
        `（list-style の解除・並べ方・リンクの見た目・:hover・:focus-visible・現在地）: ${written.styled.join('、')}`,
    ],
  }
}

