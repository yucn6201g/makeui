import { withoutProse, type InteractionDefect } from './interaction-audit.js'
import type { OutputKind } from '../config/frameworks.js';
import { readProjectFiles } from '../tools/project-transport.js';

/**
 * Machine-checkable audit of the tells that make output read as machine-made.
 *
 * "Make it look less AI-generated" is not something a prompt can guarantee — the
 * same instruction has been in the system prompt for weeks and the same tells
 * keep coming back. What a prompt asks for, only a check enforces. So the tells
 * are enumerated here, measured on the finished document, and handed to the
 * repair pass exactly like the interactivity defects.
 *
 * Every rule below is deliberately narrow. A false positive costs a full model
 * call and risks a rewrite of a good document, so anything that a real product
 * might legitimately do is left out.
 */

/**
 * Emoji used as interface furniture.
 *
 * The ranges cover pictographs, emoticons, transport, supplemental symbols and
 * flags. Typographic marks that products genuinely set in text — check marks,
 * crosses, arrows, bullets, dashes — are excluded, because banning those would
 * flag correct work.
 *
 * Miscellaneous Symbols (U+2600-U+26FF) was excluded wholesale for that reason,
 * and that was too broad: it also contains ☕ ⚡ ⛄ ⚽ ☀, which are emoji by any
 * reading. A generated coffee shop shipped `<button>☕ コーヒー器具 EC</button>` as
 * its logo and the audit passed it. The block is now included, minus the handful of
 * marks a real product does typeset — stars for ratings, ballot boxes for
 * checklists, the warning sign for alerts.
 */
const EMOJI_RE =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{2705}\u{2728}\u{274C}\u{2764}\u{2B50}\u{1F004}\u{FE0F}]/u

/** Same ranges, global, for counting. */
const EMOJI_RE_G = new RegExp(EMOJI_RE.source, 'gu')

/**
 * Marks inside the ranges above that products legitimately set as text.
 * ★☆ rating stars, ☐☑☒ ballot boxes, ⚠ warning, ♠♥♦♣ card suits.
 */
const TYPOGRAPHIC_MARKS = new Set([
  '★', '☆', '☐', '☑', '☒', '⚠',
  '♠', '♣', '♥', '♦',
])

export function countEmoji(text: string): number {
  return (text.match(EMOJI_RE_G) ?? []).filter((c) => !TYPOGRAPHIC_MARKS.has(c)).length
}

/**
 * Text a user would actually read: element content and the string literals JSX
 * renders. Scanning the raw document instead would match emoji inside comments
 * or data that never reaches the screen.
 */
function visibleText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
}

/** Marketing filler that signals nobody wrote for this product in particular. */
const FILLER_RE =
  /(supercharge|seamlessly|next[- ]level|game[- ]changer|unlock the power|elevate your|革新的な体験|シームレスに|次世代の体験|新しい体験を、?今すぐ)/i

/** Placeholder naming that survived into the finished document. */
const PLACEHOLDER_NAMING_RE = /(feature\s+(one|two|three)|項目\s*[123]\b|サンプル(テキスト|項目)|ダミーテキスト)/i

/** The default palette models reach for when they have not chosen one. */
const DEFAULT_PALETTE_RE = /#6366f1|#818cf8|#8b5cf6|#7c3aed|#a855f7|#4f46e5|#c084fc/i

