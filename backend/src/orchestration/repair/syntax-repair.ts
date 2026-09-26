import type { InteractionDefect } from '../audit/interaction-audit.js'
import { sourceFiles, parses, writeFile } from './repair-files.js'
import { logger } from '../../utils/logger.js'

/**
 * Repairs generated files that do not parse, without asking a model.
 *
 * One unparseable file is not a degraded project, it is no project: the bundler
 * compiles every module into one document, so a single bad character anywhere
 * produces the same result as an empty response — 「ビルドエラー」 and a blank
 * pane. Measured on a real run, an eight-screen shop shipped that way for this:
 *
 *     case 'UPDATE_CART_QTY:
 *
 * A missing closing quote. The literal ran on to the next `'` eleven lines
 * later, and the parser reported the failure there — `Unexpected token, expected
 * ":" (54:11)` — which names a line that is perfectly correct. Nothing upstream
 * could act on that: the repair planner was handed one `console-error` holding a
 * position in a file it could not see.
 *
 * The class is worth handling deterministically because it is decidable. A
 * string literal in JavaScript cannot contain a raw newline, so a quote that
 * opens and does not close before the end of its line is unambiguously wrong —
 * there is no valid program in which it is intended. What is *not* decidable is
 * where the quote belonged, so this does not guess: it tries the few positions a
 * closing quote can occupy, re-parses after each, and keeps the first that
 * makes the whole file compile. A repair that cannot be verified is not applied.
 */

/** How many suspect lines to consider, and how many parses to spend in total. */
const MAX_LINES = 12
const MAX_ATTEMPTS = 48

/** Characters a closing quote can hide behind at the end of a line. */
const TRAILING = new Set([':', ',', ';', ')', ']', '}', '>'])

interface Suspect {
  /** 0-based line index. */
  line: number
  /** The quote that opened and never closed. */
  quote: string
  /** Index of the opening quote within the line. */
  from: number
}

/**
 * Lines holding a string literal that never closes.
 *
 * Scans rather than parses, because the file is one the parser has already
 * refused. Templates and comments are tracked so their contents are not read as
 * code; regular expressions are not, so `split(/['"]/)` looks like an opening
 * quote. That is deliberate — a false suspect costs one parse attempt that
 * fails, and the alternative is a tokeniser, which is the thing that already
 * gave up on this file.
 *
 * After each suspect the scanner carries on as though the string had closed at
 * the end of its line. A single stray apostrophe in JSX text would otherwise put
 * every later line inside an imaginary string and hide the real fault.
 */
export function unterminatedStrings(body: string): Suspect[] {
  const lines = body.split('\n')
  const found: Suspect[] = []
  let inBlockComment = false
  let inTemplate = false

  for (let n = 0; n < lines.length && found.length < MAX_LINES; n++) {
    const line = lines[n]
    let i = 0
    while (i < line.length) {
      const c = line[i]
      if (inBlockComment) {
        const end = line.indexOf('*/', i)
        if (end === -1) { i = line.length; break }
        inBlockComment = false
        i = end + 2
        continue
      }
      if (inTemplate) {
        if (c === '\\') { i += 2; continue }
        if (c === '`') { inTemplate = false }
        i++
        continue
      }
      if (c === '/' && line[i + 1] === '/') break
      if (c === '/' && line[i + 1] === '*') { inBlockComment = true; i += 2; continue }
      if (c === '`') { inTemplate = true; i++; continue }
      if (c === "'" || c === '"') {
        const from = i
        let j = i + 1
        let closed = false
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; continue }
          if (line[j] === c) { closed = true; break }
          j++
        }
        if (!closed) {
          found.push({ line: n, quote: c, from })
          break // carry on from the next line, as if it had closed here
        }
        i = j + 1
        continue
      }
      i++
    }
  }
  return found
}

/**
 * Where the closing quote might go, rightmost first.
 *
 * Rightmost first keeps the most of what was written: for `case 'X:` the end of
 * the line gives `'X:'`, which is still not a valid case clause and is rejected,
 * and the next position left gives `'X':`, which is the sentence that was meant.
 * Working the other way round would truncate strings that were merely missing
 * their final quote.
 */
