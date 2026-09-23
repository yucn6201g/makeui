/**
 * Which CSS rules style the controls a user types into, and which of them make
 * the text too small to type in.
 *
 * Moved here from `interaction-audit.ts` unchanged, so that the audit that
 * REPORTS a small input font and the fixup that RAISES it read the same rules.
 * They must not drift: a fixup that misses what the audit finds leaves the
 * finding standing and looks like the fixup not running, and a fixup that
 * changes what the audit does not find is a change nobody asked for.
 *
 * The scoping is deliberately tight, and the reasons are the audit's own. A
 * first version matched any rule naming any form control and reported a page
 * whose text fields were a correct 16px over its 12px language `<select>` —
 * checkboxes, radios and selects are not what the user types into and are
 * legitimately small.
 */

import { readProjectFiles } from './project-transport.js'

const TYPEABLE_INPUT_TYPES = new Set([
  'text', 'email', 'tel', 'url', 'search', 'password', 'number', 'date', 'time', 'datetime-local',
])

/** The opening tags of the controls a user actually types into. */
export function textEntryControlTags(html: string): string[] {
  const tags = (html.match(/<textarea\b[^>]*>/gi) ?? []).slice()
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]?.toLowerCase() ?? 'text'
    if (TYPEABLE_INPUT_TYPES.has(type)) tags.push(m[0])
  }
  return tags
}

/**
 * The classes the document's own form controls carry.
 *
 * Without this the check only saw element selectors, and a React project styling
 * `.checkout-form__input` was read as having no sizing rule at all — reported as
 * broken while being sized correctly. The classes are taken off the actual control
 * tags, so the rules found are the rules that really apply to them, rather than
 * whatever a class-name heuristic would have guessed.
 */
function textEntryClasses(tags: string[]): Set<string> {
  const classes = new Set<string>()
  for (const tag of tags) {
    for (const c of tag.matchAll(/\b(?:class|className)\s*=\s*["'{`]([^"'}`]*)/gi)) {
      for (const name of c[1].split(/[\s${}]+/)) {
        if (/^[A-Za-z_][\w-]*$/.test(name)) classes.add(name)
      }
    }
  }
  return classes
}

export interface ControlRule {
  /** The file the rule was written in, for an instruction that can name it. */
  path: string
  /** The selector, trimmed — what the repair has to find in that file. */
  selector: string
  /** The declarations. */
  body: string
  /**
   * The rule exactly as it stands in the file, and where.
   *
   * Carried for the fixup, which has to edit that rule and no other. `selector`
   * has already had the parts this check ignores removed from it, so it cannot
   * be used to find the text again — a rule written
   * `.field select, .field input { … }` is reported as `.field input`, which
   * appears nowhere in the stylesheet.
   */
  raw: string
  at: number
}

export function formControlRules(doc: string, tags: string[]): ControlRule[] {
  const classes = textEntryClasses(tags)
  const bodies: ControlRule[] = []
  /*
   * Read per file, so a finding can say where.
   *
   * The same text as before — each file's whole body, not just its `<style>`
   * blocks — so the set of rules found is unchanged and no measurement moves.
   */
  // Prose files are dropped for the same reason `withoutProse` exists: the
  // specification and the design guidelines carry CSS examples, and a rule the
  // document is being told about is not a rule the document has.
  const sources: [string, string][] = [...readProjectFiles(doc).entries()].filter(
    ([path]) => !/\.(md|markdown|txt)$/i.test(path)
  )
  for (const [path, text] of sources.length > 0 ? sources : [['', doc] as [string, string]]) {
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '')
      /*
       * Comma-separated selectors are separate selectors: one rule styling both
       * a select and a text input used to be discarded entirely, and the
       * document read as having no sizing for its text fields at all.
       */
      const parts = selector.split(',').filter((part) => !/checkbox|radio|\bselect\b/i.test(part))
      if (parts.length === 0) continue
      const byElement = parts.some((part) => /(?:^|[\s,>+~])(?:input|textarea)\b/i.test(part))
      const byClass = parts.some((part) =>
        [...classes].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(part))
      )
      if (byElement || byClass) {
        bodies.push({
          path,
          selector: parts.join(',').trim(),
          body: m[2],
          raw: m[0],
          at: m.index ?? 0,
        })
      }
    }
  }
  return bodies
}