export function auditAiTells(
  html: string,
  presetName: string | undefined,
  outputKind: OutputKind
): InteractionDefect[] {
  const defects: InteractionDefect[] = []

  /**
   * Every rule below is measured on the part of the document that ships.
   *
   * Generated projects are required to carry docs/design-guidelines.md, and that
   * file is this ban list restated for the app: it contains "❌ Emoji as icons",
   * 「回避: #6366f1, #8b5cf6」and 「filler copy（「Supercharge」「Seamlessly」）」as the
   * rules the app follows. Measured over the raw document, the guidelines matched
   * every pattern here — emoji, default-palette and filler-copy all fired on a
   * document that obeyed all three. Worse, the finding was unrepairable: the repair
   * pass was asked to remove emoji from a UI that had none, so it changed nothing
   * and was correctly rejected, and the next generation wrote the guidelines again.
   * Four of the six runs that ended with open defects were exactly this.
   */
  const shipped = withoutProse(html)
  const text = visibleText(shipped)

  /*
   * The same rules, asked of one file at a time, so a finding can name where it
   * is. `readProjectFiles` returns nothing for a single-page document, and then
   * every list below is empty and the planner decides as it did before.
   */
  const sources = [...readProjectFiles(html)].filter(([p]) => !/\.(md|markdown|txt)$/i.test(p))
  const inSource = (re: RegExp): string[] => sources.filter(([, body]) => re.test(body)).map(([p]) => p)
  const inText = (re: RegExp): string[] => sources.filter(([, body]) => re.test(visibleText(body))).map(([p]) => p)
  const emojiFiles = (): string[] => sources.filter(([, body]) => countEmoji(visibleText(body)) > 0).map(([p]) => p)

  const emoji = countEmoji(text)
  if (emoji > 0) {
    defects.push({
      id: 'emoji',
      instruction:
        `絵文字が ${emoji} 個使われています。UI から絵文字を完全に除去してください。` +
        (outputKind === 'react'
          ? 'アイコンが必要な箇所は src/components/icons/ のインライン SVG コンポーネントに置き換えてください。'
          : 'アイコンが必要な箇所はインライン <svg>（viewBox="0 0 24 24" / stroke="currentColor"）に置き換えてください。') +
        '装飾目的の絵文字は置き換えではなく削除してください。',
      paths: emojiFiles(),
    })
  }

  /**
   * The machine-default palette, checked whether or not a preset is bound.
   *
   * This used to be skipped entirely when a preset was selected, on the
   * reasoning that a preset already dictates the palette. It dictates it; it
   * does not enforce it — that is what conformance is for, and conformance
   * reports a ratio rather than a named finding, so indigo could appear in a
   * `warm` document and no check would say so. The user-visible consequence is
   * the one thing a preset is chosen to prevent: selecting a design system and
   * still getting a page that looks machine-made.
   *
   * With a system bound it is the stronger finding, not the weaker one: the
   * colour is both a tell and off-system, and the fix is named rather than left
   * to judgement.
   */
  const bound = Boolean(presetName) && presetName !== 'none'
  if (DEFAULT_PALETTE_RE.test(shipped)) {
    defects.push({
      id: 'default-palette',
      instruction: bound
        ? `indigo / violet の既定パレット（#6366f1, #8b5cf6, #7c3aed 等）が使われています。` +
          `このドキュメントは「${presetName}」デザインシステムで作られており、この色はシステムにありません。` +
          'デザインシステムが定義するアクセント色と中間色に置き換えてください。新しい色を作らないこと。'
        : 'indigo / violet の既定パレット（#6366f1, #8b5cf6, #7c3aed 等）が使われています。' +
          'この製品のドメインから選んだアクセント色1つに置き換え、中間色も一貫した1系統に統一してください。',
      paths: inSource(DEFAULT_PALETTE_RE),
    })
  }

  if (/background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/i.test(shipped)) {
    defects.push({
      id: 'gradient-text',
      instruction:
        '見出しのグラデーション文字を単色に置き換えてください。階層はサイズ・ウェイト・余白で表現します。',
      paths: inSource(/background-clip\s*:\s*text|-webkit-background-clip\s*:\s*text/i),
    })
  }

  // A glass header over a blurred backdrop is the single most recognisable
  // template. Legitimate uses (a modal scrim) are not on <header>/<nav>.
  if (/(?:header|nav)[^{}]*\{[^}]*backdrop-filter\s*:\s*blur/i.test(shipped)) {
    defects.push({
      id: 'glass-nav',
      instruction:
        'ヘッダー / ナビの glassmorphism（backdrop-filter: blur）をやめ、不透明な背景と' +
        '1px の境界線にしてください。',
      paths: inSource(/(?:header|nav)[^{}]*\{[^}]*backdrop-filter\s*:\s*blur/i),
    })
  }

  // Coloured glow: a shadow with no offset and a wide blur, in an accent colour.
  if (/box-shadow\s*:\s*0\s+0\s+\d{2,}px[^;]*rgba?\((?!\s*0\s*,\s*0\s*,\s*0)/i.test(shipped)) {
    defects.push({
      id: 'glow-shadow',
      instruction:
        '色付きのグロー影を、ごく薄い中性色の影（または境界線のみ）に置き換えてください。',
      paths: inSource(/box-shadow\s*:\s*0\s+0\s+\d{2,}px[^;]*rgba?\((?!\s*0\s*,\s*0\s*,\s*0)/i),
    })
  }

  if (FILLER_RE.test(text)) {
    defects.push({
      id: 'filler-copy',
      instruction:
        '「革新的」「シームレス」「次世代」等の空疎なコピーを、この製品について実際に言える' +
        '具体的な文章に書き換えてください。',
      paths: inText(FILLER_RE),
    })
  }

  if (PLACEHOLDER_NAMING_RE.test(text)) {
    defects.push({
      id: 'placeholder-naming',
      instruction:
        '「項目1」「サンプルテキスト」等の仮の名前を、この製品で実際に使われる名称・データに' +
        '置き換えてください。',
      paths: inText(PLACEHOLDER_NAMING_RE),
    })
  }

  defects.push(...auditStylingDiscipline(html, outputKind))

  return defects
}

/**
 * A Tailwind utility, recognised by its value as well as its prefix.
 *
 * Prefixes alone matched the project's own names: `my-reservations-screen` read as
 * a vertical margin. So spacing and sizing need a number or a keyword after the
 * dash, colours need a palette step, and the bare words (`flex`, `grid`, `fixed`)
 * only count because a project that defines them is excluded before this is asked.
 */
export const UTILITY_CLASS = new RegExp('^(?:' + [
  '-?[mp][trblxy]?-(?:\\d|px|auto)',
  '[wh]-(?:\\d|full|screen|auto|px|min|max|fit)',
  '(?:min|max)-[wh]-',
  'gap-(?:[xy]-)?\\d', 'space-[xy]-\\d',
  'flex(?:-(?:col|row|wrap|1|none|auto|grow|shrink))?$', 'grid(?:-(?:cols|rows)-\\d+)?$', 'col-span-\\d',
  'items-(?:center|start|end|stretch|baseline)$', 'justify-(?:center|start|end|between|around|evenly)$',
  'text-(?:xs|sm|base|lg|[2-9]?xl|center|left|right|white|black|(?:gray|slate|zinc|neutral|red|green|blue|indigo|yellow|orange|purple|pink)-\\d{2,3})$',
  'font-(?:thin|light|normal|medium|semibold|bold|extrabold|black)$',
  'bg-(?:white|black|transparent|gradient-to-\\w+|(?:gray|slate|zinc|neutral|red|green|blue|indigo|yellow|orange|purple|pink)-\\d{2,3})$',
  'border(?:-[trblxy])?(?:-\\d|-(?:gray|slate|zinc|neutral)-\\d{2,3})?$',
  'rounded(?:-(?:sm|md|lg|xl|2xl|3xl|full|none))?$', 'shadow(?:-(?:sm|md|lg|xl|2xl|none))?$',
  '(?:inset|top|left|right|bottom)-\\d', 'z-\\d+$', 'opacity-\\d+$',
  'leading-(?:none|tight|snug|normal|relaxed|loose|\\d)$', 'tracking-(?:tighter|tight|normal|wide|wider|widest)$',
  'mx-auto$', 'min-h-screen$', 'inline-(?:block|flex)$', '(?:fixed|absolute|relative|sticky)$', 'truncate$',
  'overflow-(?:hidden|auto|x-auto|y-auto)$', '(?:sm|md|lg|xl|hover|focus):', 'cursor-pointer$', 'duration-\\d+$', 'sr-only$',
].join('|') + ')')

/**
 * Whether the stylesheet is the design or merely a decoration beside it.
 *
 * Measured on a real `standard` run — eight screens, 91,625 characters, and the
 * pipeline reported it clean:
 *
 *     className=      0 uses across all eight screens
 *     style={{…}}   115 uses across all eight screens
 *     globals.css   5,194 chars, 10 class rules, 2 media queries
 *     inline <svg>    0 in the entire project
 *
 * Nothing in the pipeline could see that. Every audit checks what the markup
 * contains; none of them checked where the styling lives. And the consequence is
 * not cosmetic — an inline style cannot carry `:hover`, `:focus-visible`,
 * `:disabled` or a media query, so a project written this way has no interaction
 * states and no responsive behaviour anywhere, however many the stylesheet
 * declares. It is also the shape a developer least wants to inherit, which
 * matters for output whose whole purpose is to be continued in an editor.
 *
 * Both halves are reported, because they are different failures with different
 * fixes: a thin stylesheet is something to write, and inline styling is
 * something to move.
 */
export function auditStylingDiscipline(html: string, outputKind: OutputKind): InteractionDefect[] {
  const files = readProjectFiles(html)
  if (files.size === 0) return []

  const screens = [...files.entries()].filter(([p]) => /^src\/(screens|pages|components)\//.test(p))
  if (screens.length === 0) return []

  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length
  let inline = 0
  let classed = 0
  // Counted per file as well as in total: the finding can then say which screens
  // to edit instead of leaving a planner to guess from filenames.
  const inlineIn: { path: string; n: number }[] = []
  for (const [path, body] of screens) {
    const n = count(body, /style=\{\{/g) + count(body, /style="[^"]*:[^"]*"/g) + count(body, /:style=/g)
    inline += n
    classed += count(body, /class(Name)?=/g)
    if (n > 0) inlineIn.push({ path, n })
  }
  inlineIn.sort((a, b) => b.n - a.n)

  const defects: InteractionDefect[] = []

  /**
   * The ratio, not the count. A handful of inline styles is correct and
   * unavoidable — a width driven by a percentage, a swatch showing a colour from
   * data — and a rule that flagged those would be a rule nobody could satisfy.
   * What is being caught is a project where inline styling is the primary
   * mechanism.
   */
  if (inline >= 12 && inline > classed * 2) {
    defects.push({
      id: 'inline-styling',
      note: '見た目が要素に直書きされていて、共通のスタイルになっていません。',
      instruction:
        `画面コンポーネントのスタイルが style 属性で直接書かれています（インライン ${inline} 箇所に対し ` +
        `クラス指定 ${classed} 箇所）。これらを src/styles/globals.css のクラスに移してください。` +
        'インラインスタイルでは :hover / :focus-visible / :disabled とメディアクエリを表現できないため、' +
        'このままでは操作状態もレスポンシブも一切効きません。' +
        'データから決まる値（幅の%、データ由来の色）だけをインラインに残し、' +
        '残りはクラスに集約してください。' +
        (outputKind === 'react' ? 'className でクラスを当ててください。' : 'class でクラスを当ててください。'),
      paths: inlineIn.slice(0, 6).map((f) => f.path),
    })
  }

  /*
   * Utility-framework classes, in a project with no utility framework.
   *
   * The preview and the export load the project's own stylesheets and nothing
   * else, so `grid-cols-4`, `gap-4`, `text-sm` and `fixed inset-0` do nothing at
   * all unless globals.css happens to define them. Measured over 38 stored
   * projects, 2026-09-14: 9 wrote three or more of them undefined — one wrote 95 —
   * and the pages that leaned on them for layout rendered as unstyled stacks.
   * Three is the floor because a pair like `w-6 h-6` on an icon is a sizing slip
   * the runtime check measures, not a page built on a framework that is not there.
   */
  {
    const defined = new Set<string>()
    for (const [p, body] of files) {
      const css = p.endsWith('.css')
        ? body
        : /\.(vue|svelte)$/.test(p) ? [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n') : ''
      for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1])
    }
    const byFile = new Map<string, Set<string>>()
    for (const [p, body] of files) {
      if (!/\.(tsx|jsx|vue|svelte)$/.test(p)) continue
      const values = [
        ...[...body.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']*)["']/g)].map((m) => m[1]),
        ...[...body.matchAll(/\bclass(?:Name)?\s*=\s*\{\s*`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, ' ')),
      ]
      for (const v of values) {
        for (const c of v.split(/\s+/)) {
          if (!c || defined.has(c) || !UTILITY_CLASS.test(c)) continue
          if (!byFile.has(p)) byFile.set(p, new Set())
          byFile.get(p)!.add(c)
        }
      }
    }
    const all = [...new Set([...byFile.values()].flatMap((s) => [...s]))]
    if (all.length >= 3) {
      const paths = [...byFile.entries()].sort((a, b) => b[1].size - a[1].size).map(([p]) => p)
      defects.push({
        id: 'utility-classes',
        note: 'Tailwind などのクラスを使っていますが、このプロジェクトでは効いていません。',
        instruction:
          `このプロジェクトには Tailwind などのユーティリティ CSS が入っていないため、次のクラスは何のスタイルも持ちません（${all.length} 種類）: ` +
          `${all.slice(0, 16).join(' ')}${all.length > 16 ? ' …' : ''}。` +
          'レイアウト・余白・文字・色が指定されていない状態で表示されています。' +
          'src/styles/globals.css に定義されている既存のクラスへ置き換えるか、この製品の部品として意味のある名前のクラスを globals.css に定義して付け替えてください。' +
          'ユーティリティクラスを globals.css に1つずつ再定義するのではなく、部品のクラスにまとめてください。',
        paths: paths.slice(0, 6),
      })
    }
  }

  const sheets = [...files.entries()].filter(([p]) => p.endsWith('.css')).map(([, b]) => b)
  // Counted per file and summed rather than over a concatenation: `^` is
  // anchored per line, and joining would only matter at the seams.
  const rules = sheets.reduce((n, body) => n + count(body, /^\s*\.[\w-]+/gm), 0)
  /**
   * Scaled to the project. Three screens do not need forty classes; nine do.
   * Two per screen is a floor no designed app is under — it is roughly "a card
   * and a button each" — so anything below it is a stylesheet that was not
   * written rather than one that was written tightly.
   */
  /*
   * `cssChars > 0` used to guard this, to keep it off plain HTML documents.
   * By the time execution reaches here the document is already known to be a
   * project with screens in it, so the guard was not protecting anything — it
   * was excusing the worst case. Measured: a Svelte run that shipped with no
   * src/styles/globals.css whatsoever, 125 rules spread across fifteen scoped
   * blocks, and this audit called it clean.
   */
  if (rules < Math.max(12, screens.length * 2)) {
    defects.push({
      id: 'thin-stylesheet',
      note: '共通スタイルが画面の数に対して足りていません。',
      instruction:
        `共通スタイルシートにクラス定義が ${rules} 件しかなく、画面 ${screens.length} 個分の見た目を` +
        '支えられていません。src/styles/globals.css に、この製品が実際に使う部品のクラスを' +
        '書き足してください: シェル（ヘッダー・サイドバー・本文）、カード、テーブル、行、' +
        'バッジ、ボタンとその variant、フォーム部品、モーダル、ツールバー、空状態、ページネーション。' +
        'それぞれに :hover / :focus-visible / :active / [disabled] と、390px までのレスポンシブ規則を' +
        '必ず付けてください。各画面はそのクラスを使うだけにします。',
      // The file to write is named in the instruction; there is nothing for a
      // planner to work out. `create` handles the case where it does not exist.
      paths: ['src/styles/globals.css'],
    })
  }

  /*
   * Where the CSS went, for the two frameworks that have somewhere else to put it.
   *
   * Everything above counts `.css` files, so a Vue or Svelte project that puts
   * its styling in per-component `<style>` blocks reads as having almost no
   * styling at all — and then passes, because `thin-stylesheet` is scaled to the
   * screen count and a handful of shared rules clears it.
   *
   * Measured across nine runs of one brief:
   *
   *     React   globals.css 21–27k, 116–160 rules, scoped blocks  0
   *     Vue     globals.css  6–12k,  13– 77 rules, scoped 17–23k over  6–12 blocks
   *     Svelte  globals.css  0–10k,   0– 53 rules, scoped 16–31k over  9–16 blocks
   *
   * Vue and Svelte were not writing less CSS than React. They were writing more
   * of it, once per component. Scoping is idiomatic in both and the habit is
   * reasonable; the consequence is not. Every component ends up defining its own
   * card, its own button and its own spacing, nothing is shared, and no two
   * screens agree — which is the cross-screen inconsistency users report and the
   * one thing no per-component check can see.
   *
   * The ratio, not the count: a scoped block for layout that genuinely belongs
   * to one component is correct, and a rule that flagged those could not be
   * satisfied. What is caught is a project whose design lives in the components.
   */
  if (outputKind !== 'react') {
    let scopedRules = 0
    let scopedBlocks = 0
    /*
     * Which class names more than one component defines for itself.
     *
     * The instruction explained the consequence well and named nothing, so a
     * repair pass had to decide for itself which of twenty files to open and
     * which rules to move. These are the ones the argument is actually about: a
     * `.card` written separately in five components is five cards that will
     * drift, and it is the concrete case for a shared vocabulary rather than the
     * general one.
     *
     * Only class selectors, and only the plain leading one — `.card:hover` and
     * `.card .title` are the same decision as `.card`, and counting them apart
     * would report a single component as if it repeated itself.
     */
    const definedIn = new Map<string, Set<string>>()
    for (const [path, body] of files) {
      if (!/\.(vue|svelte)$/.test(path)) continue
      for (const block of body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        scopedBlocks++
        scopedRules += count(block[1], /^\s*[.:#[a-zA-Z][^{}]*\{/gm)
        for (const sel of block[1].matchAll(/^\s*\.([\w-]+)[^{}]*\{/gm)) {
          const at = definedIn.get(sel[1]) ?? new Set<string>()
          at.add(path)
          definedIn.set(sel[1], at)
        }
      }
    }
    const shared = [...definedIn.entries()]
      .filter(([, where]) => where.size >= 2)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 8)
    if (scopedBlocks >= 4 && scopedRules > Math.max(40, rules * 2)) {
      defects.push({
        id: 'scoped-styling',
        note: 'スタイルが各コンポーネントに散っていて、共通化されていません。',
        instruction:
          `共通スタイルシートのクラス定義が ${rules} 件しかない一方で、コンポーネント内の ` +
          `<style> に ${scopedRules} 件（${scopedBlocks} ファイル）が書かれています。` +
          'カード、ボタン、バッジ、テーブル行、フォーム項目、空状態など、複数の画面や' +
          'コンポーネントに現れる形は src/styles/globals.css のクラスに移してください。' +
          'スコープ付き <style> は、そのコンポーネントだけに固有で他のどこにも現れない配置' +
          '（グリッドの定義、sticky の位置など）に限ってください。' +
          (shared.length
            ? `\n実際に複数のコンポーネントが別々に定義しているクラス: ` +
              shared.map(([name, where]) => `.${name}（${where.size}ファイル）`).join('、') +
              '。まずこれらを globals.css に1つずつ定義し、各コンポーネントからは重複定義を削除してください。'
            : '') +
          'コンポーネントごとにスタイルを閉じると、各コンポーネントが独自のカードと独自のボタンを' +
          '定義することになり、画面ごとに見た目が食い違います。' +
          '共通の語彙こそが、複数画面を一つの製品に見せている唯一のものです。',
        // The stylesheet the rules move INTO, and the components they move out
        // of — both known here, and neither guessable from a filename.
        paths: [
          'src/styles/globals.css',
          ...[...new Set(shared.flatMap(([, where]) => [...where]))].slice(0, 5),
        ],
      })
      /*
       * One problem, reported once, with the repair that fits it.
       *
       * `thin-stylesheet` reads the same fact — globals.css holds 17 rules for
       * 14 screens — and asks for those classes to be written from scratch:
       * shell, card, table, badge, button variants, form parts, modal. When the
       * styling is scoped, they are already written, once per component, and
       * writing them again is not the repair. Moving them is.
       *
       * 92 of the 99 documents raising `thin-stylesheet` across the corpus also
       * raise this one, so nearly every time it appeared it was a second
       * description of this finding carrying contradictory advice. The seven
       * that raise it alone have no stylesheet anywhere, and there it is the
       * only thing to say.
       */
      const thin = defects.findIndex((d) => d.id === 'thin-stylesheet')
      if (thin >= 0) defects.splice(thin, 1)
    }
  }

  return defects
}
