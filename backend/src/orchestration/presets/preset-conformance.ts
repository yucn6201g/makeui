import { withoutProse } from '../audit/interaction-audit.js'

/**
 * Measures whether a document was actually built to its design system.
 *
 * The previous check looked for literal values at the point of use — patterns
 * like /border-radius:\s*[1-9]\d+px/. That worked when output hard-coded values
 * inline. It stopped working the moment generation got *better*: documents now
 * declare `--radius-card: 0.5rem` in :root and write `border-radius:
 * var(--radius-card)` everywhere. Measured against real output, both forbidden
 * patterns were structurally unable to fire — defeated twice over, by `var()`
 * and by `rem`. They had been passing because the output happened to be good,
 * not because anything was being verified.
 *
 * So the document is normalised first — custom properties resolved, units
 * converted — and the contract is then checked against the values that actually
 * reach the screen.
 */

export type Elevation = 'none' | 'subtle' | 'any'

export interface PresetSignature {
  /** Exact strings that must appear somewhere: palette anchors, font stack. */
  required: string[]
  /** The system's colours. Off-palette usage is measured against this. */
  palette?: string[]
  /** Corner radii the system permits, in px. Omit to allow any. */
  radii?: number[]
  /** How much elevation the system allows beyond focus rings. */
  elevation?: Elevation
  /** Must appear in the primary font stack. */
  font?: string
  /** Patterns checked against the normalised document. */
  forbidden?: RegExp[]
  /**
   * What the system permits of movement.
   *
   * Motion was the one axis every preset asked for in prose and nothing ever
   * measured. Measured across 199 shipped documents against that prose: 70%
   * contain a `transition: all` where the instruction says opacity and
   * transform only, and 14% run an animation past the stated entrance ceiling.
   *
   * Only two rules, and deliberately: both can be repaired by substituting a
   * value, so neither can raise a violation that has to be argued with a model
   * and will probably be rejected. "No infinite loops on decoration" is in every
   * preset's prose and is NOT here, because a loading spinner needs `infinite`
   * and nothing in the CSS separates it from a pulsing badge.
   */
  motion?: MotionContract
  /**
   * The system's own published elevation values, which the elevation rule exempts.
   *
   * The 24px blur ceiling is a rule for shadows a build invents. Spindle publishes
   * a lv6 shadow with a 28px blur for dialogs, and once the token block restored
   * that value a build using `var(--shadow-lv6)` — exactly as asked — was reported
   * as too strong.
   */
  shadows?: string[]
}

export interface MotionContract {
  /** `transition: all` sweeps layout properties into every hover. */
  namedPropertiesOnly?: boolean
  /** The longest a transition or animation may run, in ms. */
  maxDurationMs?: number
}

export interface ConformanceResult {
  /** Share of `required` tokens present, 0-1. */
  ratio: number
  missing: string[]
  violations: number
  /** Share of colour usage that is on-palette or neutral, 0-1. */
  paletteShare: number
  /** Specific, actionable findings for the repair pass. */
  details: string[]
}

/**
 * The markers around the token block MakeUI writes (preset-foundation.ts).
 *
 * Kept here, beside the measurement, because the measurement is what has to
 * respect them: the block declares every colour and the typeface of the system,
 * so counting it would satisfy `required` and pad the palette share on a
 * stylesheet that never used a single one of them. What is measured is what the
 * build wrote — its `var()` references still resolve through the block, because
 * the tokens are read before it is cut out.
 */
export const FOUNDATION_START = '/* makeui:foundation:start'
export const FOUNDATION_END = '/* makeui:foundation:end */'

/**
 * Applies a rewrite to everything except the token block.
 *
 * For the deterministic passes that edit a stylesheet by substitution. The block is
 * put back verbatim after every step, so a substitution inside it is not a fix — it
 * is a change that silently reverts, leaving the pass reporting a defect closed.
 */
export function outsideFoundation(text: string, rewrite: (part: string) => string): string {
  const start = text.indexOf(FOUNDATION_START)
  const end = start === -1 ? -1 : text.indexOf(FOUNDATION_END, start)
  if (end === -1) return rewrite(text)
  const blockEnd = end + FOUNDATION_END.length
  return rewrite(text.slice(0, start)) + text.slice(start, blockEnd) + rewrite(text.slice(blockEnd))
}

