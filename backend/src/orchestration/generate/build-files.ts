import {
  foundationPromptBlock,
  presetFoundation,
  withFoundationCss,
  withoutTokenDeclarations,
} from '../presets/preset-foundation.js'
import { shellRequirement } from '../presets/preset-composition.js'
import { FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import type { SystemPrompt } from '../prompts/prompt-cache.js'
import { parses, cleanFile, foreignImport } from '../repair/repair-files.js'
import { signatureOf } from './signature.js'
import { toRunnableDocument, unresolvedImports, addMissingBarrels } from '../../tools/project/react-bundle.js'
import { fixupFile } from '../../tools/fixups/framework-fixups.js'
import { logger } from '../../utils/logger.js'
import { firstJsonObject } from '../../utils/model-json.js'

/**
 * Builds the project one file at a time instead of one document at a time.
 *
 * The first build was the last place in this pipeline still asking a model for
 * thirty files in a single response — the request shape the repair pass and the
 * edit path were both rewritten to escape, each with its own measurement of why:
 *
 *   repair-files.ts  "one call asked to re-emit eighty-eight kilobytes across a
 *                    dozen files while holding eight unrelated instructions
 *                    returned exactly as many defects as it was given."
 *   edit-files.ts    "re-emitting thirty files to add one screen means the model
 *                    rewrites thirty files it was not asked to touch, and every
 *                    one of them is a chance to drop an export, lose a handler
 *                    or truncate."
 *
 * Generation has the same shape and therefore the same failure, and it is worse
 * here because there is no prior version to fall back to. A 64,000-token budget
 * spread over a shell, a router, a store, eight screens, a dozen components and
 * a stylesheet leaves each screen a few hundred tokens — which is exactly enough
 * for a heading, a list and a button that does nothing. That is where "the mock
 * does not really do anything" comes from: not from the design phase, which
 * enumerated every control, but from a build with no room to implement them.
 *
 * So the work is split the way it is actually shaped.
 *
 *   1. A manifest. What screens and components exist, decided once.
 *   2. The foundation, written together because it is one contract: the route
 *      union, the store, the navigation, the stylesheet, the shell. Everything
 *      else imports from it, so it cannot be written in parallel with the things
 *      that depend on it.
 *   3. Every screen and component, one call each, in parallel. Each is handed
 *      the foundation verbatim, its own part of the specification, and a sibling
 *      to copy the house style from.
 *
 * The trade is stated rather than hidden: this costs more input tokens, because
 * the foundation travels with every call. It buys each screen an entire response
 * of its own rather than a share of one. The cheap effort profiles keep the
 * single-call build for exactly that reason.
 */

/** A file the manifest says the project has. */
interface PlannedFile {
  path: string
  /** What it is for, in the planner's words. Carried into the file's own call. */
  role: string
  /** Screen id from the specification, when this file is a screen. */
  screenId?: string
  /**
   * The controls this file must implement, lifted out of the interaction
   * inventory.
   *
   * The design phase already enumerates every control on every screen and says
   * what each one writes — that is the whole point of the interaction designer.
   * It reaches the build as prose in a 60,000-character specification, where a
   * call writing one screen has to find its own rows. Pulling them out here
   * turns the inventory into a checklist the file is written against, which is
   * what it was always meant to be.
   */
  controls?: string[]
}

interface BuildManifest {
  screens: PlannedFile[]
  components: PlannedFile[]
  data: PlannedFile[]
  lib: PlannedFile[]
}

/** Everything a per-file call needs that does not change between files. */
interface BuildContext {
  spec: string
  prompt: string
  kind: OutputKind
  /**
   * Carried for the logs rather than for the prompts.
   *
   * AgentCore Observability reads the structured logs, and the design graph
   * already tags its traces with the preset and the output format so a slow or
   * poor run can be sliced by them. A build phase that logged only a file count
   * would be the one stage in the pipeline you could not ask that question of.
   */
  requestId?: string
  presetName?: string
  effort?: string
  presetSpec: string
  /** The photograph block, when the run has photographs to offer. */
  stockBlock: string
  /** Shared rules already written for the single-call build, reused verbatim. */
  formControlSizing: string
  projectContract: string
  /**
   * The stylesheet contract, which both build paths now send.
   *
   * It lived only here, and that was most of why per-file output measured
   * better — the single call was never told the stylesheet was the contract.
   */
  stylesheetContract: string
}

/**
 * Room for the control lists. At 3000 the manifest returned the screens and then
 * truncated mid-inventory, which is worse than not asking: the screens that came
 * back complete got their checklist and the last two silently did not.
 */
const MANIFEST_MAX_TOKENS = 8000
const FOUNDATION_MAX_TOKENS = 32000
const FILE_MAX_TOKENS = 16000

/**
 * How many file calls run at once.
 *
 * Bedrock throttles per account, and a burst of thirty concurrent InvokeModel
 * calls is the reliable way to collect a `ThrottlingException` on half of them.
 * Eight keeps a twenty-file project to three waves.
 */
/** A literal newline, so the joins and the document assembly read cleanly. */
const NEWLINE = '\n'

const CONCURRENCY = 8

/**
 * How much specification one file's call may carry.
 *
 * Per file, so it is multiplied by the file count — the one number in this
 * module that decides whether per-file assembly is affordable at all. Measured
 * on the first real run: about 958,000 tokens of code assembly against 84,000
 * for the same brief in a single call, and an over-generous slice here was most
 * of the difference.
 *
 * The fallback is the smaller of the two on purpose. Reaching it means the
 * paragraph match found nothing specific to this file, so what would travel is
 * the whole specification — the least targeted and therefore the least worth
 * paying for.
 */
const PER_FILE_SPEC_CHARS = 12_000
const FALLBACK_SPEC_CHARS = 6_000

/** PascalCase identifier, safe to use as a file name and a component name. */
function componentName(raw: string, suffix = ''): string {
  const cleaned = String(raw ?? '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
  if (!cleaned) return ''
  return cleaned.endsWith(suffix) ? cleaned : `${cleaned}${suffix}`
}

/** camelCase identifier for a data or helper module. */
function moduleName(raw: string): string {
  const p = componentName(raw)
  return p ? p.charAt(0).toLowerCase() + p.slice(1) : ''
}

const MANIFEST_SYSTEM = `You turn a UI design specification into the file list of a project.

You are NOT writing code here. You are naming the files, so that each can then be
written on its own with room to be complete.

Return only JSON:
{
  "screens":    [{"id":"inventory","name":"Inventory","role":"棚ごとの在庫一覧",
                  "controls":["検索欄: 入力で items をフィルタし一覧を再描画",
                              "棚フィルタ: 選択で該当棚のみ表示",
                              "行クリック: detail へ遷移し selectedId を書く",
                              "発注ボタン: request へ遷移"]}],
  "components": [{"name":"StatusBadge","role":"在庫状態を色と語で示すバッジ"}],
  "data":       [{"name":"items","role":"備品のモックデータと Item 型"}],
  "lib":        [{"name":"format","role":"数量と日付の整形"}]
}

Rules:
- "screens" must be exactly the screens the specification names, with the SAME
  ids the specification uses. Do not add screens it did not ask for and do not
  drop one it did.
- "controls" is the specification's INTERACTION INVENTORY for that screen, copied
  across one control per line. Include every control it lists — buttons, filters,
  search, tabs, rows, form fields, modal triggers and their close controls — and
  keep the state each one writes. This is the checklist the file will be built
  against, so a control you leave out is a control the screen will not have.
- "components" are pieces used by more than one screen, or complex enough to be
  worth their own file: badges, cards, tables, modals, empty states, form fields.
  Aim for 6-14. A project with no components puts everything in the screens and
  reads as one long file.
- "data" holds typed mock records; "lib" holds pure helpers. Keep both small.
- "role" is one sentence in Japanese saying what the file must contain. It is the
  only instruction the call that writes that file will get about its purpose, so
  make it specific: name the controls, the columns, the states.
- Names are PascalCase for screens and components, camelCase for data and lib,
  and must be valid identifiers.`

/**
 * Asks which files the project has.
 *
 * Cheap by construction: it reads the specification and returns names. Paths are
 * composed here from the framework's own layout rather than asked for, because a
 * model that invents `src/pages/Foo.jsx` in a Vue project produces a file nothing
 * can resolve — and that is a failure mode this codebase has already paid for
 * once, in the edit planner.
 */
export async function planProjectFiles(
  ctx: BuildContext,
  invoke: (system: string, user: string, maxTokens: number) => Promise<string>
): Promise<BuildManifest> {
  const fw = FRAMEWORKS[ctx.kind]
  const ext = fw.componentExt
  const empty: BuildManifest = { screens: [], components: [], data: [], lib: [] }

  let raw: string
  try {
    raw = await invoke(
      MANIFEST_SYSTEM,
      `Design specification:\n${ctx.spec.slice(0, 30000)}\n\nOriginal request: "${ctx.prompt}"`,
      MANIFEST_MAX_TOKENS
    )
  } catch (e) {
    logger.warn('Build manifest call failed', { error: String(e) })
    return empty
  }

  // The first balanced object, not first-brace-to-last-brace: a model that
  // adds a sentence after the JSON used to make the whole reply unparsable.
  const parsed: any = firstJsonObject(raw)
  if (!parsed) {
    logger.warn('Build manifest returned no JSON', { preview: raw.slice(0, 200) })
    return empty
  }

  const seen = new Set<string>()
  const take = (
    list: unknown,
    make: (entry: any) => PlannedFile | null,
    limit: number
  ): PlannedFile[] => {
    const out: PlannedFile[] = []
    for (const entry of Array.isArray(list) ? list : []) {
      const file = make(entry)
      if (!file || seen.has(file.path)) continue
      seen.add(file.path)
      out.push(file)
      if (out.length >= limit) break
    }
    return out
  }

  const screens = take(
    parsed.screens,
    (e) => {
      const name = componentName(e?.name ?? e?.id, 'Screen')
      if (!name) return null
      return {
        path: `src/screens/${name}${ext}`,
        role: String(e?.role ?? '').slice(0, 400),
        screenId: String(e?.id ?? '').trim() || undefined,
        controls: (Array.isArray(e?.controls) ? e.controls : [])
          .map((c: unknown) => String(c).slice(0, 240))
          .filter(Boolean)
          .slice(0, 24),
      }
    },
    12
  )
  const components = take(
    parsed.components,
    (e) => {
      const name = componentName(e?.name)
      if (!name) return null
      return { path: `src/components/ui/${name}${ext}`, role: String(e?.role ?? '').slice(0, 400) }
    },
    16
  )
  const data = take(
    parsed.data,
    (e) => {
      const name = moduleName(e?.name)
      if (!name) return null
      return { path: `src/data/${name}.ts`, role: String(e?.role ?? '').slice(0, 400) }
    },
    8
  )
  const lib = take(
    parsed.lib,
    (e) => {
      const name = moduleName(e?.name)
      if (!name) return null
      return { path: `src/lib/${name}.ts`, role: String(e?.role ?? '').slice(0, 400) }
    },
    6
  )

  return { screens, components, data, lib }
}

/** The manifest as the one-screen-per-line list every call is shown. */
function manifestListing(m: BuildManifest): string {
  const all = [...m.screens, ...m.components, ...m.data, ...m.lib]
  return all.map((f) => `- ${f.path}${f.role ? ` — ${f.role}` : ''}`).join('\n')
}

/**
 * The contract every other file is written against.
 *
 * Written as one call rather than several because these files ARE one decision:
 * the route union names the screens, the shell branches on it, the store's types
 * are what the screens read, and the stylesheet is what every one of them uses to
 * look like the same product. Splitting them would mean each half guessing at the
 * other, which is the problem this whole module exists to remove.
 */
function foundationSystem(ctx: BuildContext, m: BuildManifest): string {
  const fw = FRAMEWORKS[ctx.kind]
  const screens = m.screens
    .map((s) => `  ${s.path}   id: ${s.screenId ?? '(name it from the file)'}`)
    .join('\n')

  return `You are a senior frontend engineer. You are writing the FOUNDATION of a ${fw.label} project.

${ctx.presetSpec
    ? `BINDING DESIGN SYSTEM — every value below is absolute.
${presetFoundation(ctx.presetName) ? withoutTokenDeclarations(ctx.presetSpec, ctx.presetName) : ctx.presetSpec}

${foundationPromptBlock(ctx.presetName ?? '') || 'Transcribe its colours verbatim into :root and reference them with var(--token) everywhere.'}

${shellRequirement(ctx.presetName)}`
    : `DESIGN DIRECTION — decide it here, once, and record it as comments at the top of
the stylesheet. One accent the product's domain would really use; a single neutral
ramp; a real type scale; a settled radius and spacing rhythm. HARD BAN on
#6366f1 / #8b5cf6 / #7c3aed / #a855f7 and every indigo-violet neighbour, on
gradient headline text, blurred colour blobs, glassmorphism and glow shadows.`}

MOUNT POINT — the page this runs in contains exactly this, and nothing else:

    <body><div id="root"></div></body>

So the entry file mounts into "#root". Measured: an entry that opened with
"createRoot(document.getElementById(app)!)" threw React error #299, the page
was blank, and verification reported zero screens on a project where every file
compiled cleanly.

You write ONLY these files, and all of them:

${fw.layout.split('\n').filter((l) => !/screens|components\/(ui|icons)/.test(l)).join('\n')}
${presetFoundation(ctx.presetName)
    ? '  src/styles/globals.css        ALL styling. The design tokens are already written (see above): reference them, never declare them'
    : '  src/styles/globals.css        ALL styling, design tokens in :root'}

The screens exist and are written by someone else. Route to them, import them,
and do not write them:
${screens || '  (none — build a single-screen shell)'}

${fw.rules}

${ctx.stylesheetContract}

${ctx.projectContract}
${ctx.formControlSizing}

NO EMOJI anywhere in the interface, ever. Icons are inline SVG.

OUTPUT FORMAT — one fenced block per file, and nothing else:

  @@@makeui:file ${fw.entry}
  …the file's contents, verbatim…
  @@@makeui:endfile

The fences are whole lines. Never wrap a file in <script> or <style>. No markdown,
no commentary, no prose before or after.`
}

const FOUNDATION_LIMIT = 90_000

/**
 * A file body, written by a call that sees the contract and its own brief.
 */
/**
 * Invariant for the whole build, which is the point.
 *
 * The path used to be the first line — `You write ONE file of a … project:
 * src/screens/X.tsx` — and everything after it is identical across every call of
 * a run. Bedrock matches a cached prefix from the FIRST byte, so a path at byte
 * one makes the contract behind it unmatchable, and the run pays to write the
 * same prefix again on every file instead of reading it back.
 *
 * Measured on the most expensive run in a 14-day window: 30 calls,
 * 4,106 cache-write tokens each, 123,183 written and **zero read**. The prefix
 * clears the cacheable floor comfortably; it was never the length. It was the
 * ordering, and this is the exact failure prompt-cache.ts documents.
 *
 * The path is not lost: the user message has carried `YOUR FILE: <path>` all
 * along, which is also how repair-files.ts states it — 「THE FILE YOU RETURN IS
 * THE ONE NAMED AT THE TOP OF THE REQUEST」. Saying it twice is what cost the
 * cache.
 */
function fileSystem(ctx: BuildContext): SystemPrompt {
  const fw = FRAMEWORKS[ctx.kind]
  return { cached: `You write ONE file of a ${fw.label} project.

THE FILE YOU WRITE IS THE ONE NAMED AT "YOUR FILE:" IN THE REQUEST. Return the
COMPLETE file and nothing else. No markdown, no fences, no commentary,
no explanation before or after.

${fw.rules}

Rules:
- Use ONLY the classes the stylesheet below defines. Do not invent class names and
  do not write inline styles beyond dynamic values (a width percentage, a colour
  from data). If a shape you need is missing, compose it from the classes present.
- Import from the foundation files exactly as they are written below. Their
  exported names are fixed; you cannot change them from here.
- You may import any path in the project file list. You may not add a package
  dependency: installed packages are ${fw.packages}.
- Everything must WORK. Real state, real handlers, real empty and loading states,
  real validation messages. A control with no behaviour is a defect — remove it or
  give it one. No "coming soon", no placeholder text, no dead links.
- Real content. Plausible records for this domain with plausible names, numbers,
  dates and statuses — never "項目1", "サンプル", lorem ipsum, or a table of three
  identical rows.
- NO EMOJI. Icons are inline SVG (viewBox="0 0 24 24", stroke="currentColor",
  stroke-width 1.5, no fill).
- Nothing may throw when pressed. Routing helpers accept a missing argument and
  fall back to the first screen; an id read out of a route is read optionally
  (route.params?.id), never assumed to be there.
- Where the specification asks for artwork or an empty-state illustration, draw an
  inline SVG. A grey box is a defect.
${ctx.formControlSizing}
${ctx.stockBlock}` }
}

/** Files whose bodies every per-file call is shown verbatim. */
function contractBlock(foundation: Map<string, string>, kind: OutputKind): string {
  const fw = FRAMEWORKS[kind]
  const wanted = [
    fw.routesFile,
    ...[...foundation.keys()].filter((p) => /store|navigation|composables|lib\/(types|store|navigation)/.test(p)),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of wanted) {
    if (seen.has(path)) continue
    const body = foundation.get(path)
    if (!body) continue
    seen.add(path)
    out.push(`--- ${path} ---\n${body}`)
  }
  const css = foundation.get('src/styles/globals.css')
  if (css) out.push(styleContract(css))
  return out.join('\n\n')
}

/**
 * The stylesheet as a vocabulary, not as a stylesheet.
 *
 * This block travels with EVERY per-file call, so what goes in it is multiplied
 * by the number of files. Measured on the first real per-file run: 1,087,399
 * tokens against 285,578 for the same brief built in one call — and the
 * stylesheet, deliberately written long, was most of the difference.
 *
 * A screen does not need the declarations. It needs to know which classes exist
 * so it uses them instead of inventing its own, and it needs the tokens so any
 * value it does write by hand is on-system. So the selectors go over as a list
 * and the `:root` block goes over intact, and the four hundred lines of
 * declarations between them stay where they are — in the file the browser reads.
 */
function styleContract(css: string): string {
  // Every :root, not the first: with a design system bound the first is MakeUI's
  // token block, and the project's own aliases follow it in a second one.
  const roots = [...css.matchAll(/:root\s*\{[\s\S]*?\}/g)].map((m) => m[0])
  const selectors = [...css.matchAll(/^\s*(\.[\w-][\w-]*(?:[\s>+~][^{,]*)?)\s*(?:,|\{)/gm)]
    .map((m) => m[1].trim().split(/[\s>+~]/)[0])
    .filter((sel, i, all) => all.indexOf(sel) === i)
  return [
    '--- src/styles/globals.css (the design system for this project) ---',
    roots.join(NEWLINE),
    '',
    'CLASSES AVAILABLE — use these and only these. The declarations are already',
    'written; you are choosing from a vocabulary, not defining one. If a shape you',
    'need is missing, compose it from the classes below rather than inventing a name',
    'or writing an inline style, because a class this file invents is a class no',
    'stylesheet defines.',
    selectors.join(' '),
  ].join('\n')
}

/** Runs `jobs` with at most `limit` in flight, preserving order. */
async function pooled<T, R>(items: T[], limit: number, run: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await run(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

interface BuildResult {
  /** The assembled document, or null when the build could not be completed. */
  html: string | null
  /** Files that were written. */
  written: string[]
  /** Files that were planned and did not survive. */
  skipped: string[]
  /** The manifest, for logging. */
  manifest: BuildManifest
}

/**
 * Writes the whole project, foundation first and then every screen in parallel.
 *
 * Returns `html: null` rather than throwing whenever it cannot see the build
 * through — no manifest, no foundation, no shell — so the caller falls back to
 * the single-call assembler. A path that can only add is a path that can be
 * trusted with the default.
 */
export async function buildProjectFiles(
  ctx: BuildContext,
  /*
   * `SystemPrompt` as well as a string: the per-file prompt is now split so its
   * invariant contract can be cached across the run's calls. `systemField`
   * accepts either, and a caller that passes a plain string behaves exactly as
   * it did.
   */
  invoke: (system: string | SystemPrompt, user: string, maxTokens: number) => Promise<string>,
  hooks: {
    onPhase?: (label: string) => void
    onFile?: (path: string, body: string) => void
  } = {}
): Promise<BuildResult> {
  const fw = FRAMEWORKS[ctx.kind]
  const empty: BuildResult = {
    html: null,
    written: [],
    skipped: [],
    manifest: { screens: [], components: [], data: [], lib: [] },
  }

  hooks.onPhase?.('画面構成を組み立て中')
  const manifest = await planProjectFiles(ctx, invoke)
  if (manifest.screens.length === 0) {
    logger.info('Per-file build declined — the manifest named no screens')
    return empty
  }
  logger.info('Build manifest planned', {
    requestId: ctx.requestId,
    preset: ctx.presetName,
    kind: ctx.kind,
    effort: ctx.effort,
    screens: manifest.screens.map((s) => s.path),
    controls: manifest.screens.reduce((n, s) => n + (s.controls?.length ?? 0), 0),
    components: manifest.components.length,
    data: manifest.data.length,
    lib: manifest.lib.length,
  })

  let lastComplaint = ''
  hooks.onPhase?.('共通基盤とデザイントークンを作成中')

  /**
   * The foundation, parse-checked and retried once before anything is built on it.
   *
   * It was written, split, and used — with no gate at all. Every per-file write
   * below is checked with `parses()` and retried, and the one call whose output
   * EVERY other file imports was the one nobody checked. A broken shell or a
   * store that does not compile therefore reached the user as a build error on a
   * project where every screen was fine.
   *
   * Measured on a real Vue run: `ProductCard.vue` shipped with two
   * `defineProps()` calls — a hard `@vue/compiler-sfc` error — and the preview
   * showed nothing but the error. The parse gate catches that idiom; it simply
   * was not being asked about these files.
   *
   * One retry, carrying the compiler's own complaint, because that is a
   * different prompt rather than the same one resampled. Then it declines, and
   * the single-call assembler takes over.
   */
  const foundationBrief = `Design specification:\n${ctx.spec.slice(0, FOUNDATION_LIMIT)}\n\nOriginal request: "${ctx.prompt}"`
  let foundation: Map<string, string> | null = null
  for (let attempt = 0; attempt < 2 && !foundation; attempt++) {
    let text: string
    try {
      text = await invoke(
        foundationSystem(ctx, manifest),
        attempt === 0
          ? foundationBrief
          : `${foundationBrief}\n\n--- 前回の出力には次のコンパイルエラーがありました ---\n${lastComplaint}\n\nそのファイルを直して、全ファイルをもう一度出力してください。`,
        FOUNDATION_MAX_TOKENS
      )
    } catch (e) {
      logger.warn('Foundation call failed', { attempt: attempt + 1, error: String(e) })
      break
    }

    const candidate = readFences(text)
    if (!candidate.has(fw.entry)) {
      lastComplaint = `エントリファイル ${fw.entry} が出力に含まれていません。`
      logger.info('Foundation has no entry file', { attempt: attempt + 1, got: [...candidate.keys()] })
      continue
    }
    const broken: string[] = []
    for (const [path, body] of candidate) {
      const err = parses(path, body)
      if (err) broken.push(`${path}: ${err}`)
    }
    if (broken.length === 0) {
      foundation = candidate
      break
    }
    lastComplaint = broken.slice(0, 3).join('\n')
    logger.info('Foundation does not compile', { attempt: attempt + 1, broken: broken.slice(0, 3) })
  }
  if (!foundation) {
    logger.info('Per-file build declined — the foundation would not compile', { requestId: ctx.requestId })
    return { ...empty, manifest }
  }
  /*
   * The token block goes in before any screen is written, not after the build.
   *
   * Every per-file call is shown the stylesheet's :root (see `styleContract`), and
   * that is how a screen learns which names to reference. Put in afterwards, the
   * screens would have been written against whatever the foundation call chose to
   * name its own tokens, and the block would arrive to a project that uses none of it.
   */
  if (presetFoundation(ctx.presetName)) {
    const { css, overridden } = withFoundationCss(foundation.get('src/styles/globals.css') ?? '', ctx.presetName!)
    foundation.set('src/styles/globals.css', css)
    logger.info('Wrote the design system token block into the foundation', {
      requestId: ctx.requestId, presetName: ctx.presetName, overridden: overridden.length,
    })
  }


  const contract = contractBlock(foundation, ctx.kind)
  const listing = manifestListing(manifest)
  /**
   * Two waves, not one pool.
   *
   * Everything here is independent — each call writes one file — so the obvious
   * arrangement is a single pool, and that is what this was. It made the sibling
   * reference below dead: with every call starting at once, nothing has landed
   * when any of them ask what the project looks like, so each file was written
   * in the model's own default idiom and the house style came from the
   * stylesheet alone.
   *
   * Data, helpers and components go first; screens follow and are shown a
   * finished component. That also gets the more valuable half of the effect —
   * a screen that has seen the real `StatusBadge` composes with it instead of
   * inventing its own badge markup.
   */
  const firstWave = [...manifest.data, ...manifest.lib, ...manifest.components]
  /**
   * One screen is written alone, and the rest are shown it.
   *
   * The screens all ran in the same wave, so none of them ever saw a finished
   * screen — each was written against the stylesheet and a component, and each
   * made its own decisions about page structure, heading rhythm, spacing between
   * sections and how a toolbar is arranged. The result is the complaint that
   * prompted this: 「一部画面では良いデザインが生成されていますが、それ以外の画面は
   * レベルの低いデザイン」. A shared vocabulary of class names is not the same as a
   * shared idea of what a page looks like.
   *
   * The cost is one serialisation step, about thirty seconds. What it buys is
   * that every other screen is written with a real, complete page from this same
   * product in front of it.
   */
  const leadScreen = manifest.screens.slice(0, 1)
  const restScreens = manifest.screens.slice(1)
  const targets = [...firstWave, ...leadScreen, ...restScreens]

  hooks.onPhase?.(`${targets.length}個のファイルを実装中`)

  /**
   * A sibling to copy the house style from, chosen from what has already landed.
   *
   * The same device `edit-files.ts` uses when it writes a new screen, and for the
   * same reason: a file written with no reference is written in the model's own
   * default idiom, next to a dozen that share a different one. Here it matters
   * more, because EVERY file is being written fresh — without it the project is
   * twenty first drafts rather than one product.
   */
  const landed = new Map<string, string>()
  /**
   * The shell counts as a landed sibling from the start.
   *
   * It is a real component of this project, written by the foundation call in
   * the same idiom everything else should follow, and it exists before any
   * per-file call runs — so the first wave has a reference too rather than only
   * the second.
   */
  {
    const shell = [...foundation.entries()].find(([p]) => p.endsWith(`App${fw.componentExt}`))
    if (shell) landed.set(shell[0], shell[1])
  }

  const writeFile = async (file: PlannedFile) => {
    /**
     * A finished SCREEN if one exists, otherwise any finished component.
     *
     * A screen written next to a Button learns the class names; a screen written
     * next to another screen learns the page. Preferring the lead screen is what
     * makes the second wave consistent with the first rather than merely legal.
     */
    const sibling =
      [...landed.entries()].find(([p]) => fw.screenFile.test(p) && p !== file.path) ??
      [...landed.entries()].find(([p]) => p.endsWith(fw.componentExt) && p !== file.path)
    /**
     * Every component that has already landed, by its signature.
     *
     * Only useful to the second wave: components are written first and have
     * nothing of their own to call, and a component's own signature in its own
     * prompt would be describing the file to the call that is writing it.
     */
    const componentApi = [...landed.entries()]
      .filter(([p]) => p.startsWith('src/components/') && p !== file.path)
      .map(([p, b]) => signatureOf(p, b))
      .join('\n\n')
    const user = [
      `PROJECT FILES (import from these; they all exist):`,
      listing,
      ...[...foundation.keys()].map((p) => `- ${p}`),
      '',
      'THE CONTRACT — these files are already written. Use their exports and their',
      'classes exactly as they are; you cannot change them from here.',
      contract,
      '',
      sibling
        ? `--- ${sibling[0]} (a finished file from this project: follow its conventions and design language) ---\n${sibling[1].slice(0, 5000)}\n`
        : '',
      ...(componentApi
        ? [
            '',
            'COMPONENT API — these components already exist. Call them with EXACTLY',
            'these props: the names, and every one that is not optional. A prop you',
            'rename or omit is a crash on first render, and it takes the whole page',
            'down rather than just this screen.',
            componentApi,
          ]
        : []),
      `YOUR FILE: ${file.path}`,
      file.role ? `その役割: ${file.role}` : '',
      ...(file.controls?.length
        ? [
            '',
            'この画面が持つコントロール（設計フェーズのインタラクション一覧より）。',
            '**1つ残らず実装してください。** 押しても何も起きないコントロールは不具合です。',
            ...file.controls.map((c) => `  - ${c}`),
          ]
        : []),
      '',
      'The part of the specification this file implements:',
      relevantSpec(ctx.spec, file),
    ].join('\n')

    let body = ''
    /*
     * What the retry is told, set by whichever gate turned the last try away.
     *
     * This was one hard-coded sentence about parsing, which was the only gate
     * there was. A second gate with the first gate's complaint would send a
     * model looking for a syntax error it did not make.
     */
    let retryNote = '--- 前回の出力はパースできませんでした ---\nもっと小さく、確実に動く形で書き直してください。入れ子は浅く、開いたタグは必ず閉じること。'
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        body = cleanFile(
          await invoke(
            fileSystem(ctx),
            attempt === 0 ? user : `${user}\n\n${retryNote}`,
            FILE_MAX_TOKENS
          ),
          file.path
        )
      } catch (e) {
        logger.warn('Build file call failed', { path: file.path, attempt: attempt + 1, error: String(e) })
        return { path: file.path, body: null }
      }
      /**
       * Mechanical repairs before the gate, not after it.
       *
       * A duplicate `defineProps()` is a hard compile error with exactly one
       * correct fix, so rejecting the file and asking again is a model call
       * spent on something a rewrite settles. Left to the gate the component is
       * dropped, its importers then fail to resolve, and the whole per-file
       * build declines — a good component lost to a two-line idiom.
       */
      const repaired = fixupFile(ctx.kind, file.path, body)
      if (repaired.fixed.length > 0) {
        body = repaired.body
        logger.info('Fixed a framework idiom before writing', { path: file.path, fixed: repaired.fixed })
      }
      if (!body || body.length < 40) {
        logger.info('Build file rejected — response too short', { path: file.path, chars: body.length })
        continue
      }
      /*
       * A package nobody installed, caught before the file lands.
       *
       * The prompt above already says it — 「installed packages are …」 — and a
       * build wrote `import { format } from 'date-fns'` into two screens anyway.
       * The preview supplies `providedModules` and nothing else, so `require`
       * threw, the page was blank, and the run's first verification reported
       * blank-render, console-error and import-missing together. The repair pass
       * that followed took the defect count from 7 to 4 and was rejected for the
       * blank page it could not clear; the run shipped at the floor.
       *
       * That is a whole generation lost to an import, and the check costs a
       * regex. It shares `isProvidedModule` with the bundle and the repair, so
       * there is one answer to what is installed rather than three.
       */
      const foreign = foreignImport(body, ctx.kind)
      if (foreign) {
        logger.info('Build file rejected — imports a package the preview cannot supply', {
          path: file.path, package: foreign, attempt: attempt + 1,
        })
        retryNote =
          `--- 前回の出力は ${foreign} を import していました。このパッケージは存在しません ---\n` +
          `外部パッケージを使わず、標準の JavaScript と ${FRAMEWORKS[ctx.kind].packages} だけで書き直してください。` +
          '日付や数値の整形が必要なら Intl / toLocaleString を使うか、src/lib/ に自分で小さな関数を書いてください。'
        continue
      }
      const broken = parses(file.path, body)
      if (!broken) {
        landed.set(file.path, body)
        hooks.onFile?.(file.path, body)
        return { path: file.path, body }
      }
      logger.info('Build file does not parse', { path: file.path, attempt: attempt + 1, error: broken })
      retryNote = '--- 前回の出力はパースできませんでした ---\nもっと小さく、確実に動く形で書き直してください。入れ子は浅く、開いたタグは必ず閉じること。'
    }
    return { path: file.path, body: null }
  }

  const results = [
    ...(await pooled(firstWave, CONCURRENCY, writeFile)),
    ...(await pooled(leadScreen, 1, writeFile)),
    ...(await pooled(restScreens, CONCURRENCY, writeFile)),
  ]

  const usable = results.filter((r): r is { path: string; body: string } => Boolean(r.body))
  const skipped = results.filter((r) => !r.body).map((r) => r.path)

  /**
   * A screen that did not come back is not a smaller project, it is a broken one:
   * the shell imports every screen the manifest named. Rather than ship an
   * unresolvable import, the whole per-file build declines and the caller uses
   * the single-call assembler, which at least produces a coherent whole.
   */
  const lostScreens = manifest.screens.filter((s) => !usable.some((r) => r.path === s.path))
  if (lostScreens.length > 0) {
    logger.info('Per-file build declined — a screen did not come back', {
      lost: lostScreens.map((s) => s.path),
    })
    return { ...empty, manifest, skipped }
  }

  let doc = `<!DOCTYPE html>\n<html lang="ja"><head><meta charset="UTF-8" /></head>\n<body>\n<div id="root"></div>\n`
  const written: string[] = []
  /**
   * A path may appear once.
   *
   * The foundation call is told the screens are written by someone else and not
   * to write them, and measured on a real run it wrote six of them anyway —
   * stubs, sitting next to the real ones this module then appended. Nothing
   * downstream failed loudly: `readProjectFiles` keeps the last entry for a path,
   * so the compiled app used the right file. But the Code tab splits the document
   * into a list without deduplicating, so the user would have seen every screen
   * twice, and the stored document carried 30KB of dead stubs.
   *
   * The instruction to the model is kept and the guarantee is made here. A prompt
   * cannot promise this; the assembly can.
   */
  const owned = new Set(targets.map((f) => f.path))
  for (const [path, body] of foundation) {
    if (owned.has(path)) {
      logger.info('Foundation wrote a file the manifest owns; keeping the per-file version', { path })
      continue
    }
    doc += fenceOf(path, body)
    written.push(path)
  }
  for (const r of usable) {
    doc += fenceOf(r.path, r.body)
    written.push(r.path)
  }
  doc += '</body></html>' + NEWLINE

  /**
   * The document has to compile before this path claims it.
   *
   * Every file was parsed on its own on the way in, and that is not the same
   * question: a project compiles as a graph, so an import that resolves to
   * nothing, a barrel that was never written, or a component whose own compiler
   * rejects it only in context all pass the per-file gate and fail here. This is
   * also the last point at which declining is free — the single-call assembler
   * is still available, and it produces a coherent whole.
   *
   * The requirement this serves is the user's, stated plainly: a generation that
   * shows an error instead of a UI is the one outcome that must not happen. A
   * per-file build that cannot produce a running document should hand the work
   * back rather than ship its own failure.
   */
  const runnable = toRunnableDocument(doc, ctx.kind)
  if (runnable.error) {
    logger.info('Per-file build declined — the assembled project does not compile', {
      requestId: ctx.requestId,
      error: runnable.error.slice(0, 300),
    })
    return { ...empty, manifest, skipped }
  }
  /**
   * And every import has to resolve, which compiling does not answer.
   *
   * An unresolved specifier is not a compile error — the bundler turns it into a
   * `throw` at first require — so it passes the check above and then takes the
   * whole application down at load with `Module not found`. Barrels are written
   * first, because a directory import that only needs an index file is a thing
   * to fix rather than a reason to decline.
   */
  const barrelled = addMissingBarrels(doc)
  const missing = unresolvedImports(barrelled.html)
  if (missing.length > 0) {
    logger.info('Per-file build declined — imports that nothing wrote', {
      requestId: ctx.requestId,
      missing: missing.slice(0, 5).map((m) => `${m.importer} -> ${m.spec}`),
    })
    return { ...empty, manifest, skipped }
  }
  doc = barrelled.html


  logger.info('Per-file build assembled', {
    requestId: ctx.requestId,
    preset: ctx.presetName,
    kind: ctx.kind,
    effort: ctx.effort,
    files: written.length,
    screens: manifest.screens.length,
    components: manifest.components.length,
    skipped,
  })
  return { html: doc, written, skipped, manifest }
}

/** One fenced block. The transport's own writer is used for edits; this is the first write. */
function fenceOf(path: string, body: string): string {
  return `@@@makeui:file ${path}\n${body.replace(/\s+$/, '')}\n@@@makeui:endfile\n\n`
}

/** Reads a fenced response back into files, tolerating a stray preamble. */
function readFences(source: string): Map<string, string> {
  const out = new Map<string, string>()
  let path: string | null = null
  let body: string[] = []
  const flush = () => {
    if (path && body.length) out.set(path, body.join('\n').replace(/\s+$/, ''))
  }
  for (const line of source.split('\n')) {
    const t = line.trimEnd()
    if (t.startsWith('@@@makeui:file ')) {
      flush()
      path = t.slice('@@@makeui:file '.length).trim()
      body = []
      continue
    }
    if (t === '@@@makeui:endfile') {
      flush()
      path = null
      body = []
      continue
    }
    if (path) body.push(line)
  }
  flush()
  return out
}

/**
 * The slice of the specification a file needs, or all of it.
 *
 * A screen's own section is what makes its call worth having: the interaction
 * inventory lists every control on that screen, and handing a file only its own
 * rows is what leaves room to implement them. Matching is by the screen's id and
 * its component name, both of which the specification uses, and it falls back to
 * the whole specification rather than to nothing — a file written against too
 * much context is merely expensive, one written against none is a guess.
 */
function relevantSpec(spec: string, file: PlannedFile): string {
  const keys = [file.screenId, file.path.split('/').pop()?.replace(/\.\w+$/, '')]
    .filter((k): k is string => Boolean(k && k.length >= 3))
  if (keys.length === 0) return spec.slice(0, FALLBACK_SPEC_CHARS)

  const paragraphs = spec.split(/\n{2,}/)
  const hits = paragraphs.filter((p) => keys.some((k) => p.includes(k)))
  const joined = hits.join('\n\n')
  // Under a page of hits means the match was too narrow to be the file's brief.
  if (joined.length < 600) return spec.slice(0, FALLBACK_SPEC_CHARS)
  return joined.slice(0, PER_FILE_SPEC_CHARS)
}

