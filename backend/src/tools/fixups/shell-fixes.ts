/**
 * Two faults of the app shell that compile, render, and are wrong.
 *
 * Both were reported from the same pair of storefronts (仕上げ・Haiku・デジタル庁,
 * 2026-09-23, one React and one Vue), and neither is visible to anything that
 * reads a single file.
 */

/**
 * A screen that only means something after something else has happened.
 *
 * A detail screen needs a selection, checkout needs a cart with something in it,
 * a completion screen needs an order. Put in the top navigation they open with
 * nothing to show: the Vue storefront listed 商品一覧・商品詳細・カート・
 * チェックアウト・注文完了, so a blank detail page, an empty checkout and an
 * 「ご注文ありがとうございます」 for no order were one click away; the React one
 * put チェックアウト in the header and took payment for an empty cart.
 *
 * The contract always meant NAV_ITEMS to be top-level screens only (its own
 * comment says so); the sentence beside it — 「every screen is reachable from
 * it」 — said the opposite, and the models took the sentence.
 */
const FLOW_ID =
  /(?:^|[-_])(?:details?|complete|completed|completion|confirm|confirmation|success|thanks|thank-?you|done|results?|checkout|payment|edit)(?:$|[-_])/i
/*
 * Labels are read only for the words that cannot mean anything else. 確認 and 編集
 * can: 「予約確認・変更」 on a clinic site is the screen where you look a booking
 * up, a top-level destination — so those two are left to the id (`confirm`, `edit`).
 * Read over the 80 September documents, one proposal at a time; the exclusions
 * below are the five that were wrong.
 */
const FLOW_LABEL = /詳細|(?<!未)完了|チェックアウト|決済|購入手続き|注文手続き|ありがとう|サンクス/
/** A list, a history or a way to make something new is top-level whatever its id: 未完了一覧, 新規申請, 入荷登録. */
const TOP_LEVEL_LABEL = /一覧|履歴|リスト|新規|作成|追加|登録/
/** `checkout` is a flow step only where there is a cart: an equipment-lending app's 持ち出し票 is its own screen. */
const NEEDS_CART = /(?:^|[-_])(?:checkout|payment)(?:$|[-_])/i

/** Where a project says how a screen is reached, other than the menu itself. */
function navigatedTo(id: string, files: Map<string, string>, routesPath: string): boolean {
  const q = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = new RegExp(`navigate\\(\\s*['"\`]${q}['"\`]|screen\\s*:\\s*['"\`]${q}['"\`]|['"\`]#/${q}(?:[/?'"\`]|$)`)
  for (const [path, body] of files) {
    if (path === routesPath || !/\.(tsx?|vue)$/.test(path)) continue
    if (call.test(body)) return true
  }
  return false
}