/**
 * The token block reduced to the tokens the project actually references, as a plain :root.
 *
 * For measurements that ask how many colours, sizes or tokens a design USES. The
 * block declares a system's whole palette and type scale, and counted as written it
 * put 29 colours into a page that used 16: `palette-size` fired on the first two
 * generations built with it (digital-agency, material3, 2026-09-14) for colours
 * nobody had used, and would have sent a repair after them. Cutting the block out
 * entirely would be wrong the other way — a page built through `var()` would read
 * as having no palette at all.
 */
export function withUsedFoundationTokens(text: string): string {
  const start = text.indexOf(FOUNDATION_START)
  const end = start === -1 ? -1 : text.indexOf(FOUNDATION_END, start)
  if (end === -1) return text
  const blockEnd = end + FOUNDATION_END.length
  const block = text.slice(start, blockEnd)
  const rest = text.slice(0, start) + text.slice(blockEnd)
  const used = new Set([...rest.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))
  const kept = [...block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);\s*$/gm)]
    .filter((m) => used.has(m[1]))
    .map((m) => `  ${m[1]}: ${m[2]};`)
  return `${text.slice(0, start)}:root {\n${kept.join('\n')}\n}${text.slice(blockEnd)}`
}

export function withoutFoundation(text: string): string {
  let out = text
  for (;;) {
    const start = out.indexOf(FOUNDATION_START)
    if (start === -1) return out
    const end = out.indexOf(FOUNDATION_END, start)
    if (end === -1) return out
    out = out.slice(0, start) + out.slice(end + FOUNDATION_END.length)
  }
}

/** `0.5rem` -> 8. Assumes the conventional 16px root, which every preset uses. */
function remToPx(value: string): string {
  return value.replace(/(\d*\.?\d+)rem/g, (_, n) => `${Math.round(parseFloat(n) * 16)}px`)
}

/**
 * Inlines custom properties so the checks see real values.
 *
 * Iterative because tokens legitimately reference other tokens; bounded because
 * a malformed document could otherwise cycle.
 */
export function normaliseCss(html: string): string {
  const tokens = new Map<string, string>()
  for (const m of html.matchAll(/(--[\w-]+)\s*:\s*([^;}\n]+)/g)) {
    tokens.set(m[1], m[2].trim())
  }

  let out = html
  for (let pass = 0; pass < 6; pass++) {
    const next = out.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\)/g,
      (whole, name, fallback) => tokens.get(name) ?? fallback ?? whole
    )
    if (next === out) break
    out = next
  }
  return remToPx(out)
}

/** Greys carry no brand; they never count against a palette. */
function isNeutral(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12
}

/** Focus rings are `0 0 0 Npx` — an accessibility requirement, not decoration. */
function isFocusRing(shadow: string): boolean {
  return /^0\s+0\s+0\s+[\d.]+px/.test(shadow.trim())
}

interface SnapResult {
  html: string
  /** Every value that moved, with what it became. The log line, and the test. */
  changes: { from: number; to: number; where: 'token' | 'literal' }[]
}

/**
 * Brings a document's corner radii onto the system's scale, by substitution.
 *
 * This exists because the model repair could not. Measured on a real run: the
 * deviation was detected, the repair ran, the repair WORKED — one violation to
 * none — and was rejected for shortening the document by 13%. Deleting 9,500
 * characters to fix a corner radius is not a trade worth taking, so the guard
 * was right and the violation shipped.
 *
 * Prompting cannot win this either. Measured across the corpus, the radii that
 * offend are the conventional scale — 4, 8, 10, 2, 6, 12, 16, 24 — which is what
 * a model writes by habit at every element. The built-in presets pass because
 * they CHOSE conventional values (`digital-agency` permits 4 and 8); a system
 * that permits 3 and 7 fights that habit everywhere and loses.
 *
 * So the repair is a value substitution, which has the opposite risk profile
 * from a model rewrite: it cannot delete content and it cannot change
 * structure. And it is small, because radii are already tokenised — measured
 * across 199 shipped documents, 92% declare `--radius-*` tokens and 90% use
 * them through `var()`, 2,876 uses against 629 declarations. Rewriting about
 * three declarations and three stray literals per document reaches all of it.
 *
 * What is never touched: `0`, percentages, and anything at or above 500px.
 * Those are pill and circle shapes — a shape decision, not a scale violation —
 * and `measureConformance` ignores them for the same reason. A rewrite that
 * squared off every avatar to satisfy a radius scale would be a worse failure
 * than the one it fixed.
 *
 * The output unit is px even where the input was rem. The value is the system's
 * now, and px is how the system states it.
 */
