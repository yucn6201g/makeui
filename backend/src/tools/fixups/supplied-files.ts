import { FILE_CLOSE, FILE_OPEN, readProjectFiles } from '../project/project-transport.js'

/**
 * The build tooling MakeUI supplies itself, when a model wrote it anyway.
 *
 * The contract says not to — 「Do NOT emit index.html, package.json,
 * tsconfig.json or vite config」 — and React output honours it: 0 of 80
 * September documents. Vue output did not: 1 of 4 wrote all three, a habit from
 * `npm create vue`. Each copy is worse than nothing. The preview never loads it,
 * but `vite.config.ts` importing `vite` reads to the module audit as a package
 * nobody installed — a display-stopping `import-missing` sent to a repair — and
 * the ZIP export writes its own `vite.config.ts`, `package.json` and
 * `tsconfig.json` beside the project's, so the download held two of each.
 *
 * Root-level only: `src/config/` is the project's own business.
 */
const SUPPLIED_FILE = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[\w-]+)?\.json|vite\.config\.[cm]?[jt]s|index\.html)$/

export function dropSuppliedFiles(html: string): { html: string; dropped: string[] } {
  const dropped = [...readProjectFiles(html).keys()].filter((p) => SUPPLIED_FILE.test(p))
  if (dropped.length === 0 || !new RegExp(`^${FILE_OPEN}\\s`, 'm').test(html)) return { html, dropped: [] }
  let out = html
  for (const path of dropped) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`^${FILE_OPEN} ${escaped}\\r?\\n[\\s\\S]*?^${FILE_CLOSE}\\r?\\n?`, 'm'), '')
  }
  return { html: out, dropped }
}
