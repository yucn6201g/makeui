import { reactFiles } from '../audit/interaction-audit.js'
import { sourceFiles, parses, cleanFile, writeFile, importsLost, projectKind } from '../repair/repair-files.js'
import { lean, restore, EMBEDDED_IMAGE_NOTE } from '../../utils/embedded-images.js'
import { frameworkFor, type OutputKind } from '../../config/frameworks.js'
import { FORM_CONTROL_SIZING } from '../prompts/prompt-contracts.js'
import { logger } from '../../utils/logger.js'
import { firstJsonObject } from '../../utils/model-json.js'
import { changeSize } from '../../utils/change-size.js'
import { applyPatchReply, isPatchReply, MIN_PATCH_CHARS, PATCH_REPLY_RULES } from '../repair/patch-reply.js'
import { isModelUnavailable } from '../../utils/failure-message.js'

/**
 * Applies a user's change instruction to a React project one file at a time.
 *
 * The edit path asked for the whole project back in a single response — the same
 * request shape the repair pass was measured failing at, and for the same reason.
 * A generated project is thirty-odd files and eighty kilobytes; re-emitting all
 * of it to add one screen means the model rewrites thirty files it was not asked
 * to touch, and every one of them is a chance to drop an export, lose a handler
 * or truncate. Structural edits were the standing complaint about this product,
 * and this is the shape that produced them.
 *
 * So it is split the way the work is shaped. One cheap call sees the file list
 * and the instruction and says which files change and which are new. Then one
 * call per file. Each response is a single file, which is a thing a model gets
 * right, and the calls are independent so they run at once.
 *
 * Two things are decided here rather than asked for, because a model that
 * forgets them produces a change that looks applied and is not:
 *
 *   - A new screen drags its routing with it. A screen file nothing routes to is
 *     unreachable, which is a defect the verifier reports and the user
 *     experiences as "the screen was not added".
 *   - A file is only written back if it parses, and the document is re-checked
 *     after splicing rather than before.
 *
 * Nothing here decides whether the edit is kept. The caller re-renders and
 * applies the same rule as everything else: keep it only if it measured better.
 */

/** One thing the request asks for, as the router decomposed it. */
export interface RequestPart {
  text: string;
}

/** A file the planner says the instruction touches. */
interface FileEditPlan {
  path: string
  /** Why this file is in the plan, in the planner's words. Carried into the edit call. */
  reason: string
  /** True when the planner named a path the project does not have yet. */
  create: boolean
  /** Set when the file was added by the routing safety net rather than the planner. */
  implied?: boolean
  /**
   * Which of the request's parts this file serves, 1-based.
   *
   * Empty when the request had only one part, or when the planner did not say —
   * and an unstated mapping means the file gets the whole instruction, which is
   * what every file got before this existed. Narrowing is an improvement to
   * make where it is known, never a guess to make where it is not.
   */
  parts?: number[]
  /**
   * Set when this file is only in the plan to serve a new screen.
   *
   * Routing entries and the link that opens it have no reason to exist if the
   * screen does not. Writing them anyway leaves the project in a state nothing
   * asked for: measured on a real edit, routes.ts gained a `contact` route and
   * the footer link was wired to it while ContactScreen.tsx and the App branch
   * were both reverted — so the link the user pressed now navigated to a route
   * that rendered nothing. Half an edit is not a smaller edit.
   */
  servesNewScreen?: boolean
}

/**
 * Built per framework, because the wrong one is worse than a vague one.
 *
 * This opened "You plan a change to a TypeScript React project" for every
 * project of any kind. Handed a Vue project the model did the only thing that
 * sentence permits — it named `.tsx` paths — and every one of them was then
 * thrown out by the path filter for not being a file this project could hold.
 * An empty plan is indistinguishable from "the instruction cannot be carried
 * out", so the caller fell through to the whole-document rewrite, and that is
 * where a Vue project came back as something else.
 */
const plannerSystem = (kind: OutputKind): string => {
  const fw = frameworkFor(kind)
  return `You plan a change to a ${fw.label} project.

You are given the project's file paths, its routing file, and one change
instruction from the user. Decide which files must be edited or created.

Project conventions:
- Screens live in src/screens/ as ${fw.componentExt} files, and are branched on in the shell component.
- The set of screens is declared in src/routes.ts (a ScreenId union and a NAV_ITEMS list).
- Shared pieces live in src/components/, styling in src/styles/globals.css.
- Adding a screen therefore means: the new screen file, plus routes.ts, plus the shell.

Rules:
- Use paths exactly as listed. To create a file, name the path it should have,
  following the layout of the existing paths — and the extension the existing
  files of that kind already use. This project has no ${kind === 'react' ? '.vue' : '.tsx or .jsx'} files
  and must not gain any.
- Name the fewest files that actually carry out the change. Every file you name
  will be rewritten in full, so do not list a file "for context".
- A pure styling change belongs in the CSS file, not in every component that
  uses the token.
- A question or a problem report about this UI — 「画像が出てない」「ボタンが
  動かない」「どうすべき？」 — IS a change request: it asks you to find the
  cause and fix it. Use the PROJECT FACTS, when they are given, to find the
  files that cause it, and name them. Declining it sends the whole document to
  a full rewrite, which is the most expensive and the most damaging thing this
  pipeline can do.
- Return an empty list only when the request is not about this UI at all, or
  asks for something the project has no place for.

Return only JSON. Include "parts" only when the request was listed as having
several; it is the numbers from that list which this file serves:
{"files":[{"path":"src/screens/ReportScreen${fw.componentExt}","reason":"new screen listing monthly reports","parts":[1]}]}`
}