/** Resolves `var(--x)` against the custom properties the document defines. */
export function makeValueResolver(doc: string): (value: string) => string {
  const props = new Map<string, string>()
  for (const m of doc.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (!props.has(m[1])) props.set(m[1], m[2].trim())
  }
  const resolve = (value: string, depth = 0): string => {
    const v = value.trim()
    if (depth > 4) return v
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)$/.exec(v)
    if (!m) return v
    return resolve(props.get(m[1]) ?? m[2] ?? '', depth + 1)
  }
  return resolve
}

/** px for a literal length, null when it is not one (a token miss, a calc, a %). */
export function toPx(value: string): number | null {
  const m = /^(-?[\d.]+)(px|rem|em)$/.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] === 'px' ? n : n * 16
}

/** The threshold: below this, iOS zooms the page when the field takes focus. */
export const MIN_INPUT_FONT_PX = 16

export interface SmallControlFont extends ControlRule {
  /** The declaration as written — `var(--fs-body)`, `14px`. */
  value: string
  /** What it resolves to. */
  px: number
  /** The custom property it came through, when it came through one. */
  token?: string
}

/**
 * Every rule that sizes a typed-into control below the threshold.
 *
 * Only a value that RESOLVES to a literal counts. A `calc()`, a percentage or a
 * token the document never defines is left alone in both directions: the audit
 * does not report it and the fixup does not touch it, because neither can say
 * what it comes to.
 */
export function smallControlFonts(doc: string): SmallControlFont[] {
  const tags = textEntryControlTags(doc)
  if (tags.length < 2) return []
  const resolve = makeValueResolver(doc)
  const out: SmallControlFont[] = []
  for (const r of formControlRules(doc, tags)) {
    const raw = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(r.body)?.[1]
    if (!raw) continue
    const px = toPx(resolve(raw))
    if (px === null || px >= MIN_INPUT_FONT_PX) continue
    const value = raw.trim()
    out.push({ ...r, value, px, token: /^var\(\s*(--[\w-]+)/.exec(value)?.[1] })
  }
  return out
}

/**
 * Whether one comma-separated part of a selector targets something typed into.
 *
 * `formControlRules` keeps a rule whose selector has ANY control part, so
 * `.field input, .field label { font-size: var(--fs-sm) }` arrives with the
 * label still in it. Raising that rule whole would grow the label too, which is
 * a change nobody asked for.
 */
/**
 * The same declarations with the font-size at the threshold.
 *
 * Matched inside the BODY, because `(?:^|;)` run over a whole rule does not
 * match a font-size that is the FIRST declaration — which is where a stylesheet
 * usually puts it, and is what made three of this fixup's first tests fail.
 */
function raised16(declarations: string): string {
  return declarations.replace(
    /(^|;)(\s*)font-size\s*:\s*[^;]+/i,
    (_m, lead: string, space: string) => `${lead}${space}font-size: ${MIN_INPUT_FONT_PX}px`
  )
}

function isControlPart(part: string, classes: Set<string>): boolean {
  if (/(?:^|[\s>+~])(?:input|textarea)\b/i.test(part)) return true
  return [...classes].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(part))
}

