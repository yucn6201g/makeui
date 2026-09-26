/**
 * How good the generated thing is, as a number.
 *
 * Four scorers and the rubric they share: `scoreProject` for a multi-file app,
 * `scoreHtml` for a single page, `scoreRuntime` for what a browser found when
 * it actually opened the result, and `Rubric` — the accumulator that keeps a
 * score honest by making every deduction name itself.
 *
 * Split out of graph.ts, where it was 597 lines wedged between the prompts
 * above it and the pipeline below. It reads nothing the pipeline declares: the
 * measurement below was that this block depends on ZERO of graph.ts's own
 * declarations, only on other modules, which is what made the move a move.
 *
 * `withoutRoutingChanges` and `isRoutingFile` live here because they exist for
 * the scorers: a change that only touches routing is not the change the score
 * is being asked about.
 */
import { readProjectFiles, writeProjectFile } from '../../tools/project/project-transport.js'
import { detectKind } from '../../tools/project/framework-compile.js'
import { countScreens, hasLoginGate, hasVisibleDemoCredentials } from './interaction-audit.js'
import { renderedFrom } from '../../tools/fixups/artwork.js'
import { DEFAULT_OUTPUT_KIND, FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import { countEmoji } from './design-audit.js'
import { designSystemScore, measureDesignSystem } from './design-system-audit.js'
import { hasPresetSignature, presetConformance } from '../presets/design-presets.js'

/**
 * React output is a project, not a page — the markup heuristics below (landmark
 * tags, media queries, keyframe counts) don't describe it. Score the things that
 * actually make a generated app usable: file decomposition, shared state, routing
 * and wired-up interactions.
 */
function scoreProject(
  html: string,
  outputKind: OutputKind,
  presetName?: string,
  runtime?: ScoreRuntime,
  out?: { runtime: Mark; whole: Mark }
): number {
  const fw = FRAMEWORKS[outputKind]
  const r = new Rubric()
  if (runtime) scoreRuntime(r, runtime)
  /*
   * Everything above is what a browser found; everything below is the contract.
   * The boundary is here rather than on each check because the runtime terms all
   * run in one function, first — see `Rubric.mark`.
   */
  if (out) out.runtime = r.mark()
  /**
   * Read through the transport, not through one transport's syntax.
   *
   * This was `html.matchAll(/data-file="([^"]+)"/g)` — the attribute React
   * projects travelled in before components carrying their own `<script>` forced
   * the move to whole-line fences. Nothing has emitted it since, so `paths` was
   * EMPTY on every scored project, and every award below that asks a question
   * about the file layout silently failed.
   *
   * That is 62 points of this rubric plus the 18-point file-count partial: 80 of
   * 100 unreachable by construction. A real, complete, nine-screen project with
   * icons, illustrations, a store and a router scored 30 — and the number was
   * shown to the user as a judgement about their UI.
   *
   * The fourth detector today left behind by the transport change, after the
   * project-kind badge, the virtual filesystem and the editability guard. They
   * all failed the same way: silently, and in the direction that looks like a
   * quality problem rather than a plumbing one.
   */
  const files = readProjectFiles(html)
  const paths = [...files.keys()]
  const has = (re: RegExp) => paths.some((p) => re.test(p))

  r.gate(paths.length >= 9, 18)   // measured: every project has at least nine

  // Required layout — each slot the contract names. Screens, reusable components,
  // icons and artwork are separate directories now, so each is measured separately:
  // the previous single components/ folder scored the same whether the project had
  // real decomposition or one bucket of files.
  r.award(has(/^docs\/design-guidelines\.md$/), 4)
  r.gate(paths.includes(fw.entry), 4)
  r.gate(paths.includes(`src/App${fw.componentExt}`), 4)
  r.gate(paths.includes(fw.routesFile), 6)
  r.gate(paths.some((p) => /^src\/(hooks|composables|lib)\//.test(p)), 3)
  r.gate(paths.some((p) => /^src\/store\//.test(p)), 4)
  r.award(has(/^src\/lib\//), 3)
  r.gate(has(/^src\/screens\//), 5)
  r.award(has(/^src\/components\/ui\//), 4)
  /*
   * Scored once. This folder was awarded 5 here and deducted 8 below as a
   * "required folder missing", so its absence moved the number by 13 of a
   * 176-point scale — measured firing on 11 of 45 documents. One fact, one
   * term; the deduction is gone.
   */
  r.award(has(/^src\/components\/icons\//), 5)
  r.award(has(/^src\/data\//), 3)
  // Icons must come from inline SVG components, not emoji glyphs.
  const svgCount = (html.match(/<svg\s/g) || []).length
  r.partial(svgCount >= 8 ? 6 : svgCount >= 3 ? 3 : 0, 6)
  r.award(/viewBox="0 0 24 24"/.test(html) && /stroke="currentColor"/.test(html), 3)
  r.gate(has(/^src\/styles\/globals\.css$/), 2)

  /*
   * Artwork that a screen actually draws — not artwork that exists.
   *
   * This counted files. Measured on 75 stored documents: 56 had the directory,
   * 47 of those rendered none of it, and all 47 had an empty state somewhere
   * else drawing something of its own. The same 35 documents produced the same
   * three filenames — EmptyState, ContentFrame, Wordmark — which is what
   * satisfying a folder requirement looks like.
   *
   * So the score was paying 6 points for the half that costs nothing, and
   * `imagery-missing` then spent a repair call on the half that matters and
   * closed it 41% of the time. The requirement and the audit now measure the
   * same property, through the same function.
   *
   * The icon awards below are deliberately left counting: the same 75 documents
   * render their icons in 50 of the 65 that have them, so the incentive is not
   * where the fault is, and changing a term that is not misfiring only makes the
   * score harder to compare against the runs already recorded.
   *
   * One run since has drawn four icons and rendered none, which is one sample
   * against 65 and not a reason to move the term — but it is a reason not to
   * read the 50-of-65 as settled. The ICONS section of the prompt got the same
   * "every glyph must be rendered" requirement the artwork got, which is the
   * cheap half of the same fix; if `icons` keeps firing with the folder full,
   * this term is where to look next.
   */
  const art = renderedFrom(files, 'src/components/illustrations/', fw.componentExt)
  r.partial(art.used.length >= 3 ? 6 : art.used.length >= 1 ? 3 : 0, 6)

  const screens = paths.filter((p) => fw.screenFile.test(p)).length
  const components = paths.filter((p) => p.startsWith('src/components/') && p.endsWith(fw.componentExt)).length
  r.award(components >= 6, 4)
  r.award(components >= 12, 3)
  r.award(screens >= 5, 4)

  // Multi-screen navigation, the point of the format.
  r.gate(/ScreenId/.test(html), 4)
  r.gate(/NAV_ITEMS/.test(html), 3)
  r.award(/hashchange/.test(html), 5)
  r.gate(/useNavigation|navigation\.composables\/useNavigation|export function navigate/.test(html), 4)
  r.gate(/params/.test(html) && /detail/i.test(html), 4)   // list -> detail with an id
  r.gate(/canGoBack|back\(/.test(html), 3)

  // Shared state and real interactions.
  /*
   * Shared state: a reducer + context in React, a reactive module in Vue, a
   * `.svelte.ts` rune module in Svelte. Same property, three spellings — and
   * the framework table already holds them, so this reads them from there
   * rather than keeping a fourth copy.
   *
   * The copy it replaces had the same blind spot the audit's did: `reactive\s*\(`
   * does not match `reactive<State>({ … })`, which is how TypeScript writes it.
   * A separately-maintained duplicate of a rule is what put the audit and the
   * score on opposite sides of the same document over the login gate.
   */
  r.gate(fw.storePattern.test(html), 5)
  r.award(/createContext|provide\s*\(|export const \w+ = reactive|export (?:const|let) \w+ = \$state/.test(html), 3)
  // Mounted at all.
  r.gate(/createRoot|createApp\s*\(|\bmount\s*\(/.test(html), 2)
  // A keyed list: `key={}` in JSX, `:key` in a Vue template, `(item.id)` on a
  // Svelte {#each}. All three are "this list is keyed".
  r.gate(
    (/\.map\(/.test(html) && /key=\{/.test(html)) ||
      /:key=/.test(html) ||
      /\{#each[^}]*\([^)]+\)\s*\}/.test(html),
    3
  )
  r.award(/onSubmit=|onChange=|@submit|@change|\bonsubmit=|\bonchange=|on:submit|on:change/.test(html), 3)
  r.award(/aria-current/.test(html), 3)
  r.gate(/:focus-visible/.test(html), 2)

  // TypeScript discipline. These must survive as real syntax — an earlier run
  // passed every shallow check while writing its types as comments, so measure
  // things a comment cannot fake.
  r.gate(/interface\s+\w*Props\s*\{|defineProps\s*[<(]|\$props\s*\(/.test(html), 5)
  r.gate(/import type/.test(html), 2)
  r.award(outputKind === 'react'
    ? /React\.(?:ChangeEvent|FormEvent|MouseEvent)/.test(html)
    : /:\s*(?:Event|MouseEvent|KeyboardEvent|SubmitEvent|InputEvent)\b/.test(html), 2)
  const annotations = (html.match(/:\s*(?:string|number|boolean|void|null)/g) || []).length
  r.gate(annotations >= 20, 5)

  // Module discipline: real ES modules, not browser globals.
  const importLines = (html.match(/^\s*import\s.+from\s+['"]/gm) || []).length
  r.gate(importLines >= 20, 8)
  r.gate(/export default|export function|export const/.test(html), 3)

  // Coherence, weighted as heavily as in the HTML rubric and for the same reason:
  // everything above asks whether a thing is present, and presence alone is what
  // let the old score sit at its ceiling on every run.
  const coherence = designSystemScore(measureDesignSystem(html))
  if (coherence !== null) r.partial(coherence * 16, 16)

  // Contract violations.
  // JavaScript where the contract requires TypeScript. Asked of the paths for the
  // same reason as above: the attribute this used to test for no longer exists.
  /*
   * The prose checks read the CODE, not the whole document.
   *
   * `docs/design-guidelines.md` travels with every project and lists what not
   * to do, with a cross beside each item — including "絵文字をアイコンとして使用".
   * Counting emoji across the whole document therefore charged 20 points, the
   * cap, to a React project that had not put a single emoji in its interface:
   * it was penalised for carrying the rule that forbids them.
   *
   * The same shape waits for every other content check — a guideline listing
   * "Lorem ipsum" as forbidden would cost 15 — so the whole set reads a view
   * with the markdown removed, which is what "does the interface do this" was
   * always asking.
   */
  const code = [...readProjectFiles(html)]
    .filter(([path]) => !path.endsWith('.md'))
    .map(([, text]) => text)
    .join('\n') || html

  if (paths.some((p) => /\.jsx$/.test(p))) r.deduct(10)
  // 17 rather than 25: the gate above already charges 8 for a project that does
  // not reach twenty imports, and a project with none reaches neither. Together
  // they come to the 25 this cost before it was split — the icons folder is what
  // happens when that is not checked.
  if (importLines === 0) r.deduct(17)                      // globals instead of modules
  if (/window\.__\w+__/.test(html)) r.deduct(20)          // cross-file wiring via globals
  if (/=\s*React;|=\s*window\.React/.test(html)) r.deduct(15)
  if (/React\.createElement\(/.test(html)) r.deduct(12)   // hand-written calls instead of JSX
  if (annotations === 0) r.deduct(10)                      // .ts extension but no types; +5 from the gate = 15, as before
  /*
   * `any` is a nit, not a failure, and it was priced as a failure: 5 points,
   * firing on 24 of the 45 most recent documents — more movement than the
   * standard deviation of everything the rubric awards (6.9). A project with no
   * types at all already loses 15 on the line above; this is what is left over.
   */
  if (/:\s*any/.test(html)) r.deduct(2)
  if (/from\s+['"]react-router/.test(html)) r.deduct(12)
  /*
   * A package that is not this framework.
   *
   * The allowlist was React and relative paths, written when React was the only
   * output. A Vue project imports `from 'vue'` and a Svelte one `from 'svelte'`
   * — the framework itself, which every file needs — so both took this penalty
   * on every generation for using the thing they are written in. Measured across
   * nine stored documents: 48 points, all of it from Vue and Svelte importing
   * their own runtime.
   *
   * `providedModules` is the list the bundle actually supplies, so it is the
   * honest allowlist — and it keeps the check doing its real job, which is to
   * catch a dependency the preview cannot install.
   */
  const allowed = new Set(fw.providedModules)
  /*
   * A type-only import is not a dependency.
   *
   * `import type { HTMLButtonAttributes } from 'svelte/elements'` disappears
   * when the types are stripped, so it can never be a package the preview
   * fails to supply — which is the only thing this check exists to catch.
   * Measured at v191: a Svelte project that scored 98% of the rubric's awards
   * lost eight points for importing its own framework's type definitions.
   */
  const runtimeImports = html.replace(/import\s+type\s[^\n]*/g, '')
  const foreign = [...runtimeImports.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('.') && !allowed.has(spec))
  if (foreign.length > 0) r.deduct(8)
  if (/type="module"/.test(html)) r.deduct(6)
  if (/alert\(/.test(code)) r.deduct(4)
  if (/coming soon|近日公開|工事中|準備中です/i.test(code)) r.deduct(6)
  /*
   * A login the reviewer cannot get past hides the whole app behind it.
   *
   * This kept its own copy of the test, and the copy was the one the audit was
   * just fixed for: `type="password"` anywhere, which every generated project
   * writes in its form-control rule —
   *
   *     input[type="text"], input[type="email"], input[type="password"] { … }
   *
   * 35 corpus documents were losing 12 points for a stylesheet, none of them
   * with a password input anywhere in the markup. Sharing the predicate is the
   * point: two copies of one rule is how the audit came to be right and the
   * score wrong about the same document.
   */
  if (hasLoginGate(html) && !hasVisibleDemoCredentials(html)) r.deduct(12)
  // Emoji anywhere in the interface, not only as NavItem.icon. The narrow check
  // this replaces passed documents whose buttons and headings were full of them,
  // which is the tell users notice first.
  r.deduct(Math.min(20, countEmoji(code) * 4))
  if (/lorem ipsum/i.test(code)) r.deduct(15)

  if (presetName && hasPresetSignature(presetName)) {
    const { ratio, violations } = presetConformance(html, presetName)
    /*
     * A gate, for the reason the other 22 became gates: measured over 45 stored
     * documents this was full marks on every one of them — 20 of the contract
     * half's 97 possible points, a fifth of the scale, unable to move. Its
     * paired deduction is what has always done the work.
     *
     * The ratio is a proportion rather than a boolean, so the gate is set where
     * a system stops being followed rather than at 1: below 0.9 is a document
     * built to something else.
     */
    r.gate(ratio >= 0.9, 20)
    // Capped like the emoji count beside it: violations are counted per
    // occurrence, so a stylesheet that drifted in a dozen places could subtract
    // more than the whole rubric awards.
    r.deduct(Math.min(24, violations * 6))
  }

  if (out) out.whole = r.mark()
  return r.total()
}

/**
 * Turns a pile of bonuses into a number that can actually move.
 *
 * Both scorers were written as `let score = 55` plus fifty additions, clamped to
 * 99. Measured on real output the raw total came to 143 — forty-four points of
 * headroom above the ceiling, which every penalty in the list fell into. That is
 * why the score read 99 on every single run: not because the work was perfect,
 * but because the ceiling was reached less than halfway through the additions and
 * nothing after that could be seen.
 *
 * Tracking what was *available* alongside what was earned makes the result a
 * proportion, so a missing check costs something and the number means "how much
 * of the rubric did this meet". Penalties then subtract from that proportion,
 * where they are visible.
 */
interface Mark {
  earned: number
  possible: number
  penalty: number
}

class Rubric {
  private earned = 0
  private possible = 0
  private penalty = 0

  /** Award `weight` if `hit`; either way the weight counts as available. */
  award(hit: boolean, weight: number): void {
    this.possible += weight
    if (hit) this.earned += weight
  }

  /** Award part of `weight`, for a graded check. `got` is clamped to `weight`. */
  partial(got: number, weight: number): void {
    this.possible += weight
    this.earned += Math.max(0, Math.min(weight, got))
  }

  /**
   * A check every document passes: kept as a guard, but not as points.
   *
   * Measured over the 45 most recent generations (scripts/score-items.mjs), 22
   * of the 39 project checks were met by every one of them, and they carried 99
   * of the 176 possible points — 56% of the scale, unable to move. The largest
   * single item was one of them: two points a file capped at 18, and every
   * project MakeUI produces has at least nine files.
   *
   * Deleting them would have been the wrong fix. A check nothing fails is still
   * the thing that notices when the pipeline stops producing it — which is
   * exactly what the `data-file` break needed and did not have. So they stay,
   * and stop being points: silent while they hold, a demerit when one breaks.
   *
   * What is left in `possible` is the part of the rubric that varies, which is
   * the only part a proportion can carry information about.
   */
  gate(hit: boolean, weight: number): void {
    if (!hit) this.penalty += weight
  }

  /** A demerit. Not part of `possible` — it is a deduction from the result. */
  deduct(points: number): void {
    this.penalty += points
  }

  /**
   * A snapshot, so the caller can say which half of the rubric a point came from.
   *
   * Taken rather than tagged at every `award`. The runtime terms all run first
   * and in one function, so the boundary is a position rather than a property of
   * each check — and a tag on thirty call sites is thirty chances to forget one.
   */
  mark(): Mark {
    return { earned: this.earned, possible: this.possible, penalty: this.penalty }
  }

  /** What has accumulated since a mark. */
  since(m: Mark): Mark {
    return {
      earned: this.earned - m.earned,
      possible: this.possible - m.possible,
      penalty: this.penalty - m.penalty,
    }
  }

  /** 30..99. The floor keeps a broken document from reading as a zero-effort one. */
  total(): number {
    return Math.max(30, Math.min(99, this.raw()))
  }

  /**
   * The same number before the clamp, which is the only way to tell a 30 apart
   * from a 30.
   *
   * Measured over 21 days: 64 of 231 runs finished on exactly 30, and 22 of 25
   * of those documents score 48-90 with the browser facts left out — so the
   * floor is where the runtime half puts them, and how far below it they went
   * was not recorded anywhere. The displayed score keeps the clamp, because
   * moving it would make every score already in the table incomparable; this is
   * for the log and the metadata.
   */
  raw(): number {
    if (this.possible === 0) return 30
    return Math.round((this.earned / this.possible) * 100) - this.penalty
  }
}

/**
 * Facts the score can only get by rendering. Optional everywhere: most callers
 * (version history, edits) score a document they never ran.
 */
export interface ScoreRuntime {
  /** Per screen, how far down the viewport its content reaches, 0-1. */
  fills: number[]
  emptyBoxes: number
  consoleErrors: number
  deadNav: number
  /** Buttons inside a screen that were pressed and did nothing. */
  deadActions: number
  /**
   * Controls that raised an exception when pressed.
   *
   * Weighted well above a dead control, which is the comparison that matters: a
   * dead button is an unfinished mock, a throwing button is a broken one. The
   * user reaches it by clicking, which is the first thing anyone does.
   */
  throwingControls: number
  /**
   * Components replaced with a placeholder because they would not build.
   *
   * Counted so the score cannot go UP for a degraded project. The stub is what
   * makes the document compile, so without this the run stops reporting
   * `blank-render`, the compile gate passes, and a project missing three screens
   * scores better than the blank page it would otherwise have been.
   */
  stubbedComponents: number
  /** Form controls that rendered too small to use. */
  smallFields: number
  unreachableScreens: number
  /**
   * How many screens the project says it has, against how many the walk opened.
   *
   * `fills.length` alone cannot carry this: a project that renders one screen
   * beautifully has one fill of 1.0 and scores full marks for it. Measured on a
   * real run, an app that gated all nine of its screens behind a sign-in wall
   * rendered exactly the login screen — mean fill 1.0, no console error, no dead
   * control, nothing unreachable *among the screens the walk could see*. Every
   * runtime signal said healthy. The application was unusable.
   */
  declaredScreens: number
  /** The walk stopped at its deadline, so reachability was not fully measured. */
  truncated: boolean
  /** Pieces of text measured below the WCAG AA floor. */
  contrastFaults: number
  /** Pixels the document scrolls sideways at 390px. 0 when it does not. */
  mobileOverflowPx: number
}

/**
 * The files that decide what renders and where you can get to.
 *
 * The entry mounts, the shell branches on the route, `routes.ts` declares the
 * screen ids and the nav, and the screens are what the branches render. Every
 * one of `render-lost`, `unreachable-introduced` and `console-error-introduced`
 * is a statement about those four things.
 */
export function isRoutingFile(path: string, kind: OutputKind): boolean {
  const fw = FRAMEWORKS[kind]
  return (
    path === `src/App${fw.componentExt}` ||
    /^src\/main\.[jt]sx?$/.test(path) ||
    /^src\/routes\.tsx?$/.test(path) ||
    fw.screenFile.test(path)
  )
}

/**
 * `candidate`, with its edits to the routing files put back as they were.
 *
 * One bad file should not discard the other nine. A repair pass writes
 * `App.svelte`, `globals.css` and eight icons; one of them breaks the routing;
 * all ten go back. Measured on the v200 round — six of seven verdicts were
 * breaking rejections, and the counts they gave up were 18→9, 12→5, 11→7 and
 * 10→5. That is most of the repair the run paid for.
 *
 * Returns null when there is nothing to try: no routing edit to revert, or
 * nothing left once it is reverted. The caller should not spend a browser run
 * re-measuring a document identical to one it has already judged.
 */
/**
 * The files a salvage created that nothing in the salvaged project imports.
 *
 * A pass writes new components AND the screens that use them; a salvage that
 * puts the screens back keeps the components, which are now imported by
 * nothing. Measured on the live run of 2026-09-13: the routing revert was
 * accepted with five icons and four illustrations nobody rendered, and the
 * reply then reported 「アイコンを5個描いてありますが、どの画面にも表示されて
 * いません」 — a finding the salvage itself had just created.
 *
 * Only files the pass CREATED, never an existing file: a file that was already
 * in the project and is unused was unused before, and removing it is not this
 * function's business. Repeated until nothing changes, because an icon imported
 * only by an orphaned card is an orphan too.
 */
function orphanedNewFiles(base: Map<string, string>, result: Map<string, string>): Set<string> {
  const stem = (p: string) => p.replace(/(?:\.(?:vue|tsx|ts|jsx|js|mjs))+$/, '')
  const target = (importer: string, spec: string): string => {
    const parts = importer.split('/').slice(0, -1)
    for (const seg of spec.split('/')) {
      if (seg === '.' || seg === '') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return stem(parts.join('/'))
  }
  const created = [...result.keys()].filter((p) => !base.has(p) && /\.(vue|tsx|ts|jsx|js)$/.test(p))
  const orphans = new Set<string>()
  for (let changed = true; changed;) {
    changed = false
    const imported = new Set<string>()
    for (const [path, body] of result) {
      if (orphans.has(path)) continue
      for (const m of body.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
        const t = target(path, m[1])
        imported.add(t)
        imported.add(`${t}/index`)
      }
    }
    for (const p of created) {
      if (orphans.has(p) || imported.has(stem(p))) continue
      orphans.add(p)
      changed = true
    }
  }
  return orphans
}

export function withoutRoutingChanges(
  base: string,
  candidate: string,
  kind: OutputKind
): { html: string; kept: string[]; reverted: string[]; dropped: string[] } | null {
  const current = readProjectFiles(base)
  const keep = new Map<string, string>()
  const reverted: string[] = []
  for (const [path, body] of readProjectFiles(candidate)) {
    if (current.get(path) === body) continue
    if (isRoutingFile(path, kind)) {
      reverted.push(path)
      continue
    }
    keep.set(path, body)
  }
  const orphans = orphanedNewFiles(current, new Map([...current, ...keep]))
  let html = base
  const kept: string[] = []
  for (const [path, body] of keep) {
    if (orphans.has(path)) continue
    const next = writeProjectFile(html, path, body)
    if (next) {
      html = next
      kept.push(path)
    }
  }
  return kept.length > 0 && reverted.length > 0 ? { html, kept, reverted, dropped: [...orphans] } : null
}

/**
 * The files a breaking repair might be salvaged by putting back one at a time,
 * most likely culprit first.
 *
 * `withoutRoutingChanges` reverts every screen together, and on the run that
 * measured it the screens were where the pass's work was: 24 files written for
 * decomposition, icons and illustrations, the app crashed with React #130
 * (`Element type is invalid … got undefined`), the routing revert rendered again
 * — and scored no better, because the screens that used the new components
 * were the files it had put back. Eight defects shipped, with no attempt made
 * to find out whether both screens were at fault or only one.
 *
 * A browser run costs seconds and no tokens, so the answer to "which one" is
 * measured rather than reasoned about. Only files the pass CHANGED are
 * suspects: a file it created is unused once its importer goes back, and a
 * stylesheet cannot make a component undefined. The runtime error orders them
 * — a path it names, then the screen for a route it names (`#root is empty at
 * route "#/alerts"` → AlertsScreen), then the other screens, then the rest.
 *
 * Empty when there are fewer than two, since reverting the only change is
 * rejecting the pass.
 */
export function revertSuspects(base: string, candidate: string, errors: string[]): string[] {
  const original = readProjectFiles(base)
  const changed = [...readProjectFiles(candidate)]
    .filter(([path, body]) => original.has(path) && original.get(path) !== body)
    .map(([path]) => path)
    .filter((path) => /\.(tsx|jsx|ts|js|vue)$/.test(path))
  if (changed.length < 2) return []

  const text = errors.join('\n')
  const routes = [...text.matchAll(/#\/([\w-]+)/g)].map((m) => m[1].replace(/[-_]/g, '').toLowerCase())
  const stem = (path: string) =>
    path.slice(path.lastIndexOf('/') + 1).replace(/\.\w+$/, '')
  const rank = (path: string): number => {
    if (text.includes(path) || new RegExp(`\\b${stem(path)}\\b`).test(text)) return 0
    const isScreen = /^src\/(screens|pages|views)\//.test(path)
    if (isScreen && routes.includes(stem(path).replace(/(Screen|Page|View)$/, '').toLowerCase())) return 1
    return isScreen ? 2 : 3
  }
  return changed
    .map((path, i) => ({ path, i, r: rank(path) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.path)
}

/**
 * The candidate, minus the named files, which go back to what they were.
 *
 * Same idea as `withoutRoutingChanges` and the same justification: a pass writes
 * nine files and one of them is bad, and rejecting the document throws away the
 * other eight. Measured over 45 days, thirteen passes were rejected for 「no
 * longer compiles」 and in ten of them the file named in the compiler's error was
 * a file the pass had written — so there was one file to put back and eight or
 * nine to keep.
 *
 * The other three named a file the pass never touched. Reverting there changes
 * nothing and the compile still fails, which is the correct outcome and a
 * different finding: the document was already broken, and every repair attempt
 * against it was being blamed for it.
 *
 * Returns null when nothing would change, so a caller can tell 「no revert
 * applies」 from 「reverted and still broken」.
 */
export function withoutFiles(
  base: string,
  candidate: string,
  paths: string[]
): { html: string; reverted: string[]; dropped: string[] } | null {
  const original = readProjectFiles(base)
  const drop = new Set(paths)
  const keep = new Map<string, string>()
  const reverted: string[] = []
  for (const [path, body] of readProjectFiles(candidate)) {
    if (original.get(path) === body) continue
    if (drop.has(path)) {
      reverted.push(path)
      continue
    }
    keep.set(path, body)
  }
  // Same rule as the routing revert: what only the reverted file imported goes too.
  const orphans = orphanedNewFiles(original, new Map([...original, ...keep]))
  let html = base
  let kept = 0
  for (const [path, body] of keep) {
    if (orphans.has(path)) continue
    const next = writeProjectFile(html, path, body)
    if (next) {
      html = next
      kept += 1
    }
  }
  return reverted.length > 0 && kept > 0 ? { html, reverted, dropped: [...orphans] } : null
}

/**
 * Everything the score could see used to be in the source, and that let a page
 * score 92 while two thirds of its dashboard was white. The markup declared a
 * header, a nav, four cards, a route table and live handlers — every one of
 * which the rubric rewards, and all of which were genuinely there. What was
 * missing was anything below the fold, and no property of the text says so.
 *
 * So when the document has actually been rendered, what the render measured is
 * scored too, weighted to matter: filling the viewport is worth as much as the
 * whole structural section, because a screen that does not is unfinished
 * whatever its markup contains.
 */
function scoreRuntime(r: Rubric, rt: ScoreRuntime): void {
  /**
   * How much of the application the browser could actually get to.
   *
   * Weighted heavily and deliberately: this is the difference between a mock and
   * a screenshot, and it is the one thing every other runtime signal missed on
   * the sign-in-wall run. Only asked of projects that declare more than one
   * screen, because a single-screen brief reaching its single screen is a
   * complete result rather than a lucky one.
   */
  if (rt.declaredScreens > 1) {
    const reach = Math.min(rt.fills.length, rt.declaredScreens) / rt.declaredScreens
    r.partial(reach * 18, 18)
    /**
     * Below half is not a lower grade of finished — most of the application
     * cannot be opened at all, and a proportional term alone is far too gentle
     * about that. Measured: a project whose nine screens sat behind a sign-in
     * wall scored 89 on the proportional term because everything it DID render
     * was rendered well. A deduction is the right instrument here, because this
     * is a demerit against the result rather than a box left unticked.
     *
     * Scaled so it starts at nothing when half the app opens and reaches its
     * full weight when none of it does.
     */
    /*
     * Only when the walk finished looking.
     *
     * It stops at twenty seconds so a slow app cannot run the CDP transport past
     * its timeout, and when it does, the screens it never opened read as
     * unreachable. Charging for that charges the document for the probe's
     * budget — up to forty-five points here, plus five a screen below.
     *
     * The award above is deliberately left alone. It is evidence of what was
     * actually opened, and a truncated walk that still reached everything should
     * not lose the points it earned; skipping it was measured to cost such a
     * document five. A deduction is the other direction — it asserts there is no
     * way in — and that is the claim a walk which stopped early cannot make.
     */
    if (reach < 0.5 && !rt.truncated) r.deduct(Math.round(45 * (1 - reach * 2)))
  }
  if (rt.fills.length > 0) {
    // Mean fill across screens, so one rich screen cannot cover for three empty
    // ones. Saturates at 0.8 — a screen need not reach the fold to be complete,
    // it needs to not stop a third of the way down.
    const mean = rt.fills.reduce((a, b) => a + b, 0) / rt.fills.length
    r.partial((Math.min(mean, 0.8) / 0.8) * 14, 14)
  }
  // A container drawn and left empty is the screen's subject missing.
  r.deduct(Math.min(12, rt.emptyBoxes * 6))
  // A page that throws is broken however it looks.
  r.deduct(Math.min(15, rt.consoleErrors * 8))
  r.deduct(Math.min(10, rt.deadNav * 5))
  /**
   * Weighted above dead navigation, because it is closer to the claim.
   *
   * A mock whose nav works and whose 追加 and 保存 buttons do nothing is a
   * picture of an application. Nothing measured this until the walk started
   * pressing in-screen buttons, so every score this product has ever produced
   * was blind to it.
   */
  r.deduct(Math.min(12, rt.deadActions * 4))
  // A control that throws is not a lower grade of working.
  r.deduct(Math.min(24, rt.throwingControls * 12))
  /*
   * Heavier per item than a throwing control, and uncapped up to the point where
   * nothing is left. A control that throws is a broken interaction; a stubbed
   * component is a piece of the product that does not exist. The placeholder
   * keeps the rest of the application usable, which is the whole point of it,
   * but it must never read as a success.
   */
  r.deduct(Math.min(60, rt.stubbedComponents * 20))
  /**
   * A form you cannot type into is not a lower grade of finished.
   *
   * Capped like contrast, and for the same reason: these come in families. One
   * bad `.input` class produces eight findings and should not cost eighty
   * points.
   */
  r.deduct(Math.min(10, rt.smallFields * 3))
  // Same reason as reach above: a screen the walk ran out of time to open is
  // not a screen with no way in.
  if (!rt.truncated) r.deduct(Math.min(10, rt.unreachableScreens * 5))
  /**
   * Weighted like a defect, not like a nicety.
   *
   * Text nobody can read is not a lower grade of finished — and this product's
   * pitch is machine-checked conformance to a public-sector design system, where
   * an unreadable label is the one failure that actually stops the work being
   * usable. Capped, because these come in families: one badly paired token
   * produces six failures and should not cost sixty points.
   */
  r.deduct(Math.min(12, rt.contrastFaults * 4))
  // Sideways scrolling is binary — a page either does it or it does not — so the
  // size of the overflow does not scale the penalty.
  if (rt.mobileOverflowPx > 4) r.deduct(8)
}

/**
 * The number, and what it is made of.
 *
 * One score summing two unlike things has been read as a judgement about the UI
 * and cannot carry that: most of `contract` asks whether a path exists or a
 * string occurs, and `runtime` is what a browser found when it opened the
 * result. Measured on two runs of the same brief a day apart — 84 for a
 * 24-file project and 69 for a 29-file one that reached all five of its screens
 * with no console errors, most of the difference being two absent directories.
 *
 * `total` is left exactly as it was. 427 stored versions carry it and changing
 * what it means would make every one of them incomparable with the next — the
 * same reason the token ledger kept `total` and added `processed` beside it.
 */
/**
 * The two halves, as they travel: response metadata, stored thread, client.
 *
 * Named separately from `ScoreBreakdown` because `total` is already on the
 * message as `score`, and sending it twice invites the two copies to disagree.
 */
/*
 * `raw` is left out along with `total`: it goes to the log, not into the record
 * a thread stores and a chip renders. Two numbers for one score in the same
 * object is how a display ends up showing the wrong one.
 */
export type ScoreParts = Omit<ScoreBreakdown, 'total' | 'raw'>

/**
 * Which scale a score was measured on.
 *
 * 1: everything stored before 2026-09-03. 2: the scale after 22 checks that
 * every measured document passed stopped being points and became gates, the
 * icons folder stopped being scored twice, and the per-occurrence preset
 * deduction gained a ceiling. 3: the same treatment for preset conformance —
 * the last check earning full marks on every measured document — together with
 * the repair of the elevation test it feeds, which was exempting a tinted
 * shadow by how many digits its alpha was written with. 4 (2026-09-13): the
 * browser walk stopped counting working controls as dead — it re-reads
 * candidates before every press, does not press a row twice, counts a class or
 * field-value change as a response, clears a control that was merely already
 * selected, answers confirm() yes, and types today's date and a sentence for a
 * textarea (31 stored outputs replayed: 45 dead actions -> 4, up to twelve
 * points a document) — and the shipped document is re-walked when the
 * deterministic fixes changed it after it was measured. 5 (2026-09-15): the walk
 * stopped counting a screen that did not render — a press or a route visit that
 * changed only the hash no longer counts as navigating, and a second route showing
 * the first route's content is not recorded as a second screen (the spindle Vue
 * run: six screens at fill 1.0 that were all the home screen; replayed on 36
 * stored projects, 32 unchanged and 4 losing screens that were never rendered) —
 * together with 2026-09-14's fill of 0 for a screen whose content region shows
 * nothing beside a visible shell.
 *
 * Bump it for any change that moves the number for the same document, whether
 * the change is to the rubric or to the instruments that feed it: the version
 * list and the chat both mark scores from an older scale.
 *
 * A version rather than a migration. The old numbers were computed from
 * documents, not stored alongside them, so they cannot be recomputed for the
 * 427 versions that carry one — and a 84 from last week against a 71 from today
 * is a comparison of two different questions. Recording which one was asked is
 * the only honest thing available.
 */
export const SCORE_RUBRIC = 5

export interface ScoreBreakdown {
  /** Unchanged in meaning: what `qualityScore` has always been. */
  total: number
  /**
   * `total` before the 30..99 clamp, so a floor score can be told from a floor
   * score.
   *
   * 64 of 231 runs over 21 days finished on exactly 30, and nothing recorded how
   * far under it they were. Not displayed anywhere — the clamp stays, or every
   * score already stored becomes incomparable — this is for the log.
   */
  raw: number
  /** Which scale `total` is on — see `SCORE_RUBRIC`. */
  rubric: number
  /** The checklist — file layout, routing, types, module discipline. */
  contract: { earned: number; possible: number }
  /**
   * What the browser found, or null when it never opened the document.
   *
   * Null rather than zero, because "no deductions" and "not looked at" are the
   * two things `scoreVerified` exists to keep apart, and a zero here would read
   * as the first.
   */
  runtime: { earned: number; possible: number; penalty: number } | null
}

/**
 * The score, decomposed. Same arithmetic, reported rather than summed away.
 */
export function scoreBreakdown(
  html: string,
  presetName?: string,
  outputKind: OutputKind = DEFAULT_OUTPUT_KIND,
  runtime?: ScoreRuntime
): ScoreBreakdown {
  const zero = { earned: 0, possible: 0, penalty: 0 }
  const out = { runtime: { ...zero }, whole: { ...zero } }
  const isProject = Boolean(detectKind(readProjectFiles(html).keys()))
  const total = isProject
    ? scoreProject(html, outputKind, presetName, runtime, out)
    : scoreHtml(html, presetName, outputKind, runtime)
  if (!isProject) {
    // The single-page rubric has no split to report — it is one list of checks
    // over markup, and inventing a boundary in it would be a fiction.
    return { total, raw: total, rubric: SCORE_RUBRIC, contract: { earned: 0, possible: 0 }, runtime: null }
  }
  return {
    total,
    raw: out.whole.possible
      ? Math.round((out.whole.earned / out.whole.possible) * 100) - out.whole.penalty
      : total,
    rubric: SCORE_RUBRIC,
    contract: {
      earned: out.whole.earned - out.runtime.earned,
      possible: out.whole.possible - out.runtime.possible,
    },
    runtime: runtime ? out.runtime : null,
  }
}

export function scoreHtml(
  html: string,
  presetName?: string,
  outputKind: OutputKind = DEFAULT_OUTPUT_KIND,
  runtime?: ScoreRuntime
): number {
  /**
   * Every project format gets the project rubric.
   *
   * This read `outputKind === 'react'`, and the fall-through is a rubric for a
   * single interactive HTML page — it rewards `<style>` blocks, inline handlers
   * and document length. A Vue or Svelte project scored against it is being
   * marked on a format it is not, so the number said nothing about the output
   * and could not be compared with a React run of the same brief. Measured on
   * the same EC brief: React 77, Vue 43, on comparable documents.
   *
   * `scoreProject` reads its file list through the transport and its layout
   * expectations from the framework table, so the three are marked alike.
   */
  if (detectKind(readProjectFiles(html).keys())) return scoreProject(html, outputKind, presetName, runtime)

  const r = new Rubric()
  const len = html.length
  if (runtime) scoreRuntime(r, runtime)

  // Preset conformance dominates when a design system was requested — a beautiful
  // page that ignores the chosen system is a failed generation, not a good one.
  if (presetName && hasPresetSignature(presetName)) {
    const { ratio, violations } = presetConformance(html, presetName)
    /*
     * A gate, for the reason the other 22 became gates: measured over 45 stored
     * documents this was full marks on every one of them — 20 of the contract
     * half's 97 possible points, a fifth of the scale, unable to move. Its
     * paired deduction is what has always done the work.
     *
     * The ratio is a proportion rather than a boolean, so the gate is set where
     * a system stops being followed rather than at 1: below 0.9 is a document
     * built to something else.
     */
    r.gate(ratio >= 0.9, 20)
    // Capped like the emoji count beside it: violations are counted per
    // occurrence, so a stylesheet that drifted in a dozen places could subtract
    // more than the whole rubric awards.
    r.deduct(Math.min(24, violations * 6))
  }

  // Length, as a proxy for how much was actually built. Graded rather than
  // stacked, so a 60KB document does not out-earn a 25KB one that did everything.
  r.partial(len > 40000 ? 8 : len > 25000 ? 7 : len > 15000 ? 6 : len > 8000 ? 4 : len > 3000 ? 2 : 0, 8)

  // Structural completeness
  r.award(/<header[\s>]/i.test(html), 2)
  r.award(/<nav[\s>]/i.test(html), 2)
  r.award(/<main[\s>]/i.test(html), 2)
  r.award(/<footer[\s>]/i.test(html), 2)
  r.award(/<section[\s>]/i.test(html), 1)
  r.award(/<article[\s>]/i.test(html), 1)

  // CSS architecture
  r.award(/--[\w-]+\s*:/i.test(html), 3)
  r.award(/@media/i.test(html), 3)
  r.award(/clamp\(/i.test(html), 2)
  r.partial((html.match(/data-file\s*=/gi) || []).length, 6)

  // Motion, used sparingly. A couple of keyframes is craft; a dozen is decoration.
  const keyframeCount = (html.match(/@keyframes/gi) || []).length
  r.partial(keyframeCount === 0 ? 0 : keyframeCount <= 4 ? 3 : 1, 3)
  r.award(/transition\s*:/i.test(html), 2)
  r.award(/cubic-bezier/i.test(html), 1)
  r.award(/prefers-reduced-motion/i.test(html), 3)

  // Interaction states — the real mark of a finished component
  r.award(/:hover/i.test(html), 2)
  r.award(/:focus-visible/i.test(html), 3)
  r.award(/:active/i.test(html), 2)
  r.award(/:disabled|\[disabled\]/i.test(html), 2)

  // Typographic and layout craft
  r.award(/<svg[\s>]/i.test(html), 3)
  r.award(/tabular-nums/i.test(html), 2)
  r.award(/letter-spacing/i.test(html), 1)
  r.award(/max-width\s*:\s*\d+(ch|rem|px)/i.test(html), 2)
  r.award(/(display\s*:\s*grid|grid-template)/i.test(html), 2)

  // Accessibility
  r.award(/aria-/i.test(html), 2)
  r.award(/role="/i.test(html), 1)
  r.award(/<label[\s>]/i.test(html), 1)

  // Working mock: multiple screens, a router, and state-driven interaction.
  const screenCount = countScreens(html)
  r.award(screenCount >= 3, 6)
  r.award(/data-goto=/.test(html), 4)
  r.award(/hashchange/.test(html), 4)
  r.award(/function\s+render|const\s+render\s*=/.test(html), 4)
  r.award(/addEventListener\(\s*['"]click/.test(html), 2)

  // Content richness
  r.award((html.match(/<section[\s>]/gi) || []).length >= 4, 2)
  r.award((html.match(/<tr[\s>]/gi) || []).length >= 8, 2)

  /**
   * Whether the document reads as one system rather than a pile of local choices.
   *
   * Weighted heavily on purpose. Everything above is a presence check — does the
   * document have a footer, a hover state, a grid — and presence checks are what
   * let the old score sit at its ceiling while the output still looked
   * machine-made. This is the only part of the rubric that measures coherence,
   * and coherence is what the eye reads as "designed".
   */
  const coherence = designSystemScore(measureDesignSystem(html))
  if (coherence !== null) r.partial(coherence * 16, 16)

  // --- Penalties: the machine-generated tells the prompt bans ---
  if (/alert\(|confirm\(/.test(html)) r.deduct(6)
  if (/coming soon|近日公開|工事中|準備中です/i.test(html)) r.deduct(6)
  // Only penalise indigo/violet when it is the page's own palette — a custom
  // property or a colour/background declaration. A one-off swatch inside chart
  // data is not the AI-default look this guards against.
  if (/(?:--[\w-]+|(?:background|color|border|fill|stroke)[\w-]*)\s*:\s*[^;{}'"]*#(?:6366f1|8b5cf6|7c3aed|a855f7)/i.test(html)) r.deduct(8)
  if (/background-clip\s*:\s*text/i.test(html)) r.deduct(6)
  if (/backdrop-filter/i.test(html)) r.deduct(5)
  if (/filter\s*:\s*blur\(\s*(?:[6-9]\d|\d{3,})/i.test(html)) r.deduct(5)
  const gradientCount = (html.match(/linear-gradient|radial-gradient/gi) || []).length
  if (gradientCount > 2) r.deduct(Math.min((gradientCount - 2) * 2, 8))
  if (/Supercharge|next level|Seamlessly|Unlock the power|Elevate your/i.test(html)) r.deduct(5)
  r.deduct(Math.min(20, countEmoji(html) * 4))
  if (/lorem ipsum/i.test(html)) r.deduct(15)
  if (/sample text|placeholder text|dummy text|Feature One/i.test(html)) r.deduct(8)
  if (len < 5000) r.deduct(10)
  if (len < 2000) r.deduct(15)

  return r.total()
}