/**
 * The same sizing rule generation is held to, imported rather than restated.
 *
 * An edit that adds a form was written by a call that had never been told how
 * big a text field should be, so every edit was a fresh chance to reintroduce
 * the 24px input the build had been careful to avoid. Imported because a rule
 * written out twice is one rule until somebody edits one copy.
 */
/**
 * Blocks rather than a whole file, where the arithmetic says they pay.
 *
 * The edit path has always asked for the complete file back, and it changes
 * almost none of it: measured over 60 days, an edited file keeps 96% of its
 * lines (median 4% changed, p90 13%). The repair path asks for the same change
 * as SEARCH/REPLACE blocks, and its measured replies at that change share come
 * to 14% of the file — so this is the same form, applied to the path whose
 * changes are the smallest in the pipeline.
 *
 * The saving is the smaller half of the reason. A block cannot drop an export,
 * truncate a component or quietly rewrite a handler it was not asked about,
 * because it never re-emits them — and those are exactly the failures this path
 * logged over the same window: 5 files reverted for importing a module nothing
 * wrote, 3 broken after splicing, 6 that would not parse. A patch that misses
 * fails loudly and costs one whole-file call, which is what an edit cost
 * anyway.
 *
 * Only for a file that already exists, and only above `MIN_PATCH_CHARS`. A new
 * file has nothing to search for, and a short one costs more as blocks than as
 * itself.
 */
const editPatchWorthy = (create: boolean | undefined, chars: number): boolean =>
  !create && chars >= MIN_PATCH_CHARS

const fileSystem = (kind: OutputKind, reply: 'patch' | 'whole' = 'whole'): string => {
  const fw = frameworkFor(kind)
  return `You write one file of a ${fw.label} project, applying a change.
${FORM_CONTROL_SIZING}

Rules:
${reply === 'patch'
    ? PATCH_REPLY_RULES
    : `- Return the COMPLETE file and nothing else. No markdown, no fences, no
  commentary, no explanation before or after.`}
- Carry out the instruction as it affects THIS file. Leave everything else in the
  file — the design, the copy, the structure, the exports — exactly as it is.
- Keep the file's imports working. You may import a file that exists in the
  project or one the plan says is being created; you may not add a package
  dependency. Installed packages: ${fw.packages}.
- Preserve TypeScript: real annotations, real prop types, no "any".
- The file must still export what other files import from it, unless the
  instruction is specifically to change that.
- Everything you add must work: real state, real handlers, real empty and
  loading states. No placeholder text, no "coming soon", no dead controls.
- NO EMOJI anywhere in the interface. If an icon is needed use an inline SVG.

${fw.editGuard}`
}

/*
 * Which files are routing and which are screens is a per-framework question.
 *
 * `/^src\/(routes|App)\.tsx?$/` matches nothing in a Vue project — the shell is
 * `App.vue` — so the planner was never shown the file that decides what screens
 * exist, and the safety net that adds routing alongside a new screen could never
 * fire. Both now come from the framework table.
 */

/**
 * Files holding a link that goes nowhere and whose label the instruction names.
 *
 * The third thing decided here rather than asked for, and the one the user
 * actually reported. Measured on 「お問い合わせのリンクを押したときに表示される
 * お問い合わせページを作成してください」: the planner produced the screen, the
 * route and the App branch, all correct — and left Footer.tsx alone, so
 * `<a href="#">お問い合わせ</a>` still went nowhere. Every file the user was
 * asked to believe in existed, and the one thing they described doing did not
 * work.
 *
 * The match is deliberately narrow: a link with `href="#"` is a link that
 * demonstrably goes nowhere, and its own visible label appearing in the
 * instruction is about as direct a statement of intent as text gets. Anything
 * looser would rewrite a shell component on every edit.
 */
/**
 * How this particular project moves between screens, quoted from itself.
 *
 * Without it the model reaches for what it knows, which is React Router:
 * measured on a real edit, Footer.tsx came back importing
 * `../hooks/useNavigate` — a file this project does not have and never had. The
 * import gate caught it and reverted the file, so nothing broke and nothing
 * happened, which is the failure the user reported as 「反映されない」.
 *
 * A line of the project's own code is a better instruction than any description
 * of it, because it carries the real name, the real path and the real shape.
 */
