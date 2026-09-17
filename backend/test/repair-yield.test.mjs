// The repair loop spends calls only on defects it has actually fixed.
//
// Repair is 43% of what a run spends and 49% of its passes end rejected — 205 of
// 415, three quarters for "no improvement". Measured over 165 accepted passes
// and 1,371 defect instances, 32% of what the planner is handed belongs to ids
// fixed less than a fifth of the time.
//
// What is asserted here is that the exclusion list stays tied to its own
// evidence. A hand-written list of ids is a list that grows by opinion; every id
// on it must be under the floor in the table sitting beside it, and the table has
// to be re-derivable — scripts/fix-rates.mjs reads it back out of CloudWatch for
// nothing.
//
//   node test/repair-yield.test.mjs      (from backend/)
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execSync(
  `npx esbuild "${path.join(root, 'src/orchestration/repair-yield.ts')}" --bundle --platform=node ` +
    `--format=esm --outfile="${path.join(root, 'dist/ry.test.mjs')}"`,
  { stdio: 'pipe', cwd: root }
);
const { worthRepairing, repairable, FIX_RATE, SURVIVAL, survivalRate, YIELD_FLOOR, CRITIC_GAP, isCriticFinding, RETRY_RATE, RETRY_FLOOR, PERSISTENCE } = await import(
  pathToFileURL(path.join(root, 'dist/ry.test.mjs')).href
);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

const d = (id) => ({ id, instruction: `fix ${id}` });

// --- the split ------------------------------------------------------------------
{
  const { attempt, skipped } = worthRepairing([
    d('imagery-missing'), d('visual-spacing'), d('shell-without-nav'), d('empty-container'),
  ]);
  check('what a pass fixes is attempted',
    attempt.map((x) => x.id), ['imagery-missing', 'shell-without-nav', 'empty-container']);
  check('what it does not is skipped',
    skipped.map((x) => x.id), ['visual-spacing']);
}

check('an empty list splits into two empty lists',
  worthRepairing([]), { attempt: [], skipped: [] });

// An id nobody has measured is attempted. The default has to be "try": a new
// audit's findings would otherwise be silently dropped from the day it ships.
check('an unmeasured defect is attempted', repairable('something-new'), true);

// --- the list cannot drift from its evidence -------------------------------------
//
// Every excluded id must be under the floor in the table beside it. Without
// this, the list is a place to put anything anyone finds annoying.
const src = fs.readFileSync(path.join(root, 'src/orchestration/repair-yield.ts'), 'utf8');
/*
 * Read each Set by name rather than scraping every quoted line in the file.
 *
 * There are two lists now — one for defects a pass never fixes, one for defects
 * a SECOND pass in the same run does not fix — and they are justified against
 * different tables. A scrape that took both at once checked the retry ids
 * against the first-attempt rates and called them unjustified, which is a true
 * statement about the wrong question.
 */
