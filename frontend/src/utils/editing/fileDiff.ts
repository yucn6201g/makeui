/**
 * The diff, per file — because that is the unit a change is understood in.
 *
 * A generated project arrives as one transported document, and comparing two of
 * them as one long text answers 「何行変わったか」 while hiding 「どこが」. A run
 * that rewrites the detail screen and leaves the list alone reads, in one
 * stream, as a change somewhere around line 1400. Split first and the same run
 * reads as: `src/screens/Detail.tsx` +18 −6, everything else untouched.
 *
 * Splitting is also cheaper, not just clearer. The alignment below is O(n·m);
 * over separate files the cost is the sum of n_i·m_i, which is smaller than the
 * product of the sums — and files that did not change are skipped by a string
 * comparison before any of it runs.
 *
 * Pure, and importing nothing but its sibling: the splitter lives in
 * `virtualFs`, which reaches for `DOMParser` and re-exports the scaffold, so
 * taking files already split keeps this testable in Node with no bundle graph
 * behind it.
 */
import { toSideBySide } from './sideBySideDiff';
import type { DiffLine, DiffRow } from './sideBySideDiff';

/** Enough of a file to diff it. `VFile` from `virtualFs` satisfies this. */
interface SourceFile {
  path: string;
  content: string;
}

export interface FileDiff {
  path: string;
  /** Present on one side only, or on both with different contents. */
  status: 'added' | 'removed' | 'modified';
  added: number;
  removed: number;
  rows: DiffRow[];
  /** Why what is shown is less than the whole truth, when it is. */
  note: string | null;
}

/** Unchanged lines kept either side of a change, as context. */
const CONTEXT = 3;
/** Rows shown for one file before the rest is summarised instead. */
const MAX_ROWS = 400;
/**
 * The alignment is a table of n·m numbers. Past this the browser stops being
 * able to draw a frame, so the file is reported as changed without being
 * aligned — a slow answer here is a hung tab, not a late one.
 */
const MAX_CELLS = 4_000_000;

/**
 * Line up two texts, keeping every line of both.
 *
 * A longest-common-subsequence table, walked forwards: equal lines are context,
 * and where they differ the table says which side to advance. `oldLine` and
 * `newLine` are each column's own numbering, which is what lets a row show
 * where it sits in its own version.
 */
function alignLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    new Array(newLines.length + 1).fill(0)
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? 1 + dp[i + 1][j + 1]
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  let oi = 0;
  let ni = 0;
  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      out.push({ type: 'context', content: oldLines[oi], oldLine: oldNum++, newLine: newNum++ });
      oi++; ni++;
    } else if (ni < newLines.length && (oi >= oldLines.length || dp[oi][ni + 1] >= dp[oi + 1][ni])) {
      out.push({ type: 'added', content: newLines[ni], newLine: newNum++ });
      ni++;
    } else {
      out.push({ type: 'removed', content: oldLines[oi], oldLine: oldNum++ });
      oi++;
    }
  }
  return out;
}

/**
 * Drop the long unchanged stretches, and say where the reader has been moved to.
 *
 * The marker carries the line numbers the next shown row starts at, the way a
 * unified diff's `@@` header does. 「40 行省略」 alone says how far you jumped;
 * with the numbers it says where you landed, which is the half that answers
 * 「どこに差分があるか」.
 */
function trimToChanges(lines: DiffLine[]): DiffLine[] {
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === 'context') continue;
    for (let c = Math.max(0, i - CONTEXT); c <= Math.min(lines.length - 1, i + CONTEXT); c++) {
      keep.add(c);
    }
  }
  if (keep.size === 0) return [];

  const out: DiffLine[] = [];
  let lastShown = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    const line = lines[i];
    const skipped = i - lastShown - 1;
    if (skipped > 0) {
      const oldAt = line.oldLine ?? '';
      const newAt = line.newLine ?? '';
      out.push({ type: 'context', content: `@@ -${oldAt} +${newAt} @@ ${skipped} 行省略` });
    }
    out.push(line);
    lastShown = i;
  }
  return out;
}

/** Every line of a file that exists on only one side. */
function wholeFile(text: string, type: 'added' | 'removed'): DiffLine[] {
  return text.split('\n').map((content, i) =>
    type === 'added'
      ? { type, content, newLine: i + 1 }
      : { type, content, oldLine: i + 1 }
  );
}

function countLines(text: string): number {
  return text.split('\n').length;
}

function build(path: string, status: FileDiff['status'], lines: DiffLine[]): FileDiff {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'added') added++;
    else if (line.type === 'removed') removed++;
  }
  /*
   * Cut after the two columns are paired, not before.
   *
   * Cutting the aligned lines would take them in the order the alignment emits
   * them — every removal, then the additions replacing them — so a long change
   * would arrive as four hundred deletions with nothing opposite any of them,
   * which is a picture of a file being emptied rather than of it being edited.
   */
  const all = toSideBySide(status === 'modified' ? trimToChanges(lines) : lines);
  const note = all.length > MAX_ROWS
    ? `差分が大きいため、最初の ${MAX_ROWS} 行のみ表示しています。`
    : null;
  return { path, status, added, removed, rows: all.slice(0, MAX_ROWS), note };
}

/**
 * Compare two versions of a project, file by file.
 *
 * Files present in both and identical are left out entirely: a list of what
 * changed is only useful if it is a list of what changed. Order follows the
 * newer version — `index.html` first, as the splitter arranges it — with files
 * that only the older version had at the end, since they have no place in the
 * new ordering.
 */
export function diffFileSets(before: SourceFile[], after: SourceFile[]): FileDiff[] {
  const oldByPath = new Map(before.map((f) => [f.path, f.content]));
  const newByPath = new Map(after.map((f) => [f.path, f.content]));
  const out: FileDiff[] = [];

  for (const file of after) {
    const previous = oldByPath.get(file.path);
    if (previous === undefined) {
      out.push(build(file.path, 'added', wholeFile(file.content, 'added')));
      continue;
    }
    if (previous === file.content) continue;

    if (countLines(previous) * countLines(file.content) > MAX_CELLS) {
      out.push({
        path: file.path,
        status: 'modified',
        added: 0,
        removed: 0,
        rows: [],
        note: 'ファイルが大きいため、行単位の差分は表示できません。',
      });
      continue;
    }
    out.push(build(file.path, 'modified', alignLines(previous, file.content)));
  }

  for (const file of before) {
    if (newByPath.has(file.path)) continue;
    out.push(build(file.path, 'removed', wholeFile(file.content, 'removed')));
  }

  return out;
}

/** The one line at the top: how many files, and how much of them. */
export function summarise(files: FileDiff[]): { files: number; added: number; removed: number } {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

export type { DiffRow };