function navigationExample(files: Map<string, string>): string {
  /**
   * All three router directories, plus anything named for navigation.
   *
   * React keeps the router in `src/hooks/`, Vue in `src/composables/` and
   * Svelte in `src/lib/`. The hard-coded `^src/hooks/` this replaces named one
   * of the three and returned nothing for the other two — and this hint matters
   * most exactly where it was silent, because a model with no example of how a
   * Vue project navigates reaches for vue-router, which is not installed.
   */
  const hooks = [...files.keys()].filter(
    (p) => /^src\/(hooks|composables|lib)\//.test(p) || /nav/i.test(p)
  )
  const calls: string[] = []
  for (const [path, body] of files) {
    const m = body.match(/^.*\b(?:useNavigation|useNav|navigate|setRoute|goTo|setScreen)\s*[({].*$/m)
    if (m) calls.push(`${path} 内: ${m[0].trim().slice(0, 160)}`)
    if (calls.length >= 2) break
  }
  if (calls.length === 0 && hooks.length === 0) return ''
  return [
    '',
    'このプロジェクトの画面遷移の実装（これをそのまま使うこと）:',
    ...(hooks.length ? [`- ナビゲーション関連のファイル: ${hooks.join(', ')}`] : []),
    ...calls.map((c) => `- ${c}`),
    'ルーターのパッケージ（React Router・vue-router など）や独自の useNavigate を持ち込まないこと。',
    '存在しないファイルを import した時点で、',
    'この変更は破棄されます（アプリ全体が起動しなくなるため）。',
  ].join('\n')
}

function entryPointFiles(
  files: Map<string, string>,
  instruction: string,
  fw: { componentExt: string; screenFile: RegExp }
): { path: string; label: string }[] {
  const found: { path: string; label: string }[] = []
  for (const [path, body] of files) {
    if (!path.endsWith(fw.componentExt) || fw.screenFile.test(path)) continue
    if (!/href=\s*["'{]\s*['"]?#['"]?\s*[}"']/.test(body)) continue
    for (const m of body.matchAll(/>\s*([^<>{}\n]{2,20}?)\s*</g)) {
      const label = m[1].trim()
      if (label.length >= 2 && instruction.includes(label)) {
        found.push({ path, label })
        break
      }
    }
  }
  return found.slice(0, 2)
}

/**
 * Asks which files the instruction touches.
 *
 * Cheap by construction: it sees paths, the routing file and the instruction,
 * never the body of a component. On any trouble it returns an empty plan and the
 * caller falls back to the whole-document rewrite, so this can only add.
 */
/**
 * The text the instruction quotes, so the planner can be told where it lives.
 *
 * The planner sees the project's file PATHS and the routing files, and nothing
 * else — not one byte of any screen. So 「一部の画面の上部に「I need to create ~」
 * などの無関係な文言が表示されています」 asks it which file contains a string, from
 * a list of filenames. It cannot know, and it says so: one planner reply in the
 * log is 「I cannot fix this issue because you have not provided the content of」.
 *
 * A decline is not a decline. The caller falls back to rewriting the whole
 * document — about 77,000 tokens against this call's 3,000 — and a full rewrite
 * is where an instruction goes to be half-applied. Seven of the twenty-six edits
 * in thirty days took that path.
 *
 * Which file contains a string is not a judgement, and the repair loop already
 * settled this argument: `interaction-audit` attaches grep results to a defect
 * and the repair planner is skipped for those. Same reasoning, same technique,
 * the other side of the product.
 */

/**
 * Quoted spans, in the three quotation marks these instructions actually use.
 *
 * 「」 because the requests are Japanese, "" and '' because the text being quoted
 * is often the app's own English or a class name. Backticks are deliberately
 * out: they are how people write code in prose and a search for `onClick` names
 * every screen, which is the same as naming none.
 */
const QUOTED = /[「『]([^」』]{2,80})[」』]|"([^"\n]{2,80})"|'([^'\n]{2,80})'/g

/** Below this a quote matches everything. 「×」 is a real instruction and a useless search. */
const MIN_QUOTE = 2

/** More than this and the search has not narrowed anything. */
const MAX_LOCATED = 4

/**
 * Files whose contents hold something the instruction quoted.
 *
 * Returns paths only. The planner still decides what to do with them — it has
 * the instruction and the routing, and a file containing the words is not always
 * the file to change — but it can no longer fail for want of knowing where the
 * words are.
 */
export function locateQuotedText(
  files: Map<string, string>,
  instruction: string
): { path: string; quote: string }[] {
  const quotes = [...instruction.matchAll(QUOTED)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim())
    .filter((q) => q.length >= MIN_QUOTE)
  if (quotes.length === 0) return []

  const hits: { path: string; quote: string }[] = []
  for (const [path, body] of files) {
    for (const quote of quotes) {
      if (!body.includes(quote)) continue
      hits.push({ path, quote })
      break
    }
    if (hits.length >= MAX_LOCATED) break
  }
  return hits
}

export async function planFileEdits(
  html: string,
  instruction: string,
  changeSpec: string,
  invoke: (system: string, user: string) => Promise<string>,
  /**
   * The user's data file, sampled.
   *
   * The planner needs it as much as the editor does: replacing seed data can
   * mean a new file (a fixtures module, a filter component the record count now
   * warrants), and a planner that has not seen the data cannot know that.
   */
  dataContext?: string,
  /**
   * The request's separate parts, when it has more than one.
   *
   * Numbered, and the planner is asked to say which numbers each file serves.
   * Without this the planner has to decompose the sentence AND map it to files
   * in one reading; with it, the decomposition is already done and the reading
   * is only the mapping.
   */
  parts?: RequestPart[]
): Promise<FileEditPlan[]> {
  const kind = projectKind(html)
  const fw = frameworkFor(kind)
  const files = sourceFiles(html, kind)
  if (files.size === 0) {
    logger.info('File edit declined: the project has no editable source files', { kind })
    return []
  }

  const routing = [...files.entries()].filter(([p]) => fw.routingFiles.test(p))
  /*
   * Where the words the instruction quoted actually are — see `locateQuotedText`.
   *
   * Given to the planner as a fact rather than as the answer: it still chooses,
   * and a file containing the words is not always the file to change. What it
   * can no longer do is fail for want of knowing where they are.
   */
  const located = locateQuotedText(files, instruction)
  if (located.length > 0) {
    logger.info('Located the text the edit quotes', {
      quotes: located.map((h) => `${h.path}: ${h.quote.slice(0, 30)}`),
    })
  }
  const user = [
    'PROJECT FILES:',
    ...[...files.keys()].map((p) => `- ${p}`),
    '',
    ...(located.length
      ? [
          'THESE FILES CONTAIN THE TEXT THE INSTRUCTION QUOTES:',
          ...located.map((h) => `- ${h.path}  (contains 「${h.quote.slice(0, 40)}」)`),
          '',
        ]
      : []),
    ...(routing.length
      ? ['ROUTING:', ...routing.map(([p, b]) => `--- ${p} ---\n${b.slice(0, 4000)}`), '']
      : []),
    `CHANGE INSTRUCTION: "${instruction}"${dataContext ?? ''}`,
    ...(parts && parts.length > 1
      ? [
          '',
          'This request asks for several separate things:',
          ...parts.map((part, i) => `  ${i + 1}. ${part.text}`),
          '',
          'For each file, `parts` lists which of these numbers it serves.',
        ]
      : []),
    ...(changeSpec ? ['', 'The change has been specified in detail:', changeSpec.slice(0, 12000)] : []),
  ].join('\n')

  /**
   * An empty plan costs about nineteen per-file edits.
   *
   * A decline here is not a decline: the caller falls back to rewriting the
   * whole document, which is ~77,000 tokens against this call's ~3,000, and the
   * repository's own note records that a full rewrite loses content. So a plan
   * that came back unusable is worth asking for once more, with the reason.
   *
   * Once, and only when the reason is one a second ask can change. Two of the
   * shapes below are the model answering badly; `files.size === 0` above is the
   * project having nothing to edit, and no number of retries makes a file
   * appear. A refusal is separate again and is rethrown, because answering "the
   * account is out of tokens" with a bigger call cannot work.
   *
   * The retry is the same technique the per-file edit already uses for a body
   * that would not parse: name what was wrong with the last answer rather than
   * repeating the question. Measured there at three rescues in five.
   */
  let named: { path: string; reason?: string; parts?: unknown }[] = []
  let complaint = ''
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const raw = await invoke(
        plannerSystem(kind),
        tries === 0 ? user : `${user}

--- 前回の回答は使えませんでした ---
${complaint}

このプロジェクトのファイルは上の PROJECT FILES に列挙されています。その中から、
依頼を実現するために書き換える必要があるファイルを必ず1つ以上選んでください。
新しく作る必要があるファイルは、同じ命名規則に従うパスで挙げてください。
出力は {"files":[{"path":"...","reason":"..."}]} のJSONだけにしてください。`
      )
      const parsed = firstJsonObject<{ files?: { path: string; reason?: string; parts?: unknown }[] }>(raw)
      if (!parsed) {
        complaint = 'JSONが含まれていませんでした。'
        logger.warn('File edit planner returned no JSON', { attempt: tries + 1, preview: raw.slice(0, 200) })
        continue
      }
      named = Array.isArray(parsed.files) ? parsed.files : []
      if (named.length > 0) break
      complaint = 'files が空でした。'
      // Nine of the ten declines in sixty days logged nothing at all, so the
      // 77,000-token rewrite they caused had no recorded reason.
      logger.info('File edit planner named no files', { attempt: tries + 1, preview: raw.slice(0, 200) })
    } catch (e) {
      // See planFileRepairs: a refusal must not be answered by attempting the
      // largest call in the pipeline, and a second ask will meet the same wall.
      if (isModelUnavailable(e)) {
        logger.warn('File edit planning refused; not escalating to a full rewrite', { error: String(e) })
        throw e
      }
      logger.warn('File edit planning failed', { attempt: tries + 1, error: String(e) })
      complaint = '回答を読み取れませんでした。'
    }
  }
  if (named.length === 0 && located.length > 0) {
    /*
     * The planner gave up; the grep did not.
     *
     * Falling through here costs a full-document rewrite, which is about
     * twenty-five times this call and is the path an instruction most often
     * comes back half-applied from. A file that demonstrably contains the text
     * the user quoted is a better answer than rewriting everything — it is the
     * same evidence the planner was handed and declined to act on.
     */
    logger.info('Planner named no files; using the ones that contain the quoted text', {
      paths: located.map((h) => h.path),
    })
    named = located.map((h) => ({ path: h.path, reason: `「${h.quote.slice(0, 60)}」を含むファイル` }))
  }
  if (named.length === 0) {
    logger.info('File edit declined: the planner named no files after a retry')
    return []
  }

  const plans = new Map<string, FileEditPlan>()
  for (const entry of named) {
    const path = String(entry?.path ?? '').trim().replace(/^\.?\//, '')
    /**
     * A path outside the project's own tree is a hallucination, not a plan —
     * and so is one carrying an extension this framework does not use. The
     * literal `(tsx|ts|css|md)` this replaces was the silent half of the Vue
     * bug: the planner named `.vue` screens correctly and every one of them was
     * dropped here without a word, leaving an empty plan that read as a refusal.
     */
    if (!fw.allowedPath.test(path)) {
      logger.info('File edit planner named a path this project cannot hold', { path, kind })
      continue
    }
    if (plans.has(path)) continue
    plans.set(path, {
      path,
      reason: String(entry?.reason ?? '').slice(0, 400),
      create: !files.has(path),
      // Only numbers that name a part that exists. A planner citing part 5 of a
      // three-part request is describing something the user did not ask for, and
      // acting on it would send a file an instruction from nowhere.
      parts: Array.isArray(entry?.parts)
        ? [
            ...new Set(
              entry.parts
                .map((n) => Number(n))
                .filter((n) => Number.isInteger(n) && n >= 1 && n <= (parts?.length ?? 0))
            ),
          ]
        : undefined,
    })
  }
  if (plans.size === 0) {
    // Every named path was rejected — see the allowedPath log above for which.
    logger.info('File edit declined: every named path was rejected', { kind, named: named.length })
    return []
  }

  /**
   * A new screen drags its routing with it.
   *
   * Left to the planner this is remembered most of the time, and the times it is
   * not are indistinguishable from success until someone opens the app: the file
   * is in the project, the code compiles, and nothing links to the screen. The
   * verifier calls it `screen-unreachable`; the user calls it "the screen was
   * not added". It is decided here instead of asked for.
   */
  const addsScreen = [...plans.values()].some((p) => p.create && fw.screenFile.test(p.path))
  if (addsScreen) {
    const added = [...plans.values()].filter((p) => p.create && fw.screenFile.test(p.path)).map((p) => p.path)
    for (const [path] of files) {
      if (!fw.routingFiles.test(path) || plans.has(path)) continue
      plans.set(path, {
        path,
        reason: `Register the new screen${added.length > 1 ? 's' : ''} (${added.join(', ')}) so it is reachable: add it to the screen union, the navigation list and the branch that renders screens, following exactly the pattern the existing screens use.`,
        create: false,
        implied: true,
        servesNewScreen: true,
      })
    }

    /**
     * And the control the user said they would press.
     *
     * Not marked `implied`: if this file fails, the screen is still worth
     * keeping — it exists, it is routed, and it can be reached from the nav.
     * Losing the whole change because a footer would not rewrite is a worse
     * trade than an unwired link.
     */
    for (const { path, label } of entryPointFiles(files, instruction, fw)) {
      if (plans.has(path)) continue
      plans.set(path, {
        path,
        reason:
          `This file contains a link labelled 「${label}」 with href="#", which goes nowhere. ` +
          `Wire that existing link to open the new screen (${added.join(', ')}). Change nothing ` +
          `else about the file — do not restyle it and do not touch the other links.` +
          navigationExample(files),
        create: false,
        servesNewScreen: true,
      })
    }
  }

  return [...plans.values()]
}

