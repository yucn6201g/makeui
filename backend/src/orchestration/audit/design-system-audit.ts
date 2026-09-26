import { readProjectFiles } from '../../tools/project/project-transport.js'
import { withoutProse, type InteractionDefect } from './interaction-audit.js'
import { withUsedFoundationTokens } from '../presets/preset-conformance.js'

/**
 * Whether the document was designed from a system, or assembled value by value.
 *
 * The existing audits catch *tells* — emoji, indigo defaults, gradient headlines,
 * glass navbars. Removing every one of them still leaves output that reads as
 * machine-made, because the tells are symptoms. What a designer actually brings is
 * a small set of decisions applied everywhere: a handful of type sizes, spacing on
 * one grid, one accent against one neutral ramp, two or three radii. Generated work
 * makes each of those decisions locally and afresh, so the page ends up with
 * nineteen font sizes and forty colours, none of them wrong on their own and no two
 * of them agreeing.
 *
 * That is measurable, and it is the difference the eye reads as "designed". Nothing
 * here looks at whether a feature is present — the old score was almost entirely
 * presence checks, which is why it sat at its ceiling for every run.
 *
 * Every threshold below is deliberately loose. A false positive costs a full repair
 * call, so the bands are set where a careful designer would already be outside them,
 * not where taste begins.
 */

interface DesignSystemMetrics {
  /**
   * Whether a stylesheet was found at all. False means every number below is
   * meaningless and the document must be left out of the coherence score rather
   * than scored zero by it.
   */
  measurable: boolean
  /** Distinct font-size values, resolved through custom properties. */
  typeSteps: number
  /** Those values in px, smallest first — what a scale has to be built from. */
  typeSizes: number[]
  /** Distinct spacing values used for padding / margin / gap. */
  spacingSteps: number
  /** Fraction of spacing values that sit on a 4px grid. */
  spacingOnGrid: number
  /** Distinct colours, counting a hex and its rgb() equivalent once. */
  colours: number
  /**
   * Colours written into a rule rather than declared in `:root`, most used
   * first. These are the ones a palette reduction has to replace.
   *
   * `token` is the custom property already declared with that exact value, when
   * there is one. A literal that has a token is not a palette decision at all —
   * it is the same decision typed out a second time, and the repair for it is a
   * substitution rather than a judgement.
   */
  looseColours: { hex: string; uses: number; token?: string; files: string[] }[]
  /**
   * Colours close enough to another colour to be the same decision typed twice.
   *
   * `colours` counts distinct VALUES in the stylesheet, and this is the only
   * thing that reduces it. Replacing a literal with the token that holds the
   * same value — which is what `palette-size` used to ask for — cannot: the
   * value is still declared in `:root`, and it was only ever counted once.
   * Measured on five documents where the defect fires, applying every
   * substitution the instruction named moved the count by zero on all five.
   *
   * Merging these does move it: 45 to 38, 33 to 28, 35 to 28, and two of the
   * five drop below the threshold outright. `keep` is the colour that has a
   * token, or the first seen; `merge` are the ones within `NEAR_COLOUR` of it.
   */
  nearDuplicates: { keep: string; merge: { hex: string; distance: number }[] }[]
  /** Files holding colour literals outside `:root`, most first. */
  literalFiles: { path: string; uses: number }[]
  /** Distinct non-zero border-radius values. */
  radii: number
  /** Custom properties declared in the document. */
  tokensDeclared: number
  /** How often declarations reference a token rather than repeating a literal. */
  tokenAdoption: number
  /** Distinct font-weight values. */
  weights: number
}

/** 6-digit lowercase hex for a hex or rgb() literal; null for anything else. */
function normaliseHex(value: string): string | null {
  const v = value.trim()
  const h = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)
  if (h) {
    const d = h[1]
    return (d.length === 3 ? d.split('').map((c) => c + c).join('') : d).toLowerCase()
  }
  const r = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v)
  if (r) return [r[1], r[2], r[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toLowerCase()
  return null
}

/**
 * Colour literals written outside `:root`, counted by normalised hex.
 *
 * Shadow colours are cut out first. `rgba(0, 0, 0, 0.08)` under a card is not a
 * palette decision that got typed twice — it is the shadow, and it is written
 * as a literal by people too. Left in, it was 5.5% of every loose literal in
 * the 597-document corpus and, because it concentrates on one value, it rose
 * to the top of the "no matching token" list and pushed real colours off it.
 */
/**
 * How close two colours have to be before they are one decision typed twice.
 *
 * Euclidean distance in RGB, and 12 is where the corpus separates: at that
 * threshold the pairs it finds are #f9fafb against #f3f4f6 and #fafaf8 against
 * #ffffff — the same near-white written twice — and nothing a designer chose
 * apart. Raising it starts merging colours that differ on purpose.
 */
const NEAR_COLOUR = 12

function rgbOf(hex: string): [number, number, number] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function colourDistance(a: string, b: string): number {
  const x = rgbOf(a)
  const y = rgbOf(b)
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2)
}

