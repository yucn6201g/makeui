/**
 * Three defects that compile, render, and are simply wrong — all from one
 * evening's reports (2026-09-24), each found again across the stored outputs:
 *
 *   an illustration with a viewBox and no size       8 of 377 documents
 *     The drawing takes the width of whatever holds it. The booking system's
 *     予約確認・変更 screen showed its empty-state magnifier 898px across.
 *
 *   a picture written as one literal URL             2 of 377
 *     `<img src="https://…/tshirt/….webp" alt={product.name} />` inside the
 *     product loop: every card showed the same T-shirt, while the data beside
 *     it held a different photograph for each product.
 *
 *   an action no reducer handles                     11 of 377
 *     The login screen dispatched AUTH_LOGIN_SUCCESS; the reducer handled
 *     LOGIN_SUCCESS. `dispatch` ignores a type it does not know, so the login
 *     "worked", navigated to the home screen, and the guard sent it back to
 *     the login form — 「ログインできない」. Types would have caught it; the
 *     compile gate strips types without checking them.
 *
 * Each repair is taken only where the answer is determined by the project
 * itself. What cannot be determined is left for the audit to name
 * (`unhandledDispatches`, used by interaction-audit.ts).
 */

type Files = Map<string, string>

const COMPONENT = /\.(tsx|jsx|vue)$/

// --- 1. drawings with no size ------------------------------------------------------

/**
 * The largest viewBox treated as a drawing of a fixed size. Above it a drawing
 * is a banner or a hero, meant to follow its container, and giving it a height
 * would letterbox it.
 */
const SPOT_MAX = 200

/**
 * Gives a small `<svg>` with a viewBox and no size of its own the size its
 * viewBox states.
 *
 * As presentation attributes, which any CSS rule outranks: a drawing that a
 * stylesheet sizes keeps that size, and only one nothing sizes stops filling
 * its container. An icon (a viewBox of 32 or less) is sized to the text around
 * it, as `1em`, rather than to its drawing units.
 */
