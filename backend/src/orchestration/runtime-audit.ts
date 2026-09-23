import { readProjectFiles } from '../tools/project-transport.js'
import type { InteractionDefect } from './interaction-audit.js'
import { auditComposition } from './preset-composition.js'
import type { BrokenBox, ContrastFault, RuntimeFacts, VerifyFailure } from '../tools/browser-verify.js'

/**
 * Defects that only exist once the document has been rendered.
 *
 * The static audits read the source and can prove a route table exists. They
 * cannot see that the page it produces is mostly white, that a chart container
 * was drawn but never filled, or that a handler throws on click. Those are the
 * defects users actually notice, and until the browser ran there was no way to
 * detect any of them.
 */

/**
 * Below this, a screen's content does not reach halfway down the viewport and it
 * reads as unfinished.
 *
 * Calibrated on measured pages rather than picked: a dashboard whose four stat
 * cards stopped at 265px of an 813px viewport measured 0.33, and the same brief
 * built from a complete specification saturates at 1.0. 0.45 sits between them
 * with room on both sides, so an intentionally short utility screen is not
 * dragged in.
 */
const THIN_FILL = 0.45

/** A box this size with nothing in it is a hole in the layout, not spacing. */
const EMPTY_BOX_AREA = 200 * 150

/**
 * A colour pair that would actually pass, worked out rather than asked for.
 *
 * The finding named the pair and the shortfall and then said "change one of
 * them", which leaves the model to solve a contrast equation. That is exact
 * arithmetic and the kind models get slightly wrong: the repair returns 3.9:1
 * where 4.5:1 was needed and the same finding comes back next pass. Contrast has
 * been the largest runtime deduction of the last three rounds.
 *
 * Which side to move is a design question with a clear answer. White or
 * near-black text is ink — deliberate, and usually correct — so on a coloured
 * surface the surface is what should darken; suggesting black text on a teal
 * button would meet the ratio and look wrong. Anywhere else the text colour is
 * the one to move.
 *
 * Only lightness moves, in one-percent steps, so the suggestion stays
 * recognisably the same colour rather than proposing a different design.
 * Returns null when nothing in that direction reaches the ratio — a 7:1
 * requirement over a mid grey cannot be met by lightness alone, and inventing an
 * answer there would be worse than saying nothing.
 */
const parseRgb = (s: string): [number, number, number] | null => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const luminance = ([r, g, b]: [number, number, number]): number => {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

const ratioOf = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const toHex = ([r, g, b]: [number, number, number]): string =>
  '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')

/** Moves `move` toward black or white until it clears `required` against `fixed`. */
const shiftUntil = (
  move: [number, number, number],
  fixed: [number, number, number],
  required: number
): string | null => {
  const target: [number, number, number] = luminance(fixed) > 0.18 ? [0, 0, 0] : [255, 255, 255]
  for (let step = 1; step <= 100; step++) {
    const t = step / 100
    const mixed: [number, number, number] = [
      move[0] + (target[0] - move[0]) * t,
      move[1] + (target[1] - move[1]) * t,
      move[2] + (target[2] - move[2]) * t,
    ]
    if (ratioOf(mixed, fixed) >= required) return toHex(mixed)
  }
  return null
}

export function passingPair(
  fg: string,
  bg: string,
  required: number
): { side: 'fg' | 'bg'; hex: string } | null {
  const f = parseRgb(fg)
  const b = parseRgb(bg)
  if (!f || !b) return null
  const ink = luminance(f) > 0.7 || luminance(f) < 0.03
  if (ink) {
    const hex = shiftUntil(b, f, required)
    if (hex) return { side: 'bg', hex }
  }
  const hex = shiftUntil(f, b, required)
  return hex ? { side: 'fg', hex } : null
}


/**
 * Where a failing colour is actually defined, so the instruction can name it.
 *
 * The contrast finding said "fix the design token rather than overriding the
 * colour individually" — and on a React result measured at v205 there was no
 * token to fix: `#059669` was written into `SalesChart.tsx`, `CategoryChart.tsx`,
 * `RankingTable.tsx` and `ProductChart.tsx`. The instruction forbade the only
 * repair the document allowed, and the finding survived three accepted repair
 * passes on all three frameworks.
 *
 * Vue and Svelte had it as a token (`--accent-600`, `--success`), so the
 * instruction was right for them and wrong for React. Which means it cannot be
 * written once: it has to read the document and say which case this is.
 */
/** Exported for the deterministic fixes, which need the same conversion. */
export const toHexColour = (rgb: string): string | null => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(rgb)
  return m
    ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    : null
}

function definedAt(source: string, rgb: string): string {
  const hex = toHexColour(rgb)
  if (!hex) return ''
  const bare = hex.slice(1)
  const tokens = [
    ...new Set(
      [...source.matchAll(new RegExp(`(--[\\w-]+)\\s*:\\s*#${bare}\\b`, 'gi'))].map((m) => m[1])
    ),
  ]
  if (tokens.length > 0) {
    return `この色 ${hex} は ${tokens.join(' と ')} で定義されています。トークンの値を変えてください。`
  }
  // Not a token. Naming the files matters more here than anywhere: the standing
  // advice is "fix the token", and following it is impossible.
  const files = [...readProjectFiles(source)]
    .filter(([path, body]) => !/\.(md|markdown|txt)$/i.test(path) && new RegExp(bare, 'i').test(body))
    .map(([path]) => path)
  return files.length > 0
    ? `この色 ${hex} はトークンではなく ${files.slice(0, 4).join('、')}${files.length > 4 ? ' ほか' : ''} に直接書かれています。` +
        `まず ${'`--color-positive`'} のようなトークンを1つ宣言し、これらの箇所をそこから参照させたうえで値を直してください。`
    : ''
}