export function snapRadii(html: string, radii: number[]): SnapResult {
  const allowed = [...new Set(radii)].filter((v) => v > 0 && v < 500).sort((a, b) => a - b)
  if (allowed.length === 0) return { html, changes: [] }

  /*
   * Nearest permitted, ties going to the smaller.
   *
   * Ties are real — 5px sits exactly between a scale of 3 and 7 — so the rule
   * has to be stated rather than left to whichever value the reduce happened to
   * see first. Downward, because a corner that is too round reads as a mistake
   * in a way that one which is too square does not, and because `allowed` is
   * sorted so "the first of the equally near" is always the smaller.
   */
  const nearest = (v: number): number =>
    allowed.reduce((best, cur) => (Math.abs(cur - v) < Math.abs(best - v) ? cur : best), allowed[0])

  const changes: SnapResult['changes'] = []

  /** One value list — `8px`, `8px 8px 0 0`, `0.5rem 0` — with each length snapped. */
  const snapValue = (value: string, where: 'token' | 'literal'): string =>
    value.replace(/([\d.]+)(px|rem)/g, (whole, n: string, unit: string) => {
      const px = Math.round(unit === 'rem' ? parseFloat(n) * 16 : parseFloat(n))
      // Pill, circle and square are shape decisions. Left alone, exactly as the
      // measurement leaves them.
      if (px <= 0 || px >= 500) return whole
      if (allowed.includes(px)) return whole
      const to = nearest(px)
      changes.push({ from: px, to, where })
      return `${to}px`
    })

  let out = html

  /*
   * The token declarations first, because they are where the leverage is: three
   * of them typically stand behind every rounded corner in the document.
   *
   * A declaration whose value is a `var()` reference is skipped — snapping it
   * would inline one token into another's definition and quietly break the
   * indirection the document was built on.
   */
  out = out.replace(
    /(--[\w-]*(?:radius|rounded|corner)[\w-]*\s*:\s*)([^;}\n]+)/gi,
    (whole, head: string, value: string) =>
      /var\(/.test(value) ? whole : head + snapValue(value, 'token')
  )

  /*
   * Then the literals still written at the point of use. The longhands are here
   * as well as the shorthand: `border-top-left-radius` is just as much a corner,
   * and a rewrite that missed them would leave a document the measurement also
   * misses — the two agreeing on a blind spot is worse than either having one.
   */
  out = out.replace(
    /(border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*)([^;}\n]+)/gi,
    (whole, head: string, value: string) =>
      /var\(/.test(value) ? whole : head + snapValue(value, 'literal')
  )

  return { html: out, changes }
}

/**
 * The properties a transition may safely sweep in place of `all`.
 *
 * Everything here is compositor-friendly or cheap; none of them force layout.
 * `all` was the most common transition in the corpus — 831 of 2,832
 * declarations, in 70% of documents — against prompts that have always said
 * opacity and transform only. So the instruction was there and nothing checked
 * it, which is the same shape the corner radii were in.
 */
const SAFE_TRANSITION_PROPERTIES = [
  'background-color',
  'color',
  'border-color',
  'box-shadow',
  'transform',
  'opacity',
]

/**
 * Brings a document's movement inside the system's contract, by substitution.
 *
 * The same discipline as `snapRadii`, for the same reason: a value the code can
 * rewrite never has to be argued with a model, and a model rewrite of a whole
 * document to fix a duration is the trade that got rejected for shortening the
 * file by 13%.
 *
 * Two rewrites, both pure substitutions:
 *
 *   `transition: all 120ms ease` becomes the same timing applied to the named
 *   properties above. The visible behaviour is a superset of what the author
 *   asked for minus the layout thrash, which is what `all` was reaching for.
 *
 *   A duration past the ceiling is clamped to it. Nothing is removed.
 *
 * What is NOT done: stripping `infinite`. A loading spinner needs it, a pulsing
 * badge does not, and nothing in the CSS tells them apart — so the contract does
 * not carry that rule rather than carrying one this cannot honour.
 */
