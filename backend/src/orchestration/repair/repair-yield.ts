import type { InteractionDefect } from '../audit/interaction-audit.js';

/**
 * Which defects the repair loop can actually fix, measured rather than assumed.
 *
 * Repair is 46% of everything a generation spends — 35% of it in `repair:per-file`
 * alone, 27 calls a run rewriting a median of 13 whole files. So the question
 * worth asking is not how many passes to buy but what they are being spent ON.
 *
 * Two tables answer it, because one of them cannot.
 *
 * `FIX_RATE` asks a question about one pass: for every ACCEPTED pass in the log
 * history, was the defect absent from the `remaining` list the pass reported.
 * 190 passes, 1,616 defect instances, re-measured 2026-09-12 over 30 days by
 * `scripts/fix-rates.mjs`.
 *
 * `SURVIVAL` asks the question the user experiences: the run is over, is the
 * defect still in the document. 130 runs with two or more passes, 1,161
 * instances, same window, `scripts/defect-survival.mjs`.
 *
 * They disagree, and the disagreement is the point. A pass is accepted or
 * rejected whole, so a defect the pass fixed goes back when the pass is thrown
 * away — and half the passes are. `contrast-low` is fixed 48% of the time and
 * survives 44% of runs; `action-dead-runtime` is fixed 5% and survives 84%.
 * Either number alone is a partial answer.
 *
 * THIRTEEN ROWS BELOW ARE NOT MEASUREMENTS, and the defect that made them was
 * found 2026-09-13. The judge built `after` from five auditors while `before`
 * came from all fifteen in `collectDefects`, so these ids could never be
 * reported as remaining and read as fixed every time: app-fallback,
 * component-unresolved, destructured-key-missing, import-missing,
 * inline-styling, preset-drift, radius-scale, required-prop-missing,
 * route-default, router-hash, spacing-scale, svelte-legacy-idiom, syntax-error.
 * Their 100% is the blind spot. The judge now measures with the same collector;
 * re-run `scripts/fix-rates.mjs` over a window that starts after that deploy
 * before trusting any of them. `SURVIVAL` was never affected — it compares the
 * lists passes were handed, which always came from the full collector.
 *
 * These numbers describe the pipeline as it was when they were taken. They move
 * as it changes — the previous measurement read `visual-typography` at 85% and
 * it is 50% now, `visual-density` 72% and it is 54%. Re-measure before trusting
 * them again; both scripts read CloudWatch and cost nothing.
 */
export const FIX_RATE: Record<string, { fixed: number; of: number }> = {
  'default-palette': { fixed: 0, of: 26 },
  'filler-copy': { fixed: 0, of: 17 },
  'dead-controls': { fixed: 0, of: 10 },
  'visual-spacing': { fixed: 4, of: 146 },
  'action-dead-runtime': { fixed: 5, of: 93 },
  'palette-size': { fixed: 2, of: 25 },
  'nav-dead-runtime': { fixed: 6, of: 44 },
  emoji: { fixed: 7, of: 44 },
  'empty-container': { fixed: 4, of: 22 },
  'visual-alignment': { fixed: 17, of: 90 },
  'demo-login': { fixed: 4, of: 20 },
  'native-dialog': { fixed: 5, of: 23 },
  'visual-hierarchy': { fixed: 18, of: 80 },
  store: { fixed: 4, of: 11 },
  'layout-broken': { fixed: 10, of: 27 },
  'console-error': { fixed: 10, of: 26 },
  'imagery-missing': { fixed: 52, of: 129 },
  screens: { fixed: 7, of: 17 },
  'blank-render': { fixed: 5, of: 12 },
  'visual-artefact': { fixed: 6, of: 14 },
  'screen-unreachable': { fixed: 13, of: 30 },
  'input-sizing': { fixed: 27, of: 61 },
  'visual-accent': { fixed: 10, of: 22 },
  'contrast-low': { fixed: 51, of: 107 },
  'scoped-styling': { fixed: 16, of: 32 },
  'visual-typography': { fixed: 12, of: 24 },
  'visual-density': { fixed: 22, of: 41 },
  'input-small': { fixed: 7, of: 13 },
  icons: { fixed: 46, of: 71 },
  'shell-without-nav': { fixed: 70, of: 93 },
  decomposition: { fixed: 54, of: 56 },
  'seed-data-flat': { fixed: 29, of: 30 },
  'thin-stylesheet': { fixed: 19, of: 19 },
  'required-prop-missing': { fixed: 16, of: 16 },
  'preset-drift': { fixed: 14, of: 14 },
  'component-unresolved': { fixed: 13, of: 13 },
  'import-missing': { fixed: 11, of: 11 },
};