/**
 * The colours that could be merged, and into what.
 *
 * Greedy and deliberately so: a colour joins the first group whose head is
 * within `NEAR_COLOUR`, and a group's head is preferred to be one that already
 * has a token, because a declared token is the decision the others are copies
 * of. Anything cleverer would be a clustering choice presented as a fact.
 */
function groupNearDuplicates(
  colours: string[],
  tokenByColour: Map<string, string>
): { keep: string; merge: { hex: string; distance: number }[] }[] {
  /*
   * Which colour survives a merge, in order of how much of a decision it is.
   *
   * White and black first: an off-white sitting nine units from #ffffff is the
   * copy, and merging the other way round takes pure white out of the document
   * to keep a value nobody chose. Then a colour that already has a token, for
   * the same reason — a declared token is the decision its neighbours are
   * copies of.
   */
  const rank = (hex: string): number =>
    (hex === 'ffffff' || hex === '000000' ? 2 : 0) + (tokenByColour.has(hex) ? 1 : 0)
  const ordered = [...colours].sort((a, b) => rank(b) - rank(a))
  const groups: { head: string; merge: { hex: string; distance: number }[] }[] = []
  for (const hex of ordered) {
    const near = groups.find((g) => colourDistance(g.head, hex) < NEAR_COLOUR)
    if (near) near.merge.push({ hex: `#${hex}`, distance: Math.round(colourDistance(near.head, hex)) })
    else groups.push({ head: hex, merge: [] })
  }
  return groups.filter((g) => g.merge.length > 0).map((g) => ({ keep: `#${g.head}`, merge: g.merge }))
}

/**
 * The stylesheet with its token declarations removed.
 *
 * A value written in `:root` is the decision; the same value typed into a rule
 * is a copy of it. Every measurement that asks 「is this a token or a copy」 has
 * to cut the declarations out first, and there is one way to do it so the
 * measurements cannot disagree about what a declaration is.
 */
function withoutRootBlocks(css: string): string {
  return css.replace(/:root\s*\{[^}]*\}/gi, '')
}

function looseColoursIn(css: string): Map<string, number> {
  const outsideRoot = withoutRootBlocks(css)
    .replace(/(?:box|text)-shadow\s*:[^;{}]+/gi, '')
  const found = new Map<string, number>()
  const note = (hex: string) => found.set(hex, (found.get(hex) ?? 0) + 1)
  for (const m of outsideRoot.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const hex = normaliseHex(m[0])
    if (hex) note(hex)
  }
  for (const m of outsideRoot.matchAll(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/gi)) {
    const hex = normaliseHex(m[0])
    if (hex) note(hex)
  }
  return found
}

/**
 * The same CSS `stylesheet()` measures, but kept per file.
 *
 * Attribution only — every metric still comes from the joined text, so this
 * cannot move a number. What it buys is the difference between "22% of your
 * colours reference a token" and "these four literals in these two files are
 * the ones to replace, and here is the token each already has".
 */
function styleSources(doc: string): { path: string; css: string }[] {
  const out: { path: string; css: string }[] = []
  for (const [path, body] of readProjectFiles(doc)) {
    if (path.endsWith('.css')) {
      out.push({ path, css: body })
      continue
    }
    // A component's own <style> block — Vue SFC and Svelte keep theirs here.
    const blocks = [...body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n')
    if (blocks.trim()) out.push({ path, css: blocks })
  }
  return out
}

/**
 * Declared colour tokens, keyed by the colour they hold.
 *
 * A token whose value is itself a `var()` is skipped: the alias is not the
 * literal's home, the thing it points at is.
 */
function colourTokens(doc: string): Map<string, string> {
  const byColour = new Map<string, string>()
  for (const m of doc.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const hex = normaliseHex(m[2])
    if (hex && !byColour.has(hex)) byColour.set(hex, m[1])
  }
  return byColour
}

/** Declarations of a property, with `var()` resolved against the document. */
function declaredValues(css: string, property: RegExp, resolve: (v: string) => string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(property)) {
    const value = resolve(m[1] ?? '')
      .trim()
      .replace(/\s*!important\s*$/i, '')
    if (value) out.push(value)
  }
  return out
}