/**
 * Raises every input font the audit would report, to the threshold.
 *
 * Reported 2026-09-20 by a user as 「入力欄の font-size が var(--fs-body) に
 * なっています」 — the build chose a body token for its fields and the token is
 * under 16px, which is a reasonable-looking choice that iOS answers by zooming
 * the page whenever a field takes focus.
 *
 * Done here rather than by a repair call because the repair call does not work.
 * `input-sizing` is one of four ids in `NOT_WORTH_RETRYING`: measured at 1 fix in
 * 10 second attempts over 30 days, and 24 of 48 survive the whole run. The
 * reason is visible in the instruction — the document is told not to change the
 * token, because the token is used elsewhere, and to point the input rules at a
 * bigger one, which means knowing which of the project's tokens is bigger. That
 * is bookkeeping, and bookkeeping is what this file is for.
 *
 * TWO EDITS, chosen per rule:
 *
 *   - when every part of the selector is a control, the value is replaced where
 *     it stands. Media queries, `<style scoped>` and specificity all keep
 *     working because nothing about the rule moves.
 *   - when the selector also styles something else — a label, a hint — a second
 *     rule for the control parts alone is written immediately after it. Same
 *     place, so the same at-rule and the same scope; same specificity and later,
 *     so it wins.
 *
 * A literal is written rather than a token: the point is that the project's
 * scale has no token at or above the threshold, so there is none to point at.
 */
export function raiseControlFonts(
  files: Map<string, string>,
  doc: string
): { files: Map<string, string>; raised: SmallControlFont[] } {
  const found = smallControlFonts(doc)
  if (found.length === 0) return { files, raised: [] }
  const classes = textEntryClasses(textEntryControlTags(doc))

  const out = new Map(files)
  const raised: SmallControlFont[] = []
  // Per file, and from the end of each, so an earlier edit does not move the
  // offsets of the rules still to come.
  const byFile = new Map<string, SmallControlFont[]>()
  for (const f of found) {
    if (!files.has(f.path)) continue
    byFile.set(f.path, [...(byFile.get(f.path) ?? []), f])
  }
  for (const [path, rules] of byFile) {
    let body = files.get(path) ?? ''
    for (const r of [...rules].sort((a, b) => b.at - a.at)) {
      // The text must still be where it was read from; a document whose files
      // were rewritten between the two reads is left alone rather than guessed at.
      if (body.slice(r.at, r.at + r.raw.length) !== r.raw) continue
      const parts = r.selector.split(',')
      const controls = parts.filter((p) => isControlPart(p, classes))
      if (controls.length === 0) continue
      /*
       * A selector that styles more than the control is SPLIT rather than
       * followed by an override.
       *
       * Appending `.field input { font-size: 16px }` after the rule renders
       * correctly — same specificity, later — and leaves the original
       * declaration in the file, so the audit reads the stylesheet and reports
       * the finding again. A fixup that renders right and still reports is
       * indistinguishable from a fixup that did not run.
       */
      const others = parts.filter((p) => !isControlPart(p, classes))
      const head = r.raw.slice(0, r.raw.indexOf('{'))
      const lead = /^\s*/.exec(head)?.[0] ?? ''
      let replacement: string
      if (controls.length === parts.length) {
        /*
         * Rewritten from the rule's own parts rather than by a search-and-
         * replace over the whole text. The declaration is matched inside the
         * BODY, because `(?:^|;)` run over the rule as a whole does not match a
         * font-size that is the first declaration — which is where a stylesheet
         * usually puts it, and is why three of this file's first tests failed.
         */
        const tail = r.raw.slice(r.raw.lastIndexOf('}'))
        const declarations = raised16(r.body)
        if (declarations === r.body) continue
        replacement = `${head}{${declarations}${tail}`
      } else {
        const declarations = raised16(r.body)
        if (declarations === r.body) continue
        replacement =
          `${lead}${others.join(',').trim()} {${r.body}}\n` +
          `${lead}${controls.join(',').trim()} {${declarations}}`
      }
      if (replacement === r.raw) continue
      body = body.slice(0, r.at) + replacement + body.slice(r.at + r.raw.length)
      raised.push(r)
    }
    out.set(path, body)
  }
  return raised.length > 0 ? { files: out, raised } : { files, raised: [] }
}
