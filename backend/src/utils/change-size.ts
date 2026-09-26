/**
 * How much of a file a rewrite actually changed.
 *
 * Every repair and every per-file edit returns the COMPLETE file, and output is
 * most of what a generation costs: 76% of `repair:per-file`'s cost is output, and
 * that stage alone is 31% of a run. Measured per call, the output is about 95%
 * of the file it replaces — a three-line fix to a screen is paid for as the
 * whole screen, written out again.
 *
 * A search-and-replace output format would pay only for the lines that change.
 * Whether that is worth building depends on one number nobody has: how much of a
 * file a repair changes. This measures it, from the two bodies the repair path
 * already holds, at no model cost.
 *
 * Line-level, because that is the unit a replace block would carry. An exact LCS
 * while it is cheap, and a prefix/suffix bound past that — the bound can only
 * over-state the change, which errs toward NOT building the patch format.
 */

/** Above this many line-pair comparisons the exact count is not worth the time. */
const LCS_BUDGET = 4_000_000;

interface ChangeSize {
  beforeLines: number;
  afterLines: number;
  /** Lines common to both, in order. */
  unchangedLines: number;
  /** The share of the larger file that is not unchanged. 0 is identical, 1 is rewritten. */
  changedShare: number;
  /** True when the prefix/suffix bound was used instead of an exact count. */
  estimated: boolean;
}

export function changeSize(before: string, after: string): ChangeSize {
  const a = before.split('\n');
  const b = after.split('\n');
  const larger = Math.max(a.length, b.length, 1);

  // Common prefix and suffix first: cheap, exact, and usually most of the file.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  let middle = 0;
  let estimated = false;
  if (midA.length > 0 && midB.length > 0) {
    if (midA.length * midB.length <= LCS_BUDGET) {
      // Two rows of the LCS table is all the length needs.
      let prev = new Array<number>(midB.length + 1).fill(0);
      let cur = new Array<number>(midB.length + 1).fill(0);
      for (let i = 1; i <= midA.length; i++) {
        for (let j = 1; j <= midB.length; j++) {
          cur[j] = midA[i - 1] === midB[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        [prev, cur] = [cur, prev];
      }
      middle = prev[midB.length];
    } else {
      estimated = true;
    }
  }

  const unchangedLines = prefix + suffix + middle;
  return {
    beforeLines: a.length,
    afterLines: b.length,
    unchangedLines,
    changedShare: Math.round((1 - unchangedLines / larger) * 1000) / 1000,
    estimated,
  };
}
