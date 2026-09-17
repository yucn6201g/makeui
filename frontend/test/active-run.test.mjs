/**
 * A run outlives the screen that started it, and the screens did not know.
 *
 * Generation is a server-side job. `activeJob.ts` already existed because of
 * that — leaving a project and coming back used to lose the progress display
 * entirely, and recording the job id fixed re-attaching to it. Two things were
 * still missing, and both are the same shape: state the client accumulates that
 * only the client has.
 *
 *   the TRANSCRIPT. The server keeps a list of pipeline `events` and exactly one
 *     `streamPhase` — the current step, overwritten on every write. The list of
 *     steps a person watches is built in the browser by observing that single
 *     value change between polls, so it lives in a hook and nowhere else.
 *     Re-attaching restored the job and rebuilt the transcript from whichever
 *     step happened to be running: eight steps became one, which is what "the
 *     progress display partly disappears" was.
 *   the PROJECT LIST. A run outlives that screen too, and it is where somebody
 *     goes to check on one — and it said nothing at all. The records are already
 *     there, one per project; the alternative is a request per card to a server
 *     that keeps no index of running jobs.
 *
 *   node test/active-run.test.mjs      (from frontend/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const activeJob = read('src/utils/activeJob.ts');
const app = read('src/App.tsx');
const list = read('src/components/ProjectList.tsx');
const admin = read('src/components/AdminPanel.tsx');
const css = read('src/index.css');
const hooks = ['useGenerate', 'useModify', 'usePlan'].map((h) => [h, read(`src/hooks/${h}.ts`)]);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// --- the transcript survives leaving the project -----------------------------------
{
  check('the transcript has somewhere to live', /export function setActivePhases/.test(activeJob), true);
  check('and somewhere to be read from', /export function getActivePhases/.test(activeJob), true);

  /*
   * Its own key, not the job record's. That record is rewritten on every render
   * while a job is in flight — see the note on `setActiveJob` keeping its
   * original `startedAt` — and the transcript is the larger of the two by an
   * order of magnitude.
   */
  check('under its own key', /const PHASE_PREFIX/.test(activeJob), true);
  check('and cleared with the job it belongs to',
    /clearActiveJob[\s\S]{0,220}removeItem\(phaseKey/.test(activeJob), true);

  // Written only while something is actually running, so a finished run's last
  // state is not left behind to be resumed into the next one.
  check('written only while a run is in flight',
    /const liveP = isGenerating \? phases : isModifying \? modifyPhases : isPlanning \? planPhases : null/.test(app),
    true);
  // Through the same trimmer the chat history uses: a step's text is a 6,000
  // character tail and storage has no reason to hold all of it.
  check('and trimmed the way stored phases already were',
    /setActivePhases\(project\.projectId, trimPhasesForStorage\(liveP\)\)/.test(app), true);

  check('every hook can be resumed into',
    hooks.filter(([, src]) => !/priorPhases\?: PhaseEntry\[\]/.test(src)).map(([h]) => h), []);
  check('and seeds rather than overwrites an empty one',
    hooks.filter(([, src]) => !/priorPhases && priorPhases\.length > 0/.test(src)).map(([h]) => h), []);
  check('the re-attach passes what it read', /resumeGenerate\(active\.jobId, prior\)/.test(app), true);
}