export function snapMotion(html: string, motion: MotionContract): SnapResult {
  const changes: SnapResult['changes'] = []
  let out = html

  if (motion.namedPropertiesOnly) {
    /*
     * The token declarations first, and they are not an afterthought.
     *
     * The measurement runs on `normaliseCss`, which resolves `var()` — so a
     * `--transition-base: all 200ms` reads as `all` at every one of its uses
     * while the source at those uses says only `var(--transition-base)`. The
     * first version of this rewrote the uses and left two corpus documents
     * still reported, with 5 and 23 offences each, because every one of them
     * came through a token. Measured: 22 distinct motion tokens across the
     * corpus hold `all`.
     */
    out = out.replace(
      /(--[\w-]*(?:transition|motion)[\w-]*\s*:\s*)all\b([^;}\n]*)/gi,
      (_whole, head: string, rest: string) => {
        const timing = rest.trim()
        changes.push({ from: 0, to: 0, where: 'token' })
        return head + SAFE_TRANSITION_PROPERTIES.map((prop) => `${prop}${timing ? ' ' + timing : ''}`).join(', ')
      }
    )
    out = out.replace(
      /(transition\s*:\s*)all\b([^;}\n]*)/gi,
      (_whole, head: string, rest: string) => {
        const timing = rest.trim()
        changes.push({ from: 0, to: 0, where: 'literal' })
        return head + SAFE_TRANSITION_PROPERTIES.map((prop) => `${prop}${timing ? ' ' + timing : ''}`).join(', ')
      }
    )
  }

  const cap = motion.maxDurationMs
  if (cap) {
    out = out.replace(
      /((?:transition|animation)(?:-duration)?\s*:\s*)([^;}\n]+)/gi,
      (_whole, head: string, value: string) =>
        head +
        value.replace(/([\d.]+)(ms|s)\b/g, (span, n: string, unit: string) => {
          const ms = unit === 's' ? parseFloat(n) * 1000 : parseFloat(n)
          if (ms <= cap) return span
          changes.push({ from: Math.round(ms), to: cap, where: 'literal' })
          return `${cap}ms`
        })
    )
  }

  return { html: out, changes }
}

/**
 * How wide a shadow may be before it stops being elevation, and how strong a
 * TINTED one may be before it stops being a shadow.
 *
 * Both numbers replace tests that could not do their job.
 *
 * The blur test read `blur[2] > 12` over lengths matched as `([\d.]+)px`, so it
 * only saw a shadow whose offset-x also carried a unit. `0 8px 32px rgba(…)`
 * has two px lengths, `blur[2]` is undefined, and the comparison was false: in
 * 70 stored documents the test fired on none of the 120 shadows they contain.
 * The lengths are parsed in order now, unit or not. 12px is not restored with
 * it, because a threshold that never ran was never validated and enforcing it
 * as written flags 90 of those 120 — including the whole 16-24px cluster, which
 * is ordinary modal elevation. 24px is where the distribution's tail starts:
 * 32, 40, 44, 48, 60.
 *
 * The alpha test was the sharper failure. It exempted a tinted shadow whose
 * alpha matched `0?\.0?[0-9]` — a test of how many DIGITS were typed, not of
 * how strong the shadow is. `rgba(212, 175, 55, 0.6)` passed, a gold glow at
 * 60%, while `rgba(26, 24, 21, 0.12)` was a violation. Of 94 tinted shadows in
 * the corpus it exempted 65, most of them the decorative glow this rule exists
 * to catch, and the repair it did trigger was asked to fix shadows that were
 * already subtle — which is why those calls came back 「no improvement」.
 *
 * A neutral shadow is still unrestricted by alpha: black at 30% is elevation,
 * and colour at 30% is a glow. That asymmetry is the rule, and it was the one
 * thing the old test had right.
 */
const MAX_SUBTLE_BLUR_PX = 24
const MAX_TINTED_ALPHA = 0.25

/** The lengths of a shadow in order, whether or not the zero carries a unit. */
function shadowLengths(value: string): number[] {
  return [...value.matchAll(/(?:^|\s)(-?[\d.]+)(?:px|rem|em)?(?=\s|$|,)/g)].map((m) => parseFloat(m[1]))
}

