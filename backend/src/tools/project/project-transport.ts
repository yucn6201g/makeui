/**
 * How a multi-file project travels as one string.
 *
 * The original transport wrapped each file in `<script data-file="…">`, which
 * works only while no file contains the sequence that closes it. React source
 * rarely does. Vue and Svelte source *always* does: every single-file component
 * has its own `<script>` block, and the reader cuts the file at the component's
 * own closing tag. Measured on a minimal SFC: 113 bytes written, 68 read back,
 * with the `<style>` block and the closing `</script>` gone. There is no way to
 * escape around that — the collision is with the format itself.
 *
 * So new projects use a line fence instead. A line that is exactly the sentinel
 * has no meaning in HTML, JavaScript, CSS, Vue, Svelte or Markdown, which is the
 * whole requirement:
 *
 *     @@@makeui:file src/App.vue
 *     <template>…</template>
 *     <script setup lang="ts">…</script>
 *     @@@makeui:endfile
 *
 * The reader accepts both. Sixteen stored React projects use the old form, and
 * migrating them would be a rewrite of records that are currently fine — a
 * migration that can half-finish, to remove a format the reader can simply keep
 * understanding. Writing is new-format only, so the old one dies out on its own.
 */

export const FILE_OPEN = '@@@makeui:file'
export const FILE_CLOSE = '@@@makeui:endfile'

/** True when the document uses the line-fenced transport. */
export function isFencedTransport(source: string): boolean {
  return new RegExp(`^${FILE_OPEN}\\s`, 'm').test(source)
}

/**
 * Every file in the document, whichever transport carried it.
 *
 * The fenced form is read first and, when present, exclusively: a document is
 * one shape or the other, and reading both would let a stray `<script>` inside a
 * fenced file register as a second, bogus file.
 */
export function readProjectFiles(source: string): Map<string, string> {
  return isFencedTransport(source) ? readFenced(source) : readScriptBlocks(source)
}

/**
 * A body the model wrapped in a markdown code fence.
 *
 *     @@@makeui:file src/lib/navigation.svelte.ts
 *     ```svelte.ts
 *     import type { Route } from '../routes';
 *     …
 *     ```
 *     @@@makeui:endfile
 *
 * Measured at v169, on one file out of twenty-five — the others in the same
 * response were bare. The fence is a habit from writing code in prose, and the
 * line sentinel does nothing to discourage it: both say "here is a file", so
 * writing both reads as correct.
 *
 * It survives every gate we have, because in JavaScript it is *valid*. Three
 * backticks are an empty template literal followed by the start of a tagged
 * one, so the entire file becomes a single template string tagged with `""`.
 * It parses, it compiles, the per-file gate passes and the project gate passes
 * — and the module exports nothing and throws `TypeError: "" is not a function`
 * the moment it is required. A blank page from a document every check called
 * clean, which is the failure mode that costs the most to find.
 *
 * Only a body that is exactly one fenced block is unwrapped. A fence anywhere
 * between the first and the last leaves the body alone, which is what keeps
 * SPECIFICATION.md and the design guidelines — markdown whose fences are the
 * content — from being unwrapped into their own first code block.
 */