interface FileEditResult {
  html: string
  written: string[]
  skipped: string[]
}

/**
 * A sibling file, offered as the house style when writing a new one.
 *
 * A new screen written with no reference is a new screen in the model's own
 * default idiom, next to twelve that share a different one — the fastest way to
 * make an added screen look bolted on. The nearest existing sibling is the
 * cheapest available statement of what the project's components look like.
 */
function styleReference(
  files: Map<string, string>,
  path: string,
  fw: { componentExt: string; screenFile: RegExp }
): string {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const sibling =
    [...files.entries()].find(([p]) => p !== path && p.startsWith(`${dir}/`) && p.endsWith(fw.componentExt)) ??
    [...files.entries()].find(([p]) => fw.screenFile.test(p))
  if (!sibling) return ''
  return `\n--- ${sibling[0]} (an existing file: follow its conventions, imports and design language) ---\n${sibling[1].slice(0, 6000)}\n`
}

/**
 * Runs the planned edits and splices the results back in.
 *
 * Concurrent, because the calls are genuinely independent — each sees one file
 * and returns one file. Splicing happens after they all land, so a failure in one
 * leaves the others alone and the document is never half-written.
 */
/**
 * The plan again, once it is known which parts of it happened.
 *
 * Everything the edit path checks afterwards is about defects the edit
 * INTRODUCED — the tell audit diffed against before, the module defects diffed,
 * the browser check for console errors and dead navigation. Nothing asks
 * whether the instruction was carried out, so an edit that applied three of a
 * request's four parts came back with no new defects, a clean browser and the
 * word "success".
 *
 * The information to say otherwise was already there and only being logged:
 * `applyFileEdits` returns what it wrote and what it could not. This turns that
 * into the same lines the user was shown before the edit ran, with the outcome
 * against each — so a partial edit reads as a partial edit.
 *
 * `plan.reason` carries the planner's own words for what each file was for
 * (「CSVエクスポート追加」), which is what makes an unapplied line legible as a
 * missing REQUEST rather than as a filename that failed.
 */