function makeResolver(doc: string): (value: string) => string {
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

/** px for a literal length; null for a percentage, a calc, or anything unresolved. */
function toPx(value: string): number | null {
  const m = /^(-?[\d.]+)(px|rem|em)$/.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] === 'px' ? n : n * 16
}

/**
 * Style blocks only.
 *
 * Measuring the whole document would count colours inside chart data and inline
 * SVG artwork, where a dozen distinct fills is correct rather than careless.
 *
 * Returns an empty string when there is nothing to measure — deliberately, rather
 * than falling back to the whole document. That fallback was here, and what it
 * produced was not a measurement: reading a React project's JSX as if it were CSS
 * gave 0 type steps, 0 tokens and a scattering of SVG fills, which scored 0.43 out
 * of 1 and quietly took ~9 points off the total. No defect was raised, because no
 * threshold was crossed — the document simply lost points for a stylesheet the
 * parser had failed to find. An unmeasurable document must be excluded from the
 * measurement, not scored badly by it.
 */
function stylesheet(doc: string): string {
  /**
   * Read through the transport first, and only then look for raw tags.
   *
   * This was two regexes over the document — <style> blocks, and <script
   * data-file="….css"> blocks — and a project stylesheet now lives inside a
   * whole-line fence, which is neither. So this returned the empty string for
   * every project the product currently makes,  came back false, and
   * the ENTIRE design-system audit switched itself off: type scale, spacing grid,
   * colour count, radii and token adoption, none of them measured, on the output
   * whose selling point is design quality.
   *
   * It failed in the quietest possible direction, too. The module deliberately
   * treats "unmeasurable" as "do not judge" rather than "judge harshly", so a
   * document nothing could read looked exactly like a document with nothing
   * wrong with it.
   */
  const fromFiles = [...readProjectFiles(doc).entries()]
    .filter(([path]) => path.endsWith('.css'))
    .map(([, body]) => body)
  const blocks = [...doc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  return [...fromFiles, ...blocks].join('\n').trim()
}

const UNMEASURABLE: DesignSystemMetrics = {
  measurable: false,
  typeSteps: 0,
  typeSizes: [],
  spacingSteps: 0,
  spacingOnGrid: 1,
  colours: 0,
  looseColours: [],
  nearDuplicates: [],
  literalFiles: [],
  radii: 0,
  tokensDeclared: 0,
  tokenAdoption: 0,
  weights: 0,
}

export function measureDesignSystem(html: string): DesignSystemMetrics {
  // A design system's token block counts only for the tokens the project uses — see
  // withUsedFoundationTokens for the palette-size it raised otherwise.
  const doc = withUsedFoundationTokens(withoutProse(html))
  const css = stylesheet(doc)
  if (!css) return UNMEASURABLE
  const resolve = makeResolver(doc)

  const sizes = new Set<number>()
  for (const v of declaredValues(css, /font-size\s*:\s*([^;{}]+)/gi, resolve)) {
    // clamp()/calc() are a deliberate fluid step, not a stray size — one entry each.
    if (/clamp\(|calc\(/i.test(v)) { sizes.add(-1); continue }
    const px = toPx(v)
    if (px !== null) sizes.add(Math.round(px * 100) / 100)
  }

  const spacing: number[] = []
  for (const v of declaredValues(
    css,
    /(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|block|inline))?\s*:\s*([^;{}]+)/gi,
    resolve
  )) {
    for (const part of v.split(/\s+/)) {
      const px = toPx(resolve(part))
      if (px !== null && px > 0) spacing.push(px)
    }
  }
  const spacingSet = new Set(spacing)
  const onGrid = spacing.length ? spacing.filter((n) => n % 4 === 0).length / spacing.length : 1

  const colours = new Set<string>()
  for (const m of css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
    colours.add(hex.toLowerCase())
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
    const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    colours.add(hex.toLowerCase())
  }

  /**
   * The colours written straight into a rule, rather than declared as a token.
   *
   * `palette-size` used to say "you have 29 colours, reduce to an accent, a
   * neutral ramp and semantic colours" and stop there — a description of the
   * destination with nothing about the route. It has been open on Vue and
   * Svelte in every round.
   *
   * These are the ones to act on. A colour declared once in `:root` and used
   * through `var()` is a decision; the same value typed into a component rule is
   * a copy of a decision, and the copies are what pushes the count past the
   * threshold. Naming them turns "reduce your palette" into a list of literals
   * to replace.
   *
   * `:root` blocks are cut out rather than parsed: the question is only whether
   * a literal sits inside the token declarations or outside them.
   */
  const loose = looseColoursIn(css)
  const tokenByColour = colourTokens(doc)
  const nearDuplicates = groupNearDuplicates([...colours], tokenByColour)
  const holders = new Map<string, Set<string>>()
  const perFile = new Map<string, number>()
  for (const { path, css: body } of styleSources(doc)) {
    let n = 0
    for (const [hex, uses] of looseColoursIn(body)) {
      if (!holders.has(hex)) holders.set(hex, new Set())
      holders.get(hex)!.add(path)
      n += uses
    }
    if (n > 0) perFile.set(path, n)
  }
  const looseColours = [...loose.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex, n]) => ({
      hex: `#${hex}`,
      uses: n,
      token: tokenByColour.get(hex),
      files: [...(holders.get(hex) ?? [])].sort(),
    }))
  const literalFiles = [...perFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([path, uses]) => ({ path, uses }))

  const radii = new Set<number>()
  for (const v of declaredValues(css, /border-radius\s*:\s*([^;{}]+)/gi, resolve)) {
    for (const part of v.split(/[\s/]+/)) {
      const px = toPx(resolve(part))
      // 9999px/50% pills are one decision however often they appear.
      if (px !== null && px > 0 && px < 100) radii.add(Math.round(px))
    }
  }

  const weights = new Set<string>()
  for (const v of declaredValues(css, /font-weight\s*:\s*([^;{}]+)/gi, resolve)) weights.add(v)

  const tokensDeclared = new Set([...doc.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])).size
  const varUses = (css.match(/var\(\s*--/g) ?? []).length
  /*
   * Literals OUTSIDE the token declarations, because a declaration is not a
   * failure to adopt.
   *
   * This counted every hex and rgba() in the stylesheet, `:root` included, so
   * each token a document declared added one to the denominator: it was charged
   * for the exact thing the finding asks it to do. Measured over 73 stored
   * documents, five fired and three of them were declarations and nothing else —
   *
   *   d61  16 tokens, 32 literals, ALL 32 inside :root, none outside.  24% -> 100%
   *   d51  22 tokens, 30 of 32 inside :root.                           20% ->  80%
   *   d29  32 tokens, 36 of 40 inside :root.                           29% ->  80%
   *
   * — three documents using tokens and nothing else, told they were not using
   * them. The two that keep firing have 166 and 157 loose literals, which is
   * what this was always for.
   */
  const colourLiterals = (withoutRootBlocks(css).match(/#[0-9a-f]{3,6}\b|rgba?\(/gi) ?? []).length
  const tokenAdoption = varUses + colourLiterals > 0 ? varUses / (varUses + colourLiterals) : 1

  return {
    measurable: true,
    typeSteps: sizes.size,
    typeSizes: [...sizes].filter((n) => n > 0).sort((a, b) => a - b),
    spacingSteps: spacingSet.size,
    spacingOnGrid: onGrid,
    colours: colours.size,
    nearDuplicates,
    looseColours,
    literalFiles,
    radii: radii.size,
    tokensDeclared,
    tokenAdoption,
    weights: weights.size,
  }
}

/**
 * 0..1, how much of the document reads as one system.
 *
 * Each band is scored on its own so a document cannot trade a coherent palette
 * against chaotic spacing. The bands are wide in the middle: there is no single
 * right number of type steps, only a range outside which something has gone wrong.
 */
export function designSystemScore(m: DesignSystemMetrics): number | null {
  // null, not 0: the caller must leave this out of the rubric entirely rather
  // than award it nothing. See `stylesheet()`.
  if (!m.measurable) return null
  const band = (value: number, good: [number, number], tolerated: [number, number]): number => {
    if (value >= good[0] && value <= good[1]) return 1
    if (value >= tolerated[0] && value <= tolerated[1]) return 0.6
    return 0.2
  }

  const parts = [
    band(m.typeSteps, [4, 9], [3, 13]),
    band(m.spacingSteps, [4, 12], [3, 18]),
    band(m.colours, [6, 18], [4, 26]),
    band(m.radii, [1, 3], [1, 5]),
    band(m.weights, [2, 4], [1, 5]),
    m.spacingOnGrid >= 0.85 ? 1 : m.spacingOnGrid >= 0.7 ? 0.6 : 0.2,
    m.tokenAdoption >= 0.6 ? 1 : m.tokenAdoption >= 0.35 ? 0.6 : 0.2,
  ]
  return parts.reduce((a, b) => a + b, 0) / parts.length
}

/**
 * Findings a repair pass can act on.
 *
 * Only the outer band produces a defect. The tolerated band is left alone on
 * purpose: it is the range where reasonable documents live, and spending a model
 * call to move a document from acceptable to ideal is how an audit turns into a
 * tax on every run.
 *
 * Each instruction quotes the number that was measured, because a repair told
 * "unify the type scale" has to guess what it is being asked to change, and a
 * repair that guesses gets rejected for no improvement.
 */
export function auditDesignSystem(html: string): InteractionDefect[] {
  const m = measureDesignSystem(html)
  // Nothing to say about a document whose styles could not be located. Reporting
  // it would send a repair pass after a problem that may not exist.
  if (!m.measurable) return []
  const defects: InteractionDefect[] = []

  if (m.typeSteps > 13) {
    /*
     * The sizes, not the number of them.
     *
     * "文字サイズが 18 種類あります" is a count, and a repair told to unify a
     * scale has to go and find the eighteen values first. They were measured to
     * produce that number — printing them turns the finding into a list of
     * substitutions, the same move that made `palette-size` actionable.
     */
    const sizes = m.typeSizes.map((n) => `${Math.round(n * 10) / 10}px`)
    defects.push({
      id: 'type-scale',
      instruction:
        `文字サイズが ${m.typeSteps} 種類あります。これは設計ではなく都度の判断の積み重ねです。` +
        (sizes.length ? `\n実際に使われているのは ${sizes.join(' / ')} です。` : '') +
        '\n5〜7段階のタイプスケールを決めて custom property として宣言し、すべての font-size を' +
        'そのいずれかに置き換えてください（例: 12 / 14 / 16 / 20 / 24 / 32 / 48px）。' +
        '近い値どうし（13px と 14px、15px と 16px など）は必ず1つに寄せてください。' +
        '階層はサイズだけでなくウェイトと余白でも表現してください。',
    })
  }

  if (m.spacingSteps > 18) {
    defects.push({
      id: 'spacing-scale',
      instruction:
        `余白の値が ${m.spacingSteps} 種類あります。4px グリッドの間隔スケール` +
        '（4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px）を custom property として宣言し、' +
        'padding・margin・gap をすべてそのいずれかに置き換えてください。',
    })
  } else if (m.spacingOnGrid < 0.7) {
    const pct = Math.round(m.spacingOnGrid * 100)
    defects.push({
      id: 'spacing-grid',
      instruction:
        `余白の ${pct}% しか4pxグリッドに乗っていません。padding・margin・gap を 4 の倍数に` +
        '揃えてください。半端な値（13px, 27px など）は最も近いグリッド値に丸めます。',
    })
  }

  if (m.colours > 26) {
    /*
     * The literals to replace, not just the count.
     *
     * A colour declared once in `:root` and used through `var()` is a decision;
     * the same value typed into a component rule is a copy of one, and the
     * copies are what push the count past the threshold. The instruction used
     * to describe the destination and leave the route to be worked out, and it
     * stayed open on Vue and Svelte in every round.
     */
    /*
     * The list names what would actually reduce the count.
     *
     * It used to name the loose literals that exactly match a declared token,
     * with 「そのまま置き換えてください」 beside them. Those substitutions are real
     * and worth making — and they cannot move this number. `colours` counts
     * distinct VALUES in the stylesheet, and a literal equal to a token is the
     * same value already counted once at its declaration, so replacing it
     * changes nothing. Measured on the five corpus documents where this fires:
     * applying every substitution the instruction named moved the count by zero
     * on all five, and left `loose` at 30 -> 10 on one of them. A model doing
     * exactly as told could not clear it, which is what 0 fixed of 19 was.
     *
     * They belong to `token-adoption`, which measures the ratio they DO move,
     * and which already lists them. Repeating them here was the duplication that
     * made this defect unactionable.
     *
     * What reduces a count of distinct values is merging values, so the pairs
     * close enough to be one decision are named instead: 45 -> 39, 33 -> 28,
     * 35 -> 29 on those same documents, and two of the five drop under the
     * threshold outright. The rest is a smaller palette, which is a judgement,
     * and it is asked for in those words rather than dressed as a substitution.
     */
    const merges = m.nearDuplicates.slice(0, 6)
    const mergeable = merges.reduce((n, g) => n + g.merge.length, 0)
    defects.push({
      id: 'palette-size',
      instruction:
        `色が ${m.colours} 種類使われています。アクセント1色（と、その濃淡2〜3段）、` +
        'ニュートラル1系統（5〜6段）、意味色（成功・警告・エラー）だけに絞ってください。' +
        (mergeable
          ? `\n次の色はほぼ同じ値です。左に寄せれば ${mergeable} 色減ります: ` +
            merges
              .map((g) => `${g.merge.map((x) => x.hex).join('・')} → ${g.keep}`)
              .join('、') +
            '。'
          : '') +
        (m.colours - mergeable > 26
          ? `\nそれでも ${m.colours - mergeable} 色残ります。残りは似ていない色なので、` +
            'どの色をやめるかを決めて減らしてください。' +
            'custom property として宣言し、全体をそこから参照します。'
          : '') +
        (m.literalFiles.length
          ? '\n書き換える対象は ' +
            m.literalFiles.slice(0, 4).map((f) => `${f.path}（${f.uses}箇所）`).join('、') +
            ' です。'
          : ''),
      paths: m.literalFiles.slice(0, 4).map((f) => f.path),
    })
  }

  if (m.radii > 5) {
    defects.push({
      id: 'radius-scale',
      instruction:
        `角丸が ${m.radii} 種類あります。2〜3種類（小: コントロール、中: カード、` +
        '完全な丸: アバターやピル）に統一し、custom property として宣言してください。',
    })
  }

  if (m.tokensDeclared >= 8 && m.tokenAdoption < 0.35) {
    /*
     * The substitutions, not the percentage.
     *
     * "35 個宣言しているのに 22% しか参照していません" is a true sentence that
     * nothing can act on: it names no literal, no token and no file, so the
     * repair has to re-derive all three from a document it is seeing for the
     * first time. It reads as a grade rather than a request, and it has stayed
     * open in every round it appeared in.
     *
     * Most of the work is already decided. A literal that matches a declared
     * token exactly is the same decision typed twice — the repair for it is a
     * substitution, and we can write the substitution out. What is left after
     * those is the small set that genuinely needs a judgement, and saying so
     * separates the two kinds of work instead of presenting them as one.
     */
    const pct = Math.round(m.tokenAdoption * 100)
    const known = m.looseColours.filter((c) => c.token).slice(0, 8)
    const unknown = m.looseColours.filter((c) => !c.token).slice(0, 6)
    const where = m.literalFiles.slice(0, 4)
    defects.push({
      id: 'token-adoption',
      paths: m.literalFiles.slice(0, 4).map((f) => f.path),
      instruction:
        `custom property を ${m.tokensDeclared} 個宣言しているのに、色の指定のうち ` +
        `${pct}% しかそれを参照していません。宣言だけして使わないトークンは設計になりません。` +
        (known.length
          ? '\n次の色は、宣言済みのトークンとまったく同じ値です。リテラルを var() に置き換えてください: ' +
            known.map((c) => `${c.hex} → var(${c.token})`).join('、') +
            '。'
          : '') +
        (unknown.length
          ? '\n対応するトークンがない色: ' +
            unknown.map((c) => `${c.hex}（${c.uses}箇所）`).join('、') +
            '。近いトークンに寄せるか、:root にトークンを足してそこから参照してください。'
          : '') +
        (where.length
          ? '\n書き換える対象は ' +
            where.map((f) => `${f.path}（${f.uses}箇所）`).join('、') +
            ' です。'
          : ''),
    })
  }

  return defects
}