/**
 * Whether some file other than the route table calls a navigation function with
 * this screen's id.
 *
 * The route table and the nav list are declarations — `'result'` in a
 * `ScreenId` union or a NAV_ITEMS entry says the screen exists, not that
 * anything goes there — so `routes.ts` and `types-nav.ts` are not read. What
 * counts is the id as an argument near a navigating callee: `navigate('result')`,
 * `navigate({ screen: 'result' })`, `setScreen('result')`, `goTo('result')`, or a
 * hash assignment to `#/result`. Without a source there is nothing to read and
 * the answer is no, which keeps the check as it was.
 */
export function navigatedToInCode(source: string, screen: string): boolean {
  if (!source || !screen) return false
  const id = screen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = new RegExp(
    `\\b(?:navigate|navigateTo|goTo|go|push|setScreen|setCurrentScreen|setRoute|setView|setPage|setActiveScreen)\\s*\\(\\s*(?:\\{[^}]{0,80}?)?['"\`]${id}['"\`]`
  )
  const hash = new RegExp(`location\\.hash\\s*=\\s*['"\`]#/?${id}['"\`]`)
  for (const [path, body] of readProjectFiles(source)) {
    if (/(?:^|\/)(?:routes|types-nav)\.[jt]sx?$/.test(path) || /\.(md|css)$/i.test(path)) continue
    if (call.test(body) || hash.test(body)) return true
  }
  return false
}

/**
 * The classes a navigation's component uses and no stylesheet defines.
 *
 * `nav-unstyled` names the element the walk saw (`nav.breadcrumb`), and on the
 * carbon run of 2026-09-14 that was not where the fault was: `.breadcrumb`
 * existed, and the `ol.breadcrumb-list` / `li.breadcrumb-item` inside it did
 * not. A repair told only "nav.breadcrumb is in bullets" rewrote nothing useful
 * and was rejected. The component that renders the element is found by its first
 * class; what it writes and nothing defines is listed, per file.
 */