interface EditOutcome {
  /** The lines to show, each marked applied or not. */
  summary: string;
  /** Planned files that did not land, for the caller to log and report. */
  unapplied: FileEditPlan[];
  /** True when some of the plan landed and some did not — the silent case. */
  partial: boolean;
}

export function describeEditOutcome(
  plans: FileEditPlan[],
  written: string[],
  skipped: string[]
): EditOutcome {
  const done = new Set(written);
  /*
   * Anything planned and not written counts as unapplied, whether or not it
   * reached the `skipped` list. A file can fall out of an edit in several ways —
   * an unparsable reply, a splice that would not apply, a body rejected as too
   * short — and the union is the honest set. `skipped` is used to keep a file
   * that was dropped without ever being planned from being lost.
   */
  const unapplied = plans.filter((p) => !done.has(p.path));
  const extraSkips = skipped.filter((path) => !plans.some((p) => p.path === path));

  const line = (label: string, path: string, reason: string | undefined, ok: boolean) =>
    `${ok ? '✓' : '×'} ${label} ${path}${reason ? ` — ${reason}` : ''}${ok ? '' : '（適用できませんでした）'}`;

  const summary = [
    ...plans.map((p) => line(p.create ? '新規' : '編集', p.path, p.reason, done.has(p.path))),
    ...extraSkips.map((path) => line('編集', path, undefined, false)),
  ].join('\n');

  return { summary, unapplied, partial: written.length > 0 && unapplied.length > 0 };
}

