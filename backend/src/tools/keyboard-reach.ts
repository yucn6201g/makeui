/**
 * Controls the mouse can reach and the keyboard cannot.
 *
 * A product card built as `<div className="product-card" onClick={…}>` opens
 * the detail screen when clicked and does nothing at all from the keyboard: Tab
 * skips it, because a `div` is not in the tab order, and Enter never arrives.
 * It looks finished and it is not usable without a mouse.
 *
 * Measured 2026-09-20 over the 34 project documents in the stored corpus, after
 * excluding the two shapes that are correctly unreachable (below): 21 of them
 * (62%) contain at least one, 32 elements in all — 16 `div`, 13 `tr`, and one
 * each of `td`, `li` and `h1`. One of the 32 is the 商品カード of the storefront
 * a user reported, `<div className="card product-card" onClick=…>`.
 *
 * TWO SHAPES ARE LEFT ALONE, and both are the majority of what a naive scan
 * finds — 22 of the 54 raw matches:
 *
 *   - a modal BACKDROP dismissed by clicking outside it. Its keyboard
 *     equivalent is Escape, and giving it a tab stop puts the focus ring on a
 *     sheet of glass in front of the dialog.
 *   - a panel whose only handler is `e.stopPropagation()`, which exists to keep
 *     the backdrop's handler from firing. It is not a control; it is the
 *     absence of one.
 *
 * WHAT IS WRITTEN differs by tag, because `role="button"` is not always an
 * improvement. On a `tr` it removes the row from its table's semantics, and on
 * an `li` it removes the item from its list — so those get the tab stop and the
 * key handler without the role. A `div` gets all three, unless it already
 * contains a `button` or an `a`, in which case the role would nest a button
 * inside a button and the tab stop is enough.
 *
 * The key handler re-dispatches rather than duplicating the click expression:
 *
 *     onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') {
 *       e.preventDefault(); e.currentTarget.click(); } }}
 *
 * `element.click()` dispatches a real bubbling click, which is what React's
 * delegated listener and Vue's native listener are both waiting for. Copying
 * the expression instead would mean parsing it, and an expression that closes
 * over the loop variable would have to be copied exactly or silently open the
 * wrong record.
 */

import type { OutputKind } from '../config/frameworks.js'

/** Tags that are already in the tab order and need nothing. */
const NATIVELY_FOCUSABLE = /^(?:button|a|input|select|textarea|summary|label|dialog|details)$/i

/**
 * Tags that carry meaning inside a parent that counts its children.
 *
 * A `tr` belongs to its table and an `li` to its list; `role="button"` replaces
 * that meaning rather than adding to it, so these get the tab stop and the key
 * handler only.
 */
const ROLE_WOULD_REPLACE = /^(?:tr|td|th|li|dt|dd|option|figcaption)$/i

/** A backdrop is dismissed by clicking outside it; its keyboard equivalent is Escape. */
const BACKDROP = /overlay|backdrop|scrim|\bmask\b/i

export interface UnreachableControl {
  /** Offset of the `<` that opens the element. */
  at: number
  /** Offset just past the `>` that closes the opening tag. */
  end: number
  tag: string
  /** Whether `role="button"` is safe here. */
  role: boolean
}

/**
 * The opening tag starting at `at`, or null when it is not one.
 *
 * Walks to the `>` that closes it, ignoring any inside a quoted value or a JSX
 * expression — `onClick={() => go({ id })}` contains both a `>` and a `}` that
 * must not end the scan.
 */
function openingTag(source: string, at: number): { tag: string; attrs: string; end: number; selfClosing: boolean } | null {
  const name = /^<([a-zA-Z][\w.-]*)/.exec(source.slice(at, at + 64))
  if (!name) return null
  let i = at + name[0].length
  let depth = 0
  let quote = ''
  for (; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') { depth++; continue }
    if (c === '}') { depth--; continue }
    if (c === '>' && depth === 0) break
  }
  if (i >= source.length) return null
  const selfClosing = source[i - 1] === '/'
  return {
    tag: name[1],
    attrs: source.slice(at + name[0].length, selfClosing ? i - 1 : i),
    end: i + 1,
    selfClosing,
  }
}

/**
 * Where this element's content ends, by matching its own tag.
 *
 * Only used to ask whether the subtree already holds something interactive, so
 * an unbalanced document costs a conservative answer rather than a wrong edit:
 * running off the end returns the rest of the file, which can only add
 * interactive elements and therefore only withholds the role.
 */