// --- the project list says which projects are busy ------------------------------------
{
  check('the records can be listed', /export function activeJobProjectIds/.test(activeJob), true);
  /*
   * Through `getActiveJob`, so an expired record is dropped by the listing too
   * rather than marking a card as busy for the rest of the browser's life.
   */
  check('and an expired one is not counted', /if \(getActiveJob\(projectId\)\) out\.add/.test(activeJob), true);

  check('the list reads them', /activeJobProjectIds\(\)/.test(list), true);
  /*
   * Polled, not read once: a run finishes while somebody is looking at the
   * list, and a card that said 「生成中」 for the rest of the visit would be
   * worse than one that never said it.
   */
  check('and keeps reading them', /setInterval\(tick, 6000\)/.test(list), true);
  check('including on returning to the tab', /addEventListener\('focus', tick\)/.test(list), true);
  check('and stops when the list goes', /removeEventListener\('focus', tick\)/.test(list), true);

  check('the card says so', /project-list__running/.test(list), true);
  // The pulse goes for anyone who asked not to be shown motion; the badge stays.
  check('without animating at somebody who asked it not to',
    /prefers-reduced-motion[\s\S]{0,140}project-list__running-dot \{ animation: none/.test(css), true);
}

// --- a closed model is unusable rather than labelled -----------------------------------
{
  /*
   * The checkbox being unclickable IS the statement. A word beside every closed
   * model repeated it, in a place that cost a column of width, and the reason
   * is on the `title` for anyone who wonders.
   */
  check('the badge is gone', /adm-model__closed/.test(admin), false);
  check('and its style with it', /adm-model__closed/.test(css), false);
  check('but the control is still unusable', /disabled=\{last \|\| saving !== null \|\| \(closed && !on\)\}/.test(admin), true);
  check('and still says why', /title=\{closed \? opt\.closed/.test(admin), true);
}

// --- the period is selectable, and the labels follow it ---------------------------------
{
  check('there is a picker', /function PeriodPicker/.test(admin), true);
  check('with the two questions that are one click', [
    admin.includes("label: '先月'"), admin.includes("label: '過去3ヶ月'"),
  ], [true, true]);
  // Dragging the start past the end would otherwise produce a range the server
  // refuses, which reads as the picker being broken.
  check('and a range that cannot be inverted', /if \(next\.to < next\.from\)/.test(admin), true);

  check('the fetch carries it', /\?from=\$\{period\.from\}&to=\$\{period\.to\}/.test(read('src/hooks/useAdmin.ts')), true);
  /*
   * Keyed on the period rather than on `users.length`. That guard stopped a
   * refetch on every render, and would also have stopped a period change from
   * ever loading a month that happened to have the same number of rows.
   */
  check('and changing it refetches', /if \(visible\) fetchUsers\(period\)/.test(admin), true);

  /*
   * A budget is monthly, so it is a comparison only over one month. Over a
   * quarter the money is still the money and the ratio is not — a bar of
   * 「$26 / $10」 would report three correct months as three times over budget.
   */
  check('the budget is only drawn where it means something',
    /const oneMonth = period\.from === period\.to/.test(admin), true);
  check('and the heading says which figure it is',
    /oneMonth \? '今月の金額 \/ 予算' : '期間の金額'/.test(admin), true);
  check('the summary is labelled by its period, not by 「今月」',
    [/\{span\}の合計トークン/.test(admin), /今月合計トークン/.test(admin)], [true, false]);
}

// --- and the projects tab counts the account, like the tabs beside it --------------------
{
  /*
   * The whole account, not the account being read.
   *
   * This used to be reported up from the pane — one person's project count, and
   * nothing at all until somebody had been chosen — while the three chips beside
   * it counted every user, every account and every group. Same row, same shape,
   * a different subject.
   */
  check('the tab carries a count', /totalProjects !== null && <span className="adm-tab-badge">/.test(admin), true);
  check('and it is every account added up',
    /reduce\(\(n, u\) => n \+ \(u\.projectCount \?\? 0\), 0\)/.test(admin), true);
  // Which also removes the effect that carried it: a parent setState reported
  // from a child on every render is the shape of the save loop this project has
  // had once, and the safest version of that is not to have one.
  check('nothing is reported up from the pane any more', /onCount/.test(admin), false);
  // 「何件あるか」 is the first thing asked of a list, and it was answered only
  // once somebody had typed into the search box.
  check('the list says its size without being filtered first',
    /\$\{projects\.length\} 件/.test(admin), true);
  check('and the history says its own', /\$\{versions\.length\} 件/.test(admin), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