export function fixUnsizedSvg(files: Files): { files: Files; fixed: string[] } {
  const out: Files = new Map()
  const touched: string[] = []
  for (const [path, body] of files) {
    if (!COMPONENT.test(path)) continue
    let changed = false
    const next = body.replace(/<svg\b([^>]*)>/g, (tag, attrs: string) => {
      if (/\s(?::)?(?:width|height)\s*=|\sstyle\s*=|\s:style\s*=/.test(attrs)) return tag
      const vb = /viewBox\s*=\s*["{']?\s*["']?\s*([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(attrs)
      if (!vb) return tag
      const w = Number(vb[3]), h = Number(vb[4])
      if (!(w > 0 && h > 0) || Math.max(w, h) > SPOT_MAX) return tag
      /*
       * The width only. The height follows from the viewBox's proportions, and
       * a stylesheet that sizes one side — `.icon { width: 20px }`,
       * `.brand svg { height: 28px }` — still gets its proportions: with both
       * attributes, the side the stylesheet did not set would stay pinned and
       * the drawing would shrink inside a box of the wrong shape.
       */
      const size = Math.max(w, h) <= 32
        ? ` width="${Math.round((w / Math.max(w, h)) * 100) / 100}em"`
        : ` width="${w}"`
      changed = true
      return `<svg${size}${attrs}>`
    })
    if (changed) { out.set(path, next); touched.push(path) }
  }
  return {
    files: out,
    fixed: touched.length
      ? [`大きさの指定がない図に viewBox の大きさを付けました（置かれた場所の幅いっぱいに広がっていました）: ${touched.join('、')}`]
      : [],
  }
}

// --- 2. one literal photograph for every record ----------------------------------------

const IMAGE_FIELD = /^(image|imageUrl|img|photo|photoUrl|thumbnail|thumbnailUrl|picture|cover|coverImage)$/

/**
 * The records in the project's data that carry a photograph: the field it is
 * under, and the other fields those records have.
 */
function photographedRecords(files: Files): { field: string; siblings: Set<string> } | null {
  const byField = new Map<string, Set<string>>()
  for (const [path, body] of files) {
    if (!/^src\/(data|store|lib|mocks?)\//.test(path) || !/\.(ts|js)$/.test(path)) continue
    // Every object literal, nested ones included — a product carries `sizes: { S: 1 }`
    // beside its `image`, and a flat-object pattern never saw it.
    for (let open = body.indexOf('{'); open !== -1; open = body.indexOf('{', open + 1)) {
      const end = closeBrace(body, open)
      if (end < 0) continue
      const obj = body.slice(open, end)
      const keys = topLevelKeys(obj)
      for (const k of keys) {
        if (!IMAGE_FIELD.test(k)) continue
        if (!/^['"`]https?:\/\//.test(topLevelValue(obj, k) ?? '')) continue
        const set = byField.get(k) ?? new Set<string>()
        for (const other of keys) if (other !== k) set.add(other)
        byField.set(k, set)
      }
    }
  }
  if (byField.size !== 1) return null
  const [[field, siblings]] = [...byField]
  return { field, siblings }
}

/** The keys an object literal `{…}` declares at its own level. */
function topLevelKeys(obj: string): string[] {
  const keys: string[] = []
  let depth = 0
  for (let i = 1; i < obj.length - 1; i++) {
    const c = obj[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < obj.length && obj[i] !== q; i++) if (obj[i] === '\\') i++
      continue
    }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 0 && /[A-Za-z_$]/.test(c) && /[\s{,]/.test(obj[i - 1])) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(obj.slice(i))
      if (m) { keys.push(m[1]); i += m[1].length - 1 }
      else { const w = /^[\w$]+/.exec(obj.slice(i)); if (w) i += w[0].length - 1 }
    }
  }
  return keys
}

/**
 * An `<img>` with a literal URL, whose alt text reads a field of a record that
 * has a photograph of its own, is made to show that record's photograph.
 *
 * The alt is the evidence of which record the picture is of: `alt={product.name}`
 * says this image is of `product`. The field it reads has to be one the
 * photographed records carry, so a banner captioned with a category's name is
 * not rebound to a photograph the category does not have.
 */
export function fixLiteralRecordImages(files: Files): { files: Files; fixed: string[] } {
  const out: Files = new Map()
  const fixed: string[] = []
  const records = photographedRecords(files)
  if (!records) return { files: out, fixed }
  for (const [path, body] of files) {
    if (!COMPONENT.test(path) || !/^src\/(screens|components|views|pages)\//.test(path)) continue
    const vue = path.endsWith('.vue')
    let changed = false
    const next = body.replace(/<img\b[^>]*>/g, (tag) => {
      const lit = /(\s)src\s*=\s*"(https?:\/\/[^"]+)"/.exec(tag)
      if (!lit) return tag
      const alt = vue
        ? /\s:alt\s*=\s*"\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*"/.exec(tag)
        : /\salt\s*=\s*\{\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\}/.exec(tag)
      if (!alt || !records.siblings.has(alt[2])) return tag
      changed = true
      fixed.push(`${path}: ${alt[1]}.${records.field}`)
      const bound = vue ? `${lit[1]}:src="${alt[1]}.${records.field}"` : `${lit[1]}src={${alt[1]}.${records.field}}`
      return tag.replace(lit[0], bound)
    })
    if (changed) out.set(path, next)
  }
  return {
    files: out,
    fixed: fixed.length
      ? [`どの商品にも同じ画像を直接書いていたので、各レコードの画像を表示するようにしました: ${[...new Set(fixed)].join('、')}`]
      : [],
  }
}

// --- 3. actions no reducer handles -------------------------------------------------------

/** Every action type a reducer answers to, and every one the project dispatches. */
function actionTypes(files: Files): { handled: Set<string>; sent: Set<string>; code: string } {
  const code = [...files.entries()].filter(([p]) => /\.(tsx?|jsx?|vue)$/.test(p)).map(([, b]) => b).join('\n')
  const handled = new Set<string>([
    ...[...code.matchAll(/\bcase\s+['"]([A-Za-z][\w:/-]*)['"]\s*:/g)].map((m) => m[1]),
    ...[...code.matchAll(/\.type\s*===?\s*['"]([A-Za-z][\w:/-]*)['"]/g)].map((m) => m[1]),
  ])
  const sent = new Set<string>([...code.matchAll(/\bdispatch\(\s*\{\s*type\s*:\s*['"]([A-Za-z][\w:/-]*)['"]/g)].map((m) => m[1]))
  return { handled, sent, code }
}

/** Dispatched types with no reducer case, and the cases there are. Empty when the project has no reducer. */
export function unhandledDispatches(files: Files): { unhandled: string[]; handled: string[] } {
  const { handled, sent } = actionTypes(files)
  if (handled.size === 0) return { unhandled: [], handled: [] }
  return { unhandled: [...sent].filter((t) => !handled.has(t)).sort(), handled: [...handled].sort() }
}

/** Words that say what happens; two names for one action have to agree on these. */
const VERBS = new Set(['ADD', 'REMOVE', 'UPDATE', 'CLEAR', 'RESET', 'TOGGLE', 'SHOW', 'HIDE', 'OPEN', 'CLOSE', 'SELECT',
  'APPROVE', 'REJECT', 'INCREMENT', 'DECREMENT', 'LOGIN', 'LOGOUT', 'SUBMIT', 'CANCEL', 'START', 'STOP', 'MOVE', 'RESTORE',
  'CREATE', 'EDIT', 'FETCH', 'LOAD', 'SAVE', 'SORT', 'FILTER', 'CONFIRM', 'COMPLETE', 'MARK', 'ARCHIVE'])
const SYNONYM: Record<string, string> = {
  FAILED: 'ERROR', FAILURE: 'ERROR', FAIL: 'ERROR', ERRORS: 'ERROR',
  SUCCEEDED: 'SUCCESS', SUCCESSFUL: 'SUCCESS', DELETE: 'REMOVE', SIGNIN: 'LOGIN', SIGNOUT: 'LOGOUT',
}
const words = (t: string): Set<string> =>
  new Set(t.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w && w !== 'SET').map((w) => SYNONYM[w] ?? w))
const verbs = (ws: Set<string>): string => [...ws].filter((w) => VERBS.has(w)).sort().join(',')
const subset = (a: Set<string>, b: Set<string>): boolean => [...a].every((w) => b.has(w))

/**
 * The one reducer case a dispatched type means, when the names say so without
 * doubt: the same words in another order (AUTH_SET_LOADING / SET_AUTH_LOADING),
 * or one name inside the other (AUTH_LOGIN_SUCCESS / LOGIN_SUCCESS), with the
 * same verbs either way. `SET_` is ignored — it is how one author says what
 * another leaves unsaid — and FAILED/ERROR, DELETE/REMOVE are one word.
 */
export function intendedCase(sent: string, handled: Iterable<string>): string | null {
  const s = words(sent)
  const matches = [...handled].filter((h) => {
    const w = words(h)
    return verbs(w) === verbs(s) && w.size > 0 && (subset(w, s) || subset(s, w))
  })
  if (matches.length === 1) return matches[0]
  const exact = matches.filter((h) => words(h).size === s.size)
  return exact.length === 1 ? exact[0] : null
}

/** Index just past the brace matching the one at `open`. */
function closeBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return -1
}

/** The value expression of top-level key `key` in an object literal `{…}`, if it has one. */
function topLevelValue(obj: string, key: string): string | null {
  let depth = 0
  for (let i = 1; i < obj.length - 1; i++) {
    const c = obj[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      for (i++; i < obj.length && obj[i] !== q; i++) if (obj[i] === '\\') i++
      continue
    }
    if (c === '{' || c === '[' || c === '(') depth++
    else if (c === '}' || c === ']' || c === ')') depth--
    else if (depth === 0 && obj.startsWith(key, i) && /[\s{,]/.test(obj[i - 1]) && /^\s*:/.test(obj.slice(i + key.length))) {
      let j = obj.indexOf(':', i) + 1
      const start = j
      let d = 0
      for (; j < obj.length - 1; j++) {
        const ch = obj[j]
        if (ch === '"' || ch === "'" || ch === '`') {
          const q = ch
          for (j++; j < obj.length && obj[j] !== q; j++) if (obj[j] === '\\') j++
          continue
        }
        if (ch === '{' || ch === '[' || ch === '(') d++
        else if (ch === '}' || ch === ']' || ch === ')') d--
        else if (ch === ',' && d === 0) break
      }
      return obj.slice(start, j).trim()
    }
  }
  return null
}

/**
 * Renames each dispatched type no reducer handles to the case it means, when
 * `intendedCase` can tell; and where that case stores the whole payload under a
 * key (`user: action.payload`) and the dispatch sends an object that HAS that
 * key, sends that key's value instead — otherwise the renamed login stores
 * `{ user, email, password }` as the user, and the header greets `undefined`.
 */
export function fixUnhandledDispatch(files: Files): { files: Files; fixed: string[] } {
  const out: Files = new Map()
  const { handled, sent, code } = actionTypes(files)
  if (handled.size === 0) return { files: out, fixed: [] }
  const renames = new Map<string, string>()
  for (const t of sent) {
    if (handled.has(t)) continue
    const to = intendedCase(t, [...handled].filter((h) => /^[A-Z0-9_]+$/.test(h)))
    if (to) renames.set(t, to)
  }
  if (renames.size === 0) return { files: out, fixed: [] }

  // What each target case does with its payload: `key: action.payload` (the whole of it).
  const wholeUnder = new Map<string, string>()
  for (const to of renames.values()) {
    const at = code.search(new RegExp(`\\bcase\\s+['"]${to}['"]\\s*:`))
    if (at < 0) continue
    const body = code.slice(at, at + 600).split(/\bcase\s+['"]/)[1] ?? ''
    const whole = /\b([A-Za-z_$][\w$]*)\s*:\s*action\.payload\b(?![.\w[])/.exec(body)
    if (whole && !/action\.payload\./.test(body)) wholeUnder.set(to, whole[1])
  }

  for (const [path, body] of files) {
    if (!/\.(tsx?|jsx?|vue)$/.test(path)) continue
    let next = body
    for (const [from, to] of renames) {
      const re = new RegExp(`\\bdispatch\\(\\s*\\{\\s*type\\s*:\\s*(['"])${from}\\1`, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(next))) {
        const open = next.indexOf('{', m.index)
        const end = closeBrace(next, open)
        if (end < 0) break
        let call = next.slice(open, end).replace(new RegExp(`(['"])${from}\\1`), `$1${to}$1`)
        const key = wholeUnder.get(to)
        const payload = key ? topLevelValue(call, 'payload') : null
        if (key && payload?.startsWith('{')) {
          const inner = topLevelValue(payload, key)
          if (inner) call = call.replace(payload, inner)
        }
        next = next.slice(0, open) + call + next.slice(end)
        re.lastIndex = open + call.length
      }
    }
    if (next !== body) out.set(path, next)
  }
  return {
    files: out,
    fixed: out.size
      ? [`どの reducer も処理しない action を、処理される名前にそろえました（dispatch が無視され、操作が効いていませんでした）: ${[...renames].map(([a, b]) => `${a} → ${b}`).join('、')}`]
      : [],
  }
}

// --- 4. the hash reader's own list of screens -------------------------------------------

/**
 * The screens `routes.ts` declares, added to the list the hash reader checks
 * a URL against.
 *
 * The navigation hook parses `location.hash` and accepts only screens in a
 * list of its own (`validScreens`). An edit that adds screens adds them to
 * `ScreenId`, the menu and App's branches — and not to that list, which lives
 * in a file the edit had no reason to open. The login added to the inventory
 * system on 2026-09-24 did exactly that: `#/home` and `#/login-loading` were
 * rejected as unknown and parsed to the default screen, the login form, so a
 * correct password went nowhere. Found in 4 of 377 stored documents.
 *
 * Only a list the hash reader uses: an array whose entries are mostly screen
 * ids, tested with `.includes(` in a file that reads `location.hash`. A menu's
 * list of screens leaves detail and flow screens out on purpose, and is not
 * touched.
 */
export function fixHashScreenList(files: Files): { files: Files; fixed: string[] } {
  const out: Files = new Map()
  const fixed: string[] = []
  const routes = files.get('src/routes.ts')
  const union = routes ? /type\s+ScreenId\s*=\s*([^;]+);/.exec(routes) : null
  if (!union) return { files: out, fixed }
  const ids = [...union[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
  if (ids.length === 0) return { files: out, fixed }
  for (const [path, body] of files) {
    if (path === 'src/routes.ts' || !/\.(ts|tsx|js|jsx|vue)$/.test(path) || !/location\.hash/.test(body)) continue
    let next = body
    for (const a of body.matchAll(/(?:const|let)\s+(\w+)(?:\s*:\s*[\w<>[\]\s|]+?)?\s*=\s*\[([^\]]*)\]/g)) {
      if (/nav|menu|tab/i.test(a[1]) || !body.includes(`${a[1]}.includes(`)) continue
      const items = [...a[2].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
      if (items.length < 2 || items.filter((i) => ids.includes(i)).length < Math.ceil(items.length * 0.6)) continue
      const missing = ids.filter((i) => !items.includes(i))
      if (missing.length === 0) continue
      const quote = /"/.test(a[2]) && !/'/.test(a[2]) ? '"' : "'"
      const list = a[2].trimEnd().replace(/,\s*$/, '')
      const added = `${list}${list.trim() ? ', ' : ''}${missing.map((m) => `${quote}${m}${quote}`).join(', ')}`
      next = next.replace(a[0], a[0].replace(`[${a[2]}]`, `[${added}]`))
      fixed.push(`${path} ${a[1]}: ${missing.join(', ')}`)
    }
    if (next !== body) out.set(path, next)
  }
  return {
    files: out,
    fixed: fixed.length
      ? [`URL の読み取りが知らない画面を ScreenId に合わせて追加しました（開いても既定の画面に戻されていました）: ${fixed.join('、')}`]
      : [],
  }
}

/**
 * All of them, in order, each reading what the one before it wrote — one call for
 * fixupProject, whose own length is held to a ceiling (svelte-removed.test.mjs).
 */
export function fixSourceConsistency(files: Files): { files: Files; fixed: string[] } {
  const current = new Map(files)
  const changed: Files = new Map()
  const fixed: string[] = []
  for (const pass of [fixUnsizedSvg, fixLiteralRecordImages, fixUnhandledDispatch, fixHashScreenList, fixScrollOnNavigate]) {
    const r = pass(current)
    for (const [p, b] of r.files) { current.set(p, b); changed.set(p, b) }
    fixed.push(...r.fixed)
  }
  return { files: changed, fixed }
}

// --- 5. a new screen that opens where the last one was scrolled to --------------------------

/** Marks the snippet, so it is added once and recognised when already there. */
export const SCROLL_MARK = 'MakeUI: screen scroll'

/*
 * The snippet itself, kept to syntax every entry file accepts (TSX, TS).
 *
 * Moving forward starts the new screen at its top; moving back to the screen
 * before returns to where it was left — the navigation stack a phone app has.
 * Both the window and any element scrolled inside the page are covered, because
 * a shell whose main area scrolls on its own never scrolls the window at all.
 * Applied three times — at once, after the next frame and shortly after —
 * because the new screen renders after `hashchange`, not during it.
 */
const SCROLL_SNIPPET = `
// ${SCROLL_MARK} — a new screen starts at its top; going back returns to where you were.
(() => {
  type Spot = [Element | Window, number];
  const stack: Array<{ hash: string; spots: Spot[] }> = [];
  let current = location.hash;
  const spots = (): Spot[] => {
    const found: Spot[] = [[window, window.scrollY]];
    document.querySelectorAll('*').forEach((el) => { if (el.scrollTop > 0) found.push([el, el.scrollTop]); });
    return found;
  };
  window.addEventListener('hashchange', () => {
    const leaving = { hash: current, spots: spots() };
    current = location.hash;
    const back = stack.length > 0 && stack[stack.length - 1].hash === current;
    const target = back ? stack.pop() : null;
    if (!back) stack.push(leaving);
    const apply = () => {
      if (target) {
        for (const [el, y] of target.spots) {
          if (el === window) window.scrollTo(0, y);
          else if ((el as Element).isConnected) (el as Element).scrollTop = y;
        }
      } else {
        window.scrollTo(0, 0);
        for (const [el] of leaving.spots) if (el !== window && (el as Element).isConnected) (el as Element).scrollTop = 0;
      }
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 80);
  });
})();
`

/**
 * A screen change that keeps the scroll position of the screen before it.
 *
 * Reported 2026-09-24 on the booking system: choose a slot far down the
 * calendar, and the details form opened scrolled to that same depth — its first
 * fields above the fold, the page apparently empty. Every generated app routes
 * on the hash, and of 377 stored documents 8 scroll at all — a form's step
 * returning to its top, a field with an error brought into view — and none on
 * the route change itself, and none on an inner scroller. Those per-screen
 * calls agree with this one and stay. Added to the entry file, so the exported
 * project behaves the same as the preview.
 */
export function fixScrollOnNavigate(files: Files): { files: Files; fixed: string[] } {
  const out: Files = new Map()
  const entry = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js'].find((p) => files.has(p))
  if (!entry) return { files: out, fixed: [] }
  const body = files.get(entry) ?? ''
  const code = [...files.values()].join('\n')
  if (body.includes(SCROLL_MARK) || !/hashchange/.test(code)) return { files: out, fixed: [] }
  const snippet = entry.endsWith('.js') || entry.endsWith('.jsx')
    ? SCROLL_SNIPPET.replace('type Spot = [Element | Window, number];\n  ', '').replace(/: Array<\{ hash: string; spots: Spot\[\] \}>/, '').replace(/\(\): Spot\[\]/, '()').replace(/: Spot\[\]/, '').replace(/ as Element/g, '')
    : SCROLL_SNIPPET
  out.set(entry, body.replace(/\s*$/, '\n') + snippet)
  return { files: out, fixed: ['画面を切り替えても前の画面のスクロール位置のまま開いていたので、新しい画面は先頭から、戻ったときは元の位置で開くようにしました'] }
}