/**
 * How often a defect is still in the document when the run ends.
 *
 * The other half of the evidence. `FIX_RATE` counts what a pass achieved;
 * this counts what the run delivered, which is the only one the user meets.
 *
 * Measured over 30 days by `scripts/defect-survival.mjs`: the defect list the
 * FIRST repair pass was given, against the list the LAST one was given. Runs
 * with a single pass are excluded — there is no "after" to compare with, and
 * counting them would read "the loop ran once" as "the loop failed".
 */
export const SURVIVAL: Record<string, { survived: number; of: number }> = {
  'default-palette': { survived: 15, of: 15 },
  'filler-copy': { survived: 10, of: 10 },
  'visual-spacing': { survived: 73, of: 77 },
  'action-dead-runtime': { survived: 54, of: 64 },
  emoji: { survived: 26, of: 31 },
  'visual-alignment': { survived: 44, of: 55 },
  'empty-container': { survived: 12, of: 15 },
  'nav-dead-runtime': { survived: 23, of: 30 },
  'demo-login': { survived: 12, of: 16 },
  'visual-hierarchy': { survived: 37, of: 50 },
  'blank-render': { survived: 13, of: 18 },
  'native-dialog': { survived: 10, of: 15 },
  'console-error': { survived: 17, of: 27 },
  store: { survived: 6, of: 10 },
  'visual-accent': { survived: 17, of: 24 },
  'input-sizing': { survived: 24, of: 48 },
  screens: { survived: 6, of: 12 },
  'visual-artefact': { survived: 9, of: 20 },
  'imagery-missing': { survived: 53, of: 109 },
  'scoped-styling': { survived: 12, of: 25 },
  'layout-broken': { survived: 9, of: 19 },
  'contrast-low': { survived: 33, of: 75 },
  'input-small': { survived: 3, of: 8 },
  'screen-unreachable': { survived: 7, of: 20 },
  'visual-typography': { survived: 19, of: 32 },
  icons: { survived: 21, of: 67 },
  'visual-density': { survived: 17, of: 36 },
  'shell-without-nav': { survived: 20, of: 86 },
  'router-hash': { survived: 1, of: 10 },
  decomposition: { survived: 5, of: 58 },
  'thin-stylesheet': { survived: 1, of: 19 },
  'seed-data-flat': { survived: 1, of: 30 },
};


/**
 * The line, and it is drawn low on purpose.
 *
 * `imagery-missing` is fixed 41% of the time and `shell-without-nav` 78%; both
 * are worth the call. A fifth is where a defect stops being something the loop
 * fixes and becomes something it pays to attempt.
 */
export const YIELD_FLOOR = 0.2;

/** A finding from the vision critic rather than from a deterministic audit. */
export function isCriticFinding(id: string): boolean {
  return id.startsWith('visual-');
}

/**
 * The critic's findings split in two — on survival, not on fix rate.
 *
 * This used to be a gap in `FIX_RATE`: 4% / 21% / 23% against 72% / 73% / 85%,
 * "49 points of nothing". The 2026-09-12 re-measurement closed it. The same
 * three findings now read 3% / 19% / 23% against 43% / 45% / 50% / 54%, and a
 * 22-point interval with four values crowded above it is a continuum, not a
 * gap. The test beside this file said that would happen and it did.
 *
 * The split survives on the other measurement, which is the better one for this
 * decision anyway. `SURVIVAL` asks whether the defect was still in the document
 * when the run ended — which is what the user meets, and what a repair pass is
 * bought to prevent:
 *
 *   visual-spacing 95%   visual-alignment 80%   visual-hierarchy 74%
 *   ————————————————— 16 points of nothing —————————————————
 *   visual-accent 57%   visual-artefact 50%   visual-typography 33%   visual-density 31%
 *
 * Same three ids, measured a different way, on 77, 55 and 50 instances. A
 * finding that is still there at the end of nine runs in ten is not one the
 * loop fixes, whatever an individual pass reported.
 *
 * And the caveat that motivated the original gap still stands underneath both
 * numbers: the vision model returns a different list each time it is asked, so
 * a finding can leave a list without the page changing. That makes every fix
 * rate here an upper bound and every survival rate a lower one — which is the
 * direction that argues for the exclusion, not against it.
 *
 * The boundary is put in the empty region rather than at a number chosen to
 * include what I wanted to exclude. If a future measurement fills THIS gap, the
 * split stops being defensible and the test beside this file says so again.
 */