function unfence(body: string): string {
  const lines = body.split('\n')
  let first = 0
  while (first < lines.length && lines[first].trim() === '') first++
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last--
  if (first >= last) return body
  if (!/^```[A-Za-z0-9._+-]*$/.test(lines[first].trim())) return body
  if (lines[last].trim() !== '```') return body
  for (let i = first + 1; i < last; i++) if (/^\s*```/.test(lines[i])) return body
  return lines.slice(first + 1, last).join('\n')
}

function readFenced(source: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = source.split('\n')
  let path: string | null = null
  let body: string[] = []
  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed.startsWith(`${FILE_OPEN} `)) {
      // An unclosed file still counts. A truncated response is worth reading as
      // far as it got — the parse gate downstream will reject what is broken,
      // and dropping it here would report the file as simply missing.
      if (path) out.set(path, unfence(body.join('\n')))
      path = trimmed.slice(FILE_OPEN.length + 1).trim()
      body = []
      continue
    }
    if (trimmed === FILE_CLOSE) {
      if (path) out.set(path, unfence(body.join('\n')))
      path = null
      body = []
      continue
    }
    if (path) body.push(line)
  }
  if (path) out.set(path, unfence(stripEnvelope(body.join('\n'))))
  return out
}

/**
 * The document's own closing tags, taken off the last file.
 *
 * A fenced document is a set of files inside an HTML shell, and the last file
 * is the one that can lose its `@@@makeui:endfile` — the model runs out of
 * response, or simply forgets it, and writes the shell's `</body></html>`
 * anyway. `readFenced` accepts an unclosed file on purpose (a truncated answer
 * is worth reading as far as it got), and so it accepted the envelope with it.
 *
 * Measured on a corpus project: `src/App.vue` ended with a blank line and then
 * the shell's closing tags, and Vue's own parser answered `Invalid end tag.` —
 * the whole project failed to build over two tags that were never part of any
 * file. That document has 8 `@@@makeui:file` markers and 7 `@@@makeui:endfile`.
 *
 * Only from the end, and only when the file is not itself an HTML document:
 * `index.html` legitimately ends this way, and taking its closing tags off
 * would be the same defect pointed the other way.
 */
function stripEnvelope(body: string): string {
  if (/<html[\s>]/i.test(body) || /<body[\s>]/i.test(body)) return body
  return body.replace(/\s*<\/body>\s*<\/html>\s*$/i, "")
}

/**
 * The original transport.
 *
 * The closing tag must match the one that opened — an untied alternation ended a
 * `<script>` block at the first `</style>` inside it, which a screen can
 * legitimately contain, and truncated a 6.8KB file to 3.0KB.
 */
function readScriptBlocks(source: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /<(script|style)\b[^>]*data-file=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) out.set(m[2], m[3])
  return out
}

/** Wraps one file for the fenced transport. */
function fenceFile(path: string, body: string): string {
  return `${FILE_OPEN} ${path}\n${body}\n${FILE_CLOSE}`
}

/**
 * Assembles a whole project document from its files.
 *
 * The `<div id="root">` and the doctype are kept so the artefact is still a
 * recognisable HTML file — published pages, thumbnails and anything that treats
 * the stored document as a page keep working — while the source lives in fences
 * no HTML parser touches.
 */
export function writeProjectDocument(files: Map<string, string>): string {
  const blocks = [...files].map(([path, body]) => fenceFile(path, body)).join('\n')
  return `<!DOCTYPE html>\n<html lang="ja">\n<head><meta charset="UTF-8" /></head>\n<body>\n<div id="root"></div>\n${blocks}\n</body>\n</html>`
}

/**
 * Replaces one file's body, or adds it when new, in whichever transport the
 * document already uses.
 *
 * Refuses nothing in the fenced form: a body can hold `</script>`, `</style>` or
 * anything else, because the fence is a whole line and source lines are not.
 * That is the point of the change, so the old form's refusals stay confined to
 * the old form.
 */
export function writeProjectFile(source: string, path: string, body: string): string | null {
  if (isFencedTransport(source)) {
    if (new RegExp(`^${FILE_CLOSE}$|^${FILE_OPEN}\\s`, 'm').test(body)) return null
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const block = new RegExp(`^${FILE_OPEN} ${escaped}\\r?\\n[\\s\\S]*?^${FILE_CLOSE}$`, 'm')
    // A function, not a string: a body holding `$&` — every regex-escape helper
    // does — was spliced as a replacement pattern, pasting the whole old block
    // into the new one. Measured on a stored blog project, whose format.ts no
    // longer compiled after an unrelated fixup rewrote it.
    if (block.test(source)) return source.replace(block, () => fenceFile(path, body))
    const at = source.lastIndexOf('</body>')
    const fenced = fenceFile(path, body)
    return at === -1 ? `${source}\n${fenced}` : `${source.slice(0, at)}${fenced}\n${source.slice(at)}`
  }
  return null
}

/**
 * The one file a design-system deviation can live in.
 *
 * Conformance is measured over `normaliseCss(html)` and nothing else — missing
 * token values, a forbidden colour, palette dominance, radii, motion — and the
 * stylesheet contract puts all styling in one file. So the repair for it needs
 * that file, not the project it sits in.
 *
 * Largest rather than first, and only when it is a real stylesheet: a project
 * can carry a second `.css` for a print sheet or a vendor reset, and the
 * deviations are in the one that holds the tokens. Returns null for a document
 * with no fenced CSS at all, which is a legacy single-page mock and has to keep
 * the whole-document path.
 */
export function stylesheetOf(source: string): { path: string; body: string } | null {
  if (!isFencedTransport(source)) return null
  let best: { path: string; body: string } | null = null
  for (const [path, body] of readProjectFiles(source)) {
    if (!path.endsWith('.css')) continue
    if (!best || body.length > best.body.length) best = { path, body }
  }
  return best && best.body.trim().length > 0 ? best : null
}

/**
 * Puts a repaired stylesheet back, or null when it is not a stylesheet.
 *
 * The check is deliberately weak — a brace and a colon — because it is guarding
 * against a reply that is prose or markdown, not judging CSS. Whether the
 * repair actually helped is decided afterwards by measuring the whole document,
 * which is the only test that means anything.
 */
export function spliceStylesheet(source: string, path: string, css: string): string | null {
  const body = css.trim()
  if (!body.includes('{') || !body.includes(':')) return null
  return writeProjectFile(source, path, body)
}