export function fixFlowScreensInNav(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const routesPath = [...files.keys()].find((p) => /^src\/routes\.ts$/.test(p))
  if (!routesPath) return { files, fixed: [] }
  const routes = files.get(routesPath)!
  const list = /(\bNAV_ITEMS\b[^=]*=\s*\[)([\s\S]*?)(\]\s*(?:as\s+const\s*)?;?)/.exec(routes)
  if (!list) return { files, fixed: [] }

  const entries = [...list[2].matchAll(/[ \t]*\{[^{}]*\}[ \t]*,?[ \t]*(?:\r?\n)?/g)]
  if (entries.length < 2) return { files, fixed: [] }
  const removed: string[] = []
  let body = list[2]
  const hasCart = /['"]cart['"]|カート/i.test(routes) || [...files].some(([p, b]) => /^src\/store\//.test(p) && /\bcart\b/i.test(b))
  // The first entry is the home screen and stays whatever it is called.
  for (const e of entries.slice(1)) {
    const id = /\b(?:id|screen)\s*:\s*['"]([^'"]+)['"]/.exec(e[0])?.[1]
    if (!id) continue
    const label = /\b(?:label|title|name)\s*:\s*['"]([^'"]+)['"]/.exec(e[0])?.[1] ?? ''
    if (!FLOW_ID.test(id) && !FLOW_LABEL.test(label)) continue
    if (TOP_LEVEL_LABEL.test(label)) continue
    if (NEEDS_CART.test(id) && !FLOW_LABEL.test(label) && !hasCart) continue
    // Only when something else leads there. Taking an orphan off the menu would
    // make it unreachable, which is worse than reachable too early.
    if (!navigatedTo(id, files, routesPath)) continue
    body = body.replace(e[0], '')
    removed.push(label || id)
  }
  if (removed.length === 0) return { files, fixed: [] }
  const out = new Map(files)
  out.set(routesPath, routes.replace(list[0], () => list[1] + body + list[3]))
  return {
    files: out,
    fixed: [
      `ナビゲーションから、前提となる操作が要る画面を外しました（${removed.join('・')}）。` +
        'これらの画面へは、商品の選択やカートの確定など、元になる操作から移動します',
    ],
  }
}

/**
 * A count badge drawn on top of the thing it counts.
 *
 * Measured on the React storefront: a 25×24px badge at `top: -8px; right: -12px`
 * of a 24px icon button with no padding, so it covered the right half of the
 * cart; on the Vue one it sat on the last character of 「カート」. The offsets are
 * the habit — they assume a padded 40px button that was never built.
 *
 * So a count that is positioned absolutely is put back in the flow, beside what
 * it counts, and its host lines the two up. Nothing overlaps whatever the host's
 * size, and the badge keeps its own colour, size and radius. Only a badge the
 * project positions absolutely is touched: one already in the flow is not the
 * fault.
 */
export const COUNT_BADGE_MARKER = '/* makeui:count-badge */'

const BADGE_CLASS = /badge|count|counter|bubble|qty|pill/i
const COUNT_EXPR = /count|total|qty|quantity|length|num|items|unread|size/i

function countBadgeClasses(files: Map<string, string>): Set<string> {
  const found = new Set<string>()
  const tag = '(?:span|div|b|strong|small|em|i|sup)'
  // Attribute values read whole: `v-if="count > 0"` has a `>` that is not the tag's end.
  const attrs = `(?:[^>"']|"[^"]*"|'[^']*')*?`
  const jsx = new RegExp(`<(${tag})\\b${attrs}\\bclassName=["']([^"']+)["']${attrs}>\\s*\\{\\s*([^{}]{1,80}?)\\s*\\}\\s*</\\1>`, 'g')
  const vue = new RegExp(`<(${tag})\\b${attrs}\\bclass=["']([^"']+)["']${attrs}>\\s*\\{\\{\\s*([^{}]{1,80}?)\\s*\\}\\}\\s*</\\1>`, 'g')
  for (const [path, body] of files) {
    const pattern = path.endsWith('.vue') ? vue : /\.[jt]sx$/.test(path) ? jsx : null
    if (!pattern) continue
    for (const m of body.matchAll(pattern)) {
      if (!COUNT_EXPR.test(m[3])) continue
      for (const cls of m[2].split(/\s+/)) if (BADGE_CLASS.test(cls)) found.add(cls)
    }
  }
  return found
}

function stylesOf(files: Map<string, string>): string {
  return [...files]
    .map(([path, body]) =>
      path.endsWith('.css')
        ? body
        : path.endsWith('.vue')
          ? [...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
          : ''
    )
    .join('\n')
}

export function fixCountBadges(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const sheets = [...files].filter(([p]) => p.endsWith('.css'))
  if (sheets.length === 0) return { files, fixed: [] }
  const sheet = sheets.find(([p]) => p === 'src/styles/globals.css') ?? sheets.reduce((a, b) => (b[1].length > a[1].length ? b : a))
  if (sheet[1].includes(COUNT_BADGE_MARKER)) return { files, fixed: [] }

  const css = stylesOf(files)
  const overlaid = [...countBadgeClasses(files)].filter((cls) => {
    const q = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // A rule whose last compound names the class and places it absolutely.
    const rule = new RegExp(`\\.${q}(?![\\w-])[^{},]*\\{[^{}]*position\\s*:\\s*absolute`, 'i')
    return rule.test(css)
  })
  if (overlaid.length === 0) return { files, fixed: [] }

  const rules = overlaid
    .map((cls) => {
      const c = `.${cls}`
      return [
        `:is(button, a, [role="button"]):has(> ${c}) {`,
        '  display: inline-flex;',
        '  align-items: center;',
        '  gap: 6px;',
        '  white-space: nowrap;',
        '}',
        `${c}${c}${c} {`,
        '  position: static;',
        '  inset: auto;',
        '  transform: none;',
        '  margin: 0;',
        '  flex-shrink: 0;',
        '}',
      ].join('\n')
    })
    .join('\n')
  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${COUNT_BADGE_MARKER}\n${rules}\n`)
  return {
    files: out,
    fixed: [`個数バッジがアイコンや文字に重なっていたため、横に並べました（${overlaid.map((c) => `.${c}`).join(', ')}）`],
  }
}

/**
 * An icon sitting on the text baseline of the button that holds it.
 *
 * An inline `<svg>` is laid out like a letter, so a button whose only content is
 * an icon keeps room below it for descenders: measured on the React storefront's
 * cart, a 24px glyph in a 28px button, all 4px of the slack underneath — the
 * 「線画がずれている」 the report described. Every icon button without a flex
 * container has it.
 *
 * `:where()` keeps the rule at the specificity of the bare `svg`, so any rule the
 * project wrote for its icons still wins, and inside a flex host the property does
 * nothing at all.
 */
export const ICON_BASELINE_MARKER = '/* makeui:icon-baseline */'
const ICON_BASELINE_CSS = `${ICON_BASELINE_MARKER}
:where(button, a, [role="button"]) > svg {
  vertical-align: middle;
}`

export function fixIconBaseline(files: Map<string, string>): { files: Map<string, string>; fixed: string[] } {
  const sheet = files.has('src/styles/globals.css')
    ? (['src/styles/globals.css', files.get('src/styles/globals.css')!] as const)
    : [...files].filter(([p]) => p.endsWith('.css')).sort((a, b) => b[1].length - a[1].length)[0]
  if (!sheet || sheet[1].includes(ICON_BASELINE_MARKER)) return { files, fixed: [] }
  const drawsIcons = [...files].some(([p, b]) => /^src\/components\/icons\//.test(p) || (/\.(tsx|vue)$/.test(p) && /<svg\b/.test(b)))
  if (!drawsIcons) return { files, fixed: [] }
  const out = new Map(files)
  out.set(sheet[0], `${sheet[1].replace(/\s+$/, '')}\n\n${ICON_BASELINE_CSS}\n`)
  return { files: out, fixed: ['ボタン内のアイコンを縦中央に揃えました（文字のベースライン分の隙間を解消）'] }
}

/**
 * A checkout that opens with nothing in the cart.
 *
 * Off the menu, a flow screen is still one typed hash away, and the contract
 * asks each to guard its own precondition. Read over the September storefronts
 * and the 2026-09-23 verification pair: 11 of 18 checkout-type screens rendered
 * their form over an empty cart — the Vue one showed 「注文を確定する」 under a
 * ¥0 subtotal. Its React twin, built from the same brief, guarded every screen,
 * so the prompt alone is a coin toss.
 *
 * Found by reading, fixed by a repair: a guard is a branch in one file, which is
 * exactly the size of change a per-file repair makes well, and what the empty
 * state says is the screen's own copy to write.
 */
const CHECKOUT_SCREEN = /^src\/(?:screens|pages)\/[\w-]*(?:Checkout|Payment|Purchase|OrderConfirm)[\w-]*\.(?:tsx|vue)$/
/** A completion screen needs an order, not a cart; its guard is a different question. */
const COMPLETION_SCREEN = /(?:Complete|Completed|Done|Success|Thanks|ThankYou)[\w-]*\.(?:tsx|vue)$/
/*
 * Whether the screen asks if the cart is empty. About the CART: the first version
 * accepted any `.length > 0`, and `Object.keys(errors).length > 0` — every form
 * has one — passed three screens that never looked at the cart. And not whether
 * the screen reads the cart at all: the Vue verification's checkout never
 * mentioned it, and rendered the form over nothing.
 */
const CART = String.raw`(?:cart|items|lines|basket|order)\w*(?:\.value)?`
const CHECKS_EMPTY = new RegExp(
  [
    String.raw`${CART}\.length\s*(?:===?|<=?|>|!==?)\s*[01]\b`,
    String.raw`!\s*[\w.$]*${CART}\.length\b`,
    String.raw`${CART}\.length\s*\?`,
    String.raw`${CART}\.length\s*\)`,
    String.raw`isEmpty|isCartEmpty|cartEmpty|emptyCart`,
    String.raw`\b(?:cart|item|basket)\w*(?:Count|Total|Length|Quantity)\s*(?:===?|<=?)\s*0\b`,
    String.raw`v-if="[^"]*${CART}\.length`,
  ].join('|'),
  'i'
)

export function unguardedCheckouts(files: Map<string, string>): string[] {
  const hasCart = [...files].some(([p, b]) => /^src\/store/.test(p) && /\bcart\b/i.test(b))
  if (!hasCart) return []
  return [...files]
    .filter(([p, b]) => CHECKOUT_SCREEN.test(p) && !COMPLETION_SCREEN.test(p) && !CHECKS_EMPTY.test(b))
    .map(([p]) => p)
}