function subtreeOf(source: string, tag: string, contentStart: number): string {
  const open = new RegExp(`<${tag}(?![\\w-])`, 'g')
  const close = new RegExp(`</${tag}\\s*>`, 'g')
  open.lastIndex = contentStart
  close.lastIndex = contentStart
  let depth = 1
  let from = contentStart
  for (let guard = 0; guard < 500; guard++) {
    close.lastIndex = from
    const c = close.exec(source)
    if (!c) return source.slice(contentStart)
    open.lastIndex = from
    let o = open.exec(source)
    while (o && o.index < c.index) {
      depth++
      open.lastIndex = o.index + 1
      o = open.exec(source)
    }
    depth--
    if (depth === 0) return source.slice(contentStart, c.index)
    from = c.index + c[0].length
  }
  return source.slice(contentStart)
}

/**
 * The value of a click handler attribute, with its delimiters removed.
 *
 * Returns null when the element has no click handler at all.
 */
function clickExpression(attrs: string, kind: OutputKind): string | null {
  const at = kind === 'vue'
    ? /(?:^|\s)(?:@click|v-on:click)(?:\.[\w.]+)?\s*=\s*/.exec(attrs)
    : /(?:^|\s)onClick\s*=\s*/.exec(attrs)
  if (!at) return null
  let i = (at.index ?? 0) + at[0].length
  const opener = attrs[i]
  if (opener === '"' || opener === "'") {
    const shut = attrs.indexOf(opener, i + 1)
    return shut === -1 ? '' : attrs.slice(i + 1, shut)
  }
  if (opener !== '{') return ''
  let depth = 0
  const start = i
  for (; i < attrs.length; i++) {
    if (attrs[i] === '{') depth++
    else if (attrs[i] === '}' && --depth === 0) return attrs.slice(start + 1, i)
  }
  return attrs.slice(start + 1)
}

/**
 * A handler that only stops the backdrop's — not a control.
 *
 * Asked as "is every call in this expression `stopPropagation`", rather than by
 * matching a shape, because the same non-control is written as an arrow with a
 * block, an arrow without one, and a named `handleBackgroundClick`.
 */
function onlyStopsPropagation(expression: string): boolean {
  const calls = [...expression.matchAll(/([\w$]+)\s*\(/g)].map((m) => m[1])
  return calls.length > 0 && calls.every((c) => c === 'stopPropagation')
}

/** The clickable elements in one file that the keyboard cannot reach. */
export function unreachableControls(source: string, kind: OutputKind): UnreachableControl[] {
  const out: UnreachableControl[] = []
  for (let at = source.indexOf('<'); at !== -1; at = source.indexOf('<', at + 1)) {
    const tag = openingTag(source, at)
    if (!tag) continue
    // A component decides its own markup; adding attributes here would pass
    // props it may not accept.
    if (/^[A-Z]/.test(tag.tag) || tag.tag.includes('.')) continue
    if (NATIVELY_FOCUSABLE.test(tag.tag)) continue
    const expression = clickExpression(tag.attrs, kind)
    if (expression === null) continue
    if (/\btabindex\b/i.test(tag.attrs)) continue
    if (/\brole\s*=/.test(tag.attrs)) continue
    if (BACKDROP.test(tag.attrs)) continue
    if (onlyStopsPropagation(expression)) continue
    const nested = tag.selfClosing ? '' : subtreeOf(source, tag.tag, tag.end)
    out.push({
      at,
      end: tag.end,
      tag: tag.tag,
      role: !ROLE_WOULD_REPLACE.test(tag.tag) && !/<(?:button|a)(?![\w-])/i.test(nested),
    })
  }
  return out
}

/** What is inserted after the tag name, for one framework. */
function attributesFor(kind: OutputKind, role: boolean): string {
  if (kind === 'vue') {
    return (
      (role ? ' role="button"' : '') +
      ' tabindex="0"' +
      ' @keydown.enter.prevent="$event.currentTarget.click()"' +
      ' @keydown.space.prevent="$event.currentTarget.click()"'
    )
  }
  return (
    (role ? ' role="button"' : '') +
    ' tabIndex={0}' +
    " onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}"
  )
}

/**
 * Gives every clickable element in the file a tab stop and an Enter/Space handler.
 *
 * Rewrites from the end so that an earlier insertion does not move the offsets
 * of the ones still to come.
 */
export function reachByKeyboard(
  source: string,
  kind: OutputKind
): { source: string; count: number } {
  const found = unreachableControls(source, kind)
  if (found.length === 0) return { source, count: 0 }
  let out = source
  for (const c of [...found].reverse()) {
    const nameEnd = c.at + 1 + c.tag.length
    out = out.slice(0, nameEnd) + attributesFor(kind, c.role) + out.slice(nameEnd)
  }
  return { source: out, count: found.length }
}