/**
 * A real, minimal screen for a new one that would not come back.
 *
 * Not a diagnostic stub. `componentStub` in framework-fixups says 「ビルドできな
 * かったため差し替えられています」 and is meant to be read by whoever is debugging
 * a project that will not compile; this is meant to be read by the person who
 * asked for the screen, and it is a screen — a heading and a line, in the
 * project's own framework, with no classes so it inherits whatever the
 * stylesheet gives the document.
 *
 * ## Why anything at all
 *
 * Measured on real edits: a new `ContactScreen` came back unparseable twice, and
 * the consistency net below correctly dropped everything that served it — the
 * route, the App branch, the footer link. The user's 「お問い合わせページを作成して
 * ください」 then changed nothing at all, and the edit reported success. That is
 * the worst of the three outcomes: no screen, no route, and no sign that
 * anything went wrong.
 *
 * A scaffold turns it into the second-worst, which is a large gap: the route
 * resolves, the link goes somewhere, everything else in the change survives, and
 * the screen is thin rather than absent. `screen-thin` then fires on it, so the
 * repair loop is told about it in the same run.
 *
 * Only for a file being CREATED. An edit to a file that already exists is
 * dropped rather than scaffolded, and that stays: the original is intact and a
 * working file is better than a placeholder of one.
 */
function newScreenScaffold(kind: OutputKind, filePath: string): string {
  /** `src/screens/ContactScreen.tsx` -> `Contact` */
  const base = (filePath.split('/').pop() ?? filePath).replace(/\.\w+$/, '');
  const name = base.replace(/(Screen|Page|View)$/, '') || base;
  const heading = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  const note = 'この画面はまだ内容がありません。';

  if (kind === 'vue') {
    return `<template>\n  <section>\n    <h1>${heading}</h1>\n    <p>${note}</p>\n  </section>\n</template>\n`;
  }
  return (
    `export default function ${base}() {\n` +
    `  return (\n` +
    `    <section>\n` +
    `      <h1>${heading}</h1>\n` +
    `      <p>${note}</p>\n` +
    `    </section>\n` +
    `  );\n` +
    `}\n`
  );
}