export function undefinedClassesAround(source: string, elements: string[]): { path: string; classes: string[] }[] {
  if (!source) return []
  const files = readProjectFiles(source)
  const defined = new Set<string>()
  for (const [p, body] of files) {
    const css = p.endsWith('.css') ? body : /\.(vue)$/.test(p) ? [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n') : ''
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1])
  }
  const out: { path: string; classes: string[] }[] = []
  for (const el of elements) {
    const cls = /^[a-z][\w-]*\.([\w-]+)/.exec(el)?.[1]
    const tag = /^([a-z][\w-]*)/.exec(el)?.[1] ?? 'nav'
    for (const [p, body] of files) {
      if (!/\.(tsx|jsx|vue)$/.test(p) || out.some((o) => o.path === p)) continue
      const renders = cls
        ? new RegExp(`class(?:Name)?\\s*=\\s*(?:"[^"]*|'[^']*|\\{\`[^\`]*)(?<![\\w-])${cls.replace(/[-]/g, '\\-')}(?![\\w-])`).test(body)
        : new RegExp(`<${tag}[\\s>]`).test(body)
      if (!renders) continue
      const used = new Set<string>()
      for (const m of body.matchAll(/class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`)/g)) {
        for (const c of (m[1] ?? m[2] ?? (m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ')).split(/\s+/)) {
          if (/^[_a-zA-Z][\w-]*$/.test(c) && !defined.has(c)) used.add(c)
        }
      }
      if (used.size > 0) out.push({ path: p, classes: [...used].slice(0, 8) })
    }
  }
  return out.slice(0, 4)
}

export function auditRuntime(facts: RuntimeFacts, source = '', presetName?: string): InteractionDefect[] {
  const defects: InteractionDefect[] = []

  /**
   * Nothing painted at all — reported first, and as its own finding.
   *
   * A blank page did produce a `console-error`, and that was treated as enough.
   * It is not: `console-error` says "an exception happened somewhere" and asks
   * for it not to happen, which is a weak instruction when the exception is the
   * difference between an application and a white rectangle. Three separate
   * Svelte generations shipped this way — a store export shadowing a rune, a
   * SvelteKit import, and `new App({…})` where Svelte 5 wants `mount(App, {…})`
   * — each compiling cleanly and each delivered to the user as a blank screen.
   *
   * Named separately so the repair planner can see what it is, and so the run
   * cannot be called clean while it is present.
   */
  if (facts.screens.length === 0) {
    defects.push({
      id: 'blank-render',
      instruction:
        'アプリを実行しても画面が1つも描画されません。**これは最優先で直してください。' +
        'ビルドが通ることと、画面が出ることは別です。**\n' +
        (facts.consoleErrors.length > 0
          ? `実行時に出ているエラー:\n${facts.consoleErrors.slice(0, 3).map((e) => `- ${e}`).join('\n')}\n`
          : 'コンソールにエラーは出ていないため、エントリファイルがマウントに失敗しているか、' +
            'シェルが何も返していない可能性が高いです。\n') +
        'まず確認すること: エントリファイルが正しいマウント方法を使っているか' +
        '（React は createRoot(...).render(...)、Vue は createApp(App).mount(...)）、' +
        'マウント先の要素 id が index.html と一致しているか、' +
        'ルートが空のときに既定の画面へ落ちるようになっているか。',
    })
  }

  /*
   * A route built out of a value that was never a route.
   *
   * The walk records the screen id it arrived at, read back from the hash. Three
   * separate runs produced ids that are not screens at all:
   *
   *     "[object%20Object]"   navigate({ screen: 'home' }) into navigate(screen: ScreenId)
   *     "undefined"           navigate(item.id)            into navigate(next?: Route)
   *
   * Both are the router and its call sites disagreeing about what a route is,
   * and neither throws — a template literal stringifies anything — so they ship
   * as routes nobody can parse and screens nobody can reach, with a clean
   * console and no build error. The React run that produced "undefined" passed
   * every static audit.
   *
   * Checked here because it is certain rather than heuristic. A screen whose id
   * is `undefined` is not a screen the author meant to build, whatever produced
   * it, and unlike the static check this cannot be evaded by passing a variable.
   */
  // Anchored at BOTH ends for the bare words. Prefix-matching alone flagged
  // any screen whose id merely starts with one — `undefined-state`,
  // `nullable-form`, `true-north` — and a false route defect is expensive in
  // the same way a false "unreachable" is: it buys a repair pass that goes
  // looking for a routing bug that is not there. `[object …]` keeps its
  // prefix match, since what follows is the rest of a stringified object and
  // never part of an id anyone chose.
  const NOT_A_SCREEN = /^(?:(?:undefined|null|NaN|false|true)$|\[object[%\s])/i
  const bogus = facts.screens.map((s) => s.id).filter((id) => NOT_A_SCREEN.test(decodeURIComponent(id || '')))
  if (bogus.length > 0) {
    defects.push({
      id: 'route-not-a-route',
      instruction:
        `URL ハッシュが画面IDではない値になっています: ${bogus.map((b) => `「${b}」`).join('、')}。` +
        'これは画面遷移の関数と呼び出し側で「ルートとは何か」が食い違っているときに起きます。' +
        'オブジェクトを受ける関数に文字列や id を渡すと `#/undefined` に、' +
        '文字列を受ける関数にオブジェクトを渡すと `#/[object Object]` になります。' +
        '**どちらも例外にならない**ため、コンソールは綺麗なまま、解釈できないルートと' +
        '到達できない画面だけが残ります。\n' +
        '遷移関数が両方の形を受け取るようにしてください。これが最も確実です:\n' +
        '  function toRoute(next) {\n' +
        '    if (!next) return DEFAULT_ROUTE;\n' +
        "    if (typeof next === 'string') return { screen: next };\n" +
        '    return next;\n' +
        '  }\n' +
        'そのうえで、ハッシュを組み立てる側は必ず toRoute() を通してから screen を読むこと。',
    })
  }


  /**
   * A control that throws when pressed.
   *
   * Reported ahead of the dead-control findings and separately from
   * `console-error`, because it is a different and worse fault: a dead button
   * does nothing, a throwing button takes the screen down. Measured, reported by
   * a user clicking through a generated storefront:
   *
   *     TypeError: Cannot read properties of undefined (reading 'params')
   *       at hash (…) at onClick (…)
   *
   * That reached the pipeline only as an anonymous `console-error` carrying a
   * stack into a bundled file the repair planner cannot open, so it had to infer
   * both which control and which line. Naming the control is the whole fix —
   * the control is the thing the repair has to look at.
   */
  const throwing = facts.throwing ?? []
  if (throwing.length > 0) {
    defects.push({
      id: 'action-throws',
      instruction:
        '次のコントロールは、押すと例外が発生してアプリが止まります。' +
        '**表示されるだけのモックではなく、押して動くものにしてください。**\n' +
        throwing.map((t) => `- 「${t.label}」→ ${t.error}`).join('\n') +
        '\n原因として多いもの: ハンドラが引数なしで navigate() を呼んでいる、' +
        'ルート定義に無いキーを引いて undefined を渡している、' +
        'params を省略できる形にしていない（route.params?.id のように必ず省略可で読む）、' +
        '一覧から詳細へ渡す id が undefined。' +
        'ルーティング関数は、引数が undefined でも既定の画面へ落ちるようにしてください。',
    })
  }

  if (facts.consoleErrors.length > 0) {
    defects.push({
      id: 'console-error',
      instruction:
        'ページを実行するとJavaScriptエラーが発生します。次のエラーが出ないように原因を修正してください（画面の見た目は変えないでください）:\n' +
        facts.consoleErrors.slice(0, 5).map((e) => `- ${e}`).join('\n'),
    })
  }

  /*
   * A screen whose content is there and not shown.
   *
   * Reported on its own rather than as `screen-thin`, whose instruction is to ADD
   * content — the wrong repair for a screen that already has its content and hides
   * it. Measured on the carbon run of 2026-09-14: `.screen { display: none }` unless
   * `.is-active`, and no screen ever received the class.
   */
  const hiddenScreens = facts.screens.filter((s) => s.hiddenBy)
  if (hiddenScreens.length > 0) {
    const named = hiddenScreens.filter((s) => s.hiddenBy !== 'empty')
    defects.push({
      id: 'screen-hidden',
      // What the reply shows. Without it the chat got the head of the repair instruction, clipped.
      note: `画面の中身が表示されていません（${hiddenScreens.map((x) => x.id).slice(0, 3).join('、')}${hiddenScreens.length > 3 ? ' ほか' : ''}）。`,
      instruction:
        `次の画面は、ナビゲーションなどの外枠は表示されているのに、画面の中身が何も見えていません: ` +
        hiddenScreens.map((s) => `${s.id}${s.hiddenBy && s.hiddenBy !== 'empty' ? `（${s.hiddenBy}）` : '（中身が空）'}`).join('、') + '。' +
        (named.length > 0
          ? '中身は描画されていますが、CSS で非表示になっています。スタイルシートが表示の条件にしているクラス（例: .screen.is-active）を' +
            '画面側の要素が付けているか、表示中の画面にその条件が満たされるかを確認し、表示される状態に直してください。' +
            '中身を足したり作り直したりする必要はありません。'
          : '画面コンポーネントが中身を返しているか、ルートに対応する画面が描画されているかを確認してください。'),
    })
  }

  /*
   * Styling that never arrived: a navigation still in browser bullets.
   *
   * Measured on 38 stored projects, 7 shipped like this, and every one used nav
   * classes (`da-nav`, `app-nav`, `shell-nav`) that no stylesheet defines.
   */
  const bareNav = facts.unstyledNav ?? []
  if (bareNav.length > 0) {
    const found = undefinedClassesAround(source, bareNav)
    defects.push({
      id: 'nav-unstyled',
      note: 'ナビゲーションが箇条書きのまま表示されています。',
      instruction:
        `ナビゲーションのリストが、ブラウザ既定の箇条書き（・付きの縦並び）のまま表示されています: ${bareNav.join('、')}。` +
        (found.length > 0
          ? '次のファイルで使っているクラスが、どのスタイルシートにも定義されていません: ' +
            found.map((f) => `${f.path}（${f.classes.join(', ')}）`).join('、') + '。' +
            'これらのクラスを src/styles/globals.css に定義してください'
          : 'ナビに付けているクラスがスタイルシートに定義されていないことがほとんどです。そのクラスを src/styles/globals.css に定義してください') +
        '（list-style: none、余白の初期化、項目の並べ方、リンクやボタンの見た目、現在地の表示、:hover と :focus-visible）。' +
        '既にあるナビ用のクラスがあれば、それに付け替えても構いません。',
      ...(found.length > 0 ? { paths: ['src/styles/globals.css', ...found.map((f) => f.path)] } : {}),
    })
  }
  const bigIcons = facts.oversizedIcons ?? []
  if (bigIcons.length > 0) {
    defects.push({
      id: 'icon-oversized',
      note: 'アイコンが大きく表示されすぎています。',
      instruction:
        `24px 程度で描いたアイコンが、大きさの指定が無いため巨大に表示されています: ${bigIcons.join('、')}。` +
        'アイコンを包む要素のクラス、または svg 自体に width と height を指定してください（本文と並ぶアイコンは 16〜24px）。',
    })
  }

  const thin = facts.screens.filter((s) => s.fill < THIN_FILL && !s.hiddenBy)
  if (thin.length > 0) {
    defects.push({
      id: 'screen-thin',
      instruction:
        `次の画面は、実際に描画するとコンテンツが画面の${Math.round(THIN_FILL * 100)}%の高さにも届かず、` +
        `下半分が空白になっています: ${thin.map((s) => `${s.id}（${Math.round(s.fill * 100)}%）`).join('、')}。` +
        'その画面の目的に本当に必要な要素を足して埋めてください。' +
        'ダッシュボードなら推移グラフ・内訳・直近の履歴、一覧なら十分な行数、詳細なら関連情報のセクションです。' +
        '余白を詰めるのではなく、中身を足してください。既存の要素の見た目は変えないでください。',
    })
  }

  const holes = facts.screens.flatMap((s) =>
    s.emptyBoxes.filter((b) => b.area >= EMPTY_BOX_AREA).map((b) => ({ screen: s.id, ...b }))
  )
  if (holes.length > 0) {
    defects.push({
      id: 'empty-container',
      instruction:
        '次の枠は描画されているのに中身が空です: ' +
        holes.slice(0, 5).map((h) => `${h.screen} の ${h.label}`).join('、') +
        '。枠だけあって中身が無いのは、その画面の主役が欠けている状態です。' +
        'グラフならSVGで実データを描き、リストなら行を入れ、図ならSVGを描いてください。',
    })
  }

  /**
   * The screens' own controls, which nothing used to press.
   *
   * This is the defect closest to the product's actual claim. A mock whose
   * navigation works and whose 追加 and 保存 buttons do nothing is a picture of
   * an application, and until the walk started pressing them there was no check
   * anywhere that could tell the two apart.
   */
  if (facts.deadActions.length > 0) {
    defects.push({
      id: 'action-dead-runtime',
      instruction:
        `画面内の次のボタンは、実際にクリックしても何も起きません: ${facts.deadActions.join('、')}。` +
        'それぞれのボタンに、そのラベルが約束している動作を実装してください。' +
        '状態を更新して画面に反映する（一覧に行が増える、値が変わる、ダイアログが開く、' +
        '入力が検証される）ところまで実装してください。' +
        'ラベルだけ変えて逃げたり、ボタンを削除して解決したことにしないでください。',
    })
  }

  /**
   * Form controls that rendered too small to use.
   *
   * The prompts have described comfortable field sizing for as long as they have
   * existed, and cramped inputs kept arriving anyway — which is the standing
   * lesson of this file: a rule nothing measures is a suggestion. Reported with
   * the measured numbers, because "入力欄が小さい" is an opinion and
   * "height 24px, font-size 12px" is not.
   */
  if (facts.smallFields.length > 0) {
    const worst = facts.smallFields.slice(0, 5)
    defects.push({
      id: 'input-small',
      instruction:
        '実際に描画すると、次の入力欄が小さすぎて使えません: ' +
        worst.map((f) => `${f.screen} の ${f.label}（高さ${f.height}px / 文字${f.fontSize}px）`).join('、') +
        '。入力欄・セレクト・テキストエリアは高さ40px以上、文字サイズ16px以上にしてください' +
        '（16px未満はiOSでフォーカス時にページが拡大され、レイアウトが崩れます）。' +
        'padding は上下10px以上・左右12px以上、line-height は1.4以上。' +
        '高さは固定値ではなく padding と line-height で確保し、ラベルと入力欄の間には8px空けてください。' +
        '個々の要素にその場しのぎで指定するのではなく、共通のフォームコントロールのスタイルを直してください。',
    })
  }

  if (facts.deadNav.length > 0) {
    defects.push({
      id: 'nav-dead-runtime',
      instruction:
        `実際にクリックしても画面が変わらないナビゲーション項目があります: ${facts.deadNav.join('、')}。` +
        'クリックで対応する画面が表示されるように配線してください。',
    })
  }

  /**
   * Only a lone orphan, and only when the walk demonstrably worked.
   *
   * The first version reported `project-detail` as unreachable on a document
   * where clicking a table row opens it perfectly well — the walk clicked only
   * nav items at the time. The walk now clicks rows and cards too, but screens
   * opened from a modal, a search result, or any control it does not know about
   * still exist, and a false positive here sends a correct document into a
   * repair pass.
   *
   * So: report one unreached screen out of many reached, which is the shape of
   * a genuine orphan. Several unreached at once is far more likely to mean the
   * walk ran out of routes it understands than that the app grew several dead
   * screens, and blaming the document for the walk's limits is the failure this
   * check has already committed once.
   */
  /*
   * And not when the project's own code navigates there.
   *
   * The walk clicks; it does not type into forms or press keys. A screen reached
   * only at the end of a flow — 予約確認 after the booking form is filled and
   * submitted, 結果 after arrow-keying to the last flashcard — is therefore
   * reported unreachable on a project where it is reached exactly as designed.
   * Measured on the 2026-09-14 comparison runs: both of those, each handed to a
   * repair pass that could not change what the walk does and was rejected as
   * "no improvement".
   *
   * A navigation call naming the screen is the project saying how it is reached.
   * A true orphan — declared and routed, with nothing that ever navigates to it —
   * still has no such call and is still reported.
   */
  const orphan = facts.unreachable.length === 1 && !navigatedToInCode(source, facts.unreachable[0])
  if (orphan && facts.screens.length >= 3) {
    defects.push({
      id: 'screen-unreachable',
      instruction:
        `次の画面はマークアップ上は存在しますが、どの操作からも到達できませんでした: ${facts.unreachable.join('、')}。` +
        'ナビゲーションか、一覧行・カードなどからの遷移を追加して、必ず開けるようにしてください。',
    })
  }

  /**
   * Contrast, which every prompt has asked for and nothing has ever checked.
   *
   * Reported as one defect listing the worst offenders rather than one per
   * failure, because they nearly always share a cause — a muted foreground token
   * used on a surface it was not paired with. Fixing the token fixes all of them,
   * and five separate instructions would invite five separate local patches.
   */
  /*
   * Two different faults, reported separately because they have different fixes.
   *
   * Text on a colour is a colour problem: change the token and every place using
   * that pair improves. Text on a PHOTOGRAPH is a structural problem, and the
   * same advice there is actively wrong — the background is not a token, its
   * brightness is chosen by the stock library after the CSS is written, and a
   * slot that cannot be filled falls back to a pale placeholder. No colour
   * choice survives all three.
   */
  const overImage = facts.contrast.filter((c) => c.overImage)
  const measured = facts.contrast.filter((c) => !c.overImage)

  if (measured.length > 0) {
    const worst = measured.slice(0, 4)
    /*
     * A colour that would actually pass, worked out rather than asked for.
     *
     * "Change one of them to meet the ratio" leaves the model to solve a
     * contrast equation, which is exact arithmetic and the kind models get
     * slightly wrong — the repair returns 3.9:1 where 4.5:1 was needed and the
     * same finding comes back next pass. Contrast has been the largest runtime
     * deduction of the last three rounds.
     */
    /*
     * The suggestion and the place to apply it, worked out together.
     *
     * They were computed apart, and the halves disagreed: on a Svelte result
     * the suggestion said to darken the BACKGROUND while the definition site
     * named was the foreground's token. Naming the wrong side is worse than
     * naming none — it sends the repair to a token whose value is correct.
     */
    const advice = (c: ContrastFault) => {
      const fix = passingPair(c.fg, c.bg, c.required)
      if (!fix) return ''
      const head =
        fix.side === 'fg'
          ? `（文字色を ${fix.hex} にすれば基準を満たします）`
          : `（文字が白または黒なので、背景を ${fix.hex} にしてください）`
      const where = source ? definedAt(source, fix.side === 'fg' ? c.fg : c.bg) : ''
      return where ? `${head}${where.replace(/。$/, '')}` : head
    }
    defects.push({
      id: 'contrast-low',
      instruction:
        'コントラスト比が WCAG AA を下回るテキストがあります（実際に描画して測定した値です）: ' +
        worst
          .map(
            (c) => `「${c.text}」${c.fg} on ${c.bg} = ${c.ratio}:1（必要 ${c.required}:1）${advice(c)}`
          )
          .join('、') +
        '。前景色か背景色のどちらかを変えて基準を満たしてください。' +
        /*
         * Where the colour lives, instead of assuming it is a token.
         *
         * "Fix the token rather than overriding individually" was standing
         * advice, and on the v205 React result there was no token: `#059669`
         * was written into four chart and table components. The instruction
         * forbade the only repair the document allowed, and the finding
         * survived three accepted passes on all three frameworks.
         */
        'レイアウトと文言は変えないでください。',
    })
  }

  if (overImage.length > 0) {
    defects.push({
      id: 'text-over-image',
      instruction:
        '写真やグラデーションの上に直接テキストが置かれています: ' +
        overImage.slice(0, 4).map((c) => `「${c.text}」`).join('、') +
        '。写真の明るさはこちらで決められません（ストック画像は CSS を書いたあとに割り当てられ、' +
        '割り当てられなかった枠は明るいグレーのプレースホルダになります）。' +
        'そのため不透明度の固定されたスクリムでは可読性を保証できません。' +
        '実測: `linear-gradient(180deg, rgba(0,0,0,.3), transparent)` の上の白見出しが 1.1:1 でした。\n' +
        '次のいずれかに変えてください:\n' +
        '1. 文字の背後に不透明なパネルを敷く（最も確実。コントラストが CSS だけで決まります）\n' +
        '   例: background: rgba(17,17,17,.72); border-radius: var(--radius-md); padding: var(--space-lg);\n' +
        '2. 写真の「上」ではなく「横」または「下」にテキストを置く（多くの場合こちらが良いレイアウトです）\n' +
        '3. どうしてもスクリムにするなら、文字が実際にある位置で最低 rgba(0,0,0,.55) の' +
        '**単色**にする（透明へ抜けるグラデーションは、文字の位置で薄くなります）\n' +
        'いずれの場合も、文字色は写真ではなく自分で敷いた背景に対して決めること。',
    })
  }

  /**
   * Sideways scrolling at phone width.
   *
   * Only the overflow, not the general shape of the layout. Whether a page looks
   * cramped on a phone is a judgement; whether it scrolls sideways is not, every
   * user meets it in the first second, and it is completely invisible at the
   * 1440px this check used to be the only width for.
   */
  /**
   * A page with no viewport meta is reported before any overflow it may have.
   *
   * At a 980px layout viewport the layout has all the room it wants, so it will
   * usually show no overflow at all — while on a real phone it is the whole page
   * shrunk to a third of its size with text nobody can read. Reporting the
   * overflow first would send the repair after a symptom that is not there.
   *
   * Only ever fires for single-HTML output, and that is a limit worth knowing
   * rather than a bug. A React project has no index.html of its own: the one it
   * is rendered in here, and the one it is exported with, are both scaffolded,
   * and both carry the tag. So for React this check can only confirm what the
   * scaffold already guarantees. The overflow measurement below is unaffected —
   * that is the application's own CSS being measured, not the harness's.
   */
  if (facts.mobile && facts.mobile.layoutWidth > 420) {
    defects.push({
      id: 'mobile-no-viewport',
      instruction:
        `スマートフォン（幅390px）で開くと、ページは ${facts.mobile.layoutWidth}px 幅でレイアウトされ、` +
        '全体が縮小表示されて文字が読めません。<head> に ' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"> を追加してください。' +
        'この1行が無いだけで、レスポンシブ対応の有無に関係なくスマートフォンでは縮小表示になります。',
    })
  } else if (facts.mobile && facts.mobile.overflowBy > 4) {
    defects.push({
      id: 'mobile-overflow',
      instruction:
        `幅390pxのスマートフォンで表示すると、横に ${facts.mobile.overflowBy}px はみ出して横スクロールが発生します。` +
        (facts.mobile.overflow.length
          ? `はみ出している要素: ${facts.mobile.overflow.join('、')}。`
          : '') +
        '固定幅・min-width・折り返さないテーブルやフレックス行が原因です。' +
        'メディアクエリで積み上げるか、max-width:100% と折り返しを入れて、横スクロールが出ないようにしてください。' +
        'デスクトップでの見た目は変えないでください。',
    })
  }


  /**
   * Layout that visibly came apart on the rendered page.
   *
   * Every other design check reads the source. None of them can see a bar drawn
   * past the end of its track, a table pushing the page sideways, or text that
   * has escaped its card — and those are what a person means by 「デザインが
   * 乱れている」. This is the measurement, so the repair loop gets a number and a
   * named element rather than an impression.
   */
  const spills = facts.screens.flatMap((s) =>
    (s.broken ?? []).map((b: BrokenBox) => ({ screen: s.id, ...b }))
  )
  if (spills.length > 0) {
    const worst = spills.sort((a, b) => b.px - a.px).slice(0, 6)
    defects.push({
      id: 'layout-broken',
      instruction:
        '実際に描画すると、次の要素が入れ物からはみ出しています。レイアウトが崩れて見えます:\n' +
        worst
          .map((b) =>
            b.kind === 'spill'
              ? `- ${b.screen}: ${b.el} が親の ${b.parent} より ${b.px}px 外にはみ出している`
              : `- ${b.screen}: ${b.el} の中身が ${b.px}px はみ出して切れている`
          )
          .join('\n') +
        '\n原因として多いもの: 割合から求めた幅に上限が無い（Math.min(値, 100) で頭打ちにする）、' +
        '固定幅がコンテナより大きい、テーブルに min-width があるのに親が overflow-x: auto でない、' +
        '長い文字列が折り返されない（overflow-wrap: anywhere を当てる）。' +
        '要素を小さくするのではなく、はみ出す原因を直してください。',
    })
  }

  // The shell against the bound design system's composition — see preset-composition.ts.
  defects.push(...auditComposition(facts.layout, presetName, facts.screens.length))

  return defects
}

