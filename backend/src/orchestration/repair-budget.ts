/**
 * How much rewriting one run is allowed to do, and which rewriting it drops.
 *
 * `repairPasses` bounds passes, not work. A pass plans one call per file that
 * has a defect, so three passes over a dozen files is thirty-odd calls, and the
 * profile that says "3" never said how many that was. Measured over 17 real
 * generations: 30.8 per-file repairs a run, and the four worst did 46, 53, 62
 * and 69. Repair is 43% of everything MakeUI spends, and those runs are what
 * exhausts a daily quota.
 *
 * Two bounds, and they are different in kind.
 *
 * The per-file one is about waste. A file rewritten twice whose defect is still
 * open has not been failed by a shortage of attempts; a third rewrite of the
 * same file against the same complaint is the definition of a call that will not
 * land. Cutting it costs nothing anyone would have got.
 *
 * The per-run one is about the tail, and it does cost something: a dropped plan
 * is a file that keeps its defect. So it is set above every typical run rather
 * than at some target — the median is 28 and the mean 30.8, and the budget is
 * 32, so a run of ordinary size never meets it. And when it does bite, it drops
 * the plans carrying the FEWEST defects, because the alternative is dropping by
 * whatever order the planner happened to return.
 *
 * What is dropped is counted and carried out — into the log with its paths and
 * reasons, and into `metadata.unrepairedDefects` as a number. Silently shipping a
 * defect the pipeline found and chose not to fix is the same failure as a score
 * that does not say it was never verified: the output looks like the pipeline's
 * best answer without being it. Nothing renders the number yet, which is a gap
 * on the client rather than a missing fact.
 *
 * The build-repair path is deliberately NOT bounded by this. It runs only when
 * the project does not compile, and it is already bounded at six files. "Less
 * polished" and "not a deliverable" are different things — the same distinction
 * the effort profiles already make when they buy a repair pass nobody paid for.
 */

/** Above the measured median (28) and mean (30.8): a typical run never meets it. */
export const MAX_FILE_REPAIRS = 32;

/** A file that survived two rewrites will survive a third. */
export const MAX_ATTEMPTS_PER_FILE = 2;

/**
 * The fewest defects worth opening another pass for.
 *
 * A pass is not free and it is not neutral: it rewrites files. Measured over 14
 * days and 67 passes, what a pass does depends almost entirely on how much is
 * left to do when it starts —
 *
 *   open when it started   passes  accepted  median change  made it worse
 *                    1-2        7         0            +4.0            6/7
 *                    3-4       11         8            +1.0           8/11
 *                    5-7       29        17             0.0          12/29
 *                     8+       20        13            -1.5           5/20
 *
 * A pass opened on one or two remaining defects has NEVER been accepted — 0 of
 * 7 — and made the document worse six times out of seven, by a median of four
 * new defects. The shape is not surprising once seen: with almost nothing left
 * to fix, a rewrite of a nearly-clean file is mostly an opportunity to break
 * something, and the judge then throws the whole pass away. The tokens are
 * spent either way.
 *
 * All seven were the second or third pass; a first pass has never met this,
 * which is why the loop only consults it after pass one. Cutting them costs
 * nothing that was being got: none of them landed.
 *
 * Two, not four. At 3-4 the picture is mixed — eight of eleven accepted, but
 * still a median of one new defect — and mixed is not a case for spending or
 * for stopping. The floor sits where the evidence is unambiguous.
 */
export const REPAIR_FLOOR = 2;

export interface Droppable {
  path: string;
  defects: unknown[];
}

export interface Admission<T> {
  /** Plans to run, most defects first. */
  run: T[];
  /** Plans not run, and why. */
  skipped: { path: string; defects: number; reason: 'budget' | 'attempts' }[];
}

/**
 * One run's allowance. Created per generation, consulted by every pass.
 *
 * Per run rather than per pass because that is the quantity that was
 * unbounded: three passes each obeying their own limit is still three times
 * whatever that limit was.
 */
export class RepairBudget {
  private used = 0;
  private readonly tries = new Map<string, number>();

  constructor(
    private readonly maxCalls: number = MAX_FILE_REPAIRS,
    private readonly maxPerFile: number = MAX_ATTEMPTS_PER_FILE
  ) {}

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.used);
  }

  /** How many times this file has already been rewritten in this run. */
  attempts(path: string): number {
    return this.tries.get(path) ?? 0;
  }

  /**
   * Decides which of a pass's plans run, and records the attempts.
   *
   * Sorted by defect count before the cut, so a short budget spends itself on
   * the files that need the most. Ties keep the planner's order — it groups
   * related files, and reordering them for no reason would only make two runs
   * of the same brief harder to compare.
   */
  admit<T extends Droppable>(plans: T[]): Admission<T> {
    const skipped: Admission<T>['skipped'] = [];
    const eligible: T[] = [];

    for (const plan of plans) {
      if (this.attempts(plan.path) >= this.maxPerFile) {
        skipped.push({ path: plan.path, defects: plan.defects.length, reason: 'attempts' });
      } else {
        eligible.push(plan);
      }
    }

    /*
     * A file carrying one of the user's own requirements goes first.
     *
     * The budget is spent in this order and cut at `remaining`, so whatever sorts
     * last is what a short budget drops. Ordered by defect count alone, a file
     * holding the one requirement the user actually stated sorts behind a file
     * with three generic findings about contrast and icons — and is the one cut.
     * The user did not ask about the contrast. They asked for 「満席」.
     *
     * Within each group the old order stands: most defects first.
     */
    const carriesRequirement = (p: Droppable) =>
      p.defects.some((d) => (d as { id?: string })?.id === 'requirement-unmet') ? 1 : 0;
    const ordered = [...eligible].sort((a, b) =>
      carriesRequirement(b) - carriesRequirement(a) || b.defects.length - a.defects.length
    );
    const run = ordered.slice(0, this.remaining);
    for (const plan of ordered.slice(this.remaining)) {
      skipped.push({ path: plan.path, defects: plan.defects.length, reason: 'budget' });
    }

    for (const plan of run) this.tries.set(plan.path, this.attempts(plan.path) + 1);
    this.used += run.length;

    return { run, skipped };
  }
}