export const CRITIC_GAP = { below: 0.58, above: 0.74 };

/**
 * How often the critic raises a category again on the SAME, unchanged screenshot.
 *
 * The caveat above, measured. Measured 2026-09-13 on screenshots of 31 stored
 * outputs, each critiqued twice by Haiku through the production prompt: of the
 * screenshots where a category was raised at all, the share where it was raised
 * both times.
 *
 * This is the baseline `SURVIVAL` has to be read against. A repair has shown an
 * effect only when a finding survives it LESS often than it survives doing
 * nothing:
 *
 *   visual-typography  persists 82%, survives a run 59%   -> repairs move it
 *   visual-density     persists 72%, survives a run 47%   -> repairs move it
 *   visual-accent      persists 38%, survives a run 71%   -> no effect shown
 *   visual-artefact    persists 24%, survives a run 45%   -> no effect shown
 *
 * Re-measured 2026-09-14, both tables together as the first measurement asked:
 * 23 more screenshots (the most recent stored outputs not already measured,
 * one blank one left out as the pipeline leaves it out) critiqued twice each by
 * Haiku through the production prompt, pooled with the first 31, and `SURVIVAL`
 * re-derived over 30 days. The pattern held past twenty on both — accent 24 and
 * 24, artefact 37 and 20 — and on the new screenshots alone it pointed the same
 * way (accent 3/9, artefact 6/18). So both are in `NOT_WORTH_REPAIRING` on this
 * ground: a finding a repair leaves standing MORE often than asking again does
 * is one the repair is not moving. The first measurement read 40% and 16%.
 *
 * And a category raised twice is not the same finding twice. Of 18 screenshots
 * where density was raised both times, 3 pointed the same way, 4 the opposite
 * way (「行が詰まりすぎ」 then 「余白が多すぎ」) and 11 were about different
 * elements — so even the persistent categories are weaker evidence than 69%
 * suggests.
 */
export const PERSISTENCE: Record<string, { both: number; either: number }> = {
  'visual-typography': { both: 41, either: 50 },
  'visual-density': { both: 34, either: 47 },
  'visual-accent': { both: 9, either: 24 },
  'visual-artefact': { both: 9, either: 37 },
};

/** How often a defect id was still there when the run ended. 1 when unmeasured. */
export function survivalRate(id: string): number {
  const s = SURVIVAL[id];
  return s ? s.survived / s.of : 1;
}

/**
 * Defects the repair loop no longer plans for.
 *
 * Not everything under the floor is here, because a low fix rate has more than
 * one cause and only some of them mean "stop trying".
 *
 * The three critic findings stay excluded, and the evidence for it changed
 * shape without changing side — see `CRITIC_GAP`. They are the three findings
 * still present at the end of 74%, 80% and 95% of the runs that reported them,
 * against 31–57% for every other finding the same critic produces.
 *
 * `empty-container` (4/23) was on this list for one commit, on the reasoning
 * that `fillEmptyContainers` had already tried it. That reasoning was wrong, and
 * the code says so a few lines from where the pass is called: for a PROJECT
 * document — which is everything MakeUI produces — the fill pass is skipped,
 * because it edits rendered markup and a `.tsx` file is not its own markup.
 * 「React's empty containers go to the general repair below」. The general repair
 * is the only repair there is, so excluding it removed the only attempt at a
 * chart container with nothing drawn in it. Put back.
 *
 * What is deliberately NOT here: `empty-container` (17%),
 * `action-dead-runtime` (6%), `native-dialog` (12%), `nav-dead-runtime` (14%). Those are real, they are what a user runs
 * into, and dropping them from the repair would be one step from dropping them
 * from the report. They stay, bounded by the per-file attempt cap in
 * repair-budget.ts — two tries a file, then the run stops paying for that one.
 *
 * Also not here: the palette and copy findings (`default-palette` 0/26,
 * `palette-size` 0/19, `filler-copy` 0/17, `emoji` 6/40). A model has never
 * fixed one, which makes them candidates for a deterministic pass rather than
 * for silence — the question is whether the fix is mechanical, and that has to
 * be checked one at a time. `mobile-no-viewport` looked mechanical and turned
 * out to be impossible; guessing costs more than reading.
 *
 * Checked, 2026-09-14, on the 80 most recent documents in S3. `emoji` was
 * mechanical — 15 documents, two shapes — and is now rewritten by
 * `fixupProject` before any audit reads the project (tools/fixups/emoji-icons.ts), so
 * it rarely reaches this list at all. `default-palette` (7 of 80) sat in chart
 * series arrays and SVG strokes, where the replacement colour is a choice, not a
 * substitution; `filler-copy` fired on none of the 80.
 */