function insertionPoints(line: string, from: number): number[] {
  const end = line.replace(/\s+$/, '').length
  const points = [end]
  for (let i = end - 1; i > from && TRAILING.has(line[i]); i--) points.push(i)
  return points
}

interface SyntaxRepair {
  path: string
  line: number
  before: string
  after: string
}

/**
 * Closes unterminated string literals in one file, if doing so makes it parse.
 *
 * Returns null when the file already parses, when no suspect line is found, or
 * when no candidate produced a file the parser accepts. The last case is the
 * common one for faults this cannot handle, and returning null there is the
 * whole safety property: the document is only ever rewritten into a state that
 * has been compiled.
 */
export function repairFileSyntax(
  path: string,
  body: string
): { body: string; repairs: SyntaxRepair[] } | null {
  if (parses(path, body) === null) return null

  const suspects = unterminatedStrings(body)
  if (suspects.length === 0) return null

  const lines = body.split('\n')
  let attempts = 0
  for (const s of suspects) {
    const original = lines[s.line]
    for (const at of insertionPoints(original, s.from)) {
      if (++attempts > MAX_ATTEMPTS) return null
      const candidate = original.slice(0, at) + s.quote + original.slice(at)
      const next = [...lines]
      next[s.line] = candidate
      const joined = next.join('\n')
      if (parses(path, joined) === null) {
        return {
          body: joined,
          repairs: [{ path, line: s.line + 1, before: original.trim(), after: candidate.trim() }],
        }
      }
    }
  }
  return null
}

interface SyntaxRepairResult {
  html: string
  repairs: SyntaxRepair[]
}

/** Applies `repairFileSyntax` to every source file in the document. */
export function repairSyntax(html: string): SyntaxRepairResult {
  let doc = html
  const repairs: SyntaxRepair[] = []
  for (const [path, body] of sourceFiles(html)) {
    const fixed = repairFileSyntax(path, body)
    if (!fixed) continue
    const next = writeFile(doc, path, fixed.body)
    if (!next) continue
    doc = next
    repairs.push(...fixed.repairs)
  }
  if (repairs.length > 0) {
    logger.info('Syntax repaired without a model call', {
      files: repairs.map((r) => `${r.path}:${r.line}`).join(', '),
    })
  }
  return { html: doc, repairs }
}

/**
 * Files that still do not parse, named one defect at a time.
 *
 * The point is the naming. A project that fails to compile reached the repair
 * planner as a single `console-error` carrying a parser position, and the
 * planner has to reverse-engineer "rewrite this file" out of it — measured, it
 * did not, and a broken project shipped. A defect that says which file, quotes
 * the line, and asks for that file back is the shape the per-file repair
 * already knows how to answer.
 *
 * The offending line travels with the complaint because the position alone is
 * useless twice over: the file exists only inside this run, and the parser
 * frequently reports the *next* correct line rather than the fault — an
 * unterminated string is noticed at the quote that eventually closes it.
 */
export function syntaxDefects(html: string): InteractionDefect[] {
  const out: InteractionDefect[] = []
  for (const [path, body] of sourceFiles(html)) {
    const error = parses(path, body)
    if (!error) continue
    const at = /\((\d+):(\d+)\)/.exec(error)
    const lines = body.split('\n')
    const n = at ? Number(at[1]) : 0
    const near = n > 0
      ? lines
          .slice(Math.max(0, n - 3), n)
          .map((l, i) => `${Math.max(1, n - 2) + i}: ${l}`)
          .join('\n')
      : ''
    out.push({
      id: 'syntax-error',
      instruction:
        `${path} が構文エラーで、プロジェクト全体がビルドできません（1ファイルでも壊れていると画面は何も表示されません）。\n` +
        `パーサのエラー: ${error}\n` +
        (near ? `該当箇所の前後:\n${near}\n` : '') +
        'このファイルを構文的に正しい形に直してください。' +
        'なお、エラー位置は原因の行とは限りません（閉じ忘れた引用符は、次に現れる引用符の位置で報告されます）。' +
        'その行だけでなく、少し手前から見直してください。' +
        '内容・設計・エクスポートは変更せず、構文だけを直すこと。',
    })
  }
  return out
}