const setNamed = (name) => {
  const at = src.indexOf(`const ${name} = new Set([`);
  if (at < 0) return [];
  const body = src.slice(at, src.indexOf(']', at));
  return [...body.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
};
const excluded = setNamed('NOT_WORTH_REPAIRING');
const notRetried = setNamed('NOT_WORTH_RETRYING');
check('the exclusion list was read', excluded.length > 0, true);
check('and so was the retry list', notRetried.length > 0, true);

const rate = (id) => (FIX_RATE[id] ? FIX_RATE[id].fixed / FIX_RATE[id].of : 1);

/*
 * Two grounds, and an id must stand on one of them. Anything else is an opinion
 * with a table next to it.
 *
 * An ordinary defect stands on its fix rate. A critic finding stands on
 * SURVIVAL — whether it was still in the document when the run ended — because
 * the fix-rate ground it used to stand on collapsed: the 2026-09-12
 * re-measurement moved visual-typography 85% -> 50% and visual-density
 * 72% -> 54%, and the "49 points of nothing" the split was drawn in became a
 * 22-point interval with four values crowded above it.
 */
/*
 * A third ground since 2026-09-14, for the critic categories the critic is still
 * asked about twice over: a repair leaves the finding standing at least as often
 * as asking the critic again on an unchanged screenshot does, on twenty or more
 * of each. That is "no effect shown", measured against the right baseline.
 */
const persists = (id) => PERSISTENCE[id].both / PERSISTENCE[id].either;
const noEffectShown = (id) => Boolean(PERSISTENCE[id]) && PERSISTENCE[id].either >= 20 &&
  (SURVIVAL[id]?.of ?? 0) >= 20 && survivalRate(id) >= persists(id);
const unjustified = excluded.filter((id) =>
  // At or above the top of the gap. visual-hierarchy sits exactly on it at
  // 37/50, which is the boundary being the measurement rather than a round
  // number chosen near it.
  isCriticFinding(id) ? survivalRate(id) < CRITIC_GAP.above && !noEffectShown(id) : rate(id) >= YIELD_FLOOR
);
check('every excluded id stands on one of the grounds', unjustified, []);

/*
 * And the second ground has to be a gap rather than a line through a continuum.
 * Two of the excluded ids are ABOVE the ordinary fix-rate floor and are excluded
 * on survival instead, so that separation has to be real. If a measurement ever
 * fills the space, the split stops being defensible — which is exactly what
 * happened to the previous version of this check, on the previous table.
 */
/*
 * The gap is the ground only for the categories without a persistence
 * measurement — spacing, alignment and hierarchy, which the critic is no longer
 * asked about. The 2026-09-14 re-derivation put visual-accent (71%) and
 * visual-typography (59%) inside it, which is why the categories that do have
 * one are decided against it instead, and are left out of this check.
 */
const criticSurvival = Object.keys(SURVIVAL).filter((id) => isCriticFinding(id) && !PERSISTENCE[id]).map(survivalRate);
const persistenceMeasured = Object.keys(SURVIVAL).filter((id) => isCriticFinding(id) && PERSISTENCE[id]).map(survivalRate);
check('nothing decided on survival alone sits inside the critic gap',
  criticSurvival.filter((r) => r > CRITIC_GAP.below && r < CRITIC_GAP.above), []);
/*
 * Wide enough to be a gap, and deliberately a weaker claim than the one it
 * replaces. The fix-rate gap was 49 points and this one is 14 — a real
 * separation (95/80/74 against 57/50/33/31) but visibly a narrower one, and
 * pretending otherwise by keeping the old threshold would be choosing the
 * number that made the answer come out.
 */
check('and the gap is wide enough to be one', CRITIC_GAP.above - CRITIC_GAP.below >= 0.1, true);
// The side below the gap is the repairable categories, which now carry a persistence measurement.
check('and both sides of it are populated',
  [criticSurvival.some((r) => r >= CRITIC_GAP.above), persistenceMeasured.some((r) => r <= CRITIC_GAP.below)],
  [true, true]);

// And a sample size worth deciding on. Four out of ten is not a measurement.
// On the tables of the ground each stands on: an exclusion on persistence is not a fix-rate claim.
check('and measured on enough instances to mean something',
  excluded.filter((id) => !noEffectShown(id) && (FIX_RATE[id]?.of ?? 0) < 20), []);
check('on both tables', excluded.filter((id) => (SURVIVAL[id]?.of ?? 0) < 20), []);

// --- the ones deliberately kept ---------------------------------------------------
//
// Low yield has more than one cause, and only some mean "stop trying". These are
// real defects a user runs into; dropping them from the repair is one step from
// dropping them from the report, so they stay — bounded by the per-file attempt
// cap instead.
// `empty-container` is in this group and not in the exclusion list, because the
// pass that was supposed to have already tried it is skipped for every format
// MakeUI produces — the general repair is the only attempt there is.
for (const id of ['empty-container', 'action-dead-runtime', 'nav-dead-runtime']) {
  check(`${id} is still attempted despite a low rate`, repairable(id), true);
  check(`  and the table admits it is low`, FIX_RATE[id].fixed / FIX_RATE[id].of < YIELD_FLOOR, true);
}
/*
 * `native-dialog` was in that group and is out of it: the re-measurement put its
 * fix rate at 22%, above the floor. It is the clearest case for keeping both
 * tables — a pass clears it more than one time in five, and it is still in the
 * document at the end of two runs in three, because the passes that cleared it
 * were thrown away for other reasons.
 */
check('native-dialog is attempted', repairable('native-dialog'), true);
check('  and is no longer a low-rate exception', rate('native-dialog') >= YIELD_FLOOR, true);
check('  while still surviving most runs', survivalRate('native-dialog') > 0.5, true);

/*
 * The palette and copy findings are candidates for a deterministic pass, not for
 * silence — a model essentially never fixes one, which is a different problem
 * from a low yield.
 *
 * "Never" was literal until the re-measurement: `palette-size` is 2 of 25 now,
 * having been 0 of 19. Two fixes in twenty-five does not make it a repairable
 * defect; it makes the absolute claim wrong, and the assertion is a rate rather
 * than a zero so the next fix does not break a test about something else.
 */
for (const id of ['default-palette', 'palette-size', 'filler-copy']) {
  check(`${id} is not silently dropped`, repairable(id), true);
  check(`  and a model almost never fixes it`, rate(id) < 0.1, true);
}
// And they stay in the document: what a deterministic pass would be for.
for (const id of ['default-palette', 'filler-copy']) {
  check(`  ${id} survives the run`, survivalRate(id), 1);
}

// --- the table is re-derivable ------------------------------------------------------
check('the script that re-measures it exists',
  fs.existsSync(path.join(root, 'scripts/fix-rates.mjs')), true);
check('and the module points at it', src.includes('scripts/fix-rates.mjs'), true);
// Both tables, because a decision justified on one of them can only be checked
// by someone who can re-derive both.
check('the survival script exists too',
  fs.existsSync(path.join(root, 'scripts/defect-survival.mjs')), true);
check('and is named as well', src.includes('scripts/defect-survival.mjs'), true);
/*
 * And the two tables describe the same pipeline. An id measured in one and not
 * the other is a table that was refreshed alone, which is how the pair silently
 * stops being comparable.
 */
const criticIds = (o) => Object.keys(o).filter(isCriticFinding).sort();
check('the two tables cover the same critic findings',
  criticIds(FIX_RATE).filter((id) => !SURVIVAL[id]), []);

// --- and the same discipline for the retry list -----------------------------------
//
// A different question from the one above: not whether an id is ever worth
// repairing, but whether it is worth repairing AGAIN after a pass has already
// been given it and left it standing.
//
// By attempt number there is no cliff to cut at, measured over 45 days: 539 of
// 1,212 first attempts land, 76 of 268 second, 16 of 69 third. A rule banning
// third attempts would throw away sixteen real fixes. By id there is a gap, and
// every excluded id has to be on the low side of it.
const retryRate = (id) => (RETRY_RATE[id] ? RETRY_RATE[id].fixed / RETRY_RATE[id].of : 1);

check('every id we stop retrying is under the retry floor',
  notRetried.filter((id) => retryRate(id) >= RETRY_FLOOR), []);

// Ten is the floor for deciding. Under it a rate is a coin toss with a small
// coin, and this list decides what a run stops paying for.
check('and measured on at least ten retries',
  notRetried.filter((id) => (RETRY_RATE[id]?.of ?? 0) < 10), []);

/*
 * The floor has to sit in an empty region rather than be a line through a
 * continuum.
 *
 * The exact edges, not rounded ones: writing 0.18 for what was 18.2% once put a
 * row inside the gap and failed this assertion, which is the assertion doing its
 * job.
 *
 * The edges moved when the rates were re-derived without the ids the loop never
 * attempts. `visual-hierarchy` at 4/22 was the old lower edge and was one of
 * them: it was never retried, so its rate measured nothing. The highest below
 * the gap is now emoji at 3/14 (21.4%), and the lowest solid rate above it is
 * contrast-low at 12/25 (48%).
 */
{
  const solid = Object.entries(RETRY_RATE).filter(([, r]) => r.of >= 10);
  const inside = solid.filter(([, r]) => r.fixed / r.of > 3 / 14 && r.fixed / r.of < 12 / 25);
  check('nothing sits inside the gap the floor is in', inside.map(([id]) => id), []);
  // Narrower than it was (32 points against 39) and still wide enough that the
  // floor is a choice between two populations rather than a cut through one.
  check('and the gap is wide enough to be one', 12 / 25 - 3 / 14 >= 0.25, true);
}

/*
 * `emoji` qualifies on the numbers and is deliberately kept.
 *
 * It and `default-palette` had their repair targeting changed on 2026-09-04: the
 * planner used to be asked which file held a hex colour, from a list of
 * filenames, and the audit hands it the answer now. Those rates were measured
 * against the broken version, so excluding them would bake in a number the fix
 * exists to move and nothing would measure it again - the `empty-container`
 * mistake, excluded on reasoning about a pass that turned out never to run.
 */
check('emoji is still retried despite its measured rate', notRetried.includes('emoji'), false);
check('  and the table admits the rate is low', retryRate('emoji') < RETRY_FLOOR, true);

/*
 * `default-palette` is the same decision, one step later: it is no longer in the
 * table at all, because over the last 30 days it is retried zero times. That is
 * the outcome the 2026-09-04 fix predicted - first attempts clear it now - so
 * the row is gone rather than frozen at the 0/10 it scored while the targeting
 * was broken. A rate that cannot be re-derived is not a measurement.
 *
 * Both halves are asserted, because either one alone reads as an oversight:
 * absent from the table, and still not in the set of things a run gives up on.
 */
check('default-palette has left the table rather than being frozen',
  Object.prototype.hasOwnProperty.call(RETRY_RATE, 'default-palette'), false);
check('  and is still retried', notRetried.includes('default-palette'), false);

// --- what the split actually does -------------------------------------------------
{
  const first = worthRepairing([d('imagery-missing'), d('contrast-low')]);
  check('a first attempt tries both', first.attempt.map((x) => x.id), ['imagery-missing', 'contrast-low']);

  const again = worthRepairing(
    [d('imagery-missing'), d('contrast-low')],
    new Set(['imagery-missing', 'contrast-low'])
  );
  check('a second attempt drops the one that does not land',
    again.attempt.map((x) => x.id), ['contrast-low']);
  check('and reports the other rather than losing it',
    again.skipped.map((x) => x.id), ['imagery-missing']);

  // An id nobody has measured on a retry is retried. The default has to be
  // "try", here as in `repairable`.
  check('an unmeasured defect is still retried',
    worthRepairing([d('something-new')], new Set(['something-new'])).attempt.length, 1);
}

// --- the critic's own repeatability, the baseline survival is read against ---------------
{
  check('every category the critic still asks for has a persistence measurement',
    Object.keys(SURVIVAL).filter((id) => isCriticFinding(id) && repairable(id) && !PERSISTENCE[id]), []);
  /*
   * Stated as a check so the note beside PERSISTENCE cannot outlive the numbers:
   * the categories where a repair shows an effect are the ones that survive a run
   * less often than they survive being asked twice.
   */
  const shownEffect = Object.keys(PERSISTENCE).filter((id) => survivalRate(id) < persists(id)).sort();
  check('repairs show an effect on typography and density only', shownEffect, ['visual-density', 'visual-typography']);
  // Re-measured 2026-09-14 past twenty on both tables, and excluded on that ground.
  check('the two without one are excluded, on twenty or more of each',
    ['visual-accent', 'visual-artefact'].map((id) => [repairable(id), noEffectShown(id)]), [[false, true], [false, true]]);
  check('and the two with one are still repaired', ['visual-density', 'visual-typography'].map(repairable), [true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
