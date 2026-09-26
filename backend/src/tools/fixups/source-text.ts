/**
 * Small readers and writers of source text that several fixups share:
 * whether a module declares a name, and adding an import to one.
 */
import { type OutputKind } from '../../config/frameworks.js'

/**
 * The same file with an import added, wherever this framework keeps them.
 *
 * After the last existing import, so it sits with its neighbours; failing that,
 * at the top of the module — which for a Vue SFC means inside `<script setup>`,
 * and means creating that block when the component has none.
 */
export function withImport(source: string, statement: string, kind: OutputKind): string {
  if (source.includes(statement)) return source
  if (kind === 'vue') {
    const block = /<script[^>]*\bsetup\b[^>]*>/.exec(source)
    if (!block) {
      return `<script setup lang="ts">\n${statement};\n</script>\n\n${source}`
    }
    const at = (block.index ?? 0) + block[0].length
    const inner = source.slice(at)
    const last = lastImportEnd(inner)
    return source.slice(0, at + last) + `\n${statement};` + source.slice(at + last)
  }
  const last = lastImportEnd(source)
  return last === 0
    ? `${statement};\n${source}`
    : source.slice(0, last) + `\n${statement};` + source.slice(last)
}

/** Whether the file already binds this name — a declaration or an import. */
export function declares(source: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    new RegExp(`\\b(?:function|const|let|var|class)\\s+${n}(?![\\w$])`).test(source) ||
    new RegExp(`\\bimport\\s[^\\n]*?(?<![\\w$])${n}(?![\\w$])[^\\n]*?from`).test(source) ||
    new RegExp(`\\bas\\s+${n}(?![\\w$])`).test(source)
  )
}

/** Just past the last top-level import, or 0 when there is none. */
function lastImportEnd(source: string): number {
  let end = 0
  for (const m of source.matchAll(/^import\s[^\n]*?;?\s*$/gm)) {
    end = (m.index ?? 0) + m[0].replace(/\s+$/, '').length
  }
  return end
}