/**
 * A one-line summary for the run log and the chat transcript, so a user watching
 * the run can see that the page was actually opened rather than only parsed.
 */
/**
 * The page stopped answering when a control was pressed.
 *
 * Found on a user's 在庫管理 run of 2026-09-20. Clicking any item row froze the
 * preview outright: the detail screen read `selectedItemId` from the top of the
 * store while the reducer wrote it under `state.ui`, so it was never set, and
 * the screen answered that by navigating back DURING ITS OWN RENDER —
 *
 *     if (!selectedItemId) { onNavigateItems(); return null; }
 *
 * navigate() updates the router while a child renders, the router renders again
 * before the hash has changed, the child renders again, and the page never
 * returns to the event loop. The walk went down with it, and the run shipped at
 * 89 with nothing reported about the one thing a reviewer would hit first.
 *
 * The instruction names the control and the three shapes that do this, most
 * likely first — the fix for each is to move the update out of the render.
 */
export function pageFrozenDefect(failure: VerifyFailure): InteractionDefect {
  const on = failure.frozeOn
  const where = on
    ? `${on.hash ? `${on.hash} の画面で` : ''}「${on.label || '(ラベルなし)'}」${on.kind === 'row' ? '（一覧の行）' : ''}を押すと`
    : 'ページを開くと'
  return {
    id: 'page-frozen',
    note: `${where}ページが応答しなくなります（画面全体が固まります）。`,
    instruction:
      `${where}ページのメインスレッドが止まり、ブラウザが一切応答しなくなります。` +
      '無限ループです。次の順に確認して直してください:\n' +
      '1. 描画中の画面遷移・状態更新。コンポーネント本体（return より前、ハンドラや useEffect の外）で ' +
      'navigate() / onNavigate…() / setState / dispatch を呼んでいないか。' +
      '`if (!x) { navigate(...); return null; }` は描画のたびに遷移を起こし、止まりません。' +
      '遷移は useEffect の中か、イベントハンドラの中で行ってください。\n' +
      '2. その画面が読む値が、ストアの実際の置き場所と一致しているか。' +
      'reducer が `state.ui.X` に書いている値を `state.X` から読むと常に undefined になり、' +
      '上の「未設定なら戻る」分岐が毎回走ります。\n' +
      '3. 依存配列の無い useEffect が、毎回新しい値で setState していないか。',
  }
}