const NOT_WORTH_REPAIRING = new Set([
  'visual-spacing',
  'visual-alignment',
  'visual-hierarchy',
  /*
   * On the second ground — see `PERSISTENCE`. Not on survival alone: accent
   * survives 71%, which is inside `CRITIC_GAP`, and typography at 59% now is too,
   * so survival by itself no longer separates what repairs move from what they
   * do not. Measured against what asking twice produces, it does.
   */
  'visual-accent',
  'visual-artefact',
]);

/**
 * Findings reported and never handed to a repair, by what fixing them is.
 *
 * NOT a yield claim, and deliberately not in the list above, whose every entry
 * stands on twenty or more measured instances. These are excluded on scope: the
 * fix is a restructure of a working app, which the repair judge cannot accept
 * without the navigation it moved counting as broken.
 *
 * `preset-composition` — a design system's shell. On the material3 run of
 * 2026-09-14 (tabs across the top where the system has a rail) six candidates
 * were built and none accepted: three changed nothing measurable, three broke
 * navigation (`unreachable-introduced, console-error-introduced`), for 11k output
 * tokens. One run is not a rate, which is why this is scope and not yield. The
 * shell is asked for where it is cheap instead — in the foundation prompt, before
 * any screen exists (`shellRequirement` in preset-composition.ts) — and the
 * finding still reaches the user. Revisit it with measurements, not with this.
 */
const REPORT_ONLY = new Set(['preset-composition']);

/** Whether a defect id is one the loop still spends calls on. */
export function repairable(id: string): boolean {
  return !NOT_WORTH_REPAIRING.has(id) && !REPORT_ONLY.has(id);
}

/**
 * How often a SECOND attempt at the same defect, in the same run, clears it.
 *
 * A different question from `FIX_RATE`, which asks whether an id is ever worth
 * repairing. This asks whether it is worth repairing again after a pass has
 * already been given it and left it standing.
 *
 * It exists because two generations on 2026-09-04 handed `emoji`,
 * `action-dead-runtime` and `imagery-missing` to every pass they ran, fixed none
 * of them, and spent the repair budget doing it — one finished with fourteen
 * files unrepaired because there was nothing left to spend.
 *
 * By attempt number there is no cliff to cut at: 528 of 1,012 first attempts
 * land (52%), 68 of 193 second (35%), 14 of 46 third (30%). A rule that banned
 * third attempts would throw away fourteen real fixes.
 *
 * By id there is a gap. Everything at or below 21% and everything at or above
 * 44%, with nothing in between, re-derived over 30 days:
 *
 *   action-dead-runtime 2/26   nav-dead-runtime 1/10   input-sizing 1/10
 *   imagery-missing 3/24       emoji 3/14
 *   ——————— nothing between 3/14 (21%) and 4/9 (44%) ———————
 *   screen-unreachable 4/9     contrast-low 12/25      scoped-styling 4/8
 *
 * These figures replace a set that was wrong in one direction throughout, and
 * the correction is worth stating because it moved every row. The script counted
 * the defects a pass was HANDED; `worthRepairing` then splits that into what it
 * attempts and what it skips, and the three ids in `NOT_WORTH_REPAIRING` above
 * stayed in the handed set, were never attempted, and so were never cleared.
 * They scored near zero for the reason that nobody retried them —
 * `visual-spacing` reported 3 of 54, and none of those 54 second attempts
 * happened. Dragging them through every total is what made first attempts look
 * like 44% when they are 52%.
 *
 * It mattered for the shape of the argument too: three of the eight ids under
 * the floor were ids with no attempts behind them. The gap survives without
 * them, which is why `RETRY_FLOOR` does not move — but a floor justified by an
 * empty band has to be measured on defects somebody actually tried.
 *
 * `default-palette` has left the table rather than been updated: it was 0/10
 * when its repair targeting was broken, that targeting was fixed on 2026-09-04,
 * and over the last 30 days it is retried zero times because first attempts now
 * clear it. A stale row is worse than no row.
 *
 * `scripts/retry-rates.mjs` re-derives all of this from the logs and costs
 * nothing. Note that the Runtime log group retains 30 days, so the script's
 * 45-day default silently reads 30 — pass the window you mean.
 *
 * Re-measured 2026-09-13 and left alone: every row moved by at most one
 * instance (action-dead-runtime 2/26 -> 1/25, emoji 3/14 -> 3/12) and the band
 * the exclusion sits in is unchanged. Recorded rather than rewritten, because a
 * table with no date on it is how the FIX_RATE one above drifted nine days into
 * an argument it could no longer support.
 */
