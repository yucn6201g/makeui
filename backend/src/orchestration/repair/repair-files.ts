import { transform } from 'sucrase'
import type { InteractionDefect } from '../audit/interaction-audit.js'
import { reactFiles } from '../audit/interaction-audit.js'
import { leafModule } from '../generate/leaf-modules.js'
import { unresolvedImports, addMissingBarrels, isProvidedModule } from '../../tools/project/react-bundle.js'
import { detectKind, compileFile } from '../../tools/project/framework-compile.js'
import { frameworkFor, FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import { logger } from '../../utils/logger.js'
import { lean, restore, EMBEDDED_IMAGE_NOTE } from '../../utils/embedded-images.js'
import { isFencedTransport, writeProjectFile } from '../../tools/project/project-transport.js'
import { firstJsonObject } from '../../utils/model-json.js'
import { changeSize } from '../../utils/change-size.js'
import { isModelUnavailable } from '../../utils/failure-message.js'
import { applyPatchReply, isPatchReply, MIN_PATCH_CHARS, PATCH_REPLY_RULES } from './patch-reply.js'

/**
 * Repairs a generated React project one file at a time.
 *
 * The whole-document repair asks for the entire project back in a single
 * response: eighty-eight kilobytes across a dozen files, holding eight unrelated
 * instructions in mind at once. Measured on a real run it returned exactly as
 * many defects as it was given — five deterministic before, five after. It had
 * fixed the missing illustrations folder and broken the icons folder doing it.
 * That is not a model that needs another attempt; it is a request that cannot be
 * answered well.
 *
 * So the work is split the way it is actually shaped. A first cheap call sees
 * only the file list and the defects and says which files each one lives in. Then
 * one call per file, carrying that file and the two or three instructions that
 * concern it. Each response is a single file, which is a thing a model can get
 * right, and the calls are independent so they run at once.
 *
 * Nothing here decides whether the result is kept. The caller re-measures and
 * applies the same rule as every other pass: keep it only if it measurably
 * improved.
 */

/** A file the planner says must change, with the defects that concern it. */
interface FileRepairPlan {
  path: string
  /** Indices into the defect list handed to the planner. */
  defects: InteractionDefect[]
  /** True when the planner named a path the project does not have yet. */
  create: boolean
}

/**
 * The prompts are built per framework rather than written once for React.
 *
 * "Only 'react' and 'react-dom/client' are installed" is a true sentence about
 * one of the three formats and a lie about the other two, and a model told it
 * while holding a `.vue` file does the reasonable thing with a contradiction:
 * it follows the instruction and abandons the file.
 */
const plannerSystem = (kind: OutputKind): string => {
  const fw = frameworkFor(kind)
  return `You route defects to the files that must change in a ${fw.label} project.

You are given the project's file paths and a numbered list of defects. For each
defect, name the files that have to be edited to fix it. A defect may need
several files; a file may serve several defects.

Rules:
- Use paths exactly as listed. To fix a defect that needs a file the project does
  not have, name the path it should have — following the layout of the existing
  paths — and it will be created.
- Name the fewest files that actually fix the defect. Do not list a file "for
  context": every file you name will be rewritten.
- A defect that needs a new file needs TWO kinds of path, and both belong in its
  list: the file to create, and the existing file that will import it. Naming
  only the screen leaves one call trying to create and use a file at once — it
  returns the new file, the screen is never rewritten, and the whole pass is
  discarded. Naming only the new file leaves it written and never rendered,
  which is the defect again.
- A styling or design-token defect belongs to the CSS file, not to every
  component that uses a token.

Return only JSON:
{"assignments":[{"defect":1,"paths":["src/screens/ListScreen${fw.componentExt}"]}]}`
}

/**
 * How much of a file a repair for this defect rewrites, measured per defect.
 *
 * Offering the patch form to every repair was measured, and it did not pay. On
 * the first round after it shipped (6 generations, 50 repaired files,
 * 2026-09-14) the replies came to 96% of what whole files would have been:
 *
 *   stylesheets and the critic's visual findings   replies 2-14% of the file
 *   decomposition / icons / imagery-missing /      replies 2-14x the file
 *   shell-without-nav / screen-thin / blank-render
 *
 * The second group rewrites a third to a half of a screen, and a block carries
 * the lines it replaces as well as the lines replacing them — so past roughly
 * half the file a patch is longer than the file. Worse, those repairs are the
 * ones that create components, and the new components' code came back inside
 * the reply to the screen, outside any block, where it is paid for and thrown
 * away (a 13-line Header repair replied with 3,717 characters).
 *
 * The answer to that was a list of six ids. This is the same answer with the
 * numbers filled in, re-measured 2026-09-18 over 60 days on React and Vue files
 * only (`scripts/repair-change-size.mjs`; 364 of the 382 repaired files were
 * already React or Vue, so removing Svelte moved none of these medians). What
 * the wider window adds is the SHAPE of the trade, from the 98 files that were
 * patched in production, as reply characters against the file they rewrote:
 *
 *   changed <= 5%    n=53   the reply is 14% of the file
 *   changed 5-15%    n=19   71%
 *   changed 15-30%   n=10   173%      <- a patch now costs more than the file
 *   changed > 30%    n=16   219%
 *
 * So the ceiling is a measurement rather than a taste: at a tenth of a file the
 * form pays six times over, and by a fifth it has stopped paying at all.
 *
 * Six ids join the six that were listed — `preset-drift`, `palette-size`,
 * `nav-dead-runtime`, `export-missing`, `action-dead-runtime` and
 * `screen-hidden` — on the same evidence the six were kept for, and on the same
 * bar the script prints at: five files or more. Everything
 * at or above `icons` (17%) stays a whole file, which is where the volume is:
 * those repairs create components, and this form is the wrong shape for them.
 *
 * An id that is not here is written as a whole file. That is the safe direction
 * — an unmeasured repair is one whose size nobody knows — and it is why the
 * table carries `of`, so the next re-measurement can see what each row rests on.
 */
const CHANGE_SHARE: Record<string, { median: number; of: number }> = {
  'input-sizing': { median: 0.01, of: 7 },
  'visual-artefact': { median: 0.02, of: 17 },
  'contrast-low': { median: 0.02, of: 9 },
  'preset-drift': { median: 0.02, of: 9 },
  'visual-density': { median: 0.02, of: 61 },
  'visual-typography': { median: 0.03, of: 77 },
  'visual-accent': { median: 0.03, of: 29 },
  'palette-size': { median: 0.03, of: 12 },
  'nav-dead-runtime': { median: 0.08, of: 22 },
  'export-missing': { median: 0.08, of: 6 },
  'action-dead-runtime': { median: 0.09, of: 23 },
  'screen-hidden': { median: 0.10, of: 6 },
}

/** Where the bands above cross over. Below it a patch pays; above it, it does not. */
const PATCH_CEILING = 0.1


/**
 * Whether this file's repair is asked for as blocks rather than as a file.
 *
 * `chars` is the file as the prompt will carry it — the lean body, pictures
 * already taken out — because that is what the reply is being compared against.
 */
export function patchWorthy(plan: FileRepairPlan, chars: number): boolean {
  if (plan.create) return false
  if (chars < MIN_PATCH_CHARS) return false
  if (/\.css$/i.test(plan.path)) return true
  if (plan.defects.length === 0) return false
  return plan.defects.every((d) => (CHANGE_SHARE[d.id]?.median ?? 1) <= PATCH_CEILING)
}

/**
 * `patch` for a file that exists, `whole` for one being written.
 *
 * A new file has no lines to search for, and the module-writing round below
 * asks for files by construction — so the patch form is offered only where there
 * is something to patch. See patch-reply.ts for why the form exists.
 */
const fileSystem = (kind: OutputKind, reply: 'patch' | 'whole' = 'whole'): string => {
  const fw = frameworkFor(kind)
  return `You correct one file of a generated ${fw.label} project.

Rules:
${reply === 'patch'
    ? PATCH_REPLY_RULES
    : `- Return the COMPLETE corrected file and nothing else. No markdown, no fences, no
  commentary, no explanation before or after.`}
- Fix ONLY the listed defects. Keep everything else — the design, the copy, the
  component structure, the exports — exactly as it is.
- THE FILE YOU CHANGE IS THE ONE NAMED AT THE TOP OF THE REQUEST. When a defect
  asks for a file that does not exist yet — an icon, an illustration, a component
  to extract — do NOT write that file here. Import it at the path the defect
  names; a separate call writes it. Returning the new file instead of this one is
  the single most common way a repair is thrown away: measured over 30 days, 201
  replies were rejected for coming back a fraction of the size of the file they
  replaced, and the ones that recorded what came back show a 367-character
  ChevronIcon returned in place of a 5,402-character screen.
- Keep the file's imports working. You may add an import of a file that exists in
  the project, or of one the defects above say must be created; you may not add a
  package dependency. Installed packages: ${fw.packages}.
- Preserve TypeScript: real annotations, real prop types, no "any".
- The file must still export what other files import from it. Changing its
  exported shape breaks the build.

${fw.editGuard}`
}

/**
 * The framework a transported document is written in.
 *
 * Every pass below has to agree about this, and the document is the only thing
 * that knows: an edit is handed a project and returns one, so what the user
 * picked in the composer six edits ago is not evidence. Falls back to React only
 * when the paths say nothing at all, which is a document that will fail the next
 * check anyway.
 */
export function projectKind(html: string): OutputKind {
  return detectKind(reactFiles(html).keys()) ?? 'react'
}

/**
 * Path -> file body, for the source files a repair or edit may touch.
 *
 * The filter used to be a literal `/\.(tsx|ts|css)$/`, which is not a narrow
 * definition of "source" — it is the React definition. Handed a Vue project it
 * returned `main.ts`, `routes.ts` and the stylesheet and hid every screen,
 * because screens are `.vue`. The planner above it then saw a project with no
 * screens in it and had nothing sensible to plan, so the edit declined and fell
 * through to a whole-document rewrite that was told it held an HTML document.
 * One wrong extension list, three passes downstream of it.
 */
export function sourceFiles(html: string, kind: OutputKind = projectKind(html)): Map<string, string> {
  const exts = frameworkFor(kind).editExt
  const out = new Map<string, string>()
  for (const [path, body] of reactFiles(html)) {
    if (exts.some((e) => path.endsWith(e))) out.set(path, body)
  }
  return out
}

/**
 * Asks which files each defect lives in.
 *
 * Cheap by construction: it sees the paths and the defects, never a file body.
 * On any trouble it returns an empty plan and the caller falls back to the
 * whole-document repair, so this can only add.
 */
export async function planFileRepairs(
  html: string,
  defects: InteractionDefect[],
  invoke: (system: string, user: string) => Promise<string>
): Promise<FileRepairPlan[]> {
  const kind = projectKind(html)
  const files = sourceFiles(html, kind)
  if (files.size === 0 || defects.length === 0) return []

  const byPath = new Map<string, InteractionDefect[]>()
  const assign = (path: string, defect: InteractionDefect): void => {
    if (!frameworkFor(kind).allowedPath.test(path)) return
    const list = byPath.get(path) ?? []
    if (!list.includes(defect)) list.push(defect)
    byPath.set(path, list)
  }
  const plans = (): FileRepairPlan[] =>
    [...byPath.entries()].map(([path, ds]) => ({ path, defects: ds, create: !files.has(path) }))

  /*
   * A defect that already knows where it lives does not go to the planner.
   *
   * The planner is a model call that sees the file PATHS and the defect
   * sentences, and nothing else. Asked 「#6366f1 が使われています」 it has to name the
   * file holding a hex colour from a list of filenames, which it cannot do, so
   * it guesses the stylesheet. Measured over 14 days: 53 passes were handed
   * `default-palette` and it was fixed 0 times, and in the stored documents that
   * still carry the colour it is in a chart or illustration component every
   * time, never the stylesheet.
   *
   * `paths` on the defect is a grep result — see interaction-audit.ts. Using it
   * is more accurate, it makes the planner's job smaller, and when every defect
   * carries one there is no call to make at all.
   */
  const located = defects.filter((d) => d.paths && d.paths.length > 0)
  const unlocated = defects.filter((d) => !(d.paths && d.paths.length > 0))
  for (const d of located) {
    for (const raw of d.paths ?? []) assign(String(raw).trim().replace(/^\.?\//, ''), d)
  }
  if (unlocated.length === 0) return plans()

  const user = [
    'PROJECT FILES:',
    ...[...files.keys()].map((p) => `- ${p}`),
    '',
    'DEFECTS:',
    ...unlocated.map((d, i) => `${i + 1}. [${d.id}] ${d.instruction}`),
  ].join('\n')

  let assignments: { defect: number; paths: string[] }[]
  try {
    const raw = await invoke(plannerSystem(kind), user)
    const parsed = firstJsonObject<{ assignments?: { defect: number; paths: string[] }[] }>(raw)
    if (!parsed) {
      logger.warn('File repair planner returned no JSON', { preview: raw.slice(0, 200) })
      // What grep located still stands; only the planner's share is lost.
      return plans()
    }
    assignments = Array.isArray(parsed.assignments) ? parsed.assignments : []
    if (assignments.length === 0) {
      logger.info('File repair planner named no files', { defects: unlocated.length, preview: raw.slice(0, 200) })
    }
  } catch (e) {
    /*
     * A refusal is not an empty plan.
     *
     * Returning `plans()` here sends the caller to the whole-document repair,
     * which is roughly thirty times this call. Every one of the thirteen
     * escalations in sixty days was `Too many tokens per day` — the account had
     * run out, the cheap call was refused for it, and the answer was to attempt
     * the most expensive call in the pipeline. Rethrown so the pass can stop
     * instead.
     */
    if (isModelUnavailable(e)) {
      logger.warn('File repair planning refused; not escalating to a whole-document rewrite', { error: String(e) })
      throw e
    }
    logger.warn('File repair planning failed', { error: String(e) })
    return plans()
  }

  for (const a of assignments) {
    const defect = unlocated[a.defect - 1]
    if (!defect || !Array.isArray(a.paths)) continue
    for (const raw of a.paths) {
      const path = String(raw).trim().replace(/^\.?\//, '')
      /*
       * A path outside the project's own tree is a hallucination, not a plan.
       *
       * The pattern was React's, hard-coded: `(tsx|ts|css|md)`. So for a Vue or
       * Svelte project EVERY component the planner named was silently dropped —
       * src/App.vue, src/screens/HomeScreen.svelte, every card and badge under
       * src/components/ui — and the plan came back holding only the .ts and .css
       * files. The repair pass could not touch a component in two of the three
       * frameworks.
       *
       * That is the whole reason `decomposition`, `shell-without-nav`, `icons`
       * and `emoji` survived three repair passes on Vue and Svelte runs while
       * the same defects were fixed on React ones. It reads as the model being
       * worse at those frameworks; it was the plan being thrown away.
       *
       * `frameworkFor(kind).allowedPath` is the same table the edit path already
       * uses, and it was added for exactly this question.
       */
      assign(path, defect)
    }
  }

  return plans()
}


/**
 * A package the preview cannot install, imported by a returned file.
 *
 * The repair prompt already says it: 「you may not add a package dependency」,
 * with the installed list beside it. A model did it anyway, and the cost is not
 * a deduction — the bundle has no `date-fns`, so `require` throws, the page is
 * blank, and the WHOLE pass is rejected for `console-error-introduced`. Measured
 * on request 33c8019e: a per-file repair that took the defect count from 7 to 4
 * was discarded twice, and the run shipped its original document at the floor.
 *
 * So it is enforced where `parses` is enforced, and for the same stated reason —
 * 「Independent files must fail independently, or they are not independent」. One
 * file reaching for a package should cost that file, not the nine good ones
 * beside it.
 *
 * Type-only imports are not dependencies: they are gone once the types are
 * stripped, so they can never be a module the preview fails to supply. That
 * exemption is the scorer's too, added there after a Svelte project lost eight
 * points for importing its own framework's type definitions.
 */
export function foreignImport(body: string, kind: OutputKind): string | null {
  const runtime = body.replace(/import\s+type\s[^\n]*/g, '')
  for (const m of runtime.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/')) continue
    if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)$/i.test(spec)) continue
    if (isProvidedModule(spec, kind)) continue
    return spec
  }
  return null
}

/**
 * Whether a returned file would survive the build.
 *
 * Checked per file, before anything is spliced, and this is the difference
 * between per-file repair working and not. Measured on the first real run: nine
 * files came back, eight of them good, and one syntax error in ListScreen.tsx
 * failed the whole-document compile check and discarded all nine. Independent
 * files must fail independently, or they are not independent.
 *
 * Sucrase is the same parser the verification bundle uses, so a file that passes
 * here is a file that will render.
 */
export function parses(path: string, body: string): string | null {
  if (path.endsWith('.css') || path.endsWith('.md') || path.endsWith('.json')) return null
  /**
   * Components go to their own compiler, not to Sucrase.
   *
   * Sucrase reads a `.vue` or `.svelte` file as TypeScript, so a perfectly good
   * SFC fails here on its own `<template>` and a perfectly broken one can pass —
   * neither answer has anything to do with whether the project builds. Using the
   * compiler the bundle uses is the only version of this gate that means
   * anything, and it is the same rule the React branch below already follows:
   * where the gate and the bundler disagree, the bundler is right.
   */
  if (path.endsWith('.vue')) {
    try {
      compileFile('vue', path, body)
      return null
    } catch (e) {
      return (e instanceof Error ? e.message : String(e)).slice(0, 200)
    }
  }
  const transforms: Array<'typescript' | 'jsx' | 'imports'> = path.endsWith('.tsx')
    ? ['typescript', 'jsx', 'imports']
    : ['typescript', 'imports']
  try {
    transform(body, { transforms, production: true, filePath: path })
    return null
  } catch (e) {
    /**
     * A .ts file holding JSX is retried with the jsx transform, because the
     * bundler retries it too.
     *
     * This gate must not be stricter than the thing it is a gate for. Measured:
     * a barrel `src/components/illustrations/index.ts` was rejected here for a
     * token the verification bundle would have compiled without complaint, so a
     * usable file was thrown away to protect against a failure that could not
     * happen. Where the two disagree, the bundler is right — it is what actually
     * renders the page.
     */
    if (path.endsWith('.ts')) {
      try {
        transform(body, { transforms: ['typescript', 'jsx', 'imports'], production: true, filePath: path })
        return null
      } catch {
        /* fall through to the original error, which is the more useful one */
      }
    }
    return (e instanceof Error ? e.message : String(e)).slice(0, 200)
  }
}

/**
 * Strip fences, transport blocks, and anything a file response arrived wrapped in.
 *
 * The transport half is not defensive tidying; it is the fix for a measured
 * failure that looked impossible. A file passed the parse check on the way into
 * the document and failed it on the way out, at line 245 — the same function on
 * what should be the same string.
 *
 * The cause: the model answered with the `<script data-file="…">` wrapper around
 * the file, or with a stray `</script>` after it. That body parses on its own
 * only if the wrapper is at the end, and `reactFiles` reads a block only as far
 * as the first closing tag — so the document held a truncated file, which is
 * what failed. Proved in test/splice-roundtrip.test.mjs: a 245-line file
 * survives the round trip on length alone, and any body containing a closing
 * script or style tag does not.
 *
 * Everything after the first closing tag goes too. A response that continued
 * into the next file is answering a question that was not asked, and splicing
 * two files into one block is how a project quietly loses one.
 *
 * `path` decides which closing tag ends the response, because it decides which
 * transport the body is going into. Without it this cut at `</script>` or
 * `</style>`, whichever came first — so a screen returning
 * `<style>{…}</style>` inside its JSX was truncated at its own markup, and a
 * correct repair was thrown away for it. The same untied-alternation mistake as
 * the block reader, one layer up, and the reason it survived is that the
 * outcome here is a rejected file rather than a corrupted one: nothing shipped
 * broken, the repair simply never landed.
 */
export function cleanFile(text: string, path?: string): string {
  let out = text.trim()
  const fenced = out.match(/```(?:tsx?|ts|typescript|css|jsx|vue|html|markdown|md)?\n([\s\S]*?)```/)
  if (fenced) out = fenced[1]
  out = out.trim()

  /**
   * A component file's own `<script>` is not a stray tag.
   *
   * The cut at the bottom of this function removes everything from the first
   * `</script>`, on the theory that a response reaching one has run past the end
   * of the file and into the transport around it. That is true of a `.tsx`,
   * whose source contains no such tag, and catastrophically false of a `.vue` or
   * `.svelte`, where the script block IS part of the file. Measured: an edited
   * `ListScreen.vue` came back correct and was truncated here to its
   * `<template>` plus an unclosed `<script setup>`, failed the parse gate with
   * "Element is missing end tag", and was dropped — so the instruction was
   * carried out, discarded, and reported to the user as applied.
   *
   * The markdown fence and the `data-file` wrapper are still removed, because
   * both are things a model puts *around* a file rather than inside one.
   */
  if (path?.endsWith('.vue')) {
    const wrapper = /^<(script|style)\b[^>]*data-file=["'][^"']+["'][^>]*>([\s\S]*)<\/\1>\s*$/i.exec(out)
    return (wrapper ? wrapper[2] : out).trim()
  }

  /**
   * Anchored at the start, and checked before the stray-tag cut.
   *
   * An unanchored search matched the *second* block of a response that was
   * "the file, then a stray closing tag, then another file" — so the real file
   * was thrown away and the junk after it kept. Caught by the test rather than
   * in production, which is the only reason it is written this way round.
   */
  const wrapped = /^<(script|style)\b[^>]*data-file=["'][^"']+["'][^>]*>([\s\S]*?)<\/\1>/i.exec(out)
  if (wrapped) return wrapped[2].trim()

  // Unknown path keeps the old either-tag cut: a caller that cannot say where
  // the body is going gets the conservative answer.
  const closer = path === undefined
    ? /<\/(?:script|style)>/i
    : path.endsWith('.css') ? /<\/style>/i : /<\/script>/i
  const stray = out.search(closer)
  return (stray === -1 ? out : out.slice(0, stray)).trim()
}

/**
 * Replaces one file's body inside the document, or adds it when it is new.
 *
 * The block's opening tag is kept verbatim rather than rebuilt: it carries the
 * type and the data-file attribute the rest of the pipeline reads, and rebuilding
 * it is how a repair silently changes a file's identity.
 */
export function writeFile(html: string, path: string, body: string): string | null {
  /**
   * A body that closes its own transport cannot be stored in it.
   *
   * A block ends at the closing tag that matches the one that opened it, so the
   * tag to refuse depends on which transport the file goes into: CSS travels in
   * a `<style>`, everything else in a `<script>`. This used to refuse both for
   * both, which was over-strict in the direction that matters — a screen that
   * legitimately renders `<style>{…}</style>` inside its JSX is a file the
   * script transport carries perfectly well, and refusing it discarded a
   * correct repair for a truncation that cannot happen.
   */
  /**
   * The fenced transport has no tag to close, so nothing has to be refused: a
   * whole-line sentinel cannot occur inside a line of source. Documents still on
   * the script-block transport keep the old refusal, because there the collision
   * is real.
   */
  if (isFencedTransport(html)) {
    const written = writeProjectFile(html, path, body)
    if (!written) logger.info('File not written — its body contains a transport fence', { path })
    return written
  }

  const closer = path.endsWith('.css') ? /<\/style>/i : /<\/script>/i
  if (closer.test(body)) {
    logger.info('File not written — its body would close the transport block', { path })
    return null
  }
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(
    `(<(script|style)\\b[^>]*data-file=["']${escaped}["'][^>]*>)([\\s\\S]*?)(</\\2>)`,
    'i'
  )
  const found = block.exec(html)
  if (found) {
    return html.slice(0, found.index) + found[1] + '\n' + body + '\n' + found[4] +
      html.slice(found.index + found[0].length)
  }

  // New file. CSS goes in a <style>, everything else in the jsx transport block.
  const tag = path.endsWith('.css')
    ? `<style data-file="${path}">`
    : `<script type="text/jsx" data-file="${path}">`
  const close = path.endsWith('.css') ? '</style>' : '</script>'
  const at = html.lastIndexOf('</body>')
  if (at === -1) return null
  return html.slice(0, at) + `${tag}\n${body}\n${close}\n` + html.slice(at)
}

/**
 * Written files whose imports no longer resolve, and the specifier that broke.
 *
 * The parse gate accepts a file that is valid TypeScript and imports a module
 * nobody wrote. That is not a lesser failure than a syntax error — it is a
 * worse one, because the first require throws and the whole application renders
 * nothing. Measured: a repair rewrote Header.tsx to import '../icons/UserIcon',
 * created seven sibling icons and not that one, passed every gate, and shipped
 * a blank page scoring 30.
 *
 * Judged as a delta. A document that already had a broken import is not this
 * pass's doing, and blaming it for one would revert good work to fix nothing.
 * The barrels the pipeline adds after repair are added here first, so the gate
 * is asking about the document that will actually ship rather than an
 * intermediate one — otherwise a file importing a folder whose index has not
 * been generated yet is reverted for a problem that was about to be solved.
 */
export function importsLost(
  before: string,
  after: string,
  written: Set<string>
): Map<string, string> {
  const was = new Set(unresolvedImports(before).map((u) => `${u.importer}|${u.spec}`))
  const lost = new Map<string, string>()
  for (const u of unresolvedImports(addMissingBarrels(after).html)) {
    if (was.has(`${u.importer}|${u.spec}`) || !written.has(u.importer)) continue
    if (!lost.has(u.importer)) lost.set(u.importer, u.spec)
  }
  return lost
}

interface FileRepairResult {
  html: string
  written: string[]
  skipped: string[]
}

/**
 * Runs the planned repairs and splices the results back in.
 *
 * Concurrent, because the calls are genuinely independent — each one sees one
 * file and returns one file. Splicing happens after they all land, so a failure
 * in one leaves the others unaffected and the document is never half-written.
 */
/**
 * Defects a one-file repair cannot fix without seeing the store.
 *
 * A button that does nothing is fixed by giving it a handler, and a handler
 * writes state. The per-file repair sends ONE file and its contents, so the
 * model is asked to wire a control to a store whose exported names it has never
 * been shown. It has two options from there: invent a name, which fails to
 * compile and gets the pass reverted, or change nothing.
 *
 * It changes nothing. Measured over 30 days: `action-dead-runtime` was handed to
 * 93 passes and cleared 5 times, and it is still in the document at the end of
 * 84% of the runs that reported it — the worst survival of any defect the loop
 * still attempts. `nav-dead-runtime` is 6 of 44.
 *
 * It is not an expensive defect to attempt: adding it to a pass costs 0.6 extra
 * files against 12.7 for `decomposition`. So this is not a defect to stop paying
 * for. It is one that has been paid for 93 times without being given what it
 * needs to succeed.
 */
const NEEDS_WIRING = new Set(['action-dead-runtime', 'nav-dead-runtime'])

/**
 * A ceiling on the reference block, because it rides on every wiring repair.
 *
 * Generous enough for a store and a routes file — the two together run about
 * 6KB on the projects in S3 — and small enough that a project which put its
 * whole domain in `store.ts` cannot double the cost of the pass. Truncated
 * rather than dropped: the exported names are near the top of these files, and
 * the names are the thing the repair is missing.
 */
const WIRING_CONTEXT_CHARS = 12_000

/**
 * The store and the router, as reading material.
 *
 * Deliberately NOT added to the repair plan. Letting the pass rewrite the store
 * as well would put every screen's imports at the mercy of one repair, and the
 * splice is all-or-nothing — this is the file that, rewritten badly, takes the
 * project down rather than one screen. What the model needs here is the API, not
 * permission to change it.
 *
 * The file being repaired is excluded: it is already in the prompt, in full, as
 * the thing to return, and sending it twice is how a model starts returning the
 * wrong copy.
 */
function wiringContext(files: Map<string, string>, kind: OutputKind, target: string): string {
  const fw = frameworkFor(kind)
  const wanted = [...files.keys()].filter(
    (path) =>
      path !== target &&
      (path === fw.routesFile || /store|navigation|composables|lib\/(types|store|navigation)/.test(path))
  )
  if (wanted.length === 0) return ''
  const blocks: string[] = []
  let budget = WIRING_CONTEXT_CHARS
  for (const path of wanted) {
    if (budget <= 0) break
    const body = (files.get(path) ?? '').slice(0, budget)
    budget -= body.length
    blocks.push(`--- ${path} ---\n${body}`)
  }
  return [
    '',
    'REFERENCE ONLY — do not return these files, do not rewrite them:',
    '',
    ...blocks,
    '',
    'Wire the control to what these files already export. If no existing action',
    'fits, compose one from the setters that are there. Do not call a name that',
    'does not appear above: a handler that does not compile loses the whole pass,',
    'which leaves the button exactly as dead as it was.',
  ].join('\n')
}

export async function repairFiles(
  html: string,
  plans: FileRepairPlan[],
  invoke: (system: string, user: string) => Promise<string>,
  /**
   * Give a reply that does not parse one more attempt, with the error.
   *
   * Off by default: across the repair loop a rejected file is one of many and
   * the pass is judged as a whole. The build repair sets it, because there the
   * alternative to another call is a certain placeholder.
   */
  retryOnParseError = false
): Promise<FileRepairResult> {
  const kind = projectKind(html)
  const files = sourceFiles(html, kind)
  const results = await Promise.all(
    plans.map(async (plan) => {
      const instructions = plan.defects.map((d, i) => `${i + 1}. ${d.instruction}`).join('\n')
      // Embedded pictures come out before the body goes into a prompt; see the
      // header of utils/embedded-images.ts for the measurement behind it.
      const leaned = lean(files.get(plan.path) ?? '')
      /*
       * The store travels with a wiring defect, and with nothing else.
       *
       * Unconditionally would put 6KB on all 27 repair calls a run makes, to be
       * read by the 23 of them fixing a colour or a heading. Keyed off the
       * defect, it rides on the passes that cannot succeed without it.
       */
      const wiring = plan.defects.some((d) => NEEDS_WIRING.has(d.id))
        ? wiringContext(files, kind, plan.path)
        : ''
      /*
       * Logged so the change can be judged the way it was argued for.
       *
       * The case for it is a 5% fix rate on `action-dead-runtime`. Whether the
       * store made a difference is `scripts/fix-rates.mjs` split on this line —
       * without it, the only way to tell would be to remember the deploy date.
       */
      if (wiring) {
        logger.info('Wiring context attached to a repair', {
          path: plan.path,
          defects: plan.defects.filter((d) => NEEDS_WIRING.has(d.id)).map((d) => d.id),
          chars: wiring.length,
        })
      }
      const user = plan.create
        ? [
            `Write a new file: ${plan.path}`,
            '',
            'It does not exist yet. These defects require it:',
            instructions,
            '',
            'Existing project files, for import paths:',
            ...[...files.keys()].map((p) => `- ${p}`),
          ].join('\n')
        : [
            `File: ${plan.path}`,
            '',
            'Defects to fix in this file:',
            instructions,
            wiring,
            '',
            /*
             * Last, and after the reference block on purpose. The single most
             * common way a repair is thrown away is a reply that returns some
             * other file — 201 of them in 30 days — so the file to return is
             * both named first and shown last, with everything it may only read
             * in between.
             */
            '--- current contents ---',
            leaned.text,
          ].join('\n')
      try {
        const reply = patchWorthy(plan, leaned.text.length) ? 'patch' : 'whole'
        const system = leaned.images.size > 0 ? fileSystem(kind, reply) + EMBEDDED_IMAGE_NOTE : fileSystem(kind, reply)
        const answer = await invoke(system, user)
        let raw: string
        let format: 'patch' | 'whole' = 'whole'
        if (reply === 'patch' && isPatchReply(answer)) {
          format = 'patch'
          const applied = applyPatchReply(leaned.text, answer)
          if (applied.ok) {
            raw = applied.body
          } else {
            /*
             * One call for the file, told why the blocks did not land.
             *
             * Not a silent drop: a block that fails to match is a model copying
             * inexactly, which is a different failure from a model that could
             * not fix the defect, and dropping the file would count it as the
             * second. The retry asks for the whole file, the form that cannot
             * fail this way — so the cost of a miss is the old cost, once.
             */
            logger.info('File repair patch did not apply', {
              path: plan.path, error: applied.error, blocks: applied.blocks, replyChars: answer.length,
              // What came back, because the four misses of the first measured round could not say.
              head: answer.slice(0, 300),
            })
            raw = cleanFile(await invoke(
              leaned.images.size > 0 ? fileSystem(kind, 'whole') + EMBEDDED_IMAGE_NOTE : fileSystem(kind, 'whole'),
              `${user}\n\n--- 直前の回答の SEARCH/REPLACE ブロックは適用できませんでした（${applied.error}）---\n` +
                '今回はブロックではなく、修正後のファイル全体を出力してください。'
            ), plan.path)
            format = 'whole'
          }
        } else {
          raw = cleanFile(answer, plan.path)
        }
        /*
         * The pictures go back before anything measures this reply.
         *
         * The length guard below and the import check both read the body, and
         * a body still holding markers is neither what was asked for nor what
         * will be written. See utils/embedded-images.ts.
         */
        const back = restore(raw, leaned.images)
        if (back.missing.length > 0) {
          logger.info('A repaired file did not keep every embedded image', {
            path: plan.path, restored: back.restored, dropped: back.missing.length,
          })
        }
        const body = back.text
        // A response far shorter than the file it replaces has lost content
        // rather than corrected it — the same failure the whole-document repair
        // is guarded against, at the scale where it actually happens.
        // Compared LEAN against LEAN. Against a body inflated by half a megabyte
        // of base64 this ratio stops meaning anything: a correct rewrite that
        // drops one picture reads as a 90% shrink and is thrown away.
        const before = leaned.text.length
        const after = lean(body).text.length
        if (!body || (before > 0 && after < before * 0.6)) {
          /*
           * What came back, not just how much of it.
           *
           * Two files of 1,039 and 1,851 characters were both rejected at
           * exactly 221 — the same length from different inputs, which is a
           * systematic reply rather than a model abbreviating. The log could not
           * say which, because it recorded two numbers and threw the text away.
           * The parse-error branch below already learned this lesson: the
           * offending line travels with the complaint, because the document it
           * came from is gone before anyone can look at it.
           */
          logger.info('File repair rejected — response too short', {
            path: plan.path,
            before,
            after,
            head: body.slice(0, 200).replace(/\s+/g, ' '),
          })
          return { path: plan.path, body: null }
        }
        const foreign = foreignImport(body, kind)
        if (foreign) {
          logger.info('File repair rejected — imports a package the preview cannot supply', {
            path: plan.path,
            package: foreign,
            installed: FRAMEWORKS[kind].providedModules.join(', '),
          })
          return { path: plan.path, body: null }
        }
        const broken = parses(plan.path, body)
        if (broken) {
          /**
           * The offending line travels with the complaint.
           *
           * "Unexpected token (9:103)" names a position in a file that exists
           * only inside this run: it is gone before anyone can look at it, and
           * the next occurrence starts the diagnosis from nothing. Two barrel
           * files failed this way in one run and the logs could not say why.
           */
          const at = /\((\d+):(\d+)\)/.exec(broken)
          const line = at ? (body.split('\n')[Number(at[1]) - 1] ?? '') : ''
          logger.info('File repair rejected — does not parse', {
            path: plan.path,
            error: broken,
            line: line.trim().slice(0, 200),
          })
          /**
           * One more attempt, with the compiler's answer to the last one.
           *
           * Not a resample: the second call is given something the first did
           * not have — what its own reply failed on. Measured at v207, a Svelte
           * chart component whose build repair replied with markup that also
           * would not parse; it was stubbed, which cost twenty points and a
           * screen, and nothing tried again.
           *
           * Only where the caller says the alternative is worse than another
           * call. The build repair is that case by construction: it runs when
           * the project already does not compile, and giving up there is a
           * certain placeholder.
           */
          if (retryOnParseError) {
            try {
              const second = cleanFile(
                await invoke(
                  fileSystem(kind),
                  `${user}\n\n--- 直前の回答はコンパイルできませんでした ---\n${broken}\n` +
                    'この指摘を踏まえて、ファイル全体をもう一度出力してください。'
                ),
                plan.path
              )
              if (second && !parses(plan.path, second)) {
                logger.info('File repair succeeded on the second attempt', { path: plan.path })
                return { path: plan.path, body: second }
              }
            } catch (e) {
              logger.info('Second file repair attempt failed', { path: plan.path, error: String(e) })
            }
          }
          return { path: plan.path, body: null }
        }
        /*
         * How much of the file this repair actually changed — see
         * utils/change-size.ts. Measured on the lean bodies so embedded pictures
         * do not count as unchanged lines, and on accepted bodies only, because a
         * rejected one was never going to ship. `scripts/repair-change-size.mjs`
         * reads these back.
         */
        if (!plan.create) {
          const size = changeSize(leaned.text, lean(body).text)
          logger.info('File repair change size', {
            path: plan.path,
            defects: plan.defects.map((d) => d.id),
            ...size,
            outChars: body.length,
            /*
             * What the reply itself cost, next to what a whole file would have.
             * `outChars` stays the body length so the script's estimate reads the
             * same field before and after; `replyChars` is the measured answer.
             */
            format,
            replyChars: format === 'patch' ? answer.length : body.length,
          })
        }
        return { path: plan.path, body }
      } catch (e) {
        logger.warn('File repair failed', { path: plan.path, error: String(e) })
        return { path: plan.path, body: null }
      }
    })
  )

  const usable = results.filter((r): r is { path: string; body: string } => Boolean(r.body))
  const failedToSplice = results.filter((r) => !r.body).map((r) => r.path)

  /**
   * Splices the given files in, then checks the result rather than the input.
   *
   * Validating each response before splicing is not enough, and the gap is not
   * theoretical: a run wrote eleven files, every one of which parsed on its own,
   * and the assembled document then failed to compile on the fourth of them. The
   * document is what gets rendered, so the document is what has to be checked —
   * whatever the cause of the disagreement, checking the output closes it.
   */
  const spliceAll = (paths: Set<string>): { html: string; written: string[]; unsplicable: string[] } => {
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

  let keep = new Set(usable.map((r) => r.path))
  let attempt = spliceAll(keep)
  const skipped = [...failedToSplice, ...attempt.unsplicable]

  // One re-splice, not a search: if dropping the files that broke still leaves a
  // broken document, the problem is not which files were chosen and the caller's
  // own compile gate is the right place to stop.
  const broken = new Set<string>()
  for (const [path, body] of reactFiles(attempt.html)) {
    if (!keep.has(path)) continue
    const err = parses(path, body)
    if (err) {
      broken.add(path)
      logger.info('File repair reverted — broken after splicing', { path, error: err })
    }
  }
  if (broken.size > 0) {
    keep = new Set([...keep].filter((p) => !broken.has(p)))
    attempt = spliceAll(keep)
    skipped.push(...broken)
  }

  /**
   * Asked after the reverts, not before — the same ordering bug the edit path
   * had, and it is worth stating why once in each place.
   *
   * A file that was spliced and then dropped for not parsing is gone from the
   * document, but anything written to import it is not. Checking imports on the
   * pre-revert document sees that file present and reports nothing.
   */
  /**
   * A module nothing wrote is written, not reverted.
   *
   * This was the single largest thing standing between the repair loop and a
   * decomposed project, and it is visible as one line in every round: the model
   * is told to break a screen into components, it extracts one and imports
   * `../components/ui/ItemCard.vue`, and nothing ever writes ItemCard. The
   * screen is then reverted for the dangling import — so the extraction is
   * undone, the defect count does not fall, the pass is judged "no improvement",
   * and the components that WERE created in the same pass are thrown out with
   * it.
   *
   * Measured on the v194 round. Vue planned eight new components, six screens
   * were reverted for importing files nobody wrote, the pass changed nothing and
   * was rejected; Vue shipped with one component against React's eleven, on the
   * same brief and the same model, and carried `decomposition`,
   * `imagery-missing` and `icons` as open defects. Svelte the same, two reverts,
   * same outcome. The same two lines appear in the v191 and v192 rounds.
   *
   * The import is the specification. It names the path, the importer says what
   * kind of thing it is, and the file that wants it is right there to read — so
   * this is a smaller question than any repair already being asked. One round,
   * bounded, and whatever still dangles afterwards is reverted exactly as
   * before.
   */
  const writeMissing = async (dangling: Map<string, string>): Promise<boolean> => {
    const current = reactFiles(attempt.html)
    const wanted = new Map<string, { importer: string; spec: string }>()
    for (const [importer, spec] of dangling) {
      // Only a path this project could hold. A bare specifier is a package the
      // preview does not provide, and writing a file will not change that.
      if (!spec.startsWith('.')) continue
      const dir = importer.slice(0, importer.lastIndexOf('/'))
      const parts: string[] = []
      for (const seg of `${dir}/${spec}`.split('/')) {
        if (seg === '.' || seg === '') continue
        if (seg === '..') parts.pop()
        else parts.push(seg)
      }
      let path = parts.join('/')
      if (!path.startsWith('src/')) continue
      /*
       * A capitalised last segment is a component, wherever it sits.
       *
       * The directory test alone sent `../icons/CartIcon` — no `components/`
       * segment in it — to `src/icons/CartIcon.ts`, a file that cannot hold the
       * markup the importer expects to render. Nine of the corpus specs are
       * under a bare `icons/` or `illustrations/` directory.
       */
      if (!/\.[A-Za-z]+$/.test(path)) {
        const isComponent = /\/(components|screens|icons|illustrations)\//.test(path)
          || /\/[A-Z][A-Za-z0-9]*$/.test(path)
        path += isComponent ? frameworkFor(kind).componentExt : '.ts'
      }
      if (current.has(path) || wanted.has(path)) continue
      wanted.set(path, { importer, spec })
    }
    if (wanted.size === 0) return false

    /*
     * The leaf graphics first, and without a model.
     *
     * Written here rather than left to the batch below for two reasons that both
     * showed up in the logs: the batch is capped at six a round, so an <svg>
     * takes a slot from a module that genuinely needs writing; and a returned
     * file has a two-in-three chance of not arriving usable, which for a drawing
     * with no logic in it is a coin flip against nothing.
     */
    const drawn: { path: string; body: string }[] = []
    for (const [path, { importer, spec }] of [...wanted]) {
      const body = leafModule(path, kind, current.get(importer) ?? '', spec)
      if (!body) continue
      if (parses(path, body)) continue
      drawn.push({ path, body })
      wanted.delete(path)
      logger.info('Missing module drawn without a call', { path, importer })
    }

    const made = wanted.size === 0 ? [] : await Promise.all(
      [...wanted].slice(0, 6).map(async ([path, { importer, spec }]) => {
        const user = [
          `Write a new file: ${path}`,
          '',
          `It does not exist yet. ${importer} imports it as "${spec}" and will not run without it.`,
          'Write the module that import expects — the same props, the same named exports, the',
          'same shape. Read the importer below to see exactly how it is used.',
          '',
          'Existing project files, for import paths:',
          ...[...current.keys()].map((p) => `- ${p}`),
          '',
          `--- ${importer} ---`,
          current.get(importer) ?? '',
        ].join('\n')
        try {
          const body = cleanFile(await invoke(fileSystem(kind), user), path)
          /*
           * Logged, because this was the one way a missing module could fail to
           * be written without saying so. Over 30 days, 338 repairs were
           * reverted for a dangling import and 272 of those were in passes where
           * nothing at all was written — and the parse and invoke failures
           * account for two. Whatever the rest are, they came through here.
           */
          if (!body) {
            logger.info('Missing module came back empty', { path, importer })
            return null
          }
          const broken = parses(path, body)
          if (broken) {
            logger.info('Missing module rejected — does not parse', { path, error: broken })
            return null
          }
          return { path, body }
        } catch (e) {
          logger.info('Missing module failed', { path, error: String(e) })
          return null
        }
      })
    )

    /*
     * Added to `usable`, not spliced by hand.
     *
     * `spliceAll` rebuilds the document from the original html and whatever is
     * in `usable`, so a file written straight into `attempt.html` disappears the
     * next time anything re-splices — which is exactly what happens when some
     * other import is still dangling and the revert path runs. The created
     * module would vanish while the file importing it stayed, and the last
     * `importsLost` has already been taken by then, so nothing would notice.
     */
    let wrote = false
    for (const m of [...drawn, ...(made.filter(Boolean) as { path: string; body: string }[])]) {
      if (!writeFile(attempt.html, m.path, m.body)) continue
      usable.push(m)
      keep.add(m.path)
      wrote = true
      logger.info('Wrote a module the repair imported', { path: m.path })
    }
    if (wrote) attempt = spliceAll(keep)
    return wrote
  }

  let lost = importsLost(html, attempt.html, keep)
  /*
   * Rounds, not one round.
   *
   * `importsLost` reports at most ONE dangling spec per importer, so a screen
   * that imports three new components asks for one of them and is reverted for
   * the other two. Measured over 30 days: twenty passes wrote a module and were
   * reverted anyway, 66 reverts between them — every one of those is a file that
   * asked again and was not asked.
   *
   * Bounded at three and stops the moment a round writes nothing, so a spec
   * nothing can satisfy costs one extra round rather than a loop.
   */
  for (let round = 0; round < 3 && lost.size > 0; round += 1) {
    if (!(await writeMissing(lost))) break
    lost = importsLost(html, attempt.html, keep)
  }
  if (lost.size > 0) {
    for (const [path, spec] of lost) {
      logger.info('File repair reverted — imports a module nothing wrote', { path, spec })
      skipped.push(path)
    }
    keep = new Set([...keep].filter((p) => !lost.has(p)))
    attempt = spliceAll(keep)
  }

  return { html: attempt.html, written: attempt.written, skipped }
}