export function summariseRuntime(facts: RuntimeFacts): string {
  const fills = facts.screens.map((s) => `${s.id} ${Math.round(s.fill * 100)}%`).join(' / ')
  const contrast = facts.contrast.length ? `、コントラスト不足 ${facts.contrast.length}件` : ''
  const mobile = facts.mobile && facts.mobile.overflowBy > 4 ? `、スマホ横はみ出し ${facts.mobile.overflowBy}px` : ''
  return `画面 ${facts.screens.length}件（表示密度: ${fills || 'n/a'}）、JSエラー ${facts.consoleErrors.length}件${contrast}${mobile}`
}

/**
 * What a pass made worse, measured against the render taken before it.
 *
 * `auditRuntime` reports absolute defects and is deliberately conservative,
 * because a false positive sends a correct document into a repair pass. That
 * caution has a cost: a real regression can slip under the same thresholds.
 * Measured — an interaction repair left two screens unreachable that had been
 * reachable before, invented an `about` screen the brief never asked for, and
 * was accepted anyway, because two-unreachable-out-of-two-reached does not meet
 * the absolute rule.
 *
 * A delta needs no such caution. "This was reachable and now is not" is direct
 * evidence about the change, not an inference about the walk's coverage, so it
 * can be strict where the absolute check cannot be.
 */
