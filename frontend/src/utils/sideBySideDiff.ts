/**
 * A unified diff, dealt into two columns.
 *
 * Pure on purpose, and in its own file for a reason that showed up immediately:
 * living beside the components meant a test of it pulled `LiveFrame`, then the
 * preview compiler, then Vite's virtual modules — a bundle graph the size of the
 * app, to check a function that maps a list to a list.
 */

/** One line of a unified diff, as `computeInlineDiff` produces it. */
export interface DiffLine {
  type: 'added' | 'removed' | 'context';
  content: string;
  oldLine?: number;
  newLine?: number;
}

/** A row of the side-by-side diff: what each column shows on this line. */
export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
  /** A collapsed run of unchanged lines, shown as one marker across both columns. */
  skip?: string;
}

/**
 * The same diff, laid out in two columns.
 *
 * `computeInlineDiff` already aligns the two texts — it runs an LCS and carries
 * `oldLine`/`newLine` — but it emits them as one stream, removals then
 * additions. A unified diff answers 「何が変わったか」 and this view is being
 * asked 「どちらがどう違うか」, which is a question about two things standing next
 * to each other.
 *
 * Within a change block the removals and additions are zipped: the first removed
 * line sits opposite the first added one, because a line that was edited is one
 * line in both versions and putting them level is the whole reason to have two
 * columns. When the runs are different lengths the shorter side gets blanks,
 * which is what makes an insertion look like an insertion.
 */
export function toSideBySide(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];

  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i += 1) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    if (line.type === 'removed') { removed.push(line); continue; }
    if (line.type === 'added') { added.push(line); continue; }
    flush();
    if (line.content.startsWith('@@')) rows.push({ left: null, right: null, skip: line.content });
    else rows.push({ left: line, right: line });
  }
  flush();
  return rows;
}