/** Its alpha, or 1 when it is written in a form with none. */
function shadowAlpha(value: string): number {
  const rgba = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(value)
  if (rgba) return parseFloat(rgba[1])
  const hex8 = /#[0-9a-f]{6}([0-9a-f]{2})\b/i.exec(value)
  return hex8 ? parseInt(hex8[1], 16) / 255 : 1
}

/** Whether a shadow reads as decoration rather than as elevation. */
export function isDecorativeShadow(value: string): boolean {
  const lengths = shadowLengths(value)
  const blur = lengths.length >= 3 ? lengths[2] : lengths.length === 2 ? lengths[1] : 0
  if (blur > MAX_SUBTLE_BLUR_PX) return true
  const tinted = /rgba?\((?!\s*0\s*,\s*0\s*,\s*0)/.test(value)
  return tinted && shadowAlpha(value) > MAX_TINTED_ALPHA
}

/*
 * The prose files are cut out before anything is measured.
 *
 * Every generated project carries docs/design-guidelines.md, and that file is
 * this ban list restated for the app — 「禁止: インディゴ・バイオレット系（#6366f1、
 * #8b5cf6、#7c3aed、#a855f7）」. `normaliseCss` does not extract CSS; it resolves
 * var() across the whole document and hands it back, markdown included. So the
 * document was being marked in violation for carrying the rule that forbids the
 * thing, and no repair could ever clear it: fixing it would mean editing the
 * file that says not to do it.
 *
 * Measured over 53 stored project documents, three had a violation that existed
 * only in their prose — including the run of 2026-09-04 that found this, where
 * `#6366f1` appears exactly once in the whole project and it is inside the ban
 * list. That run spent a stylesheet repair call on it and shipped with the
 * violation still standing, because there was nothing in the stylesheet to fix.
 *
 * `design-audit.ts` was fixed for exactly this and its comment describes the
 * same failure. This file never got the same treatment.
 */
export function measureConformance(html: string, sig: PresetSignature): ConformanceResult {
  const css = withoutFoundation(normaliseCss(withoutProse(html)))
  const lower = css.toLowerCase()
  const details: string[] = []

  const missing = sig.required.filter((tok) => !lower.includes(tok.toLowerCase()))
  if (missing.length) details.push(`必須値が不足: ${missing.join(', ')}`)

  /**
   * A forbidden pattern that fires has to say what it found.
   *
   * This was `filter(...).length` — it counted the violation and pushed no
   * detail. `details` is the entire content of the repair pass's instruction, so
   * a document whose only fault was a forbidden pattern was handed to a model
   * under the heading 「検出された逸脱（これらを直してください）」 with nothing beneath
   * it. The repair could not act, and the pass ran on every such generation.
   *
   * Reporting the matched text also makes the finding checkable: `#8b5cf6` names
   * the thing to replace, where "a forbidden pattern matched" does not.
   */
  let violations = 0
  for (const re of sig.forbidden ?? []) {
    const hit = re.exec(css)
    if (!hit) continue
    violations++
    details.push(
      `使用が禁止されている値が含まれています: ${hit[0]}。この製品のドメインから選んだ` +
        `アクセント色に置き換え、custom property 経由で参照してください`
    )
  }

  // --- palette dominance ------------------------------------------------
  let paletteShare = 1
  if (sig.palette?.length) {
    const allowed = new Set(sig.palette.map((c) => c.toUpperCase()))
    let on = 0
    let off = 0
    const offenders = new Map<string, number>()
    for (const m of css.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const hex = `#${m[1].toUpperCase()}`
      if (allowed.has(hex) || isNeutral(hex)) on++
      else {
        off++
        offenders.set(hex, (offenders.get(hex) ?? 0) + 1)
      }
    }
    const total = on + off
    paletteShare = total ? on / total : 1
    // 0.8 sits clear of measured good output (0.89-1.00) while still catching a
    // page that has drifted to its own palette.
    if (paletteShare < 0.8) {
      violations++
      const worst = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h]) => h)
      details.push(`システム外の色が多用されています (${worst.join(', ')})。定義済みトークンに置き換えてください`)
    }
  }

  /*
   * --- corner radius ---------------------------------------------------
   *
   * The value capture stops at a newline, and that is not a detail.
   *
   * It was `[^;}]+`, which spans lines — so in the design specification the
   * project carries as prose, a single `border-radius: 4px` swallowed every
   * line after it until the next `;` or `}`. Measured across the corpus, that
   * turned spacing scales and font sizes into reported radii: 「角丸が仕様外:
   * 1px, 12px, 16px, 24px, 48px, 56px」 on a document whose CSS used 4px and 8px
   * throughout. Every value capture below has the same fix for the same reason.
   */
  if (sig.radii) {
    const used = new Set<number>()
    for (const m of css.matchAll(/border-radius\s*:\s*([^;}\n]+)/gi)) {
      for (const p of m[1].matchAll(/([\d.]+)px/g)) {
        const v = Math.round(parseFloat(p[1]))
        // Pill shapes are a shape choice, not a scale violation.
        if (v > 0 && v < 500) used.add(v)
      }
    }
    const off = [...used].filter((v) => !sig.radii!.includes(v)).sort((a, b) => a - b)
    if (off.length) {
      violations++
      details.push(`角丸が仕様外: ${off.map((v) => `${v}px`).join(', ')} (許容: ${sig.radii.map((v) => `${v}px`).join(', ')})`)
    }
  }

  // --- motion -----------------------------------------------------------
  if (sig.motion) {
    if (sig.motion.namedPropertiesOnly) {
      const alls = [...css.matchAll(/transition\s*:\s*all\b[^;}\n]*/gi)].length
      if (alls > 0) {
        violations++
        details.push(
          `transition: all を ${alls} 箇所で使用しています。レイアウトプロパティまで遷移対象になるため、` +
            '変化するプロパティを明示してください（background-color, color, border-color, transform, opacity）'
        )
      }
    }
    const cap = sig.motion.maxDurationMs
    if (cap) {
      const over = new Set<number>()
      for (const m of css.matchAll(/(?:transition|animation)(?:-duration)?\s*:\s*([^;}\n]+)/gi)) {
        for (const d of m[1].matchAll(/([\d.]+)(ms|s)\b/g)) {
          const value = d[2] === 's' ? parseFloat(d[1]) * 1000 : parseFloat(d[1])
          if (value > cap) over.add(Math.round(value))
        }
      }
      if (over.size > 0) {
        violations++
        details.push(
          `動きの長さが仕様外: ${[...over].sort((a, b) => a - b).map((v) => `${v}ms`).join(', ')}` +
            `（上限 ${cap}ms）。この上限まで短くしてください`
        )
      }
    }
  }

  // --- elevation --------------------------------------------------------
  if (sig.elevation && sig.elevation !== 'any') {
    const squash = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
    const published = new Set((sig.shadows ?? []).map(squash))
    const decorative: string[] = []
    for (const m of css.matchAll(/box-shadow\s*:\s*([^;}\n]+)/gi)) {
      const value = m[1].trim()
      if (/^none$/i.test(value) || isFocusRing(value)) continue
      if (published.has(squash(value))) continue
      if (sig.elevation === 'none') {
        decorative.push(value)
      } else if (isDecorativeShadow(value)) {
        decorative.push(value)
      }
    }
    if (decorative.length) {
      violations++
      details.push(
        sig.elevation === 'none'
          ? `影を使わない仕様ですが ${decorative.length} 箇所で使われています: ${decorative[0]}`
          : `影が強すぎます (${decorative.length} 箇所): ${decorative[0]}`
      )
    }
  }

  // --- typography -------------------------------------------------------
  if (sig.font) {
    const stacks = [...css.matchAll(/font-family[\w-]*\s*:\s*([^;}\n]+)/gi)].map((m) => m[1])
    const declared = stacks.length > 0
    const onSystem = stacks.some((s) => s.toLowerCase().includes(sig.font!.toLowerCase()))
    if (declared && !onSystem) {
      violations++
      details.push(`書体が仕様外です。${sig.font} を基本フォントに使用してください`)
    }
  }

  return {
    // A system with nothing required is fully satisfied, not zero — `none`
    // declares no anchors and would otherwise trigger a repair on every run.
    ratio: sig.required.length === 0 ? 1 : (sig.required.length - missing.length) / sig.required.length,
    missing,
    violations,
    paletteShare,
    details,
  }
}