export const RETRY_RATE: Record<string, { fixed: number; of: number }> = {
  'action-dead-runtime': { fixed: 2, of: 26 },
  'nav-dead-runtime': { fixed: 1, of: 10 },
  'input-sizing': { fixed: 1, of: 10 },
  'imagery-missing': { fixed: 3, of: 24 },
  emoji: { fixed: 3, of: 14 },
  'screen-unreachable': { fixed: 4, of: 9 },
  'contrast-low': { fixed: 12, of: 25 },
  'scoped-styling': { fixed: 4, of: 8 },
  'import-missing': { fixed: 7, of: 7 },
  'preset-drift': { fixed: 7, of: 7 },
  'required-prop-missing': { fixed: 7, of: 7 },
  'visual-density': { fixed: 6, of: 6 },
  'component-unresolved': { fixed: 5, of: 5 },
};

/** In the empty region above. Nothing measured sits between 21% and 44%. */
export const RETRY_FLOOR = 0.25;

/**
 * Defects a run stops re-attempting once a pass has already failed on them.
 *
 * Every id here is under `RETRY_FLOOR` on at least ten measured retries. Under
 * ten it stays in: a rate from four attempts is a coin toss with a small coin,
 * and this list decides what a run stops paying for.
 *
 * One id that qualifies on the numbers is deliberately NOT here. `emoji` (3/14)
 * had its repair targeting changed on 2026-09-04 — the planner used to be asked
 * which file held a hex colour, from a list of filenames, and now the audit
 * hands it the answer. Adding it would bake in a number the fix exists to move,
 * and nothing would ever measure it again. It has gone from 15% to 21% since,
 * which is the direction that argument predicted; `default-palette`, the other
 * id the fix targeted, is no longer retried at all.
 * That is the `empty-container` mistake, which was excluded on reasoning about
 * a pass that turned out never to run, and had to be put back.
 *
 * Everything here is still REPORTED. The score deducts, the reply lists it, and
 * a later run starting from the same document gets a fresh first attempt. What
 * stops is a second call inside one run for something measured at one in ten.
 */
const NOT_WORTH_RETRYING = new Set([
  'action-dead-runtime',
  'nav-dead-runtime',
  'input-sizing',
  'imagery-missing',
]);

/** Whether a defect already attempted in this run is worth attempting again. */
function worthRetrying(id: string): boolean {
  return !NOT_WORTH_RETRYING.has(id);
}

/**
 * Splits a pass's defects into what it will attempt and what it will not.
 *
 * The skipped ones are NOT removed from the run's open defects: the score still
 * deducts for them and the reply still reports them. What changes is only
 * whether a model is paid to attempt them, which is the thing the measurement
 * says has no effect.
 */
export function worthRepairing(
  defects: InteractionDefect[],
  /** Ids this run has already handed to a pass. Empty on the first one. */
  attempted: ReadonlySet<string> = new Set()
): {
  attempt: InteractionDefect[];
  skipped: InteractionDefect[];
} {
  const attempt: InteractionDefect[] = [];
  const skipped: InteractionDefect[] = [];
  for (const d of defects) {
    const worth = repairable(d.id) && (!attempted.has(d.id) || worthRetrying(d.id));
    (worth ? attempt : skipped).push(d);
  }
  return { attempt, skipped };
}