export function runtimeRegressions(before: RuntimeFacts, after: RuntimeFacts): InteractionDefect[] {
  const defects: InteractionDefect[] = []

  /**
   * The app rendered before this change and renders nothing now.
   *
   * Checked first and stated plainly, because every other comparison here reads
   * a blank page as an improvement: no thin screens, no empty boxes, no dead
   * nav, nothing unreachable. Measured on a real run — a per-file repair passed
   * both parse gates, produced a project that threw on mount, and was caught
   * only because the throw happened to reach the console. A tree that renders
   * nothing without complaining would have looked like a clean repair.
   */
  if (before.screens.length > 0 && after.screens.length === 0) {
    defects.push({
      id: 'render-lost',
      instruction:
        'この修正のあと、アプリを実行しても画面が何も描画されなくなりました。' +
        (after.consoleErrors.length
          ? `次のエラーが出ています:\n${after.consoleErrors.slice(0, 3).map((e) => `- ${e}`).join('\n')}`
          : 'エラーは出ていないため、ルートに対応する画面が返っていないか、マウント処理が実行されていません。') +
        '\n修正前の状態に戻したうえで、指摘は別の方法で直してください。',
    })
  }

  /*
   * Clickable before, not clickable now — compared like with like.
   *
   * This read `before.screens.map(s => s.id)`, and `screens` is every screen the
   * walk MEASURED, including the ones it opened by visiting their route after
   * clicking failed to find them. `after.unreachable` is decided by clicking
   * alone. So a screen that was only ever reached by the fallback sat in both
   * sets and read as "was reachable, now is not" — on every comparison, for
   * ever, including a comparison of a document with itself. Verified that way:
   * feeding one facts object in as both sides reported two screens lost.
   *
   * It is the marker that fired most: thirteen of the twenty-two breaking
   * verdicts, and both salvage retries in the v204 round — where the retry had
   * kept exactly the `illustrations/` files the run then shipped without.
   * Repairs were being thrown away on a finding that could not be false.
   *
   * `reachable` is already on each screen and is the click-decided flag, so the
   * comparison it was always meant to make is one word away.
   */
  const wasReachable = new Set(before.screens.filter((s) => s.reachable).map((s) => s.id))
  const lost = after.unreachable.filter((id) => wasReachable.has(id))
  const invented = after.unreachable.filter((id) => !wasReachable.has(id) && !before.unreachable.includes(id))
  if (lost.length > 0 || invented.length > 0) {
    defects.push({
      id: 'unreachable-introduced',
      instruction:
        'この修正で、開けなくなった画面があります: ' +
        [...lost, ...invented].join('、') +
        '。ナビゲーションや一覧からの遷移を元に戻すか、新しく追加した画面には必ず入口を作ってください。' +
        '依頼に無い画面を勝手に追加しないでください。',
    })
  }

  const errsBefore = new Set(before.consoleErrors)
  const newErrors = after.consoleErrors.filter((e) => !errsBefore.has(e))
  if (newErrors.length > 0) {
    defects.push({
      id: 'console-error-introduced',
      instruction:
        'この修正で新しいJavaScriptエラーが発生するようになりました:\n' +
        newErrors.slice(0, 3).map((e) => `- ${e}`).join('\n'),
    })
  }

  const fillBefore = new Map(before.screens.map((s) => [s.id, s.fill]))
  // A tenth of the viewport is the smallest drop worth calling a regression;
  // below that it is layout noise between two renders of the same page.
  const thinned = after.screens.filter((s) => {
    const was = fillBefore.get(s.id)
    return was !== undefined && was - s.fill > 0.1
  })
  if (thinned.length > 0) {
    defects.push({
      id: 'screen-thinned',
      instruction:
        'この修正で内容が減った画面があります: ' +
        thinned.map((s) => `${s.id}（${Math.round((fillBefore.get(s.id) ?? 0) * 100)}% → ${Math.round(s.fill * 100)}%）`).join('、') +
        '。消えた要素を戻してください。',
    })
  }

  const holesBefore = before.screens.reduce((n, s) => n + s.emptyBoxes.length, 0)
  const holesAfter = after.screens.reduce((n, s) => n + s.emptyBoxes.length, 0)
  if (holesAfter > holesBefore) {
    defects.push({
      id: 'empty-container-introduced',
      instruction: `この修正で、中身が空の枠が ${holesAfter - holesBefore} 個増えました。枠を作ったら中身も入れてください。`,
    })
  }

  /**
   * A repair that recolours something into failing contrast.
   *
   * The absolute check reports whatever fails; this reports what this edit
   * broke. It matters because the repair pass is regularly told to change
   * colours — to adopt design tokens, to fix an accent — and "adopt the token"
   * and "stay legible" are two requirements a model can satisfy one of.
   */
  if (after.contrast.length > before.contrast.length) {
    const wasFailing = new Set(before.contrast.map((c) => c.text))
    const fresh = after.contrast.filter((c) => !wasFailing.has(c.text)).slice(0, 3)
    defects.push({
      id: 'contrast-introduced',
      instruction:
        'この修正で、コントラスト比が基準を下回るテキストが増えました: ' +
        fresh.map((c) => `「${c.text}」${c.ratio}:1（必要 ${c.required}:1）`).join('、') +
        '。色を変える前の状態に戻すか、基準を満たす色にしてください。',
    })
  }

  const overflowBefore = before.mobile?.overflowBy ?? 0
  const overflowAfter = after.mobile?.overflowBy ?? 0
  if (after.mobile && overflowAfter > overflowBefore + 4) {
    defects.push({
      id: 'mobile-overflow-introduced',
      instruction:
        `この修正で、スマートフォン幅での横はみ出しが ${overflowBefore}px から ${overflowAfter}px に増えました。` +
        '追加した要素に max-width:100% と折り返しを入れてください。',
    })
  }

  return defects
}