export async function applyFileEdits(
  html: string,
  plans: FileEditPlan[],
  instruction: string,
  changeSpec: string,
  invoke: (system: string, user: string) => Promise<string>,
  /** The user's data file, sampled — this is the call that writes the records. */
  dataContext?: string,
  /** The request's separate parts, so a file can be told only its own. */
  parts?: RequestPart[]
): Promise<FileEditResult> {
  const kind = projectKind(html)
  const fw = frameworkFor(kind)
  const files = sourceFiles(html, kind)
  const planned = plans.map((p) => `- ${p.path}${p.create ? ' (new)' : ''}`).join('\n')

  const results = await Promise.all(
    plans.map(async (plan) => {
      // Embedded pictures come out before this body reaches a prompt. The
      // seed-data file of a shop UI measured 527,914 characters with two
      // photographs in it - about nine edits' worth of tokens for one file.
      // See utils/embedded-images.ts.
      const leaned = lean(files.get(plan.path) ?? '')
      /*
       * The parts this file serves, when the mapping is known.
       *
       * Every file used to be handed the whole instruction, so a file whose job
       * was a colour token also read 「CSVエクスポートを付けて」. Narrowing only
       * where the planner said which parts apply: an unstated mapping falls back
       * to the whole instruction, because a file given the wrong fragment is a
       * worse outcome than one given too much.
       */
      const mine = parts && plan.parts?.length
        ? plan.parts.map((n) => parts[n - 1]).filter(Boolean)
        : null;
      const user = [
        `CHANGE INSTRUCTION: "${instruction}"${dataContext ?? ''}`,
        ...(mine
          ? [
              '',
              'Of that request, THIS file is responsible only for:',
              ...mine.map((part) => `  - ${part.text}`),
              'Do not attempt the rest of the request here; other files cover it.',
            ]
          : []),
        '',
        `Files being changed for this instruction:\n${planned}`,
        '',
        `YOUR FILE: ${plan.path}${plan.create ? ' — it does not exist yet; write it.' : ''}`,
        plan.reason ? `Its part in the change: ${plan.reason}` : '',
        ...(changeSpec
          ? ['', 'BUILD CONTRACT — implement the parts of this that belong to your file:', changeSpec.slice(0, 12000)]
          : []),
        '',
        ...(plan.create
          ? [
              /**
               * A budget, because the failures are all at the top of the range.
               *
               * Measured on 「お問い合わせページを作成してください」: a 10,034-character
               * ContactScreen came back with unbalanced JSX at line 237, and the
               * retry produced a different unbalanced file at line 144. The
               * model had added a modal nobody asked for. Nothing about a
               * contact form needs three hundred lines, and a file that does not
               * parse is worth zero of them.
               */
              '制約: このファイルは200行以内・6000文字以内に収めてください。',
              'マークアップの入れ子は浅く保ち、開いたタグを必ず閉じてください。',
              '依頼にない機能（モーダル、タブ、ウィザード、アニメーション）を足さないこと。',
              '必要な要素だけを、確実に動く形で書いてください。',
              '',
              'Existing project files, for import paths:',
              ...[...files.keys()].map((p) => `- ${p}`),
              styleReference(files, plan.path, fw),
            ]
          : ['--- current contents ---', leaned.text]),
      ].join('\n')

      // Lean against lean: an embedded picture in this file would otherwise
      // make every ratio below a statement about base64 rather than code.
      const before = leaned.text.length
      /**
       * One retry, carrying the parser's complaint back to the model.
       *
       * Not a general "try again" — the same prompt twice is re-sampling, which
       * this codebase has repeatedly measured as no better than once. This is a
       * different prompt: it names the line and the error, which is information
       * the first attempt did not have.
       *
       * It exists because of what dropping a file actually costs. Measured
       * twice in one hour of real use: a new ContactScreen.tsx came back
       * unparseable, was correctly dropped, and the user's 「お問い合わせページを
       * 作成してください」 produced no screen at all. One file failing collapses
       * the whole change, so it is worth one more call to save it.
       */
      let attempt = ''
      let complaint = ''
      /*
       * Blocks on the first attempt only. A retry exists because the last reply
       * did not parse, and the form to ask for then is the one that cannot fail
       * halfway.
       */
      const wantsPatch = editPatchWorthy(plan.create, leaned.text.length)
      let format: 'patch' | 'whole' = 'whole'
      let replyChars = 0
      for (let tries = 0; tries < 2; tries++) {
        try {
          const sys = (reply: 'patch' | 'whole'): string =>
            leaned.images.size > 0 ? fileSystem(kind, reply) + EMBEDDED_IMAGE_NOTE : fileSystem(kind, reply)
          const ask: 'patch' | 'whole' = tries === 0 && wantsPatch ? 'patch' : 'whole'
          const prompt = tries === 0 ? user : `${user}

--- 前回の出力はパースできませんでした ---
${complaint}

前回の出力は ${attempt.split('\n').length} 行ありました。同じものを直すのではなく、
**もっと小さく作り直してください**。JSXの入れ子が深くなるほど閉じ忘れが起きます。
- モーダル・条件付きの大きなブロック・入れ子の三項演算子を使わないこと
- 100行以内に収めること。依頼の中心にある要素だけを書くこと
- 開いたタグをその場で閉じ、深さは3段までにすること
- このプロジェクトの形式（${fw.label} / ${fw.componentExt}）から外れないこと
ファイル全体を返すこと。説明や記号を本文の前後に付けないこと。`
          const answer = await invoke(sys(ask), prompt)
          replyChars = answer.length
          format = 'whole'
          let raw: string
          if (ask === 'patch' && isPatchReply(answer)) {
            const applied = applyPatchReply(leaned.text, answer)
            if (applied.ok) {
              raw = applied.body
              format = 'patch'
            } else {
              /*
               * One call for the file, told why the blocks did not land — the
               * same recovery the repair path makes, for the same reason: a
               * block that fails to match is a model copying inexactly, which
               * is a different failure from a model that could not make the
               * change, and dropping the file would count it as the second.
               */
              logger.info('File edit patch did not apply', {
                path: plan.path, error: applied.error, blocks: applied.blocks,
                replyChars: answer.length, head: answer.slice(0, 300),
              })
              const whole = await invoke(
                sys('whole'),
                `${prompt}\n\n--- 直前の回答の SEARCH/REPLACE ブロックは適用できませんでした（${applied.error}）---\n` +
                  '今回はブロックではなく、変更後のファイル全体を出力してください。'
              )
              replyChars += whole.length
              raw = cleanFile(whole, plan.path)
            }
          } else {
            raw = cleanFile(answer, plan.path)
          }
          /*
           * The pictures go back before anything measures this reply — the
           * length floor and the parse check both read the body, and a body
           * still holding markers is not what will be written.
           */
          const back = restore(raw, leaned.images)
          if (back.missing.length > 0) {
            logger.info('An edited file did not keep every embedded image', {
              path: plan.path, restored: back.restored, dropped: back.missing.length,
            })
          }
          const body = back.text
          /**
           * A stub in place of a file.
           *
           * The repair pass rejects anything under 60% of what it replaced, but
           * an edit may legitimately shrink a file — "remove the filters" is
           * supposed to make it smaller. The floor here only catches the failure
           * that is never legitimate: a response so short it cannot be the file.
           */
          const after = lean(body).text.length
          if (!body || (before > 0 && after < before * 0.35)) {
            logger.info('File edit rejected — response too short', { path: plan.path, before, after })
            return { path: plan.path, body: null }
          }
          const broken = parses(plan.path, body)
          if (!broken) {
            // Same measurement as the repair path — see utils/change-size.ts.
            if (!plan.create) {
              logger.info('File edit change size', {
                path: plan.path,
                ...changeSize(leaned.text, lean(body).text),
                outChars: body.length,
                // What the reply itself cost, next to what a whole file would
                // have. `scripts/repair-change-size.mjs` reads both back, and
                // the verdict on this path needs 30 files it does not yet have.
                format,
                replyChars,
              })
            }
            return { path: plan.path, body }
          }

          const at = /\((\d+):(\d+)\)/.exec(broken)
          const line = at ? (body.split('\n')[Number(at[1]) - 1] ?? '') : ''
          complaint = `${broken}\n該当行: ${line.trim().slice(0, 200)}`
          attempt = body
          logger.info('File edit does not parse', {
            path: plan.path,
            attempt: tries + 1,
            error: broken,
            line: line.trim().slice(0, 200),
          })
        } catch (e) {
          logger.warn('File edit failed', { path: plan.path, attempt: tries + 1, error: String(e) })
          return { path: plan.path, body: null }
        }
      }
      logger.info('File edit rejected — still does not parse after a retry', {
        path: plan.path,
        chars: attempt.length,
      })
      return { path: plan.path, body: null }
    })
  )

  /*
   * A new screen that would not come back gets a scaffold rather than being
   * dropped — see newScreenScaffold. It happens here, before `usable` and
   * `skipped` are taken, because everything below reasons about which paths came
   * back, and a scaffolded screen HAS come back.
   */
  const rescued: string[] = []
  const settled = results.map((r) => {
    if (r.body) return r
    const plan = plans.find((p) => p.path === r.path)
    if (!plan?.create || !fw.screenFile.test(r.path)) return r
    rescued.push(r.path)
    return { path: r.path, body: newScreenScaffold(kind, r.path) }
  })
  if (rescued.length > 0) {
    logger.info('New screens scaffolded after the model could not produce them', {
      paths: rescued,
      note: 'the route and everything serving it survive; screen-thin reports the gap',
    })
  }

  const usable = settled.filter((r): r is { path: string; body: string } => Boolean(r.body))
  const skipped = settled.filter((r) => !r.body).map((r) => r.path)

  /**
   * A new screen whose routing edit failed is worse than no change at all: the
   * project grows a file nothing reaches, and the user is told the edit
   * succeeded. If any implied routing file did not come back, the screen files
   * that required it are dropped too.
   */
  const wrote = new Set(usable.map((r) => r.path))
  const routingLost = plans.some((p) => p.implied && !wrote.has(p.path))
  /**
   * And the converse: the screen itself did not come back.
   *
   * Everything the two nets added — the route, the App branch, the footer link —
   * exists only to reach that screen. Landing them without it leaves the project
   * describing a screen it does not have, and the link the user asked about
   * navigating to a route that renders nothing. Measured exactly that way on a
   * real edit.
   */
  const plannedScreens = plans.filter((p) => p.create && fw.screenFile.test(p.path)).map((p) => p.path)
  const screenLost = plannedScreens.length > 0 && !plannedScreens.some((p) => wrote.has(p))

  const keep = new Set(
    usable
      .filter((r) => {
        const plan = plans.find((p) => p.path === r.path)
        if (routingLost && plan?.create && fw.screenFile.test(r.path)) return false
        if (screenLost && plan?.servesNewScreen) return false
        return true
      })
      .map((r) => r.path)
  )
  if (routingLost || screenLost) {
    logger.info('File edit dropped part of the change to keep it consistent', {
      reason: screenLost ? 'the new screen did not come back' : 'the routing edit did not survive',
      dropped: usable.filter((r) => !keep.has(r.path)).map((r) => r.path),
    })
  }

  const spliceAll = (paths: Set<string>) => {
    let doc = html
    const written: string[] = []
    const unsplicable: string[] = []
    for (const r of usable) {
      if (!paths.has(r.path)) continue
      const next = writeFile(doc, r.path, r.body)
      if (next) {
        doc = next
        written.push(r.path)
      } else {
        unsplicable.push(r.path)
      }
    }
    return { html: doc, written, unsplicable }
  }

  let live = new Set(keep)
  let attempt = spliceAll(live)
  skipped.push(...attempt.unsplicable, ...usable.filter((r) => !keep.has(r.path)).map((r) => r.path))

  /**
   * Check the document, not the responses.
   *
   * Every file parsing on its own is not the same as the assembled project
   * parsing: measured on the repair path, eleven files each passed and the
   * document then failed on the fourth of them. The document is what renders.
   */
  const broken = new Set<string>()
  for (const [path, body] of reactFiles(attempt.html)) {
    if (!live.has(path)) continue
    const err = parses(path, body)
    if (err) {
      broken.add(path)
      /**
       * The line, and the length, because this branch means the body changed
       * between being checked and being read back out of the document — it
       * passed `parses` on the way in. Without the text there is nothing to
       * diagnose: measured on a real edit, a ContactScreen.tsx failed here at
       * line 245 and the log could not say what was on it.
       */
      const at = /\((\d+):(\d+)\)/.exec(err)
      const lines = body.split('\n')
      logger.info('File edit reverted — broken after splicing', {
        path,
        error: err,
        lines: lines.length,
        chars: body.length,
        line: at ? (lines[Number(at[1]) - 1] ?? '').trim().slice(0, 200) : '',
        tail: body.slice(-160).replace(/\n/g, '\\n'),
      })
    }
  }
  if (broken.size > 0) {
    live = new Set([...live].filter((p) => !broken.has(p)))
    attempt = spliceAll(live)
    skipped.push(...broken)
  }

  /**
   * Whether what shipped can be loaded — asked after the reverts, not before.
   *
   * This is the bug that produced the failure users actually saw. The check ran
   * on the document as first spliced, where a new ContactScreen.tsx was present
   * but unparseable; its import from App.tsx therefore resolved, nothing was
   * reported, and only then was ContactScreen dropped for not parsing — leaving
   * App.tsx importing a file that no longer existed. Measured twice in one hour
   * of real use: `Module not found: './screens/ContactScreen'`, a blank
   * application, and an edit the user was told had succeeded.
   *
   * A gate has to be asked about the document that ships. Anything else is a
   * gate on a draft.
   */
  const lost = importsLost(html, attempt.html, live)
  if (lost.size > 0) {
    for (const [path, spec] of lost) {
      logger.info('File edit reverted — imports a module nothing wrote', { path, spec })
      skipped.push(path)
    }
    live = new Set([...live].filter((p) => !lost.has(p)))
    attempt = spliceAll(live)
  }

  return { html: attempt.html, written: attempt.written, skipped }
}
