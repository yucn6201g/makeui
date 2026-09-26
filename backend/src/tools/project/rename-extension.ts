import { isFencedTransport, readProjectFiles, writeProjectDocument } from './project-transport.js'

/**
 * Renames one file inside the document, whichever transport carries it.
 *
 * Split out of `normalizeReactExtensions` because doing it correctly needs the
 * transport's own primitives rather than a regex over the document, and the
 * regex version was the bug: it rewrote a `data-file` attribute, so on a fenced
 * project it matched nothing and silently did nothing.
 *
 * The consequence was invisible in the preview and real in the export. The
 * bundler retries a `.ts` file with the JSX transform, so the page renders
 * either way — but `tsc` reads `<` in a `.ts` file as a type parameter and
 * refuses to build, and the downloadable project now promises that
 * `npm run typecheck` passes.
 *
 * For the fenced form the whole document is rebuilt from its files, which is
 * safe because a fenced document is exactly a doctype, a mount element and its
 * fences — `writeProjectDocument` produces the same shape. Order is preserved
 * because a Map iterates in insertion order.
 */
export function renameFile(source: string, from: string, to: string): string | null {
  if (isFencedTransport(source)) {
    const files = readProjectFiles(source)
    const body = files.get(from)
    if (body === undefined || files.has(to)) return null
    const renamed = new Map<string, string>()
    for (const [path, content] of files) renamed.set(path === from ? to : path, content)
    return writeProjectDocument(renamed)
  }

  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The attribute inside this file's own opening tag, and nowhere else.
  const tag = new RegExp(`(<(?:script|style)\\b[^>]*data-file=["'])${escaped}(["'])`, 'i')
  const next = source.replace(tag, `$1${to}$2`)
  return next === source ? null : next
}
