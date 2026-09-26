/**
 * What the project already says about itself, for a change that has to be
 * specified before it is built.
 *
 * Plan mode, asked on 2026-09-23 「画像が出てないんだけどどうすべき？」 of a
 * storefront, answered with four questions for the user — which screens, which
 * images, is the tag there, what should happen — and built nothing. The edit that
 * followed did the same thing a different way: its file planner decided 「this is
 * a question, not a change」, named no files, and the run fell back to rewriting
 * the whole document, the most expensive path the edit pipeline has.
 *
 * Neither of them could have answered. The change designer is handed the screen
 * NAMES and the instruction, and nothing else — not one line of the project it
 * is meant to change. Every one of its four questions was answerable from the
 * source in milliseconds: `Product` declares no picture field, none of its 12
 * records carries one, the card draws an invented <svg> where a photograph
 * belongs, and the one real photograph on the detail screen is a constant.
 *
 * So the facts are measured here and handed over: the screens, the data model,
 * what the free audits already report, and — when the request is about images —
 * where every picture is meant to go and whether anything is drawn there. It is
 * a page of text rather than the project, because the project is tens of
 * thousands of tokens and the designer needs a diagnosis, not a codebase.
 */

import { FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import { readProjectFiles } from '../../tools/project/project-transport.js'
import { detectKind } from '../../tools/project/framework-compile.js'
import { pictureFrames } from '../../tools/fixups/picture-frames.js'
import { PHOTO_SLOT } from '../../tools/images/stock-images.js'
import {
  auditInteractivity,
  auditShellContract,
  declaredScreenIds,
  type InteractionDefect,
} from '../audit/interaction-audit.js'

/** Whether a request is about pictures, in either language. */
export const ABOUT_IMAGES = /画像|写真|イメージ|サムネ|アイキャッチ|photo|image|picture|thumbnail|\bimg\b/i

/**
 * A request that describes a problem or asks what to do, rather than stating a
 * change. Treated as "find what is wrong and fix it" — which is what a person
 * who types 「画像が出ないんだけど」 wants done.
 */
export const PROBLEM_REPORT = /(?:[?？]\s*$|どうすべき|どうすれば|どうしたら|なぜ|なんで|出ない|出てない|表示されない|映らない|動かない|効かない|おかしい|壊れ|エラー|できない|うまくいかない|反映されない)/

// The whole name, suffix included: `imageUrl` read as `image` counted every
// record as missing the field it actually has.
const PICTURE_FIELD = /\b((?:image|img|thumbnail|thumb|photo|picture|cover|avatar|banner|hero)(?:Url|URL|Src|Image|Path)?)\s*(\?)?\s*:\s*string/i
const NAME_FIELD = /\b(name|title|label|productName)\s*\??\s*:\s*string/

/** Record types, from interface and type declarations anywhere in the project. */
function recordTypes(files: Map<string, string>): Array<{ name: string; fields: string[]; path: string; picture?: string; nameField?: string }> {
  const out: Array<{ name: string; fields: string[]; path: string; picture?: string; nameField?: string }> = []
  for (const [path, body] of files) {
    if (!/\.(ts|tsx|vue)$/.test(path)) continue
    for (const m of body.matchAll(/(?:interface|type)\s+([A-Z]\w*)[^{=]*=?\s*\{([\s\S]*?)\n\}/g)) {
      const fields = [...m[2].matchAll(/^\s*(\w+)\s*\??\s*:/gm)].map((f) => f[1])
      if (fields.length < 2) continue
      out.push({
        name: m[1],
        fields,
        path,
        picture: PICTURE_FIELD.exec(m[2])?.[1],
        nameField: NAME_FIELD.exec(m[2])?.[1],
      })
    }
  }
  return out
}

/** `export const X: T[] = [ … ]` in src/data, with how many records carry a field. */
function catalogues(files: Map<string, string>): Array<{ path: string; type: string; records: number; carrying: (field: string) => number; slots: number }> {
  const out: Array<{ path: string; type: string; records: number; carrying: (field: string) => number; slots: number }> = []
  for (const [path, body] of files) {
    if (!/^src\/data\//.test(path)) continue
    for (const m of body.matchAll(/export\s+const\s+\w+\s*:\s*(\w+)\[\]\s*=\s*\[/g)) {
      // Records counted by their opening brace at the array's own depth.
      const from = (m.index ?? 0) + m[0].length
      let depth = 1
      let records = 0
      let i = from
      for (; i < body.length && depth > 0; i++) {
        const c = body[i]
        if (c === '[' || c === '(') depth++
        else if (c === ']' || c === ')') depth--
        else if (c === '{') { if (depth === 1) records++; depth++ }
        else if (c === '}') depth--
      }
      const text = body.slice(from, i)
      out.push({
        path,
        type: m[1],
        records,
        carrying: (field) => (text.match(new RegExp(`\\b${field}\\s*:`, 'g')) ?? []).length,
        slots: (text.match(new RegExp(PHOTO_SLOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length,
      })
    }
  }
  return out
}

/** One line per finding, in the words the reply would use. */
function findingLine(d: InteractionDefect): string {
  const text = (d.note ?? d.instruction).replace(/\s+/g, ' ').trim()
  return `- ${d.id}: ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`
}

interface ChangeDiagnosis {
  /** The fact sheet, ready to append to a brief. Empty when nothing was readable. */
  text: string
  /** Whether the request reads as a problem to find and fix. */
  problemReport: boolean
  aboutImages: boolean
  /** Whether the user picked an element on screen — "Target element: <selector>." */
  targeted: boolean
}

/**
 * The files that write the element a user picked on screen.
 *
 * The element picker prefixes the instruction with `Target element: <selector>.`
 * — and the file planner, shown file PATHS, could not tell which of them writes a
 * `header`. Two of the six edits in thirty days that fell back to rewriting the
 * whole document were exactly 「Target element: header. header の ヘッダー を
 * 再生成して」.
 *
 * Read from the selector's last compound — its tag, classes and id — and matched
 * against the markup, so `div.product-card > h3` finds the file drawing a
 * `.product-card`, not every file with an h3 in it.
 */
function locateTargetElement(files: Map<string, string>, selector: string, ext: string): string[] {
  const last = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? ''
  const tag = /^[a-z][\w-]*/i.exec(last)?.[0]?.toLowerCase()
  // Classes and ids from the WHOLE selector: in `section.card > h3` the h3 is
  // everywhere and the .card is the evidence of which file.
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1])
  const id = /#([\w-]+)/.exec(selector)?.[1]
  if (!tag && classes.length === 0 && !id) return []
  const hits: Array<{ path: string; score: number }> = []
  for (const [path, body] of files) {
    if (!path.endsWith(ext)) continue
    let score = 0
    if (tag && new RegExp(`<${tag}[\\s>/]`, 'i').test(body)) score += 1
    for (const c of classes) if (new RegExp(`class(?:Name)?\\s*=\\s*["'{\`][^"'}\`]*\\b${c.replace(/[-]/g, '\\-')}\\b`).test(body)) score += 2
    if (id && new RegExp(`\\bid\\s*=\\s*["'{]${id}\\b`).test(body)) score += 3
    // A class or id is the evidence; a bare tag only counts when nothing else was given.
    const needed = classes.length > 0 || id ? 2 : 1
    if (score >= needed) hits.push({ path, score })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 4).map((h) => h.path)
}

/**
 * The facts a change designer needs and was never given.
 *
 * Bounded: at most a dozen findings and a few lines per catalogue, so a large
 * project does not turn a page of facts back into the codebase it replaces.
 */
export function diagnoseForChange(html: string, instruction: string): ChangeDiagnosis {
  const target = /^Target element:\s*(.+?)\.\s+/s.exec(instruction)
  const targeted = Boolean(target)
  // The user's own words, without the picker's prefix, decide what kind of request it is.
  const request = target ? instruction.slice(target[0].length) : instruction
  const problemReport = PROBLEM_REPORT.test(request.trim())
  const aboutImages = ABOUT_IMAGES.test(request)
  let files: Map<string, string>
  let kind: OutputKind | null
  try {
    files = readProjectFiles(html)
    kind = detectKind(files.keys())
  } catch {
    return { text: '', problemReport, aboutImages, targeted }
  }
  if (!kind || files.size === 0) return { text: '', problemReport, aboutImages, targeted }
  const ext = FRAMEWORKS[kind].componentExt

  const lines: string[] = []
  lines.push('PROJECT FACTS — measured from the current source. Trust these over any guess, and do not ask the user for anything stated here.')

  if (target) {
    const picked = target[1].slice(0, 80)
    const where = locateTargetElement(files, target[1], ext)
    lines.push(where.length > 0
      ? `- The element the user picked on screen (${picked}) is written in: ${where.join(', ')}`
      : `- The element the user picked on screen (${picked}) could not be located by its selector; look for it in the shell (App) and the screen files.`)
  }

  const screens = declaredScreenIds(html)
  const screenFiles = [...files.keys()].filter((p) => FRAMEWORKS[kind!].screenFile.test(p)).map((p) => p.split('/').pop())
  lines.push(`- Screens: ${screens.join(', ') || '(none declared)'}; screen files: ${screenFiles.join(', ') || '(none)'}`)

  const types = recordTypes(files)
  const cats = catalogues(files)
  for (const c of cats.slice(0, 4)) {
    const t = types.find((x) => x.name === c.type)
    lines.push(`- Data: ${c.path} holds ${c.records} ${c.type} records${t ? ` { ${t.fields.slice(0, 10).join(', ')}${t.fields.length > 10 ? ', …' : ''} }` : ''}`)
  }

  let findings: InteractionDefect[] = []
  try {
    findings = [...auditInteractivity(html, kind), ...auditShellContract(html, kind)]
  } catch {
    // An audit failure must never cost a change its facts.
  }
  if (findings.length > 0) {
    lines.push('- Open findings the source audits already report:')
    for (const d of findings.slice(0, 12)) lines.push(`  ${findingLine(d)}`)
  }

  /*
   * Where every picture is meant to go, and whether anything is drawn there.
   *
   * The four questions plan mode asked back — which screens, which images, is
   * the tag there at all, what should happen — are exactly these lines.
   */
  if (aboutImages) {
    lines.push('IMAGES — where pictures belong in this project, and what is drawn there now:')
    for (const c of cats) {
      const t = types.find((x) => x.name === c.type)
      if (!t) continue
      if (t.picture) {
        const have = c.carrying(t.picture)
        lines.push(`- ${c.type} declares \`${t.picture}\`; ${have} of ${c.records} records set it${c.slots ? ` (${c.slots} are the unresolved slot ${PHOTO_SLOT})` : ''}.`)
      } else if (t.nameField) {
        lines.push(`- ${c.type} declares NO picture field, so none of its ${c.records} records can carry a photograph.`)
      }
    }
    let imgs = 0
    let bound = 0
    const frames: string[] = []
    for (const [path, body] of files) {
      if (!path.endsWith(ext)) continue
      for (const m of body.matchAll(/<img\b[^>]*>/g)) {
        imgs++
        if (/src=\{\s*\w+\.\w+|:src="\w+\.\w+"/.test(m[0])) bound++
      }
      for (const f of pictureFrames(body)) {
        const child = f.child.trim()
        const cls = /class(?:Name)?\s*=\s*["'{]([^"'}]*)/.exec(f.attrs)?.[1] ?? ''
        const what = !child ? 'nothing' : /^<svg/i.test(child) ? 'an invented <svg> drawing' : /^<img/i.test(child) ? null : `a stand-in ${/^<(\w+)/.exec(child)?.[1] ?? 'element'}`
        if (what) frames.push(`${path.split('/').pop()}: .${cls.split(/\s+/)[0]} holds ${what}`)
      }
      for (const m of body.matchAll(/backgroundImage\s*:\s*['"`]url\(([^)'"`]+)\)/g)) {
        frames.push(`${path.split('/').pop()}: a background photograph hard-coded as ${m[1].slice(0, 60)} (the same for every record)`)
      }
    }
    lines.push(`- <img> elements: ${imgs}, of which bound to a record field: ${bound}.`)
    if (frames.length > 0) {
      lines.push('- Picture frames with no photograph in them:')
      for (const f of frames.slice(0, 8)) lines.push(`  - ${f}`)
    }
    lines.push('- A licensed stock-photo library is available to this edit: records can be given photographs by name.')
  }

  if (problemReport) {
    lines.push(
      'THE REQUEST DESCRIBES A PROBLEM OR ASKS WHAT TO DO. Treat it as "find the cause and fix it": ' +
        'use the facts above to name the cause, then specify the fix. Do not reply with questions for the user — ' +
        'where something is genuinely ambiguous, choose the most reasonable reading and state it as an assumption.'
    )
  }
  return { text: `\n\n${lines.join('\n')}`, problemReport, aboutImages, targeted }
}
